require('dotenv').config();

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const archiver = require('archiver');
const rateLimit = require('express-rate-limit');
const sharp = require('sharp');
const escapeHtml = require('escape-html');
const crypto = require('crypto');
const net = require('net');
const { execFile } = require('child_process');

const { openDatabase } = require('./db');
const ops = require('./db/operations');

const app = express();
const PORT = process.env.PORT || 3000;

// Trust reverse-proxy headers (X-Forwarded-For, X-Forwarded-Proto).
// Set TRUST_PROXY=1 when running behind Nginx/Caddy/Traefik. Default is 0 (safe for direct exposure).
// Accepts: integer (hop count), IP, CIDR, comma-separated IPs/CIDRs, or 'loopback'/'uniquelocal'.
// Docker Compose defaults to 1 via docker-compose.yml.
function parseTrustProxy(raw) {
    if (!raw || raw === '0' || raw === 'false') return 0;
    if (raw === 'true') return true;
    const n = Number(raw);
    if (Number.isInteger(n) && n >= 0) return n;
    return raw; // IP, CIDR, 'loopback', comma-separated list — passed through to Express as-is
}
const TRUST_PROXY = parseTrustProxy(process.env.TRUST_PROXY);
app.set('trust proxy', TRUST_PROXY);

app.use(express.json());

// Security headers — applied to every response
app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
});

// Admin password loaded from .env file — must be set or the server refuses to start
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
if (!ADMIN_PASSWORD) {
    console.error('FATAL: ADMIN_PASSWORD environment variable is not set. Set it in your .env file.');
    process.exit(1);
}

// Admin IP allowlist — comma-separated IPs or CIDR ranges (optional)
const ADMIN_ALLOWED_IPS = (process.env.ADMIN_ALLOWED_IPS || '')
    .split(',').map(s => s.trim()).filter(Boolean);

// File size limits (from .env, in MB)
const MAX_PHOTO_BYTES = parseInt(process.env.MAX_UPLOAD_MB || '200') * 1024 * 1024;
const MAX_VIDEO_BYTES = parseInt(process.env.MAX_VIDEO_MB || '500') * 1024 * 1024;
const MAX_BACKGROUND_BYTES = parseInt(process.env.MAX_BACKGROUND_MB || '25') * 1024 * 1024;
// Collection audio montage — an hour of 192 kbps MP3 is ~86 MB, so the cap is generous
const MAX_AUDIO_BYTES = parseInt(process.env.MAX_AUDIO_MB || '150') * 1024 * 1024;

// Install directory — where Node.js stores uploads, backgrounds, and the SQLite database
// Docker: always /data (set via environment in docker-compose.yml)
// Bare-metal: defaults to the project directory
const DATA_DIR = process.env.INSTALL_DIR || __dirname;

const THUMBNAILS_DIR = path.join(DATA_DIR, 'thumbnails');
const PREVIEWS_DIR   = path.join(DATA_DIR, 'previews');
const OG_CACHE_DIR   = path.join(DATA_DIR, 'og-cache');
const AUDIO_DIR      = path.join(DATA_DIR, 'audio');

// UUID v4 validation regex — used by middleware and reconcileGalleries (must be declared early)
const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Video file extensions accepted for gallery uploads (mp4, mov/quicktime, webm)
const VIDEO_EXTENSIONS = new Set(['mp4', 'mov', 'webm', 'm4v']);
const VIDEO_MIME_RE = /^video\/(mp4|quicktime|webm|x-m4v)/i;

function isVideoFile(filename) {
    const ext = path.extname(filename).toLowerCase().slice(1);
    return VIDEO_EXTENSIONS.has(ext);
}

// Audio formats accepted for a collection's montage. MP3 and M4A/AAC play everywhere;
// the rest are allowed but Ogg/Opus is uneven on Safari and WAV/FLAC are very heavy.
const AUDIO_EXTENSIONS = new Set(['mp3', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'wav', 'flac']);
const AUDIO_MIME_BY_EXT = {
    mp3: 'audio/mpeg',  m4a: 'audio/mp4',   aac: 'audio/aac',
    ogg: 'audio/ogg',   oga: 'audio/ogg',   opus: 'audio/ogg',
    wav: 'audio/wav',   flac: 'audio/flac'
};
// Reverse map, used when the uploaded filename carries no usable extension but the
// MIME type does. ogg/oga/opus all share audio/ogg, so that key resolves to whichever
// comes last; any of the three plays the same, so it does not matter.
const EXT_BY_AUDIO_MIME = Object.fromEntries(
    Object.entries(AUDIO_MIME_BY_EXT).map(([ext, mime]) => [mime, ext])
);
function isAudioFile(filename) {
    const ext = path.extname(filename).toLowerCase().slice(1);
    return AUDIO_EXTENSIONS.has(ext);
}

// Picks the stored extension for a montage. The upload's own extension is only
// trusted when it is one we recognise: fileFilter accepts anything with an `audio/*`
// MIME regardless of its name, so this value is otherwise an unvalidated client
// string that would land directly in a filename. It also fixes a real bug, not just
// a theoretical one — a file uploaded with no extension used to be stored as
// `gallery-<uuid>.` and then served as application/octet-stream, which simply does
// not play.
function resolveAudioExtension(file) {
    const fromName = path.extname(file.originalname || '').toLowerCase().slice(1);
    if (AUDIO_EXTENSIONS.has(fromName)) return fromName;
    const fromMime = EXT_BY_AUDIO_MIME[String(file.mimetype || '').toLowerCase()];
    return fromMime || 'mp3';
}

// Formats that MAY be animated (multi-frame). Used to decide whether it's worth
// probing an image for animation; other formats are never animated.
const ANIMATABLE_EXTENSIONS = new Set(['gif', 'webp']);
function isAnimatableFile(filename) {
    const ext = path.extname(filename).toLowerCase().slice(1);
    return ANIMATABLE_EXTENSIONS.has(ext);
}

// Admin session tokens — cleared on restart (intentional: forces re-login)
const sessions = new Map();
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 h

function parseCookies(cookieHeader) {
    return (cookieHeader || '').split(';').reduce((acc, pair) => {
        const idx = pair.indexOf('=');
        if (idx < 0) return acc;
        const k = pair.slice(0, idx).trim();
        const v = pair.slice(idx + 1).trim();
        acc[k] = decodeURIComponent(v);
        return acc;
    }, {});
}

// ── Database ─────────────────────────────────────────────────────────────────
// SQLite is the sole source of truth for galleries/collections/settings (see
// db/index.js and CLAUDE.md's "Data persistence" section). The database file
// must already exist — created once by `npm run migrate` — so this fails fast
// with a clear message otherwise, exactly like the ADMIN_PASSWORD check above.
// There is no auto-migrate-on-boot branch: that would make a deleted or
// corrupted .sqlite file silently resurrect data from whatever the original
// JSON files still say, which could by then be stale relative to months of
// SQL-only writes.
const DB_PATH = path.join(DATA_DIR, 'delyvr.sqlite');
let db;
try {
    db = openDatabase(DB_PATH);
} catch (e) {
    console.error(`FATAL: ${e.message}`);
    process.exit(1);
}

// Maps a `galleries` row (snake_case SQL columns) to the camelCase shape every
// route already expects. `order`/`sort_order` is deliberately NOT included —
// it has exactly one consumer (the admin gallery list) and needs the
// null-vs-undefined distinction handled there directly (see that route) since
// JSON.stringify drops `undefined` keys but keeps explicit `null` ones, and
// the admin dashboard's own client-side sort relies on that.
function galleryRowToObject(row) {
    return {
        id: row.id,
        eventName: row.event_name,
        created: row.created_at,
        background: row.background,
        downloadsEnabled: !!row.downloads_enabled,
        commentsEnabled: !!row.comments_enabled,
        downloadCount: row.download_count,
        viewCount: row.view_count,
        clientLanguage: row.client_language,
        deleted: !!row.deleted,
        deletedAt: row.deleted_at,
        audio: row.audio_filename ? {
            filename: row.audio_filename,
            stored: row.audio_stored,
            size: row.audio_size,
            duration: row.audio_duration,
            uploadedAt: row.audio_uploaded_at
        } : null
    };
}

// Returns the gallery only if it exists and is not soft-deleted
function getActiveGallery(galleryId) {
    const row = db.prepare(`SELECT * FROM galleries WHERE id = ? AND deleted = 0`).get(galleryId);
    return row ? galleryRowToObject(row) : null;
}

// Recovers an uploads/ folder that has no matching galleries row — used by
// both reconcileGalleries() at startup and GET /api/galleries' own inline
// recovery (a second, separate recovery site — easy to miss since it isn't
// named like a reconciliation function). `event_name`/`download_count`/
// `view_count` etc. all come from the schema's own column DEFAULTs, matching
// both of the old recovery sites' placeholder metadata exactly.
function insertRecoveredGallery(id, createdAtIso, files) {
    db.transaction(() => {
        db.prepare(`INSERT INTO galleries (id, created_at) VALUES (?, ?)`).run(id, createdAtIso);
        const insertFile = db.prepare(`INSERT OR IGNORE INTO files (gallery_id, filename) VALUES (?, ?)`);
        for (const f of new Set(files)) insertFile.run(id, f);
    })();
}

// Hard-delete all files for a gallery (used by purge and auto-expiry).
// Filesystem removal happens BEFORE the DB delete, exactly as before: this
// ordering is what lets reconcileGalleries() repair the state if the process
// crashes in between (a DB row whose uploads folder is already gone gets
// cleaned up on the next startup, same as always). The DB half collapses to
// one statement — ON DELETE CASCADE removes files/favorites/comments/
// viewer_hashes/collection_galleries automatically, replacing the old
// "scan every collection and strip this gallery out" loop.
function hardDeleteGallery(galleryId) {
    const galleryPath = safeResolvePath(path.join(DATA_DIR, 'uploads'), galleryId);
    if (fs.existsSync(galleryPath)) fs.rmSync(galleryPath, { recursive: true });
    const backgroundsDir = path.join(DATA_DIR, 'backgrounds');
    if (fs.existsSync(backgroundsDir)) {
        const bgFile = fs.readdirSync(backgroundsDir).find(f => f.startsWith(galleryId));
        if (bgFile) fs.unlinkSync(safeResolvePath(backgroundsDir, bgFile));
    }
    fs.rmSync(safeResolvePath(THUMBNAILS_DIR, galleryId), { recursive: true, force: true });
    fs.rmSync(safeResolvePath(PREVIEWS_DIR, galleryId), { recursive: true, force: true });
    try { fs.unlinkSync(safeResolvePath(OG_CACHE_DIR, `${galleryId}.jpg`)); } catch (_) {}
    deleteAudioFiles(`gallery-${galleryId}`); // this gallery's own montage, if any
    ops.deleteGalleryRow(db, galleryId);
}

// Auto-purge soft-deleted galleries older than TRASH_RETENTION_MS
const TRASH_RETENTION_MS = 3 * 24 * 60 * 60 * 1000; // 3 days
function purgeExpiredTrash() {
    const cutoff = new Date(Date.now() - TRASH_RETENTION_MS).toISOString();
    const expired = db.prepare(`SELECT id, event_name, deleted_at FROM galleries WHERE deleted = 1 AND deleted_at < ?`).all(cutoff);
    for (const g of expired) {
        // Guard each hard-delete: this also runs on a timer (see setInterval below),
        // so an fs failure on one gallery must not abort the loop or crash the process.
        try {
            console.log(`[TRASH] Auto-purge: gallery "${g.event_name}" (${g.id}) deleted at ${g.deleted_at}`);
            hardDeleteGallery(g.id);
        } catch (e) {
            console.warn(`[TRASH] Auto-purge failed for ${g.id}: ${e.message}`);
        }
    }
}

// Reconcile the database with the uploads directory on disk.
// Runs once on startup to handle two cases:
//   1. Row in DB but no uploads folder → remove the stale entry
//   2. Uploads folder exists but no DB row → recover with placeholder metadata
function reconcileGalleries() {
    const uploadsDir = path.join(DATA_DIR, 'uploads');

    // Case 1: stale DB rows with no corresponding uploads folder
    for (const row of db.prepare(`SELECT id FROM galleries`).all()) {
        if (!fs.existsSync(path.join(uploadsDir, row.id))) {
            ops.deleteGalleryRow(db, row.id);
            console.log(`[STARTUP] Reconcile: removed stale entry ${row.id} (no uploads folder)`);
        }
    }

    // Case 2: uploads folders on disk with no DB row
    if (fs.existsSync(uploadsDir)) {
        const known = new Set(db.prepare(`SELECT id FROM galleries`).all().map(r => r.id));
        for (const entry of fs.readdirSync(uploadsDir)) {
            if (!UUID_V4_REGEX.test(entry)) continue;
            if (known.has(entry)) continue;
            const galleryPath = path.join(uploadsDir, entry);
            if (!fs.statSync(galleryPath).isDirectory()) continue;
            const files = fs.readdirSync(galleryPath).filter(f => !f.startsWith('.'));
            insertRecoveredGallery(entry, fs.statSync(galleryPath).birthtime.toISOString(), files);
            console.log(`[STARTUP] Reconcile: recovered gallery ${entry} from disk (${files.length} file(s))`);
        }
    }

    // Case 3: clean orphan files/folders in thumbnails, previews, backgrounds, og-cache
    // whose galleryId no longer exists in the registry
    const knownIds = new Set(db.prepare(`SELECT id FROM galleries`).all().map(r => r.id));

    // thumbnails/ and previews/ are per-gallery folders
    for (const dirName of ['thumbnails', 'previews']) {
        const base = path.join(DATA_DIR, dirName);
        if (!fs.existsSync(base)) continue;
        for (const entry of fs.readdirSync(base)) {
            if (!UUID_V4_REGEX.test(entry)) continue;
            if (knownIds.has(entry)) continue;
            try { fs.rmSync(path.join(base, entry), { recursive: true, force: true }); } catch (_) {}
        }
    }

    // backgrounds/ contains {galleryId}.{ext} and collection-{collectionId}.{ext}
    const bgDir = path.join(DATA_DIR, 'backgrounds');
    if (fs.existsSync(bgDir)) {
        const knownCollectionIds = new Set(db.prepare(`SELECT id FROM collections`).all().map(r => r.id));
        for (const entry of fs.readdirSync(bgDir)) {
            const base = entry.replace(/\.[^.]+$/, '');
            if (base.startsWith('collection-')) {
                const cid = base.slice('collection-'.length);
                if (knownCollectionIds.has(cid)) continue;
            } else if (knownIds.has(base)) {
                continue;
            }
            try { fs.unlinkSync(safeResolvePath(bgDir, entry)); } catch (_) {}
        }
    }

    // og-cache/ contains {galleryId}.jpg
    const ogDir = path.join(DATA_DIR, 'og-cache');
    if (fs.existsSync(ogDir)) {
        for (const entry of fs.readdirSync(ogDir)) {
            const base = entry.replace(/\.[^.]+$/, '');
            if (knownIds.has(base)) continue;
            try { fs.unlinkSync(path.join(ogDir, entry)); } catch (_) {}
        }
    }
}

reconcileGalleries();
purgeExpiredTrash();
// Re-run on a timer too: the startup-only call never fires on a long-running server
// (self-hosted Docker), so trash that crosses the retention threshold while the process
// stays up would otherwise sit forever until the next restart. `.unref()` so the timer
// alone doesn't keep the process alive (the HTTP server keeps it alive anyway).
const TRASH_PURGE_INTERVAL_MS = 60 * 60 * 1000; // hourly
setInterval(purgeExpiredTrash, TRASH_PURGE_INTERVAL_MS).unref();

// Ensure directories exist
['uploads', 'backgrounds', 'thumbnails', 'previews', 'og-cache', 'audio'].forEach(dir => {
    const dirPath = path.join(DATA_DIR, dir);
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
});
if (!fs.existsSync(path.join(__dirname, 'public'))) {
    fs.mkdirSync(path.join(__dirname, 'public'), { recursive: true });
}

const SUPPORTED_LANGUAGES = ['en', 'fr', 'es', 'pt', 'it'];

// OG share-preview descriptions, localized — 'auto' (no browser to detect from) falls back to English
const OG_DESCRIPTIONS = {
    preview: {
        en: 'Browse and download individual photos.',
        fr: 'Parcourez et téléchargez vos photos individuellement.',
        es: 'Explora y descarga fotos individuales.',
        pt: 'Navegue e baixe fotos individuais.',
        it: 'Sfoglia e scarica le singole foto.'
    },
    collection: {
        en: 'Your photo galleries are ready.',
        fr: 'Vos galeries photos sont prêtes.',
        es: 'Tus galerías de fotos están listas.',
        pt: 'Suas galerias de fotos estão prontas.',
        it: 'Le tue gallerie fotografiche sono pronte.'
    },
    favorites: {
        en: 'Client favorite photos from',
        fr: 'Photos préférées du client pour',
        es: 'Fotos favoritas del cliente de',
        pt: 'Fotos favoritas do cliente de',
        it: 'Foto preferite del cliente da'
    }
};
function ogDescription(key, language) {
    const lang = SUPPORTED_LANGUAGES.includes(language) ? language : 'en';
    return OG_DESCRIPTIONS[key][lang];
}

// Date/time format for the ADMIN dashboard only. Client pages keep formatting by the
// visitor's resolved locale — this is the photographer's own display preference.
const DATE_FORMATS = ['auto', 'dmy', 'mdy', 'ymd'];

// Gallery slideshow, global for the whole site. Both lists must stay identical to
// the CHECK constraints on settings.slideshow_interval / slideshow_transition.
const SLIDESHOW_INTERVALS = [3, 5, 8, 12];
const SLIDESHOW_TRANSITIONS = ['fade', 'slide', 'kenburns'];

// Reads the full settings object (theme/website/socials/adminLanguage/
// clientLanguage/dateFormat/slideshowInterval/slideshowTransition) — the
// `settings` row always exists post-migration (a singleton created once,
// enforced by the schema's `CHECK (id = 1)`).
function getSettings() {
    const row = db.prepare(`SELECT theme, website, admin_language, client_language, date_format,
                                   slideshow_interval, slideshow_transition
                            FROM settings WHERE id = 1`).get();
    const socials = {};
    for (const s of db.prepare(`SELECT key, value FROM settings_socials`).all()) socials[s.key] = s.value;
    return {
        theme: row.theme,
        website: row.website,
        socials,
        adminLanguage: row.admin_language,
        clientLanguage: row.client_language,
        dateFormat: row.date_format,
        slideshowInterval: row.slideshow_interval,
        slideshowTransition: row.slideshow_transition
    };
}

// Applies a partial settings patch (only the keys present are touched) — the
// route handlers keep doing their own validation first, exactly as before,
// and only pass through fields that already passed it.
function updateSettings(patch) {
    db.transaction(() => {
        const sets = [];
        const params = {};
        if (patch.theme !== undefined) { sets.push('theme = @theme'); params.theme = patch.theme; }
        if (patch.website !== undefined) { sets.push('website = @website'); params.website = patch.website; }
        if (patch.adminLanguage !== undefined) { sets.push('admin_language = @admin_language'); params.admin_language = patch.adminLanguage; }
        if (patch.clientLanguage !== undefined) { sets.push('client_language = @client_language'); params.client_language = patch.clientLanguage; }
        if (patch.dateFormat !== undefined) { sets.push('date_format = @date_format'); params.date_format = patch.dateFormat; }
        if (patch.slideshowInterval !== undefined) { sets.push('slideshow_interval = @slideshow_interval'); params.slideshow_interval = patch.slideshowInterval; }
        if (patch.slideshowTransition !== undefined) { sets.push('slideshow_transition = @slideshow_transition'); params.slideshow_transition = patch.slideshowTransition; }
        if (sets.length > 0) {
            db.prepare(`UPDATE settings SET ${sets.join(', ')} WHERE id = 1`).run(params);
        }
        if (patch.socials && typeof patch.socials === 'object') {
            const upsert = db.prepare(`INSERT INTO settings_socials (key, value) VALUES (?, ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
            for (const [k, v] of Object.entries(patch.socials)) {
                if (typeof v === 'string') upsert.run(k, v.trim().substring(0, 500));
            }
        }
    })();
}

// Resolves the effective client-facing language for a gallery: its own
// override, else its (at most one, by construction) containing collection's
// override, else the global default from settings. Returns 'auto' if nothing
// overrides it. The single indexed lookup here (collection_galleries.gallery_id
// is UNIQUE) replaces the old per-request scan of every collection.
function resolveGalleryClientLanguage(galleryId) {
    const gallery = db.prepare(`SELECT client_language FROM galleries WHERE id = ?`).get(galleryId);
    if (gallery && gallery.client_language) return gallery.client_language;
    const membership = db.prepare(`
        SELECT c.client_language AS client_language
        FROM collection_galleries cg JOIN collections c ON c.id = cg.collection_id
        WHERE cg.gallery_id = ?`).get(galleryId);
    if (membership && membership.client_language) return membership.client_language;
    return getSettings().clientLanguage || 'auto';
}

function resolveCollectionClientLanguage(collectionId) {
    const collection = db.prepare(`SELECT client_language FROM collections WHERE id = ?`).get(collectionId);
    if (collection && collection.client_language) return collection.client_language;
    return getSettings().clientLanguage || 'auto';
}

// --- Helper functions ---

// Find a custom logo stored in DATA_DIR (any extension). Returns null if none exists.
function findLogoFile() {
    const LOGO_EXTS = ['.svg', '.png', '.jpg', '.jpeg', '.gif', '.webp'];
    for (const ext of LOGO_EXTS) {
        const p = path.join(DATA_DIR, `logo${ext}`);
        if (fs.existsSync(p)) return p;
    }
    return null;
}

// Safely resolve a path and verify it stays within an allowed base directory.
// Returns the resolved path, or throws if it would escape the base.
function safeResolvePath(base, ...segments) {
    const resolved = path.resolve(base, ...segments);
    if (!resolved.startsWith(path.resolve(base) + path.sep) && resolved !== path.resolve(base)) {
        throw new Error('Path traversal attempt detected');
    }
    return resolved;
}



// Upserts a photo's width/height/animated-flag onto its `files` row. A no-op
// if the gallery doesn't exist yet (mirrors the old Map-based guard exactly —
// this can legitimately be called before a gallery's row exists in rare
// timing windows, and must stay silent rather than throw a FK error).
function setPhotoDimensions(galleryId, filename, w, h, animated) {
    if (!w || !h) return;
    if (!db.prepare(`SELECT 1 FROM galleries WHERE id = ?`).get(galleryId)) return;
    db.prepare(`
        INSERT INTO files (gallery_id, filename, width, height, animated)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(gallery_id, filename) DO UPDATE SET width = excluded.width, height = excluded.height, animated = excluded.animated
    `).run(galleryId, filename, w, h, animated ? 1 : 0);
}

// Same as setPhotoDimensions but for a video's width/height/duration — kept
// as a separate function (not a shared one with an `animated`/`duration`
// union parameter) because the schema forbids setting both on the same row,
// and a single call site should never have to remember which one applies.
function setVideoDimensions(galleryId, filename, w, h, duration) {
    if (!db.prepare(`SELECT 1 FROM galleries WHERE id = ?`).get(galleryId)) return;
    db.prepare(`
        INSERT INTO files (gallery_id, filename, width, height, duration)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(gallery_id, filename) DO UPDATE SET width = excluded.width, height = excluded.height, duration = excluded.duration
    `).run(galleryId, filename, w ?? null, h ?? null, duration ?? null);
}

// Read dimensions from sharp metadata (handles EXIF orientation).
async function readDimensions(srcPath) {
    try {
        const meta = await sharp(srcPath).metadata();
        const orientation = meta.orientation || 1;
        // Animated images (GIF / animated WebP) are a vertical filmstrip: meta.height
        // is pageHeight × pages, so use pageHeight for the true single-frame height.
        const animated = (meta.pages || 1) > 1;
        const frameHeight = animated ? (meta.pageHeight || meta.height) : meta.height;
        // Orientations 5-8 swap width and height
        const swap = orientation >= 5 && orientation <= 8;
        const w = swap ? frameHeight : meta.width;
        const h = swap ? meta.width : frameHeight;
        return { w, h, animated };
    } catch (_) {
        return null;
    }
}

// { w, h, duration } for a video, or null on any failure (missing binary, bad file, timeout)
function probeVideo(srcPath) {
    return new Promise((resolve) => {
        execFile('ffprobe', [
            '-v', 'error', '-select_streams', 'v:0',
            '-show_entries', 'stream=width,height:format=duration',
            '-of', 'json', srcPath
        ], { timeout: 15000 }, (err, stdout) => {
            if (err) return resolve(null);
            try {
                const data = JSON.parse(stdout);
                const stream = data.streams && data.streams[0];
                const duration = data.format && data.format.duration ? Math.round(parseFloat(data.format.duration)) : null;
                if (!stream) return resolve(null);
                resolve({ w: stream.width, h: stream.height, duration });
            } catch (_) { resolve(null); }
        });
    });
}

// Duration in seconds for an audio file, or null on any failure. Same graceful-degradation
// contract as probeVideo: ffprobe is present in the Docker image but never assumed.
function probeAudioDuration(srcPath) {
    return new Promise((resolve) => {
        execFile('ffprobe', [
            '-v', 'error', '-show_entries', 'format=duration',
            '-of', 'json', srcPath
        ], { timeout: 15000 }, (err, stdout) => {
            if (err) return resolve(null);
            try {
                const data = JSON.parse(stdout);
                const d = data.format && data.format.duration;
                resolve(d ? Math.round(parseFloat(d)) : null);
            } catch (_) { resolve(null); }
        });
    });
}

// Extract one frame as JPEG (1s in, falling back to 0s for short clips). Returns true on success.
function extractVideoFrame(srcPath, destPath, atSeconds = 1) {
    return new Promise((resolve) => {
        execFile('ffmpeg', ['-y', '-ss', String(atSeconds), '-i', srcPath, '-frames:v', '1', '-q:v', '2', destPath],
            { timeout: 30000 }, (err) => {
                if (!err && fs.existsSync(destPath)) return resolve(true);
                if (atSeconds === 0) return resolve(false);
                execFile('ffmpeg', ['-y', '-i', srcPath, '-frames:v', '1', '-q:v', '2', destPath], { timeout: 30000 },
                    (err2) => resolve(!err2 && fs.existsSync(destPath)));
            });
    });
}

// Remux MP4/MOV/M4V so the moov atom is at the front of the file ("fast
// start"). Many cameras/phones write it at the end, which makes <video>
// stall on first play (stuck/gray frame) until a seek forces a range
// request that happens to land on the moov atom. -c copy is a container
// rewrite only — no re-encoding. No-op for webm (no faststart equivalent)
// and on any failure; the original file is left untouched either way.
function remuxVideoFastStart(filePath) {
    return new Promise((resolve) => {
        const ext = path.extname(filePath).toLowerCase().slice(1);
        if (!['mp4', 'mov', 'm4v'].includes(ext)) return resolve(false);
        const tmpPath = filePath + '.faststart.tmp' + path.extname(filePath);
        execFile('ffmpeg', ['-y', '-i', filePath, '-c', 'copy', '-movflags', '+faststart', tmpPath],
            { timeout: 120000 }, (err) => {
                if (err || !fs.existsSync(tmpPath)) {
                    try { fs.unlinkSync(tmpPath); } catch (_) {}
                    return resolve(false);
                }
                try {
                    fs.renameSync(tmpPath, filePath);
                    resolve(true);
                } catch (_) {
                    try { fs.unlinkSync(tmpPath); } catch (_) {}
                    resolve(false);
                }
            });
    });
}

// Extract a poster frame from a video and run it through the same sharp
// pipeline as photo thumbnails/previews. Also captures { w, h, duration }
// onto the file's row.
async function generateVideoPoster(galleryId, filename) {
    const src = safeResolvePath(safeResolvePath(path.join(DATA_DIR, 'uploads'), galleryId), filename);
    const thumbDest = safeResolvePath(safeResolvePath(THUMBNAILS_DIR, galleryId), filename + '.jpg');
    const previewDest = safeResolvePath(safeResolvePath(PREVIEWS_DIR, galleryId), filename + '.jpg');
    if (fs.existsSync(thumbDest) && fs.existsSync(previewDest)) return;

    const tmpDir = path.join(DATA_DIR, 'tmp');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    const posterTmp = safeResolvePath(tmpDir, `${galleryId}-${filename}.poster.jpg`);

    try {
        const existing = db.prepare(`SELECT duration FROM files WHERE gallery_id = ? AND filename = ?`).get(galleryId, filename);
        if (!existing || existing.duration == null) {
            const meta = await probeVideo(src);
            if (meta) setVideoDimensions(galleryId, filename, meta.w, meta.h, meta.duration);
        }

        if (!await extractVideoFrame(src, posterTmp, 1)) {
            console.warn(`[VIDEO] Poster frame extraction failed for ${galleryId}/${filename}`);
            return;
        }

        const thumbDir = safeResolvePath(THUMBNAILS_DIR, galleryId);
        const previewDir = safeResolvePath(PREVIEWS_DIR, galleryId);
        if (!fs.existsSync(thumbDir)) fs.mkdirSync(thumbDir, { recursive: true });
        if (!fs.existsSync(previewDir)) fs.mkdirSync(previewDir, { recursive: true });

        if (!fs.existsSync(thumbDest)) {
            await sharp(posterTmp).resize(400).withMetadata().jpeg({ quality: 80 }).toFile(thumbDest);
        }
        if (!fs.existsSync(previewDest)) {
            await sharp(posterTmp).resize(1920, null, { withoutEnlargement: true }).withMetadata().jpeg({ quality: 85 }).toFile(previewDest);
        }
    } catch (e) {
        console.warn(`[VIDEO] Poster generation failed for ${galleryId}/${filename}: ${e.message}`);
    } finally {
        try { fs.unlinkSync(posterTmp); } catch (_) {}
    }
}

// Post-upload processing for a single video: fast-start remux (before
// probing/poster extraction, so duration/poster are read from the final file)
// then poster generation.
async function processUploadedVideo(galleryId, filename) {
    const src = safeResolvePath(safeResolvePath(path.join(DATA_DIR, 'uploads'), galleryId), filename);
    await remuxVideoFastStart(src);
    await generateVideoPoster(galleryId, filename);
}

// One-time, fire-and-forget fast-start remux for videos uploaded before this
// check existed. Marker file (in tmp/) avoids re-running ffmpeg on every
// request once a video has been checked, whether or not the remux applied.
function ensureVideoFastStart(galleryId, filename, filePath) {
    const ext = path.extname(filename).toLowerCase().slice(1);
    if (!['mp4', 'mov', 'm4v'].includes(ext)) return;
    const tmpDir = path.join(DATA_DIR, 'tmp');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    const marker = safeResolvePath(tmpDir, `${galleryId}-${filename}.faststart-checked`);
    if (fs.existsSync(marker)) return;
    try { fs.writeFileSync(marker, ''); } catch (_) { return; }
    remuxVideoFastStart(filePath).catch(() => {});
}

// Generate a 400px-wide JPEG thumbnail for a single photo
async function generateThumbnail(galleryId, filename) {
    const src  = safeResolvePath(safeResolvePath(path.join(DATA_DIR, 'uploads'), galleryId), filename);
    const dir  = safeResolvePath(THUMBNAILS_DIR, galleryId);
    const dest = safeResolvePath(dir, filename + '.jpg');

    // Opportunistically capture dimensions (cheap: sharp opens the file anyway)
    const existingDims = db.prepare(`SELECT 1 FROM files WHERE gallery_id = ? AND filename = ?`).get(galleryId, filename);
    if (!existingDims) {
        const dims = await readDimensions(src);
        if (dims) setPhotoDimensions(galleryId, filename, dims.w, dims.h, dims.animated);
    }

    if (fs.existsSync(dest)) return;
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    try {
        await sharp(src).resize(400).withMetadata().jpeg({ quality: 80 }).toFile(dest);
    } catch (e) {
        console.warn(`[PREVIEW] Thumbnail failed for ${galleryId}/${filename}: ${e.message}`);
    }
}

// Generate thumbnails for an array of filenames (fire-and-forget safe)
async function generateGalleryThumbnails(galleryId, files) {
    await Promise.all(files.map(f => generateThumbnail(galleryId, f)));
}

// Generate a 1920px-wide JPEG preview for lightbox display
async function generatePreview(galleryId, filename) {
    const src  = safeResolvePath(safeResolvePath(path.join(DATA_DIR, 'uploads'), galleryId), filename);
    const dir  = safeResolvePath(PREVIEWS_DIR, galleryId);
    const dest = safeResolvePath(dir, filename + '.jpg');

    // Opportunistically capture dimensions
    let fileRow = db.prepare(`SELECT animated FROM files WHERE gallery_id = ? AND filename = ?`).get(galleryId, filename);
    if (!fileRow) {
        const dims = await readDimensions(src);
        if (dims) {
            setPhotoDimensions(galleryId, filename, dims.w, dims.h, dims.animated);
            fileRow = { animated: dims.animated ? 1 : 0 };
        }
    }

    // Animated images (GIF / animated WebP) are served as the original in the
    // lightbox so they play — a flattened JPEG preview would freeze them.
    if (fileRow && fileRow.animated) return;

    if (fs.existsSync(dest)) return;
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    try {
        await sharp(src).resize(1920, null, { withoutEnlargement: true }).withMetadata().jpeg({ quality: 85 }).toFile(dest);
    } catch (e) {
        console.warn(`[PREVIEW] Preview failed for ${galleryId}/${filename}: ${e.message}`);
    }
}

// Generate 1920px previews for an array of filenames (fire-and-forget safe)
async function generateGalleryPreviews(galleryId, files) {
    await Promise.all(files.map(f => generatePreview(galleryId, f)));
}

// Configure multer for photo uploads
// busboy hands multipart filenames back latin1-decoded, so a UTF-8 name arrives
// mojibaked ("Préparatifs" -> "PrÃ©paratifs") and would be written to disk that way,
// where it sticks forever. Re-decode only when the bytes really are UTF-8: a
// genuinely latin1 name yields invalid UTF-8 (U+FFFD) and is left untouched.
function decodeUploadFilename(name) {
    // Skip names with no high-latin1 characters — nothing to re-decode there.
    if (typeof name !== 'string' || !/[À-ÿ]/.test(name)) return name;
    const redecoded = Buffer.from(name, 'latin1').toString('utf8');
    return redecoded.includes('�') ? name : redecoded;
}

// Flattens a name into a single safe ZIP entry segment. Path separators are the
// point: archiver treats `/` in an entry name as a folder boundary, so a gallery
// called "Avant / Après" or a montage saved as "mix/final.mp3" would silently
// create nested entries instead of one file. Accents, spaces and & are kept —
// same permissive rule as the on-disk names.
function zipSafeName(name, fallback) {
    const cleaned = String(name || '')
        .replace(/[\\/]+/g, '-')
        .replace(/[<>:"|?*\x00-\x1f]/g, '')
        .replace(/^\.+/, '')          // no leading dots: ".." or hidden entries
        .trim();
    return cleaned || fallback;
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const galleryId = req.galleryId || req.params.galleryId;
        const uploadPath = safeResolvePath(path.join(DATA_DIR, 'uploads'), galleryId);
        if (!fs.existsSync(uploadPath)) {
            fs.mkdirSync(uploadPath, { recursive: true });
        }
        cb(null, uploadPath);
    },
    filename: (req, file, cb) => {
        // Allow accented characters, spaces, &, etc. — only strip truly unsafe filesystem chars
        const safeName = decodeUploadFilename(file.originalname)
            .normalize('NFC')
            .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')  // forbidden on Windows & Unix
            .replace(/^\.+/, '_')                       // no hidden files
            .trim() || 'photo';
        cb(null, safeName);
    }
});

const upload = multer({
    storage,
    limits: { fileSize: Math.max(MAX_PHOTO_BYTES, MAX_VIDEO_BYTES) },
    fileFilter: (req, file, cb) => {
        const allowedTypes = /jpeg|jpg|png|gif|webp|tiff|bmp|raw|cr2|nef|arw/i;
        const ext = path.extname(file.originalname).toLowerCase().slice(1);
        const mime = file.mimetype;
        if (allowedTypes.test(ext) || mime.startsWith('image/')) return cb(null, true);
        if (VIDEO_EXTENSIONS.has(ext) || VIDEO_MIME_RE.test(mime)) return cb(null, true);
        cb(new Error('Only image or video files are allowed'), false);
    }
});

// After multer writes files to disk, enforce per-type size limits (photos vs
// videos have different caps, but multer's limits.fileSize is a single value).
// Deletes oversized files and returns the rejected list.
function enforcePerTypeFileSizeLimits(files) {
    const rejected = [];
    for (const f of files) {
        const limit = isVideoFile(f.filename) ? MAX_VIDEO_BYTES : MAX_PHOTO_BYTES;
        if (f.size > limit) {
            try { fs.unlinkSync(f.path); } catch (_) {}
            rejected.push({ filename: f.filename, limit });
        }
    }
    return rejected;
}

// Background images are stored in memory so sharp can normalise them to JPEG
const uploadBackground = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_BACKGROUND_BYTES },
    fileFilter: (req, file, cb) => {
        const allowedTypes = /jpeg|jpg|png|gif|webp/i;
        const ext = path.extname(file.originalname).toLowerCase().slice(1);
        if (allowedTypes.test(ext)) {
            cb(null, true);
        } else {
            cb(new Error('Only JPEG, PNG, GIF, or WebP files are allowed for backgrounds'), false);
        }
    }
});

// A collection's audio montage is written straight to disk under data/audio as
// collection-{id}.{ext} — unlike backgrounds it is stored verbatim (no transcoding),
// and it is far too large to hold in memory. The extension is taken from the upload
// so the served Content-Type can be derived from it.
const uploadAudio = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => {
            if (!fs.existsSync(AUDIO_DIR)) fs.mkdirSync(AUDIO_DIR, { recursive: true });
            cb(null, AUDIO_DIR);
        },
        filename: (req, file, cb) => {
            cb(null, `${audioKey(req)}.${resolveAudioExtension(file)}`);
        }
    }),
    limits: { fileSize: MAX_AUDIO_BYTES },
    fileFilter: (req, file, cb) => {
        if (isAudioFile(file.originalname) || /^audio\//i.test(file.mimetype)) return cb(null, true);
        cb(new Error('Only audio files are allowed'), false);
    }
});

// A montage belongs either to a collection or to a single gallery, and both are
// stored side by side in AUDIO_DIR under a distinguishing prefix:
//   collection-{collectionId}.{ext}   gallery-{galleryId}.{ext}
// audioKey() derives that basename from whichever route param is present, so the
// one multer instance and the helpers below serve both owners.
// The returned value becomes part of a filename, so the id is re-validated here
// instead of trusting that validateGalleryId/validateCollectionId ran first. They do
// (both sit before uploadAudio in every audio route's middleware chain), but that is
// an ordering invariant a future edit could silently break, and this is the one place
// a route parameter reaches the filesystem by name rather than through
// safeResolvePath. An impossible state, so it throws rather than guessing.
function audioKey(req) {
    const isCollection = !!req.params.collectionId;
    const id = isCollection ? req.params.collectionId : req.params.galleryId;
    if (!UUID_V4_REGEX.test(id)) throw new Error('Invalid owner id for an audio key');
    return isCollection ? `collection-${id}` : `gallery-${id}`;
}

// Finds a stored montage regardless of its extension. `key` is an audioKey value.
function findAudioFile(key) {
    if (!fs.existsSync(AUDIO_DIR)) return null;
    return fs.readdirSync(AUDIO_DIR).find(f => f.startsWith(`${key}.`)) || null;
}

// Removes every stored montage for an owner (all extensions), used before a
// replace and when the owner is deleted.
function deleteAudioFiles(key) {
    if (!fs.existsSync(AUDIO_DIR)) return;
    for (const f of fs.readdirSync(AUDIO_DIR)) {
        if (f.startsWith(`${key}.`)) {
            try { fs.unlinkSync(safeResolvePath(AUDIO_DIR, f)); } catch (_) {}
        }
    }
}

// Rate limiter for the login endpoint — 10 attempts per 15 minutes per IP
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many login attempts, please try again in 15 minutes' }
});

// Rate limiter for public image-generation endpoints — 600 requests per minute per IP
// Prevents abuse of CPU-intensive sharp processing on unauthenticated routes
const imageLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 600,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many image requests, please slow down' }
});

// Rate limiter for admin routes that perform filesystem operations — 300 per minute per IP.
// These routes are already behind requireAuth (+ optional IP allowlist), so the abuse
// surface is low; the cap only exists to bound runaway filesystem work. It also covers the
// list routes (/api/galleries, /api/collections) that the dashboard re-fetches after every
// action, so it must be high enough for legitimate bulk work (e.g. resetting favorites/views/
// comments across many galleries in a row) not to trip its limit. Note that background/cover
// images are NOT under this limiter — they use publicReadLimiter (see below).
const adminLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 300,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many admin requests, please slow down' }
});

// Rate limiter for general public GET endpoints — 300 requests per minute per IP.
// Also covers background/cover image serving (`/api/gallery/:id/background`,
// `/api/collection/:id/background`), which the admin dashboard requests once per card.
// Messages are deliberately distinct per limiter: they used to be identical, which made
// it impossible to tell which limiter had tripped when debugging a report.
const publicReadLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 300,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many read requests, please slow down' }
});

// Rate limiter for public write endpoints (favorites toggle) — 120 per minute per IP
const publicWriteLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many write requests, please slow down' }
});

// Rate limiter for ZIP downloads — 10 per minute per IP (CPU + bandwidth intensive)
const downloadLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many download requests, please slow down' }
});

// Rate limiter for gallery password-unlock attempts — 10 per 15 minutes per IP,
// mirroring authLimiter: a human-chosen gallery password is guessable, same as
// the admin password, so this route needs its own throttle independent of
// publicReadLimiter/publicWriteLimiter.
const galleryUnlockLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many unlock attempts, please try again later' }
});

// ── SETTINGS ────────────────────────────────────────────────────────────────

// GET /api/settings — public (used by customer/collection/preview for theme + socials)
app.get('/api/settings', publicReadLimiter, (req, res) => {
    res.json(getSettings());
});

// POST /api/settings — admin only
app.post('/api/settings', adminLimiter, requireAuth, (req, res) => {
    const { theme, website, socials, adminLanguage, clientLanguage, dateFormat,
            slideshowInterval, slideshowTransition } = req.body;
    const patch = {};
    if (theme === 'light' || theme === 'dark') patch.theme = theme;
    if (typeof website === 'string') patch.website = website.trim().substring(0, 500);
    if (socials && typeof socials === 'object') {
        patch.socials = {};
        for (const [k, v] of Object.entries(socials)) {
            if (typeof v === 'string') patch.socials[k] = v.trim().substring(0, 500);
        }
    }
    if (SUPPORTED_LANGUAGES.includes(adminLanguage)) patch.adminLanguage = adminLanguage;
    if (clientLanguage === 'auto' || SUPPORTED_LANGUAGES.includes(clientLanguage)) patch.clientLanguage = clientLanguage;
    if (DATE_FORMATS.includes(dateFormat)) patch.dateFormat = dateFormat;
    // The interval MUST be coerced to a number: a <select> sends "5", and SQLite's
    // `'5' IN (3,5,8,12)` is false (no type coercion against integer literals), so a
    // bare string would trip the CHECK constraint and throw.
    const interval = Number(slideshowInterval);
    if (SLIDESHOW_INTERVALS.includes(interval)) patch.slideshowInterval = interval;
    if (SLIDESHOW_TRANSITIONS.includes(slideshowTransition)) patch.slideshowTransition = slideshowTransition;
    updateSettings(patch);
    res.json(getSettings());
});

// PATCH /api/settings/theme — alias used by admin theme toggle
app.patch('/api/settings/theme', adminLimiter, requireAuth, (req, res) => {
    const { theme } = req.body;
    if (theme === 'light' || theme === 'dark') {
        updateSettings({ theme });
        console.log(`[SETTINGS] Theme changed to ${theme}`);
    }
    res.json(getSettings());
});

// Logo uploads accept raster images and SVG; stored in memory then written to DATA_DIR
const uploadLogo = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB cap — logos should be small
    fileFilter: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        const allowed = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg'];
        if (allowed.includes(ext)) {
            cb(null, true);
        } else {
            cb(new Error('Only JPEG, PNG, GIF, WebP, or SVG files are allowed for the logo'), false);
        }
    }
});

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

function validateGalleryId(req, res, next) {
    if (!UUID_V4_REGEX.test(req.params.galleryId)) {
        return res.status(400).json({ error: 'Invalid gallery ID' });
    }
    next();
}

// Filename validation — prevents path traversal on per-photo endpoints
// Allow any char except the filesystem-dangerous ones and path separators
const SAFE_FILENAME_RE = /^[^<>:"/\\|?*\x00-\x1f][^<>:"/\\|?*\x00-\x1f]*$/;

function validateFilename(req, res, next) {
    if (!SAFE_FILENAME_RE.test(req.params.filename)) {
        return res.status(400).json({ error: 'Invalid filename' });
    }
    next();
}

// ── Per-gallery password protection + link expiration ──────────────────────
// Both are opt-in, nullable columns (galleries.password_hash / expires_at) —
// a gallery with neither set behaves exactly as before this feature existed.
// See CLAUDE.md's "Per-gallery password and expiration" section.

// scryptSync (Node's built-in crypto, no new dependency) rather than a bare
// hash: this gates something worth a little memory-hardness against offline
// brute-force if the .sqlite file ever leaked, and the cost is paid only on
// an explicit password submission — never on a thumbnail/image request.
function hashGalleryPassword(password) {
    const salt = crypto.randomBytes(16);
    const derived = crypto.scryptSync(password, salt, 64);
    return `${salt.toString('hex')}:${derived.toString('hex')}`;
}

function verifyGalleryPassword(password, stored) {
    const [saltHex, hashHex] = (stored || '').split(':');
    if (!saltHex || !hashHex) return false;
    const expected = Buffer.from(hashHex, 'hex');
    const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

// Stateless unlock token: an HMAC over the gallery id and a short fingerprint
// of the CURRENT password_hash, signed with a secret generated once per
// process start (same lifetime as the `sessions` Map above — a restart costs
// every visitor one re-prompt, same as it already costs the admin). Because
// the MAC covers the password's own fingerprint, changing or clearing a
// gallery's password silently invalidates every cookie issued for the old
// one — nothing to revoke explicitly.
const GALLERY_UNLOCK_SECRET = crypto.randomBytes(32);

function galleryPasswordFingerprint(passwordHash) {
    return crypto.createHash('sha256').update(passwordHash).digest('hex').slice(0, 16);
}

function signGalleryUnlockToken(galleryId, passwordHash) {
    const fp = galleryPasswordFingerprint(passwordHash);
    const mac = crypto.createHmac('sha256', GALLERY_UNLOCK_SECRET).update(`${galleryId}.${fp}`).digest('base64url');
    return `${fp}.${mac}`;
}

function verifyGalleryUnlockToken(token, galleryId, passwordHash) {
    if (!token) return false;
    const parts = token.split('.');
    if (parts.length !== 2) return false;
    const [fp, mac] = parts;
    if (fp !== galleryPasswordFingerprint(passwordHash)) return false;
    const expected = crypto.createHmac('sha256', GALLERY_UNLOCK_SECRET).update(`${galleryId}.${fp}`).digest('base64url');
    const a = Buffer.from(mac);
    const b = Buffer.from(expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// 410 if expires_at is set and in the past. A missing/deleted gallery falls
// through untouched so the route's own existence check still produces its
// usual 404 — this middleware only ever narrows, never widens, what a request
// can reach.
function checkGalleryExpiration(req, res, next) {
    const row = db.prepare(`SELECT expires_at FROM galleries WHERE id = ? AND deleted = 0`).get(req.params.galleryId);
    if (row && row.expires_at && row.expires_at < new Date().toISOString()) {
        return res.status(410).json({ error: 'gallery_expired' });
    }
    next();
}

// 401 unless a valid delyvr_unlock_<galleryId> cookie is presented. A gallery
// with no password_hash is a pure no-op — this is the opt-in guarantee that
// keeps every existing gallery's public routes behaving exactly as before.
function requireGalleryUnlock(req, res, next) {
    const row = db.prepare(`SELECT password_hash FROM galleries WHERE id = ? AND deleted = 0`).get(req.params.galleryId);
    if (!row || !row.password_hash) return next();
    const cookies = parseCookies(req.headers.cookie);
    const token = cookies[`delyvr_unlock_${req.params.galleryId}`];
    if (verifyGalleryUnlockToken(token, req.params.galleryId, row.password_hash)) return next();
    res.status(401).json({ error: 'password_required' });
}

// ── IP allowlist (ADMIN_ALLOWED_IPS) ────────────────────────────────────────

// Expand IPv6 :: shorthand to full 8-group form
function expandIPv6(ip) {
    if (!ip.includes('::')) return ip;
    const [left, right] = ip.split('::');
    const l = left ? left.split(':') : [];
    const r = right ? right.split(':') : [];
    const fill = Array(8 - l.length - r.length).fill('0');
    return [...l, ...fill, ...r].join(':');
}

// Convert an IPv4 or IPv6 address string to a BigInt
function ipToBigInt(ip) {
    if (net.isIPv4(ip)) {
        return ip.split('.').reduce((acc, o) => (acc << 8n) | BigInt(+o), 0n);
    }
    if (net.isIPv6(ip)) {
        return expandIPv6(ip)
            .split(':')
            .reduce((acc, g) => (acc << 16n) | BigInt(parseInt(g || '0', 16)), 0n);
    }
    return null;
}

// Returns true if ip falls within the given CIDR range or matches the exact IP
function ipMatchesCIDR(ip, entry) {
    const slashIdx = entry.indexOf('/');
    const cidrIp = slashIdx === -1 ? entry : entry.slice(0, slashIdx);
    const prefix  = slashIdx === -1 ? null  : parseInt(entry.slice(slashIdx + 1), 10);

    const ipBig   = ipToBigInt(ip);
    const cidrBig = ipToBigInt(cidrIp);
    if (ipBig === null || cidrBig === null) return false;
    if (prefix === null) return ipBig === cidrBig;

    const bits = net.isIPv4(ip) ? 32n : 128n;
    const mask = ((1n << bits) - 1n) ^ ((1n << (bits - BigInt(prefix))) - 1n);
    return (ipBig & mask) === (cidrBig & mask);
}

// Normalise the request IP: strip ::ffff: prefix for IPv4-mapped IPv6 addresses
function resolveClientIp(req) {
    const raw = req.ip || '';
    return raw.startsWith('::ffff:') ? raw.slice(7) : raw;
}

// Middleware: reject requests from IPs not in ADMIN_ALLOWED_IPS (when set)
function requireAllowedIP(req, res, next) {
    if (ADMIN_ALLOWED_IPS.length === 0) return next();
    const ip = resolveClientIp(req);
    if (ADMIN_ALLOWED_IPS.some(entry => ipMatchesCIDR(ip, entry))) return next();
    console.log(`[AUTH] IP blocked: ${ip}`);
    res.status(403).json({ error: 'Forbidden' });
}

// ── Authentication ───────────────────────────────────────────────────────────

// Simple password authentication middleware — header only, never query param
function requireAuth(req, res, next) {
    // 1. IP allowlist — checked before credentials so blocked IPs never reach auth logic
    if (ADMIN_ALLOWED_IPS.length > 0) {
        const ip = resolveClientIp(req);
        if (!ADMIN_ALLOWED_IPS.some(entry => ipMatchesCIDR(ip, entry))) {
            console.log(`[AUTH] IP blocked: ${ip}`);
            return res.status(403).json({ error: 'Forbidden' });
        }
    }
    // 2. Session cookie (browser-based admin)
    const cookies = parseCookies(req.headers.cookie);
    const token = cookies['delyvr_session'];
    if (token) {
        const session = sessions.get(token);
        if (session && Date.now() - session.createdAt < SESSION_TTL_MS) {
            return next();
        }
        // Expired token — clear it
        sessions.delete(token);
    }
    // 3. X-Admin-Password header (backward compat for direct API / CLI use)
    const password = req.headers['x-admin-password'];
    if (password === ADMIN_PASSWORD) return next();

    console.log(`[AUTH] Failed auth attempt from ${resolveClientIp(req)}`);
    res.status(401).json({ error: 'Unauthorized' });
}

// --- Routes ---

// Verify password endpoint
app.post('/api/auth/verify', authLimiter, requireAllowedIP, (req, res) => {
    const raw = req.body.password;
    const password = Array.isArray(raw) ? raw[0] : raw;
    if (typeof password === 'string' && password === ADMIN_PASSWORD) {
        const token = uuidv4();
        sessions.set(token, { createdAt: Date.now() });
        const isHttps = req.secure || req.headers['x-forwarded-proto'] === 'https';
        const cookieOpts = [
            `delyvr_session=${token}`,
            'HttpOnly',
            'SameSite=Strict',
            'Path=/',
            `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
            ...(isHttps ? ['Secure'] : [])
        ].join('; ');
        console.log(`[AUTH] Login successful from ${resolveClientIp(req)}`);
        res.setHeader('Set-Cookie', cookieOpts);
        res.json({ success: true });
    } else {
        console.log(`[AUTH] Failed auth attempt from ${resolveClientIp(req)}`);
        res.status(401).json({ error: 'Invalid password' });
    }
});

// Check if the current session cookie is still valid
app.get('/api/auth/session', publicReadLimiter, (req, res) => {
    const cookies = parseCookies(req.headers.cookie);
    const token = cookies['delyvr_session'];
    if (token) {
        const session = sessions.get(token);
        if (session && Date.now() - session.createdAt < SESSION_TTL_MS) {
            return res.json({ valid: true });
        }
        sessions.delete(token);
    }
    res.status(401).json({ valid: false });
});

// Logout — clear session token and cookie
app.post('/api/auth/logout', publicWriteLimiter, (req, res) => {
    const cookies = parseCookies(req.headers.cookie);
    const token = cookies['delyvr_session'];
    if (token) sessions.delete(token);
    res.setHeader('Set-Cookie', 'delyvr_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
    res.json({ success: true });
});

// Admin interface - photographer uploads photos here
app.get('/', publicReadLimiter, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Serve the logo — custom file in DATA_DIR takes precedence over the bundled logo.svg
const LOGO_CONTENT_TYPES = {
    '.svg':  'image/svg+xml',
    '.png':  'image/png',
    '.jpg':  'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif':  'image/gif',
    '.webp': 'image/webp',
};

const LOGO_EXTS = ['.svg', '.png', '.jpg', '.jpeg', '.gif', '.webp'];

app.get('/api/logo', publicReadLimiter, (_req, res) => {
    const custom = findLogoFile();
    // X-Custom-Logo lets the admin page know whether a custom logo is active
    res.setHeader('X-Custom-Logo', custom ? '1' : '0');
    if (custom) {
        const ext = path.extname(custom).toLowerCase();
        res.setHeader('Content-Type', LOGO_CONTENT_TYPES[ext] || 'application/octet-stream');
        return res.sendFile(custom);
    }
    // Fall back to the bundled logo.svg in public/
    res.sendFile(path.join(__dirname, 'public', 'logo.svg'));
});

// Replace the logo (admin only)
app.post('/api/logo', adminLimiter, requireAuth, uploadLogo.single('logo'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' });
    }

    for (const ext of LOGO_EXTS) {
        const p = path.join(DATA_DIR, `logo${ext}`);
        if (fs.existsSync(p)) fs.unlinkSync(p);
    }

    const ext = path.extname(req.file.originalname).toLowerCase();
    fs.writeFileSync(path.join(DATA_DIR, `logo${ext}`), req.file.buffer);
    console.log(`[SETTINGS] Logo updated (${req.file.originalname})`);
    res.json({ success: true });
});

// Reset logo to the bundled default (admin only)
app.delete('/api/logo', adminLimiter, requireAuth, (_req, res) => {
    for (const ext of LOGO_EXTS) {
        const p = path.join(DATA_DIR, `logo${ext}`);
        if (fs.existsSync(p)) fs.unlinkSync(p);
    }
    console.log('[SETTINGS] Logo reset to default');
    res.json({ success: true });
});

// Middleware to generate galleryId BEFORE multer processes files. Does not
// touch the database — the create route below inserts the row only once it
// knows at least one file was actually accepted, so there is no longer a
// "skeleton row that might need deleting again" dance: multer's own
// destination callback only ever needs `req.galleryId` as a plain string to
// decide where to write files, confirmed by reading it — it never queries
// the gallery's existence.
function generateGalleryId(req, res, next) {
    req.galleryId = uuidv4();
    next();
}

// Create new gallery and upload photos
app.post('/api/gallery/create', adminLimiter, requireAuth, generateGalleryId, upload.array('photos', 500), (req, res) => {
    const galleryId = req.galleryId;

    // If multer processed no files, there is nothing to create — no DB row
    // was ever inserted, so there's nothing to clean up either.
    if (!req.files || req.files.length === 0) {
        return res.status(400).json({ error: 'No photos were uploaded. Please select at least one image.' });
    }

    const rejected = enforcePerTypeFileSizeLimits(req.files);
    const rejectedNames = new Set(rejected.map(r => r.filename));
    const acceptedFiles = req.files.filter(f => !rejectedNames.has(f.filename));

    if (acceptedFiles.length === 0) {
        return res.status(413).json({ error: 'All uploaded files exceeded the size limit.', rejected });
    }

    const eventName = (String(Array.isArray(req.body.eventName) ? req.body.eventName[0] : (req.body.eventName || 'Untitled Event'))).trim().substring(0, 200);
    const filenames = acceptedFiles.map(f => f.filename);

    db.transaction(() => {
        db.prepare(`INSERT INTO galleries (id, event_name, created_at) VALUES (?, ?, ?)`).run(galleryId, eventName, new Date().toISOString());
        const insertFile = db.prepare(`INSERT OR IGNORE INTO files (gallery_id, filename) VALUES (?, ?)`);
        for (const f of filenames) insertFile.run(galleryId, f);
    })();

    const images = filenames.filter(f => !isVideoFile(f));
    const videos = filenames.filter(f => isVideoFile(f));
    generateGalleryThumbnails(galleryId, images).catch(() => {});
    generateGalleryPreviews(galleryId, images).catch(() => {});
    videos.forEach(f => processUploadedVideo(galleryId, f).catch(() => {}));
    console.log(`[GALLERY] Created "${eventName}" (${galleryId}) — ${filenames.length} photo(s)`);

    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const downloadUrl = `${baseUrl}/preview/${galleryId}`;

    res.json({
        success: true,
        galleryId,
        downloadUrl,
        fileCount: acceptedFiles.length,
        rejected
    });
});

// Add more photos to existing gallery
app.post('/api/gallery/:galleryId/upload', adminLimiter, requireAuth, validateGalleryId, upload.array('photos', 500), (req, res) => {
    const { galleryId } = req.params;
    const galleryRow = db.prepare(`SELECT event_name FROM galleries WHERE id = ?`).get(galleryId);

    if (!galleryRow) {
        return res.status(404).json({ error: 'Gallery not found' });
    }

    let rejected = [];
    if (req.files) {
        rejected = enforcePerTypeFileSizeLimits(req.files);
        const rejectedNames = new Set(rejected.map(r => r.filename));
        const newFiles = req.files.filter(f => !rejectedNames.has(f.filename)).map(f => f.filename);
        if (newFiles.length > 0) {
            const insertFile = db.prepare(`INSERT OR IGNORE INTO files (gallery_id, filename) VALUES (?, ?)`);
            db.transaction(() => { for (const f of newFiles) insertFile.run(galleryId, f); })();
        }
        const images = newFiles.filter(f => !isVideoFile(f));
        const videos = newFiles.filter(f => isVideoFile(f));
        generateGalleryThumbnails(galleryId, images).catch(() => {});
        generateGalleryPreviews(galleryId, images).catch(() => {});
        videos.forEach(f => processUploadedVideo(galleryId, f).catch(() => {}));
        console.log(`[UPLOAD] Added ${newFiles.length} photo(s) to "${galleryRow.event_name}" (${galleryId})`);
    }

    const fileCount = db.prepare(`SELECT COUNT(*) AS n FROM files WHERE gallery_id = ?`).get(galleryId).n;

    res.json({
        success: true,
        fileCount,
        rejected
    });
});

// Upload/replace background image — converts to JPEG via sharp
app.post('/api/gallery/:galleryId/background', adminLimiter, requireAuth, validateGalleryId, uploadBackground.single('background'), async (req, res) => {
    const { galleryId } = req.params;
    const galleryExists = db.prepare(`SELECT 1 FROM galleries WHERE id = ?`).get(galleryId);

    if (!galleryExists) {
        return res.status(404).json({ error: 'Gallery not found' });
    }

    if (!req.file) {
        return res.status(400).json({ error: 'No background file provided' });
    }

    try {
        const backgroundsDir = path.join(DATA_DIR, 'backgrounds');

        // Delete old background (any extension)
        if (fs.existsSync(backgroundsDir)) {
            const existing = fs.readdirSync(backgroundsDir).find(f => f.startsWith(galleryId));
            if (existing) fs.unlinkSync(safeResolvePath(backgroundsDir, existing));
        }

        // Invalidate og-cache so it is regenerated with the new image
        const ogFile = safeResolvePath(OG_CACHE_DIR, `${galleryId}.jpg`);
        if (fs.existsSync(ogFile)) fs.unlinkSync(ogFile);

        // Convert and save as JPEG. `.withMetadata()` keeps the source ICC profile
        // (Adobe RGB / Display P3) — without it the hero renders as sRGB and looks
        // warmer/oversaturated next to the gallery photos, which do keep theirs.
        const dest = safeResolvePath(backgroundsDir, `${galleryId}.jpg`);
        await sharp(req.file.buffer)
            .resize(2400, null, { withoutEnlargement: true })
            .withMetadata()
            .jpeg({ quality: 85 })
            .toFile(dest);

        const backgroundValue = `${galleryId}.jpg`;
        db.prepare(`UPDATE galleries SET background = ? WHERE id = ?`).run(backgroundValue, galleryId);
        const eventName = db.prepare(`SELECT event_name FROM galleries WHERE id = ?`).get(galleryId).event_name;
        console.log(`[GALLERY] Background updated for "${eventName}" (${galleryId})`);
        res.json({ success: true, background: backgroundValue });
    } catch (err) {
        console.error(`[GALLERY] Background processing failed for ${galleryId}: ${err.message}`);
        res.status(500).json({ error: 'Failed to process background image' });
    }
});

// Serve background image (legacy route — kept for backwards compatibility)
// Deliberately NOT gated by checkGalleryExpiration/requireGalleryUnlock: the
// cover must stay visible so the password/expired gate page itself can show
// it. See the matching note on the REST-style route below.
app.get('/api/background/:galleryId', publicReadLimiter, validateGalleryId, (req, res) => {
    const { galleryId } = req.params;
    const backgroundsDir = path.join(DATA_DIR, 'backgrounds');

    if (fs.existsSync(backgroundsDir)) {
        const backgroundFile = fs.readdirSync(backgroundsDir).find(f => f.startsWith(galleryId));
        if (backgroundFile) {
            return res.sendFile(safeResolvePath(backgroundsDir, backgroundFile));
        }
    }

    res.status(404).send('Background not found');
});

// Serve background image (REST-style route used by admin.html)
// Deliberately NOT gated by checkGalleryExpiration/requireGalleryUnlock —
// see the identical note on the legacy route above.
app.get('/api/gallery/:galleryId/background', publicReadLimiter, validateGalleryId, (req, res) => {
    const { galleryId } = req.params;
    const backgroundsDir = path.join(DATA_DIR, 'backgrounds');

    if (fs.existsSync(backgroundsDir)) {
        const backgroundFile = fs.readdirSync(backgroundsDir).find(f => f.startsWith(galleryId));
        if (backgroundFile) {
            const fullPath = safeResolvePath(backgroundsDir, backgroundFile);
            if (req.query.thumb === '1') {
                res.setHeader('Content-Type', 'image/jpeg');
                res.setHeader('Cache-Control', 'public, max-age=86400');
                return sharp(fullPath)
                    .resize(200, 200, { fit: 'cover' })
                    .withMetadata()
                    .jpeg({ quality: 75 })
                    .pipe(res);
            }
            if (req.query.card === '1') {
                res.setHeader('Content-Type', 'image/jpeg');
                res.setHeader('Cache-Control', 'public, max-age=86400');
                return sharp(fullPath)
                    .resize(800, null, { fit: 'inside', withoutEnlargement: true })
                    .withMetadata()
                    .jpeg({ quality: 82 })
                    .pipe(res);
            }
            return res.sendFile(fullPath);
        }
    }

    res.status(404).send('Background not found');
});

// ── GALLERY AUDIO MONTAGE ───────────────────────────────────────────────────
// A gallery can carry its own montage, which is what makes audio possible for a
// gallery that belongs to no collection. Same storage, uploader and helpers as
// the collection montage, only the key prefix differs. Precedence is decided
// client-side (see preview.html): inside a collection that has its own montage,
// the collection's track wins so playback stays continuous across galleries.

app.post('/api/gallery/:galleryId/audio', adminLimiter, requireAuth, validateGalleryId, uploadAudio.single('audio'), async (req, res) => {
    const { galleryId } = req.params;
    const galleryExists = db.prepare(`SELECT 1 FROM galleries WHERE id = ?`).get(galleryId);
    if (!galleryExists) {
        if (req.file) { try { fs.unlinkSync(req.file.path); } catch (_) {} }
        return res.status(404).json({ error: 'Gallery not found' });
    }
    if (!req.file) return res.status(400).json({ error: 'No audio file provided' });

    // Drop any older montage stored under a different extension.
    const kept = path.basename(req.file.path);
    for (const f of fs.readdirSync(AUDIO_DIR)) {
        if (f.startsWith(`gallery-${galleryId}.`) && f !== kept) {
            try { fs.unlinkSync(safeResolvePath(AUDIO_DIR, f)); } catch (_) {}
        }
    }

    const duration = await probeAudioDuration(req.file.path);
    const audio = {
        filename: decodeUploadFilename(req.file.originalname).normalize('NFC'),
        stored: kept,
        size: req.file.size,
        duration,
        uploadedAt: new Date().toISOString()
    };
    db.prepare(`UPDATE galleries SET audio_filename = ?, audio_stored = ?, audio_size = ?, audio_duration = ?, audio_uploaded_at = ? WHERE id = ?`)
        .run(audio.filename, audio.stored, audio.size, audio.duration, audio.uploadedAt, galleryId);
    const eventName = db.prepare(`SELECT event_name FROM galleries WHERE id = ?`).get(galleryId).event_name;
    console.log(`[GALLERY] Audio updated for "${eventName}" (${galleryId}) — ${kept}`);
    res.json({ success: true, audio });
});

app.delete('/api/gallery/:galleryId/audio', adminLimiter, requireAuth, validateGalleryId, (req, res) => {
    const { galleryId } = req.params;
    const row = db.prepare(`SELECT event_name FROM galleries WHERE id = ?`).get(galleryId);
    if (!row) return res.status(404).json({ error: 'Gallery not found' });
    deleteAudioFiles(`gallery-${galleryId}`);
    db.prepare(`UPDATE galleries SET audio_filename = NULL, audio_stored = NULL, audio_size = NULL, audio_duration = NULL, audio_uploaded_at = NULL WHERE id = ?`).run(galleryId);
    console.log(`[GALLERY] Audio removed from "${row.event_name}" (${galleryId})`);
    res.json({ success: true });
});

// imageLimiter, not publicReadLimiter — see the collection audio route.
app.get('/api/gallery/:galleryId/audio', imageLimiter, validateGalleryId, checkGalleryExpiration, requireGalleryUnlock, (req, res) => {
    const { galleryId } = req.params;
    const file = findAudioFile(`gallery-${galleryId}`);
    if (!file) return res.status(404).json({ error: 'No audio found' });
    const ext = path.extname(file).toLowerCase().slice(1);
    res.setHeader('Content-Type', AUDIO_MIME_BY_EXT[ext] || 'application/octet-stream');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.sendFile(safeResolvePath(AUDIO_DIR, file));
});

// Toggle downloads on/off for a gallery
app.patch('/api/gallery/:galleryId/downloads', adminLimiter, requireAuth, validateGalleryId, (req, res) => {
    const { galleryId } = req.params;
    const galleryExists = db.prepare(`SELECT 1 FROM galleries WHERE id = ?`).get(galleryId);

    if (!galleryExists) {
        return res.status(404).json({ error: 'Gallery not found' });
    }

    const enabled = req.body.enabled;
    if (enabled !== true && enabled !== false) {
        return res.status(400).json({ error: 'enabled must be a boolean' });
    }

    db.prepare(`UPDATE galleries SET downloads_enabled = ? WHERE id = ?`).run(enabled ? 1 : 0, galleryId);

    res.json({ success: true, downloadsEnabled: enabled });
});

// Toggle comments on/off for a gallery
app.patch('/api/gallery/:galleryId/comments-enabled', adminLimiter, requireAuth, validateGalleryId, (req, res) => {
    const { galleryId } = req.params;
    const galleryExists = db.prepare(`SELECT 1 FROM galleries WHERE id = ?`).get(galleryId);

    if (!galleryExists) {
        return res.status(404).json({ error: 'Gallery not found' });
    }

    const enabled = req.body.enabled;
    if (enabled !== true && enabled !== false) {
        return res.status(400).json({ error: 'enabled must be a boolean' });
    }

    db.prepare(`UPDATE galleries SET comments_enabled = ? WHERE id = ?`).run(enabled ? 1 : 0, galleryId);

    res.json({ success: true, commentsEnabled: enabled });
});

// Set the client-facing language override for a gallery ('auto' clears the override)
app.patch('/api/gallery/:galleryId/client-language', adminLimiter, requireAuth, validateGalleryId, (req, res) => {
    const { galleryId } = req.params;
    const galleryExists = db.prepare(`SELECT 1 FROM galleries WHERE id = ?`).get(galleryId);

    if (!galleryExists) {
        return res.status(404).json({ error: 'Gallery not found' });
    }

    const { language } = req.body;
    if (language !== 'auto' && !SUPPORTED_LANGUAGES.includes(language)) {
        return res.status(400).json({ error: 'Invalid language' });
    }

    const clientLanguage = language === 'auto' ? null : language;
    db.prepare(`UPDATE galleries SET client_language = ? WHERE id = ?`).run(clientLanguage, galleryId);

    res.json({ success: true, clientLanguage: clientLanguage || 'auto' });
});

// Set or clear a gallery's password. The hash is never echoed back — only
// whether one is now set.
app.patch('/api/gallery/:galleryId/password', adminLimiter, requireAuth, validateGalleryId, (req, res) => {
    const { galleryId } = req.params;
    const galleryExists = db.prepare(`SELECT 1 FROM galleries WHERE id = ?`).get(galleryId);
    if (!galleryExists) return res.status(404).json({ error: 'Gallery not found' });

    const { password } = req.body;
    if (password === null || password === '' || password === undefined) {
        db.prepare(`UPDATE galleries SET password_hash = NULL WHERE id = ?`).run(galleryId);
        return res.json({ hasPassword: false });
    }
    if (typeof password !== 'string') {
        return res.status(400).json({ error: 'password must be a string or null' });
    }
    db.prepare(`UPDATE galleries SET password_hash = ? WHERE id = ?`).run(hashGalleryPassword(password), galleryId);
    res.json({ hasPassword: true });
});

// Set or clear a gallery's link expiration date. The incoming 'YYYY-MM-DD' is
// normalised to the END of that day in UTC before storing — comparing a bare
// date against an ISO instant would otherwise expire the gallery at midnight
// UTC on the chosen day, making the day the photographer picked already
// inaccessible.
app.patch('/api/gallery/:galleryId/expiration', adminLimiter, requireAuth, validateGalleryId, (req, res) => {
    const { galleryId } = req.params;
    const galleryExists = db.prepare(`SELECT 1 FROM galleries WHERE id = ?`).get(galleryId);
    if (!galleryExists) return res.status(404).json({ error: 'Gallery not found' });

    const { expiresAt } = req.body;
    if (expiresAt === null || expiresAt === '' || expiresAt === undefined) {
        db.prepare(`UPDATE galleries SET expires_at = NULL WHERE id = ?`).run(galleryId);
        return res.json({ expiresAt: null });
    }
    if (typeof expiresAt !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(expiresAt)) {
        return res.status(400).json({ error: 'expiresAt must be a YYYY-MM-DD string or null' });
    }
    const normalized = `${expiresAt}T23:59:59.999Z`;
    if (Number.isNaN(Date.parse(normalized))) {
        return res.status(400).json({ error: 'expiresAt is not a valid date' });
    }
    db.prepare(`UPDATE galleries SET expires_at = ? WHERE id = ?`).run(normalized, galleryId);
    res.json({ expiresAt: normalized });
});

// Set a gallery's per-gallery lightbox appearance (preview size, grid
// spacing, photo corners). Patches only the keys present, same idiom as
// updateSettings() — route handlers validate each field before it is passed
// through.
app.patch('/api/gallery/:galleryId/appearance', adminLimiter, requireAuth, validateGalleryId, (req, res) => {
    const { galleryId } = req.params;
    const galleryExists = db.prepare(`SELECT 1 FROM galleries WHERE id = ?`).get(galleryId);
    if (!galleryExists) return res.status(404).json({ error: 'Gallery not found' });

    const SIZES = ['small', 'medium', 'large'];
    const CORNERS = ['rounded', 'square'];
    const { lightboxSize, gridSpacing, cornerStyle } = req.body;
    // Same "patch only the keys present" idiom as updateSettings() above.
    const sets = [];
    const params = { id: galleryId };
    if (SIZES.includes(lightboxSize)) { sets.push('lightbox_size = @lightbox_size'); params.lightbox_size = lightboxSize; }
    if (SIZES.includes(gridSpacing)) { sets.push('grid_spacing = @grid_spacing'); params.grid_spacing = gridSpacing; }
    if (CORNERS.includes(cornerStyle)) { sets.push('corner_style = @corner_style'); params.corner_style = cornerStyle; }
    if (sets.length > 0) {
        db.prepare(`UPDATE galleries SET ${sets.join(', ')} WHERE id = @id`).run(params);
    }

    const row = db.prepare(`SELECT lightbox_size, grid_spacing, corner_style FROM galleries WHERE id = ?`).get(galleryId);
    res.json({ lightboxSize: row.lightbox_size, gridSpacing: row.grid_spacing, cornerStyle: row.corner_style });
});

// Full admin-shape single-gallery object — needed so the gallery detail page
// (admin.html) can be deep-linked/reloaded directly without depending on the
// dashboard's in-memory _galleriesData cache having already been populated
// by a prior GET /api/galleries.
app.get('/api/gallery/:galleryId', adminLimiter, requireAuth, validateGalleryId, (req, res) => {
    const { galleryId } = req.params;
    const row = db.prepare(`
        SELECT id, event_name, created_at, downloads_enabled, comments_enabled, client_language,
               download_count, view_count, password_hash, expires_at,
               lightbox_size, grid_spacing, corner_style
        FROM galleries WHERE id = ? AND deleted = 0
    `).get(galleryId);
    if (!row) return res.status(404).json({ error: 'Gallery not found' });

    const nowIso = new Date().toISOString();
    const collectionRow = db.prepare(`SELECT collection_id FROM collection_galleries WHERE gallery_id = ?`).get(galleryId);
    const fileCount = db.prepare(`SELECT COUNT(*) AS n FROM files WHERE gallery_id = ?`).get(galleryId).n;

    let lastModified = null;
    try {
        const galleryPath = safeResolvePath(path.join(DATA_DIR, 'uploads'), galleryId);
        lastModified = fs.statSync(galleryPath).mtime.toISOString();
    } catch (_) {}

    res.json({
        id: row.id,
        eventName: row.event_name,
        created: row.created_at,
        lastModified,
        fileCount,
        collectionId: collectionRow ? collectionRow.collection_id : null,
        downloadsEnabled: !!row.downloads_enabled,
        commentsEnabled: !!row.comments_enabled,
        clientLanguage: row.client_language || 'auto',
        downloadCount: row.download_count,
        viewCount: row.view_count,
        hasPassword: !!row.password_hash,
        expiresAt: row.expires_at,
        isExpired: !!(row.expires_at && row.expires_at < nowIso),
        lightboxSize: row.lightbox_size,
        gridSpacing: row.grid_spacing,
        cornerStyle: row.corner_style
    });
});

// Verify a gallery password and, on success, set the per-gallery unlock
// cookie. Deliberately not under requireAuth — this is the public unlock
// flow a client-facing visitor goes through, gated only by its own limiter.
app.post('/api/gallery/:galleryId/unlock', galleryUnlockLimiter, validateGalleryId, checkGalleryExpiration, (req, res) => {
    const { galleryId } = req.params;
    const row = db.prepare(`SELECT password_hash FROM galleries WHERE id = ? AND deleted = 0`).get(galleryId);
    if (!row) return res.status(404).json({ error: 'Gallery not found' });
    if (!row.password_hash) return res.json({ success: true }); // no password set — nothing to unlock

    const { password } = req.body;
    if (typeof password !== 'string' || !verifyGalleryPassword(password, row.password_hash)) {
        return res.status(401).json({ error: 'invalid_password' });
    }

    const token = signGalleryUnlockToken(galleryId, row.password_hash);
    const isHttps = req.secure || req.headers['x-forwarded-proto'] === 'https';
    const cookieOpts = [
        `delyvr_unlock_${galleryId}=${token}`,
        'HttpOnly',
        'SameSite=Lax', // deliberately not Strict — see checkGalleryExpiration/requireGalleryUnlock's doc comment
        'Path=/',
        `Max-Age=${30 * 24 * 60 * 60}`,
        ...(isHttps ? ['Secure'] : [])
    ].join('; ');
    res.setHeader('Set-Cookie', cookieOpts);
    res.json({ success: true });
});

// Rename a gallery
app.post('/api/gallery/:galleryId/rename', adminLimiter, requireAuth, validateGalleryId, (req, res) => {
    const { galleryId } = req.params;
    const row = db.prepare(`SELECT event_name FROM galleries WHERE id = ?`).get(galleryId);

    if (!row) {
        return res.status(404).json({ error: 'Gallery not found' });
    }

    const oldName = row.event_name;
    const eventName = (String(Array.isArray(req.body.eventName) ? req.body.eventName[0] : (req.body.eventName || 'Untitled Event'))).trim().substring(0, 200);
    db.prepare(`UPDATE galleries SET event_name = ? WHERE id = ?`).run(eventName, galleryId);
    console.log(`[GALLERY] Renamed "${oldName}" → "${eventName}" (${galleryId})`);
    res.json({ success: true, eventName });
});

// List photos in a gallery (used by preview.html)
app.get('/api/gallery/:galleryId/photos', publicReadLimiter, validateGalleryId, checkGalleryExpiration, requireGalleryUnlock, async (req, res) => {
    const { galleryId } = req.params;
    const galleryPath = safeResolvePath(path.join(DATA_DIR, 'uploads'), galleryId);

    if (!fs.existsSync(galleryPath)) {
        return res.status(404).json({ error: 'Gallery not found' });
    }

    const files = fs.readdirSync(galleryPath)
        .filter(f => !f.startsWith('.'))
        .sort((a, b) => {
            // Sort on the name WITHOUT its extension so a photo (mariage-…-36.jpg) always
            // precedes a companion whose stem extends it (mariage-…-36-gif.gif) — matching
            // the file explorer. Comparing the full name lets the differing extension
            // (.gif vs .jpg) and separators reorder the pair unexpectedly. Extension breaks ties.
            const stem = f => f.slice(0, f.length - path.extname(f).length);
            const opts = { numeric: true, sensitivity: 'base' };
            return stem(a).localeCompare(stem(b), undefined, opts)
                || a.localeCompare(b, undefined, opts);
        });

    const galleryRow = db.prepare(`SELECT event_name, comments_enabled FROM galleries WHERE id = ?`).get(galleryId);

    // Fill in missing dimensions for legacy/newly-recovered galleries (one-time
    // cost per photo). Subsequent requests hit the files table directly.
    const existingDims = new Map(
        db.prepare(`SELECT filename, width, height, duration, animated, flag FROM files WHERE gallery_id = ?`).all(galleryId)
            .map(r => [r.filename, r])
    );
    const missing = files.filter(f => !existingDims.has(f) || existingDims.get(f).width === null);

    if (missing.length > 0 && galleryRow) {
        await Promise.all(missing.map(async filename => {
            const src = safeResolvePath(galleryPath, filename);
            // A row can already exist here (width NULL from a previously-failed probe)
            // with a flag already set on it — carry that over so backfilling dimensions
            // never drops the flag from this one response.
            const priorFlag = existingDims.has(filename) ? existingDims.get(filename).flag : null;
            if (isVideoFile(filename)) {
                const meta = await probeVideo(src);
                if (meta) {
                    setVideoDimensions(galleryId, filename, meta.w, meta.h, meta.duration);
                    existingDims.set(filename, { filename, width: meta.w, height: meta.h, duration: meta.duration, animated: null, flag: priorFlag });
                }
                generateVideoPoster(galleryId, filename).catch(() => {}); // legacy videos with no poster yet
                return;
            }
            const dims = await readDimensions(src);
            if (dims) {
                setPhotoDimensions(galleryId, filename, dims.w, dims.h, dims.animated);
                existingDims.set(filename, { filename, width: dims.w, height: dims.h, duration: null, animated: dims.animated ? 1 : 0, flag: priorFlag });
            }
        }));
    }

    const commentCounts = new Map(
        db.prepare(`SELECT filename, COUNT(*) AS n FROM comments WHERE gallery_id = ? GROUP BY filename`).all(galleryId)
            .map(r => [r.filename, r.n])
    );

    // Any-visitor favorite count — NOT tied to the admin's own identity (the
    // admin has none). Only the admin UI's "favorited" filter chip reads this;
    // preview.html already has its own per-visitor favorites via a separate
    // route and ignores this field.
    const favoriteCounts = new Map(
        db.prepare(`SELECT filename, COUNT(DISTINCT visitor_id) AS n FROM favorites WHERE gallery_id = ? GROUP BY filename`).all(galleryId)
            .map(r => [r.filename, r.n])
    );

    const photos = files.map(filename => {
        const dims = existingDims.get(filename) || null;
        const video = isVideoFile(filename);
        return {
            filename,
            type: video ? 'video' : 'image',
            url:         `/api/gallery/${galleryId}/photo/${encodeURIComponent(filename)}`,
            previewUrl:  `/api/gallery/${galleryId}/photo/${encodeURIComponent(filename)}?preview=1`,
            thumbnailUrl:`/api/gallery/${galleryId}/photo/${encodeURIComponent(filename)}?thumb=1`,
            downloadUrl: `/api/gallery/${galleryId}/download/${encodeURIComponent(filename)}`,
            width:  dims ? dims.width : null,
            height: dims ? dims.height : null,
            duration: video ? (dims && dims.duration != null ? dims.duration : null) : undefined,
            animated: !video && !!(dims && dims.animated),
            commentCount: commentCounts.get(filename) || 0,
            favoriteCount: favoriteCounts.get(filename) || 0,
            // Photographer-side proofing mark (red/orange/green/white or null). Technically
            // public — this route has no requireAuth, same as commentCount above — but holds
            // no personal data; preview.html never reads or renders it. See CLAUDE.md.
            flag: dims ? (dims.flag || null) : null
        };
    });

    // Return shape matches what preview.html expects: { id, eventName, photos: [...] }
    res.json({
        id: galleryId,
        eventName: galleryRow ? galleryRow.event_name : 'Untitled Event',
        commentsEnabled: galleryRow ? (!!galleryRow.comments_enabled && !isGalleryBlockedByCollectionForComments(galleryId)) : true,
        photos
    });
});

// Serve a single photo (original or thumbnail)
app.get('/api/gallery/:galleryId/photo/:filename', imageLimiter, validateGalleryId, checkGalleryExpiration, requireGalleryUnlock, validateFilename, async (req, res) => {
    const { galleryId, filename } = req.params;
    const isVideo = isVideoFile(filename);

    if (req.query.thumb === '1') {
        const thumbPath = safeResolvePath(safeResolvePath(THUMBNAILS_DIR, galleryId), filename + '.jpg');

        if (!fs.existsSync(thumbPath)) {
            // Generate on-the-fly if missing
            if (isVideo) await generateVideoPoster(galleryId, filename);
            else await generateThumbnail(galleryId, filename);
        }

        if (fs.existsSync(thumbPath)) {
            return res.sendFile(thumbPath);
        }
        // Videos: no fallback to the raw file (it won't render as an image) — 404 cleanly
        if (isVideo) return res.status(404).send('Poster not available');
        // Fall through to original if thumbnail generation failed
    }

    if (req.query.preview === '1') {
        // Animated images (GIF / animated WebP) are served as the original so they
        // play in the lightbox — a flattened JPEG preview would freeze them on
        // frame 1. This must come BEFORE the existsSync check below so a stale/legacy
        // static preview JPEG isn't served instead. Probe once for animatable formats
        // whose animation flag hasn't been recorded yet (legacy files self-heal here).
        const originalPath = safeResolvePath(safeResolvePath(path.join(DATA_DIR, 'uploads'), galleryId), filename);
        let dims = db.prepare(`SELECT width, height, duration, animated FROM files WHERE gallery_id = ? AND filename = ?`).get(galleryId, filename) || null;
        if (!isVideo && isAnimatableFile(filename) && (!dims || dims.animated === null) && fs.existsSync(originalPath)) {
            const d = await readDimensions(originalPath);
            if (d) {
                setPhotoDimensions(galleryId, filename, d.w, d.h, d.animated);
                dims = db.prepare(`SELECT width, height, duration, animated FROM files WHERE gallery_id = ? AND filename = ?`).get(galleryId, filename) || null;
            }
        }
        if (dims && dims.animated && fs.existsSync(originalPath)) {
            return res.sendFile(originalPath);
        }

        const previewPath = safeResolvePath(safeResolvePath(PREVIEWS_DIR, galleryId), filename + '.jpg');

        if (fs.existsSync(previewPath)) {
            return res.sendFile(previewPath);
        }

        if (isVideo) {
            await generateVideoPoster(galleryId, filename);
            if (fs.existsSync(previewPath)) return res.sendFile(previewPath);
            return res.status(404).send('Preview not available');
        }

        // Preview missing — serve original immediately and generate in background
        generatePreview(galleryId, filename).catch(() => {});
        // Fall through to serve original
    }

    const filePath = safeResolvePath(safeResolvePath(path.join(DATA_DIR, 'uploads'), galleryId), filename);
    if (!fs.existsSync(filePath)) {
        return res.status(404).send('Photo not found');
    }
    if (isVideo) ensureVideoFastStart(galleryId, filename, filePath);
    res.sendFile(filePath);
});

// Returns true if this gallery's single collection (at most one, enforced by
// a UNIQUE constraint) has downloadsEnabled === false
function isGalleryBlockedByCollection(galleryId) {
    const row = db.prepare(`
        SELECT c.downloads_enabled AS downloads_enabled
        FROM collection_galleries cg JOIN collections c ON c.id = cg.collection_id
        WHERE cg.gallery_id = ?`).get(galleryId);
    return !!row && row.downloads_enabled === 0;
}

// Same, for commentsEnabled
function isGalleryBlockedByCollectionForComments(galleryId) {
    const row = db.prepare(`
        SELECT c.comments_enabled AS comments_enabled
        FROM collection_galleries cg JOIN collections c ON c.id = cg.collection_id
        WHERE cg.gallery_id = ?`).get(galleryId);
    return !!row && row.comments_enabled === 0;
}

// Download a single photo as an attachment
app.get('/api/gallery/:galleryId/download/:filename', downloadLimiter, validateGalleryId, checkGalleryExpiration, requireGalleryUnlock, validateFilename, (req, res) => {
    const { galleryId, filename } = req.params;

    const gallery = db.prepare(`SELECT downloads_enabled FROM galleries WHERE id = ?`).get(galleryId);
    if (gallery && gallery.downloads_enabled === 0) {
        return res.status(403).json({ error: 'Downloads are disabled for this gallery' });
    }
    if (isGalleryBlockedByCollection(galleryId)) {
        return res.status(403).json({ error: 'Downloads are disabled for this collection' });
    }

    const filePath = safeResolvePath(safeResolvePath(path.join(DATA_DIR, 'uploads'), galleryId), filename);

    if (!fs.existsSync(filePath)) {
        return res.status(404).send('Photo not found');
    }

    res.download(filePath, filename);
});

// Delete a single photo from a gallery (admin only)
app.delete('/api/gallery/:galleryId/photo/:filename', adminLimiter, requireAuth, validateGalleryId, validateFilename, (req, res) => {
    const { galleryId, filename } = req.params;
    const galleryExists = db.prepare(`SELECT 1 FROM galleries WHERE id = ?`).get(galleryId);
    if (!galleryExists) return res.status(404).json({ error: 'Gallery not found' });

    const uploadPath = safeResolvePath(safeResolvePath(path.join(DATA_DIR, 'uploads'), galleryId), filename);
    if (!fs.existsSync(uploadPath)) return res.status(404).json({ error: 'Photo not found' });

    // Remove file
    fs.unlinkSync(uploadPath);

    // Remove thumbnail (ignore if missing)
    try { fs.unlinkSync(safeResolvePath(safeResolvePath(THUMBNAILS_DIR, galleryId), filename + '.jpg')); } catch (_) {}

    // Remove preview (ignore if missing)
    try { fs.unlinkSync(safeResolvePath(safeResolvePath(PREVIEWS_DIR, galleryId), filename + '.jpg')); } catch (_) {}

    // Remove from the files table — cascades to this filename's favorites and
    // comments too, which is a deliberate, announced behavior change from the
    // old JSON model (see CLAUDE.md's "Data persistence" section): those used
    // to be silently orphaned forever instead.
    db.prepare(`DELETE FROM files WHERE gallery_id = ? AND filename = ?`).run(galleryId, filename);

    // Invalidate OG cache (it may have used this photo)
    try { fs.unlinkSync(safeResolvePath(OG_CACHE_DIR, `${galleryId}.jpg`)); } catch (_) {}

    const fileCount = db.prepare(`SELECT COUNT(*) AS n FROM files WHERE gallery_id = ?`).get(galleryId).n;
    res.json({ success: true, fileCount });
});

const PHOTO_FLAGS = ['red', 'orange', 'green', 'white'];

// Set or clear a photo's photographer-side proofing flag. Admin-only —
// revalidated here against the same set the files.flag CHECK enforces
// (defense in depth, not a substitute for it).
app.patch('/api/gallery/:galleryId/photo/:filename/flag', adminLimiter, requireAuth, validateGalleryId, validateFilename, (req, res) => {
    const { galleryId, filename } = req.params;
    const { flag } = req.body;
    if (flag !== null && !PHOTO_FLAGS.includes(flag)) {
        return res.status(400).json({ error: 'flag must be one of red/orange/green/white, or null' });
    }
    const result = db.prepare(`UPDATE files SET flag = ? WHERE gallery_id = ? AND filename = ?`).run(flag, galleryId, filename);
    if (result.changes === 0) return res.status(404).json({ error: 'Photo not found' });
    res.json({ flag });
});

// Serve/generate OG image (1200×630 JPEG, cached)
// Deliberately NOT gated by checkGalleryExpiration/requireGalleryUnlock: a
// crawler can neither submit a password nor respect a 410, so a locked or
// expired gallery keeps a normal share-preview card, matching behavior today.
app.get('/api/gallery/:galleryId/og-image', imageLimiter, validateGalleryId, async (req, res) => {
    const { galleryId } = req.params;
    const cacheFile = safeResolvePath(OG_CACHE_DIR, `${galleryId}.jpg`);

    if (fs.existsSync(cacheFile)) {
        return res.sendFile(cacheFile);
    }

    // Find source: prefer background, fall back to first photo
    let sourceFile = null;
    const backgroundsDir = path.join(DATA_DIR, 'backgrounds');
    if (fs.existsSync(backgroundsDir)) {
        const bgFile = fs.readdirSync(backgroundsDir).find(f => f.startsWith(galleryId));
        if (bgFile) sourceFile = safeResolvePath(backgroundsDir, bgFile);
    }

    if (!sourceFile) {
        const galleryPath = safeResolvePath(path.join(DATA_DIR, 'uploads'), galleryId);
        if (!fs.existsSync(galleryPath)) return res.status(404).send('Gallery not found');
        const files = fs.readdirSync(galleryPath).filter(f => !f.startsWith('.'));
        if (files.length === 0) return res.status(404).send('No photos');

        const firstImage = files.find(f => !isVideoFile(f));
        if (firstImage) {
            sourceFile = path.join(galleryPath, firstImage);
        } else {
            const firstVideo = files[0];
            await generateVideoPoster(galleryId, firstVideo);
            const posterPath = safeResolvePath(safeResolvePath(PREVIEWS_DIR, galleryId), firstVideo + '.jpg');
            if (fs.existsSync(posterPath)) sourceFile = posterPath;
            else return res.status(404).send('No image available');
        }
    }

    try {
        await sharp(sourceFile)
            .resize(1200, 630, { fit: 'cover' })
            .withMetadata()
            .jpeg({ quality: 80 })
            .toFile(cacheFile);
        res.sendFile(cacheFile);
    } catch (err) {
        console.error(`[GALLERY] OG image generation failed for ${galleryId}: ${err.message}`);
        res.status(500).send('Could not generate OG image');
    }
});

// Regenerate gallery OG image (admin — clears cache so it is rebuilt on next share)
app.delete('/api/gallery/:galleryId/og-image', adminLimiter, requireAuth, validateGalleryId, (req, res) => {
    const { galleryId } = req.params;
    try { fs.unlinkSync(safeResolvePath(OG_CACHE_DIR, `${galleryId}.jpg`)); } catch (_) {}
    res.json({ success: true });
});

// Collection OG image — 1200×630, cached in og-cache/collection-{id}.jpg
app.get('/api/collection/:collectionId/og-image', imageLimiter, validateCollectionId, async (req, res) => {
    const { collectionId } = req.params;
    const cacheFile = safeResolvePath(OG_CACHE_DIR, `collection-${collectionId}.jpg`);

    if (fs.existsSync(cacheFile)) return res.sendFile(cacheFile);

    // Source: collection background → first gallery background → first photo of first gallery
    let sourceFile = null;
    const backgroundsDir = path.join(DATA_DIR, 'backgrounds');
    if (fs.existsSync(backgroundsDir)) {
        const colBg = fs.readdirSync(backgroundsDir).find(f => f.startsWith(`collection-${collectionId}`));
        if (colBg) sourceFile = safeResolvePath(backgroundsDir, colBg);
    }
    if (!sourceFile) {
        const galleryIds = db.prepare(`SELECT gallery_id FROM collection_galleries WHERE collection_id = ? ORDER BY position`).all(collectionId).map(r => r.gallery_id);
        for (const gid of galleryIds) {
            if (sourceFile) break;
            if (fs.existsSync(backgroundsDir)) {
                const gbg = fs.readdirSync(backgroundsDir).find(f => f.startsWith(gid));
                if (gbg) { sourceFile = safeResolvePath(backgroundsDir, gbg); break; }
            }
            const gPath = safeResolvePath(path.join(DATA_DIR, 'uploads'), gid);
            if (fs.existsSync(gPath)) {
                const files = fs.readdirSync(gPath).filter(f => !f.startsWith('.'));
                const firstImage = files.find(f => !isVideoFile(f));
                if (firstImage) sourceFile = path.join(gPath, firstImage);
            }
        }
    }
    if (!sourceFile) return res.status(404).send('No image available');

    try {
        await sharp(sourceFile).resize(1200, 630, { fit: 'cover' }).withMetadata().jpeg({ quality: 80 }).toFile(cacheFile);
        res.sendFile(cacheFile);
    } catch (err) {
        console.error(`[COLLECTION] OG image generation failed for ${collectionId}: ${err.message}`);
        res.status(500).send('Could not generate OG image');
    }
});

// Regenerate collection OG image (admin)
app.delete('/api/collection/:collectionId/og-image', adminLimiter, requireAuth, validateCollectionId, (req, res) => {
    const { collectionId } = req.params;
    try { fs.unlinkSync(safeResolvePath(OG_CACHE_DIR, `collection-${collectionId}.jpg`)); } catch (_) {}
    res.json({ success: true });
});

// Preview page — serves HTML with OG meta tags injected
app.get('/preview/:galleryId', publicReadLimiter, validateGalleryId, (req, res) => {
    const { galleryId } = req.params;
    const galleryPath = safeResolvePath(path.join(DATA_DIR, 'uploads'), galleryId);
    const gallery = getActiveGallery(galleryId);

    if (!fs.existsSync(galleryPath) || !gallery) {
        return res.status(404).send('Gallery not found');
    }

    const eventName = gallery.eventName;
    const baseUrl = `${req.protocol}://${req.get('host')}`;

    const ogTags = [
        `<meta property="og:title" content="${escapeHtml(eventName)}">`,
        `<meta property="og:description" content="${escapeHtml(ogDescription('preview', resolveGalleryClientLanguage(galleryId)))}">`,
        `<meta property="og:image" content="${escapeHtml(baseUrl)}/api/gallery/${escapeHtml(galleryId)}/og-image">`,
        `<meta property="og:type" content="website">`,
        `<meta property="og:url" content="${escapeHtml(baseUrl)}/preview/${escapeHtml(galleryId)}">`
    ].join('\n    ');

    const html = fs.readFileSync(path.join(__dirname, 'public', 'preview.html'), 'utf8');
    res.send(html.replace('<head>', `<head>\n    ${ogTags}`));
});

// Get gallery info (for customer and preview pages)
app.get('/api/gallery/:galleryId/info', publicReadLimiter, validateGalleryId, checkGalleryExpiration, requireGalleryUnlock, (req, res) => {
    const { galleryId } = req.params;
    if (!getActiveGallery(galleryId)) return res.status(404).json({ error: 'Gallery not found' });

    const backgroundsDir = path.join(DATA_DIR, 'backgrounds');
    let backgroundFile = null;
    if (fs.existsSync(backgroundsDir)) {
        backgroundFile = fs.readdirSync(backgroundsDir).find(f => f.startsWith(galleryId)) || null;
    }

    const galleryPath = safeResolvePath(path.join(DATA_DIR, 'uploads'), galleryId);
    let fileCount = 0;
    if (fs.existsSync(galleryPath)) {
        fileCount = fs.readdirSync(galleryPath).filter(f => !f.startsWith('.')).length;
    }

    const gallery = db.prepare(`SELECT * FROM galleries WHERE id = ?`).get(galleryId);
    const eventName = gallery ? gallery.event_name : 'Your Photos';
    let viewCount = gallery ? gallery.view_count : 0;

    // Track unique views via hash of IP + User-Agent
    if (gallery) {
        const ip = resolveClientIp(req);
        const ua = req.headers['user-agent'] || '';
        const hash = crypto.createHash('sha256').update(ip + ua).digest('hex');
        const alreadySeen = db.prepare(`SELECT 1 FROM viewer_hashes WHERE gallery_id = ? AND hash = ?`).get(galleryId, hash);
        if (!alreadySeen) {
            db.transaction(() => {
                db.prepare(`INSERT INTO viewer_hashes (gallery_id, hash) VALUES (?, ?)`).run(galleryId, hash);
                db.prepare(`UPDATE galleries SET view_count = view_count + 1 WHERE id = ?`).run(galleryId);
            })();
            viewCount += 1;
        }
    }

    let totalSizeBytes = 0;
    if (fs.existsSync(galleryPath)) {
        fs.readdirSync(galleryPath).filter(f => !f.startsWith('.')).forEach(f => {
            try { totalSizeBytes += fs.statSync(path.join(galleryPath, f)).size; } catch (_) {}
        });
    }

    // This gallery's own montage, with an mtime token so a replaced track busts
    // the 24h cache. Only reported when the file is really on disk.
    const gAudioFile = findAudioFile(`gallery-${galleryId}`);
    let audio = null;
    if (gAudioFile && gallery && gallery.audio_filename) {
        let version = null;
        try { version = Math.floor(fs.statSync(safeResolvePath(AUDIO_DIR, gAudioFile)).mtimeMs); } catch (_) {}
        audio = {
            url: `/api/gallery/${galleryId}/audio${version ? `?v=${version}` : ''}`,
            filename: gallery.audio_filename || null,
            duration: gallery.audio_duration ?? null,
            size: gallery.audio_size ?? null
        };
    }

    // The montage now ships inside the gallery ZIP, so it has to count towards the
    // size shown on the download button — otherwise the button under-reports by the
    // weight of an entire audio track. Read from the row, no extra statSync.
    if (audio && audio.size) totalSizeBytes += audio.size;

    res.json({
        galleryId,
        eventName,
        background: backgroundFile ? `/api/gallery/${galleryId}/background` : null,
        fileCount,
        totalSizeBytes,
        audio,
        downloadsEnabled: gallery ? (!!gallery.downloads_enabled && !isGalleryBlockedByCollection(galleryId)) : true,
        downloadCount: gallery ? gallery.download_count : 0,
        viewCount,
        commentsEnabled: gallery ? (!!gallery.comments_enabled && !isGalleryBlockedByCollectionForComments(galleryId)) : true,
        clientLanguage: resolveGalleryClientLanguage(galleryId)
    });
});

// Download all photos as ZIP
app.get('/api/gallery/:galleryId/download', downloadLimiter, validateGalleryId, checkGalleryExpiration, requireGalleryUnlock, (req, res) => {
    const { galleryId } = req.params;
    const galleryPath = safeResolvePath(path.join(DATA_DIR, 'uploads'), galleryId);

    if (!fs.existsSync(galleryPath)) {
        return res.status(404).json({ error: 'Gallery not found' });
    }

    const gallery = db.prepare(`SELECT event_name, downloads_enabled, download_count, audio_filename FROM galleries WHERE id = ?`).get(galleryId);
    if (gallery && gallery.downloads_enabled === 0) {
        return res.status(403).json({ error: 'Downloads are disabled for this gallery' });
    }
    if (isGalleryBlockedByCollection(galleryId)) {
        return res.status(403).json({ error: 'Downloads are disabled for this collection' });
    }

    // Track download count
    let newCount = gallery ? gallery.download_count : 0;
    if (gallery) {
        db.prepare(`UPDATE galleries SET download_count = download_count + 1 WHERE id = ?`).run(galleryId);
        newCount += 1;
        console.log(`[DOWNLOAD] Gallery "${gallery.event_name}" (${galleryId}) — #${newCount} from ${resolveClientIp(req)}`);
    }

    const files = fs.readdirSync(galleryPath).filter(f => !f.startsWith('.'));

    if (files.length === 0) {
        return res.status(404).json({ error: 'No files in gallery' });
    }

    const eventName = gallery && gallery.event_name ? gallery.event_name : 'photos';
    const asciiName = eventName.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_').substring(0, 50) || 'photos';
    const encodedName = encodeURIComponent(eventName.substring(0, 200) + '.zip');

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${asciiName}.zip"; filename*=UTF-8''${encodedName}`);

    // store: true = no compression (JPEGs are already compressed, saves CPU)
    // Content-Length intentionally omitted: archiver streaming adds variable ZIP metadata
    // that makes pre-calculation unreliable and causes "unexpected end of archive" errors.
    const archive = archiver('zip', { store: true });
    archive.on('error', (err) => { res.status(500).send({ error: err.message }); });
    archive.pipe(res);
    files.forEach(file => archive.file(path.join(galleryPath, file), { name: file }));
    // This gallery's OWN montage rides along — it lives in AUDIO_DIR, outside
    // galleryPath, so the readdir above never sees it. Same two-condition guard as
    // the /info route: the file must be on disk AND recorded in the row. A montage
    // owned by the containing collection is deliberately NOT included here; it goes
    // in the collection ZIP instead.
    if (gallery && gallery.audio_filename) {
        const audioFile = findAudioFile(`gallery-${galleryId}`);
        if (audioFile) {
            const ext = path.extname(audioFile);
            archive.file(safeResolvePath(AUDIO_DIR, audioFile), {
                name: zipSafeName(gallery.audio_filename, `montage${ext}`)
            });
        }
    }
    archive.finalize();
});

// Toggle favorite for a photo (public, no auth) — per visitor
app.post('/api/gallery/:galleryId/favorites', publicWriteLimiter, validateGalleryId, checkGalleryExpiration, requireGalleryUnlock, (req, res) => {
    const { galleryId } = req.params;
    const { filename, visitorId } = req.body;

    if (typeof filename !== 'string' || !SAFE_FILENAME_RE.test(filename)) {
        return res.status(400).json({ error: 'Invalid filename' });
    }
    if (typeof visitorId !== 'string' || visitorId.length < 4 || visitorId.length > 64 || !/^[a-zA-Z0-9_-]+$/.test(visitorId)) {
        return res.status(400).json({ error: 'Invalid visitorId' });
    }

    const galleryExists = db.prepare(`SELECT 1 FROM galleries WHERE id = ?`).get(galleryId);
    if (!galleryExists) {
        return res.status(404).json({ error: 'Gallery not found' });
    }

    let result;
    try {
        result = db.transaction(() => {
            const existing = db.prepare(`SELECT 1 FROM favorites WHERE gallery_id = ? AND filename = ? AND visitor_id = ?`).get(galleryId, filename, visitorId);
            if (existing) {
                db.prepare(`DELETE FROM favorites WHERE gallery_id = ? AND filename = ? AND visitor_id = ?`).run(galleryId, filename, visitorId);
            } else {
                db.prepare(`INSERT INTO favorites (gallery_id, filename, visitor_id) VALUES (?, ?, ?)`).run(galleryId, filename, visitorId);
            }
            const votes = db.prepare(`SELECT COUNT(*) AS n FROM favorites WHERE gallery_id = ? AND filename = ?`).get(galleryId, filename).n;
            return { favorited: !existing, votes };
        })();
    } catch (e) {
        // A favorite on a filename with no matching `files` row (e.g. the photo
        // was deleted) now fails loudly instead of silently creating a
        // permanent orphan entry — see CLAUDE.md's "Data persistence" section.
        if (/FOREIGN KEY constraint failed/.test(e.message)) {
            return res.status(404).json({ error: 'Photo not found' });
        }
        throw e;
    }

    res.json({
        success: true,
        favorited: result.favorited,
        votes: result.votes
    });
});

// Get favorites for this visitor (public — used by preview page on load)
app.get('/api/gallery/:galleryId/favorites-public', publicReadLimiter, validateGalleryId, checkGalleryExpiration, requireGalleryUnlock, (req, res) => {
    const { galleryId } = req.params;
    // Normalized to a string or null (never `undefined`, which better-sqlite3
    // refuses to bind) — a null visitor_id matches nothing in SQL, same net
    // result as the old `favs[f].includes(undefined)` always being false.
    const visitorId = typeof req.query.visitorId === 'string' ? req.query.visitorId : null;
    const galleryExists = db.prepare(`SELECT 1 FROM galleries WHERE id = ?`).get(galleryId);
    if (!galleryExists) {
        return res.status(404).json({ error: 'Gallery not found' });
    }
    const myFavorites = db.prepare(`SELECT filename FROM favorites WHERE gallery_id = ? AND visitor_id = ?`).all(galleryId, visitorId).map(r => r.filename);
    res.json({ favorites: myFavorites });
});

// Public favorites ranking page — photos sorted by vote count (public, no auth)
app.get('/favorites/:galleryId', publicReadLimiter, validateGalleryId, (req, res) => {
    const { galleryId } = req.params;
    const gallery = getActiveGallery(galleryId);
    if (!gallery) return res.status(404).send('Gallery not found');

    const eventName = gallery.eventName || 'Gallery';
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const ogTags = [
        `<meta property="og:title" content="${escapeHtml(eventName)} — Favorites">`,
        `<meta property="og:description" content="${escapeHtml(ogDescription('favorites', resolveGalleryClientLanguage(galleryId)))} ${escapeHtml(eventName)}.">`,
        `<meta property="og:image" content="${escapeHtml(baseUrl)}/api/gallery/${escapeHtml(galleryId)}/og-image">`,
        `<meta property="og:type" content="website">`,
        `<meta property="og:url" content="${escapeHtml(baseUrl)}/favorites/${escapeHtml(galleryId)}">`
    ].join('\n    ');
    const html = fs.readFileSync(path.join(__dirname, 'public', 'favorites.html'), 'utf8');
    res.send(html.replace('<head>', `<head>\n    ${ogTags}`));
});

// Public API: favorites sorted by vote count (used by favorites.html)
app.get('/api/gallery/:galleryId/favorites-ranked', publicReadLimiter, validateGalleryId, checkGalleryExpiration, requireGalleryUnlock, (req, res) => {
    const { galleryId } = req.params;
    const gallery = getActiveGallery(galleryId);
    if (!gallery) return res.status(404).json({ error: 'Gallery not found' });

    const rows = db.prepare(`
        SELECT f.filename AS filename, COUNT(*) AS votes, fi.width AS width, fi.height AS height, fi.duration AS duration, fi.animated AS animated
        FROM favorites f JOIN files fi ON fi.gallery_id = f.gallery_id AND fi.filename = f.filename
        WHERE f.gallery_id = ?
        GROUP BY f.filename
        HAVING COUNT(*) > 0
        ORDER BY votes DESC
    `).all(galleryId);

    const photos = rows.map(r => {
        const video = isVideoFile(r.filename);
        return {
            filename: r.filename, votes: r.votes,
            type: video ? 'video' : 'image',
            thumbnailUrl: `/api/gallery/${galleryId}/photo/${encodeURIComponent(r.filename)}?thumb=1`,
            previewUrl:   `/api/gallery/${galleryId}/photo/${encodeURIComponent(r.filename)}?preview=1`,
            width: r.width || null,
            height: r.height || null,
            duration: video ? (r.duration ?? null) : undefined
        };
    });

    const backgroundsDir = path.join(DATA_DIR, 'backgrounds');
    const hasBg = fs.existsSync(backgroundsDir) && !!fs.readdirSync(backgroundsDir).find(f => f.startsWith(galleryId));

    res.json({
        galleryId,
        eventName: gallery.eventName || 'Gallery',
        background: hasBg ? `/api/gallery/${galleryId}/background` : null,
        csvUrl: `/api/gallery/${galleryId}/favorites/export`,
        photos
    });
});

// Get favorites for a gallery (admin only) — sorted by vote count desc
app.get('/api/gallery/:galleryId/favorites', adminLimiter, requireAuth, validateGalleryId, (req, res) => {
    const { galleryId } = req.params;
    const galleryExists = db.prepare(`SELECT 1 FROM galleries WHERE id = ?`).get(galleryId);
    if (!galleryExists) {
        return res.status(404).json({ error: 'Gallery not found' });
    }
    const sorted = db.prepare(`
        SELECT filename, COUNT(*) AS votes FROM favorites WHERE gallery_id = ? GROUP BY filename ORDER BY votes DESC
    `).all(galleryId);
    res.json({ favorites: sorted });
});

// Reset view count for a gallery (admin only)
app.delete('/api/gallery/:galleryId/views', adminLimiter, requireAuth, validateGalleryId, (req, res) => {
    const { galleryId } = req.params;
    const row = db.prepare(`SELECT event_name FROM galleries WHERE id = ?`).get(galleryId);
    if (!row) return res.status(404).json({ error: 'Gallery not found' });
    db.transaction(() => {
        db.prepare(`UPDATE galleries SET view_count = 0 WHERE id = ?`).run(galleryId);
        db.prepare(`DELETE FROM viewer_hashes WHERE gallery_id = ?`).run(galleryId);
    })();
    console.log(`[GALLERY] Views reset for "${row.event_name}" (${galleryId})`);
    res.json({ success: true });
});

app.delete('/api/gallery/:galleryId/favorites', adminLimiter, requireAuth, validateGalleryId, (req, res) => {
    const { galleryId } = req.params;
    const row = db.prepare(`SELECT event_name FROM galleries WHERE id = ?`).get(galleryId);
    if (!row) {
        return res.status(404).json({ error: 'Gallery not found' });
    }
    db.prepare(`DELETE FROM favorites WHERE gallery_id = ?`).run(galleryId);
    console.log(`[GALLERY] Favorites reset for "${row.event_name}" (${galleryId})`);
    res.json({ success: true });
});

// Export favorites as CSV
app.get('/api/gallery/:galleryId/favorites/export', publicReadLimiter, validateGalleryId, checkGalleryExpiration, requireGalleryUnlock, (req, res) => {
    const { galleryId } = req.params;
    const row = db.prepare(`SELECT event_name FROM galleries WHERE id = ?`).get(galleryId);
    if (!row) return res.status(404).json({ error: 'Gallery not found' });

    const rows = db.prepare(`SELECT filename, COUNT(*) AS votes FROM favorites WHERE gallery_id = ? GROUP BY filename ORDER BY votes DESC`).all(galleryId);

    const eventName = row.event_name || 'favorites';
    const asciiName = eventName.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_').substring(0, 50) + '_favorites';
    const encodedName = encodeURIComponent(eventName.substring(0, 200) + '_favorites.csv');

    // UTF-8 BOM so Excel opens the file with correct encoding
    const bom = '\uFEFF';
    const csv = bom + ['filename,votes', ...rows.map(r => `"${r.filename.replace(/"/g, '""')}",${r.votes}`)].join('\r\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${asciiName}.csv"; filename*=UTF-8''${encodedName}`);
    res.send(csv);
});

// Download favorite photos as ZIP
app.get('/api/gallery/:galleryId/favorites/download', downloadLimiter, requireAuth, validateGalleryId, (req, res) => {
    const { galleryId } = req.params;
    const galleryRow = db.prepare(`SELECT event_name FROM galleries WHERE id = ?`).get(galleryId);
    if (!galleryRow) return res.status(404).json({ error: 'Gallery not found' });

    const minVotes = Math.max(1, parseInt(req.query.minVotes, 10) || 1);
    const filenames = db.prepare(`
        SELECT filename FROM favorites WHERE gallery_id = ? GROUP BY filename HAVING COUNT(*) >= ? ORDER BY COUNT(*) DESC
    `).all(galleryId, minVotes).map(r => r.filename);

    if (filenames.length === 0) return res.status(404).json({ error: 'No favorites' });

    const galleryPath = safeResolvePath(path.join(DATA_DIR, 'uploads'), galleryId);
    const name = (galleryRow.event_name || 'favorites').replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_').substring(0, 50) || 'favorites';
    const encodedName = encodeURIComponent((galleryRow.event_name || 'favorites').substring(0, 200) + '_favorites.zip');

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${name}_favorites.zip"; filename*=UTF-8''${encodedName}`);

    const archive = archiver('zip', { store: true });
    archive.on('error', err => res.status(500).send({ error: err.message }));
    archive.pipe(res);
    filenames.forEach(filename => {
        const filePath = safeResolvePath(galleryPath, filename);
        if (fs.existsSync(filePath)) archive.file(filePath, { name: filename });
    });
    archive.finalize();
});

// Add a comment to a photo (public, no auth) — visible to all visitors (guestbook style)
app.post('/api/gallery/:galleryId/comments', publicWriteLimiter, validateGalleryId, checkGalleryExpiration, requireGalleryUnlock, (req, res) => {
    const { galleryId } = req.params;
    const { filename, visitorId, name, text } = req.body;

    if (typeof filename !== 'string' || !SAFE_FILENAME_RE.test(filename)) {
        return res.status(400).json({ error: 'Invalid filename' });
    }
    if (typeof visitorId !== 'string' || visitorId.length < 4 || visitorId.length > 64 || !/^[a-zA-Z0-9_-]+$/.test(visitorId)) {
        return res.status(400).json({ error: 'Invalid visitorId' });
    }
    if (typeof text !== 'string') {
        return res.status(400).json({ error: 'Comment text is required' });
    }

    const gallery = db.prepare(`SELECT comments_enabled FROM galleries WHERE id = ?`).get(galleryId);
    if (!gallery) {
        return res.status(404).json({ error: 'Gallery not found' });
    }
    if (gallery.comments_enabled === 0) {
        return res.status(403).json({ error: 'Comments are disabled for this gallery' });
    }
    if (isGalleryBlockedByCollectionForComments(galleryId)) {
        return res.status(403).json({ error: 'Comments are disabled for this collection' });
    }

    const cleanText = text.trim().replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '').substring(0, 500);
    if (cleanText.length === 0) {
        return res.status(400).json({ error: 'Comment text is required' });
    }
    const trimmedName = typeof name === 'string' ? name.trim().replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '').substring(0, 60) : '';
    const cleanName = trimmedName.length > 0 ? trimmedName : null;

    const comment = {
        id: uuidv4(),
        visitorId,
        name: cleanName,
        text: cleanText,
        createdAt: new Date().toISOString()
    };

    let commentCount;
    try {
        commentCount = db.transaction(() => {
            db.prepare(`INSERT INTO comments (id, gallery_id, filename, visitor_id, name, text, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
                .run(comment.id, galleryId, filename, comment.visitorId, comment.name, comment.text, comment.createdAt);
            return db.prepare(`SELECT COUNT(*) AS n FROM comments WHERE gallery_id = ? AND filename = ?`).get(galleryId, filename).n;
        })();
    } catch (e) {
        if (/FOREIGN KEY constraint failed/.test(e.message)) {
            return res.status(404).json({ error: 'Photo not found' });
        }
        throw e;
    }

    res.json({ success: true, comment, commentCount });
});

// Get comments for a single photo (public — used by the lightbox comment drawer)
app.get('/api/gallery/:galleryId/comments-public', publicReadLimiter, validateGalleryId, checkGalleryExpiration, requireGalleryUnlock, (req, res) => {
    const { galleryId } = req.params;
    const { filename } = req.query;

    if (typeof filename !== 'string' || !SAFE_FILENAME_RE.test(filename)) {
        return res.status(400).json({ error: 'Invalid filename' });
    }

    const galleryExists = db.prepare(`SELECT 1 FROM galleries WHERE id = ?`).get(galleryId);
    if (!galleryExists) {
        return res.status(404).json({ error: 'Gallery not found' });
    }

    const comments = db.prepare(`
        SELECT id, visitor_id AS visitorId, name, text, created_at AS createdAt
        FROM comments WHERE gallery_id = ? AND filename = ? ORDER BY created_at ASC
    `).all(galleryId, filename);
    res.json({ comments });
});

// Get all comments for a gallery (admin only) — flattened across photos, newest first
app.get('/api/gallery/:galleryId/comments', adminLimiter, requireAuth, validateGalleryId, (req, res) => {
    const { galleryId } = req.params;
    const galleryExists = db.prepare(`SELECT 1 FROM galleries WHERE id = ?`).get(galleryId);
    if (!galleryExists) {
        return res.status(404).json({ error: 'Gallery not found' });
    }

    const flattened = db.prepare(`
        SELECT id, filename, visitor_id AS visitorId, name, text, created_at AS createdAt
        FROM comments WHERE gallery_id = ? ORDER BY created_at DESC
    `).all(galleryId).map(c => ({
        ...c,
        thumbnailUrl: `/api/gallery/${galleryId}/photo/${encodeURIComponent(c.filename)}?thumb=1`
    }));

    res.json({ comments: flattened });
});

// Delete a single comment (admin only) — spam removal
app.delete('/api/gallery/:galleryId/comments/:filename/:commentId', adminLimiter, requireAuth, validateGalleryId, validateFilename, (req, res) => {
    const { galleryId, filename, commentId } = req.params;
    const galleryExists = db.prepare(`SELECT 1 FROM galleries WHERE id = ?`).get(galleryId);
    if (!galleryExists) {
        return res.status(404).json({ error: 'Gallery not found' });
    }

    const info = db.prepare(`DELETE FROM comments WHERE id = ? AND gallery_id = ? AND filename = ?`).run(commentId, galleryId, filename);
    if (info.changes === 0) {
        return res.status(404).json({ error: 'Comment not found' });
    }

    res.json({ success: true });
});

// Clear all comments for a gallery (admin only)
app.delete('/api/gallery/:galleryId/comments', adminLimiter, requireAuth, validateGalleryId, (req, res) => {
    const { galleryId } = req.params;
    const row = db.prepare(`SELECT event_name FROM galleries WHERE id = ?`).get(galleryId);
    if (!row) {
        return res.status(404).json({ error: 'Gallery not found' });
    }
    db.prepare(`DELETE FROM comments WHERE gallery_id = ?`).run(galleryId);
    console.log(`[GALLERY] Comments reset for "${row.event_name}" (${galleryId})`);
    res.json({ success: true });
});

// --- Collection routes ---

function validateCollectionId(req, res, next) {
    if (!UUID_V4_REGEX.test(req.params.collectionId)) {
        return res.status(400).json({ error: 'Invalid collection ID' });
    }
    next();
}

// Create a new collection (admin only)
app.post('/api/collection/create', adminLimiter, requireAuth, (req, res) => {
    const rawName = req.body.name;
    if (typeof rawName !== 'string' && rawName !== undefined) {
        return res.status(400).json({ error: 'name must be a string' });
    }
    const name = (String(rawName || 'Untitled Collection')).trim().substring(0, 200);
    const id = uuidv4();
    db.prepare(`INSERT INTO collections (id, name, created_at) VALUES (?, ?, ?)`).run(id, name, new Date().toISOString());
    console.log(`[COLLECTION] Created "${name}" (${id})`);
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    res.json({ success: true, id, collectionUrl: `${baseUrl}/collection/${id}` });
});

// List all collections (admin only)
app.get('/api/collections', adminLimiter, requireAuth, (req, res) => {
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const bgDirC = path.join(DATA_DIR, 'backgrounds');
    const bgFilesC = fs.existsSync(bgDirC) ? new Set(fs.readdirSync(bgDirC)) : new Set();

    const list = db.prepare(`SELECT * FROM collections ORDER BY created_at DESC`).all().map(c => {
        const galleryIds = db.prepare(`SELECT gallery_id FROM collection_galleries WHERE collection_id = ? ORDER BY position`).all(c.id).map(r => r.gallery_id);
        // See /api/galleries: bgVersion is the cover mtime so the admin card
        // thumbnail can be cached and only refetched when the cover changes.
        const bgFile = [...bgFilesC].find(f => f.startsWith(`collection-${c.id}`)) || null;
        let bgVersion = null;
        if (bgFile) {
            try {
                bgVersion = Math.floor(fs.statSync(safeResolvePath(bgDirC, bgFile)).mtimeMs);
            } catch (_) { /* file vanished between readdir and stat */ }
        }
        return {
            id: c.id,
            name: c.name,
            created: c.created_at,
            galleryIds,
            collectionUrl: `${baseUrl}/collection/${c.id}`,
            hasBackground: bgFile !== null,
            bgVersion,
            downloadsEnabled: !!c.downloads_enabled,
            commentsEnabled: !!c.comments_enabled,
            clientLanguage: c.client_language || 'auto',
            // Audio montage, so the collection card can show / replace / remove it.
            // Reported only when the file is actually still on disk.
            audio: (c.audio_filename && findAudioFile(`collection-${c.id}`))
                ? { filename: c.audio_filename || null, duration: c.audio_duration ?? null, size: c.audio_size ?? null }
                : null
        };
    });
    res.json(list);
});

// Get collection info (public — used by collection page)
app.get('/api/collection/:collectionId', publicReadLimiter, validateCollectionId, (req, res) => {
    const { collectionId } = req.params;
    const collection = db.prepare(`SELECT * FROM collections WHERE id = ?`).get(collectionId);
    if (!collection) return res.status(404).json({ error: 'Collection not found' });

    const backgroundsDir = path.join(DATA_DIR, 'backgrounds');
    const bgFiles = fs.existsSync(backgroundsDir)
        ? new Set(fs.readdirSync(backgroundsDir))
        : new Set();

    const memberGalleryIds = db.prepare(`SELECT gallery_id FROM collection_galleries WHERE collection_id = ? ORDER BY position`).all(collectionId).map(r => r.gallery_id);
    const collDownloads = !!collection.downloads_enabled;

    let totalSizeBytes = 0;
    const galleriesData = memberGalleryIds
        .map(gid => {
            const gallery = getActiveGallery(gid);
            if (!gallery) return null;
            const galleryPath = path.join(DATA_DIR, 'uploads', gid);
            let fileCount = 0;
            if (fs.existsSync(galleryPath)) {
                const files = fs.readdirSync(galleryPath).filter(f => !f.startsWith('.'));
                fileCount = files.length;
                files.forEach(f => {
                    try { totalSizeBytes += fs.statSync(path.join(galleryPath, f)).size; } catch (_) {}
                });
            }
            const hasBackground = [...bgFiles].some(f => f.startsWith(gid));
            return {
                id: gid,
                eventName: gallery.eventName || 'Untitled Event',
                fileCount,
                background: hasBackground ? `/api/gallery/${gid}/background` : null,
                downloadsEnabled: collDownloads && gallery.downloadsEnabled !== false
            };
        })
        .filter(Boolean);

    const collHasBg = [...bgFiles].some(f => f.startsWith(`collection-${collectionId}`));

    // Audio montage: the URL carries an mtime token (same idea as bgVersion) so a
    // replaced track busts the 24h cache while an unchanged one stays cached across
    // navigations — which matters a lot for a file this size.
    const audioFile = findAudioFile(`collection-${collectionId}`);
    let audio = null;
    if (audioFile && collection.audio_filename) {
        let version = null;
        try { version = Math.floor(fs.statSync(safeResolvePath(AUDIO_DIR, audioFile)).mtimeMs); } catch (_) {}
        audio = {
            url: `/api/collection/${collectionId}/audio${version ? `?v=${version}` : ''}`,
            filename: collection.audio_filename || null,
            duration: collection.audio_duration ?? null,
            size: collection.audio_size ?? null
        };
    }

    // The montage now ships at the root of the collection ZIP, so it counts towards
    // the size shown on the download button. Read from the row, no extra statSync.
    if (audio && audio.size) totalSizeBytes += audio.size;

    res.json({
        id: collectionId,
        name: collection.name,
        background: collHasBg ? `/api/collection/${collectionId}/background` : null,
        downloadsEnabled: collDownloads,
        totalSizeBytes, // photos + the montage, which the ZIP now contains
        galleries: galleriesData,
        audio,
        clientLanguage: resolveCollectionClientLanguage(collectionId)
    });
});

// Rename a collection (admin only)
app.post('/api/collection/:collectionId/rename', adminLimiter, requireAuth, validateCollectionId, (req, res) => {
    const { collectionId } = req.params;
    const row = db.prepare(`SELECT name FROM collections WHERE id = ?`).get(collectionId);
    if (!row) return res.status(404).json({ error: 'Collection not found' });
    const oldColName = row.name;
    const name = (String(Array.isArray(req.body.name) ? req.body.name[0] : (req.body.name || 'Untitled Collection'))).trim().substring(0, 200);
    db.prepare(`UPDATE collections SET name = ? WHERE id = ?`).run(name, collectionId);
    console.log(`[COLLECTION] Renamed "${oldColName}" → "${name}" (${collectionId})`);
    res.json({ success: true, name });
});

// Upload/replace collection background image
app.post('/api/collection/:collectionId/background', adminLimiter, requireAuth, validateCollectionId, uploadBackground.single('background'), async (req, res) => {
    const { collectionId } = req.params;
    const collectionExists = db.prepare(`SELECT 1 FROM collections WHERE id = ?`).get(collectionId);
    if (!collectionExists) return res.status(404).json({ error: 'Collection not found' });
    if (!req.file) return res.status(400).json({ error: 'No background file provided' });
    try {
        const backgroundsDir = path.join(DATA_DIR, 'backgrounds');
        if (!fs.existsSync(backgroundsDir)) fs.mkdirSync(backgroundsDir, { recursive: true });
        const existing = fs.readdirSync(backgroundsDir).find(f => f.startsWith(`collection-${collectionId}`));
        if (existing) fs.unlinkSync(safeResolvePath(backgroundsDir, existing));
        const dest = safeResolvePath(backgroundsDir, `collection-${collectionId}.jpg`);
        // `.withMetadata()` keeps the source ICC profile — see the gallery background route.
        await sharp(req.file.buffer)
            .resize(2400, null, { withoutEnlargement: true })
            .withMetadata()
            .jpeg({ quality: 85 })
            .toFile(dest);
        const backgroundValue = `collection-${collectionId}.jpg`;
        db.prepare(`UPDATE collections SET background = ? WHERE id = ?`).run(backgroundValue, collectionId);
        const nameRow = db.prepare(`SELECT name FROM collections WHERE id = ?`).get(collectionId);
        console.log(`[COLLECTION] Background updated for "${nameRow.name}" (${collectionId})`);
        res.json({ success: true, background: backgroundValue });
    } catch (err) {
        console.error(`[COLLECTION] Background processing failed for ${collectionId}: ${err.message}`);
        res.status(500).json({ error: 'Failed to process background image' });
    }
});

// Serve collection background image
app.get('/api/collection/:collectionId/background', publicReadLimiter, validateCollectionId, (req, res) => {
    const { collectionId } = req.params;
    const backgroundsDir = path.join(DATA_DIR, 'backgrounds');
    if (fs.existsSync(backgroundsDir)) {
        const file = fs.readdirSync(backgroundsDir).find(f => f.startsWith(`collection-${collectionId}`));
        if (file) {
            const fullPath = safeResolvePath(backgroundsDir, file);
            if (req.query.thumb === '1') {
                res.setHeader('Content-Type', 'image/jpeg');
                res.setHeader('Cache-Control', 'public, max-age=86400');
                return sharp(fullPath)
                    .resize(200, 200, { fit: 'cover' })
                    .withMetadata()
                    .jpeg({ quality: 75 })
                    .pipe(res);
            }
            if (req.query.card === '1') {
                res.setHeader('Content-Type', 'image/jpeg');
                res.setHeader('Cache-Control', 'public, max-age=86400');
                return sharp(fullPath)
                    .resize(800, null, { fit: 'inside', withoutEnlargement: true })
                    .withMetadata()
                    .jpeg({ quality: 82 })
                    .pipe(res);
            }
            return res.sendFile(fullPath);
        }
    }
    res.status(404).json({ error: 'No background found' });
});

// ── COLLECTION AUDIO MONTAGE ────────────────────────────────────────────────
// One optional audio track per collection, stored verbatim (no transcoding) as
// data/audio/collection-{id}.{ext}. Deliberately NOT added to any gallery's files
// table: that table drives the photo grid, the ZIP, counts, dimension probing,
// the OG image fallback and the stem sort — an audio file has no business in any of them.

// Upload or replace the montage (admin only)
app.post('/api/collection/:collectionId/audio', adminLimiter, requireAuth, validateCollectionId, uploadAudio.single('audio'), async (req, res) => {
    const { collectionId } = req.params;
    const collectionExists = db.prepare(`SELECT 1 FROM collections WHERE id = ?`).get(collectionId);
    if (!collectionExists) {
        if (req.file) { try { fs.unlinkSync(req.file.path); } catch (_) {} }
        return res.status(404).json({ error: 'Collection not found' });
    }
    if (!req.file) return res.status(400).json({ error: 'No audio file provided' });

    // multer overwrote a previous file of the same extension; drop any older one
    // stored under a different extension so only a single montage remains.
    const kept = path.basename(req.file.path);
    for (const f of fs.readdirSync(AUDIO_DIR)) {
        if (f.startsWith(`collection-${collectionId}.`) && f !== kept) {
            try { fs.unlinkSync(safeResolvePath(AUDIO_DIR, f)); } catch (_) {}
        }
    }

    const duration = await probeAudioDuration(req.file.path);
    const audio = {
        filename: decodeUploadFilename(req.file.originalname).normalize('NFC'),
        stored: kept,
        size: req.file.size,
        duration, // seconds, or null when ffprobe is unavailable
        uploadedAt: new Date().toISOString()
    };
    db.prepare(`UPDATE collections SET audio_filename = ?, audio_stored = ?, audio_size = ?, audio_duration = ?, audio_uploaded_at = ? WHERE id = ?`)
        .run(audio.filename, audio.stored, audio.size, audio.duration, audio.uploadedAt, collectionId);
    const nameRow = db.prepare(`SELECT name FROM collections WHERE id = ?`).get(collectionId);
    console.log(`[COLLECTION] Audio updated for "${nameRow.name}" (${collectionId}) — ${kept}`);
    res.json({ success: true, audio });
});

// Remove the montage (admin only)
app.delete('/api/collection/:collectionId/audio', adminLimiter, requireAuth, validateCollectionId, (req, res) => {
    const { collectionId } = req.params;
    const nameRow = db.prepare(`SELECT name FROM collections WHERE id = ?`).get(collectionId);
    if (!nameRow) return res.status(404).json({ error: 'Collection not found' });
    deleteAudioFiles(`collection-${collectionId}`);
    db.prepare(`UPDATE collections SET audio_filename = NULL, audio_stored = NULL, audio_size = NULL, audio_duration = NULL, audio_uploaded_at = NULL WHERE id = ?`).run(collectionId);
    console.log(`[COLLECTION] Audio removed from "${nameRow.name}" (${collectionId})`);
    res.json({ success: true });
});

// Serve the montage. res.sendFile handles Range/206 by itself — that is what makes
// seeking work, exactly as for video originals. Served under imageLimiter (600/min),
// NOT publicReadLimiter (300/min): a media element fires many range requests while
// streaming and seeking, and a tripped limiter surfaces as a hard, visible error.
app.get('/api/collection/:collectionId/audio', imageLimiter, validateCollectionId, (req, res) => {
    const { collectionId } = req.params;
    const file = findAudioFile(`collection-${collectionId}`);
    if (!file) return res.status(404).json({ error: 'No audio found' });
    const ext = path.extname(file).toLowerCase().slice(1);
    // Set before sendFile: the `send` library skips its own guess when the header exists.
    res.setHeader('Content-Type', AUDIO_MIME_BY_EXT[ext] || 'application/octet-stream');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.sendFile(safeResolvePath(AUDIO_DIR, file));
});

// Add a gallery to a collection (admin only)
app.post('/api/collection/:collectionId/galleries', adminLimiter, requireAuth, validateCollectionId, (req, res) => {
    const { collectionId } = req.params;
    const { galleryId } = req.body;

    if (typeof galleryId !== 'string' || !UUID_V4_REGEX.test(galleryId)) {
        return res.status(400).json({ error: 'Invalid gallery ID' });
    }

    const result = ops.addGalleryToCollection(db, collectionId, galleryId);
    if (result.error === 'collection_not_found') return res.status(404).json({ error: 'Collection not found' });
    if (result.error === 'gallery_not_found') return res.status(404).json({ error: 'Gallery not found' });
    if (result.error === 'already_in_another_collection') return res.status(409).json({ error: 'Gallery already belongs to another collection' });

    res.json({ success: true, galleryIds: result.galleryIds });
});

// Reorder galleries within a collection (admin only)
app.patch('/api/collection/:collectionId/galleries/reorder', adminLimiter, requireAuth, validateCollectionId, (req, res) => {
    const { collectionId } = req.params;
    const { galleryIds } = req.body;
    const collectionExists = db.prepare(`SELECT 1 FROM collections WHERE id = ?`).get(collectionId);
    if (!collectionExists) return res.status(404).json({ error: 'Collection not found' });
    if (!Array.isArray(galleryIds)) return res.status(400).json({ error: 'galleryIds must be an array' });

    // Only accept IDs already in the collection — prevents injection
    const currentIds = db.prepare(`SELECT gallery_id FROM collection_galleries WHERE collection_id = ?`).all(collectionId).map(r => r.gallery_id);
    const valid = new Set(currentIds);
    if (!galleryIds.every(id => valid.has(id)) || galleryIds.length !== currentIds.length) {
        return res.status(400).json({ error: 'Invalid galleryIds' });
    }

    db.transaction(() => {
        const stmt = db.prepare(`UPDATE collection_galleries SET position = ? WHERE collection_id = ? AND gallery_id = ?`);
        galleryIds.forEach((id, idx) => stmt.run(idx, collectionId, id));
    })();

    res.json({ success: true, galleryIds });
});

// Remove a gallery from a collection (admin only)
app.delete('/api/collection/:collectionId/galleries/:galleryId', adminLimiter, requireAuth, validateCollectionId, validateGalleryId, (req, res) => {
    const { collectionId, galleryId } = req.params;
    const collectionExists = db.prepare(`SELECT 1 FROM collections WHERE id = ?`).get(collectionId);
    if (!collectionExists) return res.status(404).json({ error: 'Collection not found' });

    db.prepare(`DELETE FROM collection_galleries WHERE collection_id = ? AND gallery_id = ?`).run(collectionId, galleryId);
    const galleryIds = db.prepare(`SELECT gallery_id FROM collection_galleries WHERE collection_id = ? ORDER BY position`).all(collectionId).map(r => r.gallery_id);
    res.json({ success: true, galleryIds });
});

// Download all photos in a collection as a ZIP (one sub-folder per gallery)
app.get('/api/collection/:collectionId/download', downloadLimiter, validateCollectionId, (req, res) => {
    const { collectionId } = req.params;
    const collection = db.prepare(`SELECT name, downloads_enabled, audio_filename FROM collections WHERE id = ?`).get(collectionId);
    if (!collection) return res.status(404).json({ error: 'Collection not found' });
    if (collection.downloads_enabled === 0) {
        return res.status(403).json({ error: 'Downloads are disabled for this collection' });
    }

    const colName = collection.name || 'collection';
    const asciiColName = colName.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_').substring(0, 50) || 'collection';
    const encodedColName = encodeURIComponent(colName.substring(0, 200) + '.zip');

    const memberGalleryIds = db.prepare(`SELECT gallery_id FROM collection_galleries WHERE collection_id = ? ORDER BY position`).all(collectionId).map(r => r.gallery_id);

    // Pre-scan files for Content-Length and folder names (store mode)
    const entries = [];
    const includedGalleryIds = [];
    for (const galleryId of memberGalleryIds) {
        const gallery = db.prepare(`SELECT event_name FROM galleries WHERE id = ?`).get(galleryId);
        const galleryPath = safeResolvePath(path.join(DATA_DIR, 'uploads'), galleryId);
        if (!fs.existsSync(galleryPath)) continue;
        // zipSafeName, not just a truncation: a `/` in the event name would otherwise
        // split one gallery into nested folders inside the ZIP.
        const folderName = zipSafeName((gallery ? gallery.event_name : galleryId).substring(0, 80), galleryId);
        const files = fs.readdirSync(galleryPath).filter(f => !f.startsWith('.'));
        files.forEach(file => entries.push({ diskPath: path.join(galleryPath, file), zipName: `${folderName}/${file}` }));
        if (gallery) includedGalleryIds.push(galleryId);
    }

    // The collection's montage goes at the ZIP ROOT, beside the gallery folders —
    // it belongs to the whole event, not to any one gallery. Same two-condition
    // guard as GET /api/collection/:id (on disk AND recorded in the row).
    if (collection.audio_filename) {
        const audioFile = findAudioFile(`collection-${collectionId}`);
        if (audioFile) {
            entries.push({
                diskPath: safeResolvePath(AUDIO_DIR, audioFile),
                zipName: zipSafeName(collection.audio_filename, `montage${path.extname(audioFile)}`)
            });
        }
    }

    if (includedGalleryIds.length) {
        ops.bumpGalleryDownloadCounts(db, includedGalleryIds);
    }

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${asciiColName}.zip"; filename*=UTF-8''${encodedColName}`);

    const archive = archiver('zip', { store: true });
    archive.on('error', err => res.status(500).send({ error: err.message }));
    console.log(`[DOWNLOAD] Collection "${collection.name}" (${collectionId}) — ${entries.length} file(s) from ${resolveClientIp(req)}`);
    archive.pipe(res);
    entries.forEach(e => archive.file(e.diskPath, { name: e.zipName }));
    archive.finalize();
});

// Toggle downloads on/off for a collection
app.patch('/api/collection/:collectionId/downloads', adminLimiter, requireAuth, validateCollectionId, (req, res) => {
    const { collectionId } = req.params;
    const collectionExists = db.prepare(`SELECT 1 FROM collections WHERE id = ?`).get(collectionId);
    if (!collectionExists) return res.status(404).json({ error: 'Collection not found' });
    const enabled = req.body.enabled;
    if (enabled !== true && enabled !== false) {
        return res.status(400).json({ error: 'enabled must be a boolean' });
    }
    db.prepare(`UPDATE collections SET downloads_enabled = ? WHERE id = ?`).run(enabled ? 1 : 0, collectionId);
    res.json({ success: true, downloadsEnabled: enabled });
});

// Toggle comments on/off for a collection
app.patch('/api/collection/:collectionId/comments-enabled', adminLimiter, requireAuth, validateCollectionId, (req, res) => {
    const { collectionId } = req.params;
    const collectionExists = db.prepare(`SELECT 1 FROM collections WHERE id = ?`).get(collectionId);
    if (!collectionExists) return res.status(404).json({ error: 'Collection not found' });
    const enabled = req.body.enabled;
    if (enabled !== true && enabled !== false) {
        return res.status(400).json({ error: 'enabled must be a boolean' });
    }
    db.prepare(`UPDATE collections SET comments_enabled = ? WHERE id = ?`).run(enabled ? 1 : 0, collectionId);
    res.json({ success: true, commentsEnabled: enabled });
});

// Set the client-facing language override for a collection ('auto' clears the override)
app.patch('/api/collection/:collectionId/client-language', adminLimiter, requireAuth, validateCollectionId, (req, res) => {
    const { collectionId } = req.params;
    const collectionExists = db.prepare(`SELECT 1 FROM collections WHERE id = ?`).get(collectionId);
    if (!collectionExists) return res.status(404).json({ error: 'Collection not found' });

    const { language } = req.body;
    if (language !== 'auto' && !SUPPORTED_LANGUAGES.includes(language)) {
        return res.status(400).json({ error: 'Invalid language' });
    }

    const clientLanguage = language === 'auto' ? null : language;
    db.prepare(`UPDATE collections SET client_language = ? WHERE id = ?`).run(clientLanguage, collectionId);
    res.json({ success: true, clientLanguage: clientLanguage || 'auto' });
});

// Delete a collection (admin only — does NOT delete the galleries)
app.delete('/api/collection/:collectionId', adminLimiter, requireAuth, validateCollectionId, (req, res) => {
    const { collectionId } = req.params;
    const collection = db.prepare(`SELECT name FROM collections WHERE id = ?`).get(collectionId);
    if (!collection) return res.status(404).json({ error: 'Collection not found' });

    // Delete collection background (any extension)
    const backgroundsDir = path.join(DATA_DIR, 'backgrounds');
    if (fs.existsSync(backgroundsDir)) {
        const bgFile = fs.readdirSync(backgroundsDir).find(f => f.startsWith(`collection-${collectionId}`));
        if (bgFile) {
            try { fs.unlinkSync(safeResolvePath(backgroundsDir, bgFile)); } catch (_) {}
        }
    }

    // Delete the audio montage (any extension)
    deleteAudioFiles(`collection-${collectionId}`);

    console.log(`[COLLECTION] Deleted "${collection.name}" (${collectionId})`);
    db.prepare(`DELETE FROM collections WHERE id = ?`).run(collectionId); // cascades collection_galleries only — member galleries are untouched
    res.json({ success: true });
});

// Collection page — serves HTML with OG meta tags injected
app.get('/collection/:collectionId', publicReadLimiter, validateCollectionId, (req, res) => {
    const { collectionId } = req.params;
    const collection = db.prepare(`SELECT name FROM collections WHERE id = ?`).get(collectionId);
    if (!collection) return res.status(404).send('Collection not found');

    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const ogTags = [
        `<meta property="og:title" content="${escapeHtml(collection.name)}">`,
        `<meta property="og:description" content="${escapeHtml(ogDescription('collection', resolveCollectionClientLanguage(collectionId)))}">`,
        `<meta property="og:image" content="${escapeHtml(baseUrl)}/api/collection/${escapeHtml(collectionId)}/og-image">`,
        `<meta property="og:type" content="website">`,
        `<meta property="og:url" content="${escapeHtml(baseUrl)}/collection/${escapeHtml(collectionId)}">`
    ].join('\n    ');

    // Serves preview.html, which is the single client document for both routes:
    // it renders the collection index and mounts galleries in place on
    // #/gallery/:id, so the audio montage survives moving between galleries.
    // A separate collection page could not do that — navigating away would
    // destroy the <audio> element.
    const html = fs.readFileSync(path.join(__dirname, 'public', 'preview.html'), 'utf8');
    res.send(html.replace('<head>', `<head>\n    ${ogTags}`));
});

// List all galleries (admin)
app.get('/api/galleries', adminLimiter, requireAuth, (req, res) => {
    const galleryList = [];
    const uploadsDir = path.join(DATA_DIR, 'uploads');
    const backgroundsDir = path.join(DATA_DIR, 'backgrounds');

    const bgFiles = fs.existsSync(backgroundsDir)
        ? new Set(fs.readdirSync(backgroundsDir))
        : new Set();

    if (fs.existsSync(uploadsDir)) {
        const dirs = fs.readdirSync(uploadsDir);

        // Owning collection per gallery, computed once — replaces the old
        // per-gallery scan of every collection (UNIQUE(gallery_id) means at
        // most one row per gallery here).
        const ownerByGallery = new Map(
            db.prepare(`SELECT gallery_id, collection_id FROM collection_galleries`).all()
                .map(r => [r.gallery_id, r.collection_id])
        );

        // Computed once, outside the loop, so every gallery's isExpired is judged
        // against the same instant rather than drifting across a long directory scan.
        const nowIso = new Date().toISOString();

        dirs.forEach(galleryId => {
            const galleryPath = path.join(uploadsDir, galleryId);
            const stats = fs.statSync(galleryPath);

            if (!stats.isDirectory()) return;

            const files = fs.readdirSync(galleryPath).filter(f => !f.startsWith('.'));

            let gallery = db.prepare(`SELECT * FROM galleries WHERE id = ?`).get(galleryId);
            if (gallery && gallery.deleted) return; // exclude trashed galleries
            if (!gallery) {
                // Second, separate orphan-recovery site — distinct from
                // reconcileGalleries(), which only runs once at startup. A
                // folder created on disk after boot (e.g. by a parallel
                // upload still in flight) is recovered here instead.
                insertRecoveredGallery(galleryId, stats.birthtime.toISOString(), files);
                gallery = db.prepare(`SELECT * FROM galleries WHERE id = ?`).get(galleryId);
                console.log(`[STARTUP] Reconcile: recovered gallery ${galleryId} from disk (${files.length} file(s))`);
            }

            // `bgVersion` (background file mtime) lets the admin cards cache their
            // cover thumbnail: the URL only changes when the cover is actually
            // replaced. Never use Date.now() there — a per-render cache-buster
            // refetches every thumbnail on every keystroke and trips publicReadLimiter.
            const bgFile = [...bgFiles].find(f => f.startsWith(galleryId)) || null;
            const hasBackground = bgFile !== null;
            let bgVersion = null;
            if (bgFile) {
                try {
                    bgVersion = Math.floor(fs.statSync(safeResolvePath(backgroundsDir, bgFile)).mtimeMs);
                } catch (_) { /* file vanished between readdir and stat — treat as unversioned */ }
            }

            const favoritesCount = db.prepare(`SELECT COUNT(DISTINCT filename) AS n FROM favorites WHERE gallery_id = ?`).get(galleryId).n;
            const commentsCount = db.prepare(`SELECT COUNT(*) AS n FROM comments WHERE gallery_id = ?`).get(galleryId).n;

            galleryList.push({
                id: galleryId,
                eventName: gallery.event_name || 'Untitled Event',
                created: gallery.created_at || stats.birthtime.toISOString(),
                fileCount: files.length,
                hasBackground,
                bgVersion,
                favoritesCount,
                commentsCount,
                viewCount: gallery.view_count || 0,
                downloadCount: gallery.download_count || 0,
                collectionId: ownerByGallery.get(galleryId) || null,
                // `undefined` (not `null`) when never manually reordered —
                // JSON.stringify drops an undefined key entirely, matching the
                // old Map-based `gallery.order` being simply absent. admin.html's
                // own client-side sort relies on that same undefined-vs-null
                // distinction (see galleryRowToObject's comment above).
                order: gallery.sort_order === null ? undefined : gallery.sort_order,
                // Own montage, so the gallery card can show / replace / remove it.
                // Reported only when the file is actually still on disk.
                audio: (gallery.audio_filename && findAudioFile(`gallery-${galleryId}`))
                    ? { filename: gallery.audio_filename || null, duration: gallery.audio_duration ?? null, size: gallery.audio_size ?? null }
                    : null,
                downloadsEnabled: !!gallery.downloads_enabled,
                commentsEnabled: !!gallery.comments_enabled,
                clientLanguage: gallery.client_language || 'auto',
                lastModified: stats.mtime.toISOString(),
                hasPassword: !!gallery.password_hash,
                expiresAt: gallery.expires_at || null,
                isExpired: !!(gallery.expires_at && gallery.expires_at < nowIso),
                lightboxSize: gallery.lightbox_size,
                gridSpacing: gallery.grid_spacing,
                cornerStyle: gallery.corner_style
            });
        });
    }

    galleryList.sort((a, b) => {
        const oa = a.order;
        const ob = b.order;
        if (oa !== undefined && ob !== undefined) return oa - ob;
        if (oa !== undefined) return -1;
        if (ob !== undefined) return 1;
        return new Date(b.created) - new Date(a.created);
    });
    res.json(galleryList);
});

// Reorder galleries (admin only)
app.patch('/api/galleries/reorder', adminLimiter, requireAuth, (req, res) => {
    const { galleryIds } = req.body;
    if (!Array.isArray(galleryIds)) return res.status(400).json({ error: 'galleryIds must be an array' });
    db.transaction(() => {
        const stmt = db.prepare(`UPDATE galleries SET sort_order = ? WHERE id = ?`);
        galleryIds.forEach((id, idx) => stmt.run(idx, id));
    })();
    res.json({ success: true });
});

// Soft-delete gallery — moves to trash (files kept for TRASH_RETENTION_MS)
app.delete('/api/gallery/:galleryId', adminLimiter, requireAuth, validateGalleryId, (req, res) => {
    const { galleryId } = req.params;
    const row = db.prepare(`SELECT event_name FROM galleries WHERE id = ?`).get(galleryId);
    if (!row) return res.status(404).json({ error: 'Gallery not found' });

    ops.softDeleteGallery(db, galleryId, new Date().toISOString());
    console.log(`[GALLERY] Trashed "${row.event_name}" (${galleryId})`);
    res.json({ success: true });
});

// List trashed galleries
app.get('/api/galleries/trash', adminLimiter, requireAuth, (req, res) => {
    const uploadsDir = path.join(DATA_DIR, 'uploads');
    const backgroundsDir = path.join(DATA_DIR, 'backgrounds');
    const bgFiles = fs.existsSync(backgroundsDir) ? new Set(fs.readdirSync(backgroundsDir)) : new Set();

    const trashed = db.prepare(`SELECT id, event_name, deleted_at FROM galleries WHERE deleted = 1 ORDER BY deleted_at DESC`).all().map(g => {
        const galleryPath = path.join(uploadsDir, g.id);
        const fileCount = fs.existsSync(galleryPath)
            ? fs.readdirSync(galleryPath).filter(f => !f.startsWith('.')).length : 0;
        const hasBackground = [...bgFiles].some(f => f.startsWith(g.id));
        const daysLeft = Math.ceil((TRASH_RETENTION_MS - (Date.now() - new Date(g.deleted_at).getTime())) / 86400000);
        return { id: g.id, eventName: g.event_name, deletedAt: g.deleted_at, daysLeft: Math.max(0, daysLeft), fileCount, hasBackground };
    });
    res.json(trashed);
});

// Restore gallery from trash
app.post('/api/gallery/:galleryId/restore', adminLimiter, requireAuth, validateGalleryId, (req, res) => {
    const { galleryId } = req.params;
    const row = db.prepare(`SELECT event_name, deleted FROM galleries WHERE id = ?`).get(galleryId);
    if (!row || !row.deleted) return res.status(404).json({ error: 'Gallery not in trash' });

    ops.restoreGallery(db, galleryId);
    console.log(`[GALLERY] Restored "${row.event_name}" (${galleryId})`);
    res.json({ success: true });
});

// Permanently delete a single gallery from trash
app.delete('/api/gallery/:galleryId/purge', adminLimiter, requireAuth, validateGalleryId, (req, res) => {
    const { galleryId } = req.params;
    const row = db.prepare(`SELECT event_name FROM galleries WHERE id = ?`).get(galleryId);
    if (!row) return res.status(404).json({ error: 'Gallery not found' });
    const purgedName = row.event_name;
    hardDeleteGallery(galleryId);
    console.log(`[GALLERY] Purged "${purgedName}" (${galleryId})`);
    res.json({ success: true });
});

// Empty entire trash
app.delete('/api/galleries/trash', adminLimiter, requireAuth, (req, res) => {
    const ids = db.prepare(`SELECT id FROM galleries WHERE deleted = 1`).all().map(r => r.id);
    const purged = ops.purgeWithTolerance(ids, hardDeleteGallery);
    console.log(`[GALLERY] Trash emptied — ${purged} gallery(ies) purged`);
    res.json({ success: true, purged });
});

// Error handling — never expose internal details (file paths, stack traces) to the client
app.use((err, req, res, next) => {
    const status = err.status || err.statusCode || 500;
    // Multer errors have a user-safe code; surface only those
    if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: 'File too large' });
    }
    console.error(`[ERROR] ${req.method} ${req.path} → ${status}: ${err.message}`);
    if (status >= 500) console.error(err.stack || err);
    res.status(status).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
    const activeGalleries = db.prepare(`SELECT COUNT(*) AS n FROM galleries WHERE deleted = 0`).get().n;
    const trashedGalleries = db.prepare(`SELECT COUNT(*) AS n FROM galleries WHERE deleted = 1`).get().n;
    const collectionCount = db.prepare(`SELECT COUNT(*) AS n FROM collections`).get().n;
    console.log(`[STARTUP] Delyvr running on port ${PORT}`);
    console.log(`[STARTUP] Data dir: ${DATA_DIR} | Trust proxy: ${TRUST_PROXY}`);
    if (ADMIN_ALLOWED_IPS.length > 0) console.log(`[STARTUP] IP allowlist: ${ADMIN_ALLOWED_IPS.join(', ')}`);
    console.log(`[STARTUP] ${activeGalleries} gallery(ies) active, ${trashedGalleries} in trash | ${collectionCount} collection(s)`);

    // Generate missing previews in background after server is ready
    setImmediate(async () => {
        let totalMissing = 0;
        const galleryIds = db.prepare(`SELECT id FROM galleries`).all().map(r => r.id);
        for (const galleryId of galleryIds) {
            const galleryPath = path.join(DATA_DIR, 'uploads', galleryId);
            if (!fs.existsSync(galleryPath)) continue;
            const files = fs.readdirSync(galleryPath).filter(f => !f.startsWith('.'));
            const missing = files.filter(f => {
                const p = path.join(PREVIEWS_DIR, galleryId, f + '.jpg');
                return !fs.existsSync(p);
            });
            if (missing.length > 0) {
                totalMissing += missing.length;
                const images = missing.filter(f => !isVideoFile(f));
                const videos = missing.filter(f => isVideoFile(f));
                generateGalleryPreviews(galleryId, images).catch(() => {});
                videos.forEach(f => generateVideoPoster(galleryId, f).catch(() => {}));
            }
        }
        if (totalMissing > 0) console.log(`[STARTUP] Generating ${totalMissing} missing preview(s) in background`);
    });
});
