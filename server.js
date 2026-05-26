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
const MAX_BACKGROUND_BYTES = parseInt(process.env.MAX_BACKGROUND_MB || '25') * 1024 * 1024;

// Install directory — where Node.js stores uploads, backgrounds, and galleries.json
// Docker: always /data (set via environment in docker-compose.yml)
// Bare-metal: defaults to the project directory
const DATA_DIR = process.env.INSTALL_DIR || __dirname;

const THUMBNAILS_DIR = path.join(DATA_DIR, 'thumbnails');
const PREVIEWS_DIR   = path.join(DATA_DIR, 'previews');
const OG_CACHE_DIR   = path.join(DATA_DIR, 'og-cache');

// UUID v4 validation regex — used by middleware and reconcileGalleries (must be declared early)
const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

// Data store for galleries (in production, use a database)
const galleries = new Map();

// File to persist gallery metadata
const GALLERIES_FILE = path.join(DATA_DIR, 'galleries.json');

// Data store for collections
const collections = new Map();
const COLLECTIONS_FILE = path.join(DATA_DIR, 'collections.json');
const SETTINGS_FILE    = path.join(DATA_DIR, 'settings.json');

const SETTINGS_DEFAULTS = {
    theme: 'dark',
    website: '',
    socials: {}
};

// Load/save settings
function loadSettings() {
    try {
        if (fs.existsSync(SETTINGS_FILE)) {
            const data = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
            return {
                ...SETTINGS_DEFAULTS,
                ...data,
                socials: { ...SETTINGS_DEFAULTS.socials, ...(data.socials || {}) }
            };
        }
    } catch (e) {
        console.error('[SETTINGS] Failed to parse settings.json, using defaults:', e.message);
    }
    return { ...SETTINGS_DEFAULTS };
}
function saveSettings(s) {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2));
}

// Load galleries from file on startup
function loadGalleries() {
    if (fs.existsSync(GALLERIES_FILE)) {
        try {
            const data = JSON.parse(fs.readFileSync(GALLERIES_FILE, 'utf8'));
            data.forEach(g => galleries.set(g.id, g));
        } catch (err) {
            console.error('Error loading galleries:', err);
        }
    }
}

// Save galleries to file
function saveGalleries() {
    const data = Array.from(galleries.values());
    fs.writeFileSync(GALLERIES_FILE, JSON.stringify(data, null, 2));
}

// Returns the gallery only if it exists and is not soft-deleted
function getActiveGallery(galleryId) {
    const g = galleries.get(galleryId);
    return (g && !g.deleted) ? g : null;
}

// Hard-delete all files for a gallery (used by purge and auto-expiry)
function hardDeleteGallery(galleryId) {
    const galleryPath = safeResolvePath(path.join(DATA_DIR, 'uploads'), galleryId);
    if (fs.existsSync(galleryPath)) fs.rmSync(galleryPath, { recursive: true });
    const backgroundsDir = path.join(DATA_DIR, 'backgrounds');
    if (fs.existsSync(backgroundsDir)) {
        const bgFile = fs.readdirSync(backgroundsDir).find(f => f.startsWith(galleryId));
        if (bgFile) fs.unlinkSync(path.join(backgroundsDir, bgFile));
    }
    fs.rmSync(safeResolvePath(THUMBNAILS_DIR, galleryId), { recursive: true, force: true });
    fs.rmSync(safeResolvePath(PREVIEWS_DIR, galleryId), { recursive: true, force: true });
    try { fs.unlinkSync(safeResolvePath(OG_CACHE_DIR, `${galleryId}.jpg`)); } catch (_) {}
    galleries.delete(galleryId);
    for (const collection of collections.values()) {
        const before = collection.galleryIds.length;
        collection.galleryIds = collection.galleryIds.filter(id => id !== galleryId);
        if (collection.galleryIds.length !== before) saveCollections();
    }
}

// Auto-purge soft-deleted galleries older than TRASH_RETENTION_DAYS
const TRASH_RETENTION_MS = 3 * 24 * 60 * 60 * 1000; // 3 days
function purgeExpiredTrash() {
    const now = Date.now();
    let changed = false;
    for (const [id, g] of galleries.entries()) {
        if (g.deleted && g.deletedAt && (now - new Date(g.deletedAt).getTime()) > TRASH_RETENTION_MS) {
            console.log(`[STARTUP] Auto-purge: gallery "${g.eventName}" (${id}) deleted at ${g.deletedAt}`);
            hardDeleteGallery(id);
            changed = true;
        }
    }
    if (changed) saveGalleries();
}

// Load collections from file on startup
function loadCollections() {
    if (fs.existsSync(COLLECTIONS_FILE)) {
        try {
            const data = JSON.parse(fs.readFileSync(COLLECTIONS_FILE, 'utf8'));
            data.forEach(c => collections.set(c.id, c));
        } catch (err) {
            console.error('Error loading collections:', err);
        }
    }
}

// Save collections to file
function saveCollections() {
    const data = Array.from(collections.values());
    fs.writeFileSync(COLLECTIONS_FILE, JSON.stringify(data, null, 2));
}

// Reconcile galleries.json with the uploads directory on disk.
// Runs once on startup to handle two cases:
//   1. Entry in JSON but no uploads folder → remove the stale entry
//   2. Uploads folder exists but no JSON entry → recover with placeholder metadata
function reconcileGalleries() {
    const uploadsDir = path.join(DATA_DIR, 'uploads');
    let changed = false;

    // Case 1: stale JSON entries with no corresponding uploads folder
    for (const galleryId of galleries.keys()) {
        if (!fs.existsSync(path.join(uploadsDir, galleryId))) {
            galleries.delete(galleryId);
            console.log(`[STARTUP] Reconcile: removed stale entry ${galleryId} (no uploads folder)`);
            changed = true;
        }
    }

    // Case 2: uploads folders on disk with no JSON entry
    if (fs.existsSync(uploadsDir)) {
        for (const entry of fs.readdirSync(uploadsDir)) {
            if (!UUID_V4_REGEX.test(entry)) continue;
            if (galleries.has(entry)) continue;
            const galleryPath = path.join(uploadsDir, entry);
            if (!fs.statSync(galleryPath).isDirectory()) continue;
            const files = fs.readdirSync(galleryPath).filter(f => !f.startsWith('.'));
            galleries.set(entry, {
                id: entry,
                eventName: 'Untitled Event',
                created: fs.statSync(galleryPath).birthtime.toISOString(),
                files,
                background: null,
                downloadCount: 0,
                viewCount: 0,
                viewerHashes: [],
                dimensions: {}
            });
            console.log(`[STARTUP] Reconcile: recovered gallery ${entry} from disk (${files.length} file(s))`);
            changed = true;
        }
    }

    if (changed) saveGalleries();

    // Case 3: clean orphan files/folders in thumbnails, previews, backgrounds, og-cache
    // whose galleryId no longer exists in the registry
    const knownIds = new Set(galleries.keys());

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
        const knownCollectionIds = new Set(collections.keys());
        for (const entry of fs.readdirSync(bgDir)) {
            const base = entry.replace(/\.[^.]+$/, '');
            if (base.startsWith('collection-')) {
                const cid = base.slice('collection-'.length);
                if (knownCollectionIds.has(cid)) continue;
            } else if (knownIds.has(base)) {
                continue;
            }
            try { fs.unlinkSync(path.join(bgDir, entry)); } catch (_) {}
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

loadGalleries();
loadCollections();
reconcileGalleries();
purgeExpiredTrash();

// Ensure directories exist
['uploads', 'backgrounds', 'thumbnails', 'previews', 'og-cache'].forEach(dir => {
    const dirPath = path.join(DATA_DIR, dir);
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
});
if (!fs.existsSync(path.join(__dirname, 'public'))) {
    fs.mkdirSync(path.join(__dirname, 'public'), { recursive: true });
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



// Store photo dimensions on the gallery object so the justified layout
// can render immediately without waiting for images to load.
// Format: gallery.dimensions = { [filename]: { w, h } }
function setPhotoDimensions(galleryId, filename, w, h) {
    const gallery = galleries.get(galleryId);
    if (!gallery) return;
    if (!gallery.dimensions) gallery.dimensions = {};
    if (!w || !h) return;
    const prev = gallery.dimensions[filename];
    if (prev && prev.w === w && prev.h === h) return;
    gallery.dimensions[filename] = { w, h };
    saveGalleries();
}

// Read dimensions from sharp metadata (handles EXIF orientation).
async function readDimensions(srcPath) {
    try {
        const meta = await sharp(srcPath).metadata();
        const orientation = meta.orientation || 1;
        // Orientations 5-8 swap width and height
        const swap = orientation >= 5 && orientation <= 8;
        const w = swap ? meta.height : meta.width;
        const h = swap ? meta.width : meta.height;
        return { w, h };
    } catch (_) {
        return null;
    }
}

// Generate a 400px-wide JPEG thumbnail for a single photo
async function generateThumbnail(galleryId, filename) {
    const src  = safeResolvePath(safeResolvePath(path.join(DATA_DIR, 'uploads'), galleryId), filename);
    const dir  = safeResolvePath(THUMBNAILS_DIR, galleryId);
    const dest = safeResolvePath(dir, filename + '.jpg');

    // Opportunistically capture dimensions (cheap: sharp opens the file anyway)
    const gallery = galleries.get(galleryId);
    if (gallery && (!gallery.dimensions || !gallery.dimensions[filename])) {
        const dims = await readDimensions(src);
        if (dims) setPhotoDimensions(galleryId, filename, dims.w, dims.h);
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
    const gallery = galleries.get(galleryId);
    if (gallery && (!gallery.dimensions || !gallery.dimensions[filename])) {
        const dims = await readDimensions(src);
        if (dims) setPhotoDimensions(galleryId, filename, dims.w, dims.h);
    }

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
        const safeName = file.originalname
            .normalize('NFC')
            .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')  // forbidden on Windows & Unix
            .replace(/^\.+/, '_')                       // no hidden files
            .trim() || 'photo';
        cb(null, safeName);
    }
});

const upload = multer({
    storage,
    limits: { fileSize: MAX_PHOTO_BYTES },
    fileFilter: (req, file, cb) => {
        const allowedTypes = /jpeg|jpg|png|gif|webp|tiff|bmp|raw|cr2|nef|arw/i;
        const ext = path.extname(file.originalname).toLowerCase().slice(1);
        const mime = file.mimetype;
        if (allowedTypes.test(ext) || mime.startsWith('image/')) {
            cb(null, true);
        } else {
            cb(new Error('Only image files are allowed'), false);
        }
    }
});

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

// ── SETTINGS ────────────────────────────────────────────────────────────────

// GET /api/settings — public (used by customer/collection/preview for theme + socials)
app.get('/api/settings', (req, res) => {
    res.json(loadSettings());
});

// POST /api/settings — admin only
app.post('/api/settings', requireAuth, (req, res) => {
    const current = loadSettings();
    const { theme, website, socials } = req.body;
    if (theme === 'light' || theme === 'dark') current.theme = theme;
    if (typeof website === 'string') current.website = website.trim().substring(0, 500);
    if (socials && typeof socials === 'object') {
        current.socials = current.socials || {};
        for (const [k, v] of Object.entries(socials)) {
            if (typeof v === 'string') current.socials[k] = v.trim().substring(0, 500);
        }
    }
    saveSettings(current);
    res.json(current);
});

// PATCH /api/settings/theme — alias used by admin theme toggle
app.patch('/api/settings/theme', requireAuth, (req, res) => {
    const current = loadSettings();
    const { theme } = req.body;
    if (theme === 'light' || theme === 'dark') {
        current.theme = theme;
        saveSettings(current);
        console.log(`[SETTINGS] Theme changed to ${theme}`);
    }
    res.json(current);
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

// Rate limiter for admin routes that perform filesystem operations — 60 per minute per IP
const adminLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, please slow down' }
});

// Rate limiter for general public GET endpoints — 300 requests per minute per IP
const publicReadLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 300,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, please slow down' }
});

// Rate limiter for public write endpoints (favorites toggle) — 120 per minute per IP
const publicWriteLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, please slow down' }
});

// Rate limiter for ZIP downloads — 10 per minute per IP (CPU + bandwidth intensive)
const downloadLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many download requests, please slow down' }
});

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
app.get('/api/auth/session', (req, res) => {
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
app.post('/api/auth/logout', (req, res) => {
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

// Middleware to generate galleryId BEFORE multer processes files
function generateGalleryId(req, res, next) {
    const galleryId = uuidv4();
    req.galleryId = galleryId;
    galleries.set(galleryId, {
        id: galleryId,
        eventName: '',
        created: new Date().toISOString(),
        files: [],
        background: null,
        downloadCount: 0,
        viewCount: 0,
        viewerHashes: [],
        dimensions: {}
    });
    next();
}

// Create new gallery and upload photos
app.post('/api/gallery/create', requireAuth, generateGalleryId, upload.array('photos', 500), (req, res) => {
    const galleryId = req.galleryId;
    const gallery = galleries.get(galleryId);

    // If multer processed no files, clean up the skeleton gallery and return an error
    // so the admin never receives a link for an empty gallery that would 404
    if (!req.files || req.files.length === 0) {
        galleries.delete(galleryId);
        saveGalleries();
        return res.status(400).json({ error: 'No photos were uploaded. Please select at least one image.' });
    }

    if (gallery) {
        gallery.files = req.files.map(f => f.filename);
        gallery.eventName = (String(Array.isArray(req.body.eventName) ? req.body.eventName[0] : (req.body.eventName || 'Untitled Event'))).trim().substring(0, 200);
        saveGalleries();
        generateGalleryThumbnails(galleryId, gallery.files).catch(() => {});
        generateGalleryPreviews(galleryId, gallery.files).catch(() => {});
        console.log(`[GALLERY] Created "${gallery.eventName}" (${galleryId}) — ${gallery.files.length} photo(s)`);
    }

    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const downloadUrl = `${baseUrl}/download/${galleryId}`;

    res.json({
        success: true,
        galleryId,
        downloadUrl,
        fileCount: Array.isArray(req.files) ? req.files.length : 0
    });
});

// Add more photos to existing gallery
app.post('/api/gallery/:galleryId/upload', requireAuth, validateGalleryId, upload.array('photos', 500), (req, res) => {
    const { galleryId } = req.params;
    const gallery = galleries.get(galleryId);

    if (!gallery) {
        return res.status(404).json({ error: 'Gallery not found' });
    }

    if (req.files) {
        const newFiles = req.files.map(f => f.filename);
        gallery.files.push(...newFiles);
        saveGalleries();
        generateGalleryThumbnails(galleryId, newFiles).catch(() => {});
        generateGalleryPreviews(galleryId, newFiles).catch(() => {});
        console.log(`[UPLOAD] Added ${newFiles.length} photo(s) to "${gallery.eventName}" (${galleryId})`);
    }

    res.json({
        success: true,
        fileCount: gallery.files.length
    });
});

// Upload/replace background image — converts to JPEG via sharp
app.post('/api/gallery/:galleryId/background', adminLimiter, requireAuth, validateGalleryId, uploadBackground.single('background'), async (req, res) => {
    const { galleryId } = req.params;
    const gallery = galleries.get(galleryId);

    if (!gallery) {
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
            if (existing) fs.unlinkSync(path.join(backgroundsDir, existing));
        }

        // Invalidate og-cache so it is regenerated with the new image
        const ogFile = safeResolvePath(OG_CACHE_DIR, `${galleryId}.jpg`);
        if (fs.existsSync(ogFile)) fs.unlinkSync(ogFile);

        // Convert and save as JPEG
        const dest = path.join(backgroundsDir, `${galleryId}.jpg`);
        await sharp(req.file.buffer)
            .resize(2400, null, { withoutEnlargement: true })
            .jpeg({ quality: 85 })
            .toFile(dest);

        gallery.background = `${galleryId}.jpg`;
        saveGalleries();
        console.log(`[GALLERY] Background updated for "${gallery.eventName}" (${galleryId})`);
        res.json({ success: true, background: gallery.background });
    } catch (err) {
        console.error(`[GALLERY] Background processing failed for ${galleryId}: ${err.message}`);
        res.status(500).json({ error: 'Failed to process background image' });
    }
});

// Serve background image (legacy route — kept for backwards compatibility)
app.get('/api/background/:galleryId', publicReadLimiter, validateGalleryId, (req, res) => {
    const { galleryId } = req.params;
    const backgroundsDir = path.join(DATA_DIR, 'backgrounds');

    if (fs.existsSync(backgroundsDir)) {
        const backgroundFile = fs.readdirSync(backgroundsDir).find(f => f.startsWith(galleryId));
        if (backgroundFile) {
            return res.sendFile(path.join(backgroundsDir, backgroundFile));
        }
    }

    res.status(404).send('Background not found');
});

// Serve background image (REST-style route used by admin.html and customer.html)
app.get('/api/gallery/:galleryId/background', publicReadLimiter, validateGalleryId, (req, res) => {
    const { galleryId } = req.params;
    const backgroundsDir = path.join(DATA_DIR, 'backgrounds');

    if (fs.existsSync(backgroundsDir)) {
        const backgroundFile = fs.readdirSync(backgroundsDir).find(f => f.startsWith(galleryId));
        if (backgroundFile) {
            const fullPath = path.join(backgroundsDir, backgroundFile);
            if (req.query.thumb === '1') {
                res.setHeader('Content-Type', 'image/jpeg');
                res.setHeader('Cache-Control', 'public, max-age=86400');
                return sharp(fullPath)
                    .resize(200, 200, { fit: 'cover' })
                    .jpeg({ quality: 75 })
                    .pipe(res);
            }
            if (req.query.card === '1') {
                res.setHeader('Content-Type', 'image/jpeg');
                res.setHeader('Cache-Control', 'public, max-age=86400');
                return sharp(fullPath)
                    .resize(800, null, { fit: 'inside', withoutEnlargement: true })
                    .jpeg({ quality: 82 })
                    .pipe(res);
            }
            return res.sendFile(fullPath);
        }
    }

    res.status(404).send('Background not found');
});

// Toggle downloads on/off for a gallery
app.patch('/api/gallery/:galleryId/downloads', requireAuth, validateGalleryId, (req, res) => {
    const { galleryId } = req.params;
    const gallery = galleries.get(galleryId);

    if (!gallery) {
        return res.status(404).json({ error: 'Gallery not found' });
    }

    const enabled = req.body.enabled;
    if (enabled !== true && enabled !== false) {
        return res.status(400).json({ error: 'enabled must be a boolean' });
    }

    gallery.downloadsEnabled = enabled;
    saveGalleries();

    res.json({ success: true, downloadsEnabled: gallery.downloadsEnabled });
});

// Rename a gallery
app.post('/api/gallery/:galleryId/rename', requireAuth, validateGalleryId, (req, res) => {
    const { galleryId } = req.params;
    const gallery = galleries.get(galleryId);

    if (!gallery) {
        return res.status(404).json({ error: 'Gallery not found' });
    }

    const oldName = gallery.eventName;
    gallery.eventName = (String(Array.isArray(req.body.eventName) ? req.body.eventName[0] : (req.body.eventName || 'Untitled Event'))).trim().substring(0, 200);
    saveGalleries();
    console.log(`[GALLERY] Renamed "${oldName}" → "${gallery.eventName}" (${galleryId})`);
    res.json({ success: true, eventName: gallery.eventName });
});

// List photos in a gallery (used by preview.html)
app.get('/api/gallery/:galleryId/photos', publicReadLimiter, validateGalleryId, async (req, res) => {
    const { galleryId } = req.params;
    const galleryPath = safeResolvePath(path.join(DATA_DIR, 'uploads'), galleryId);

    if (!fs.existsSync(galleryPath)) {
        return res.status(404).json({ error: 'Gallery not found' });
    }

    const files = fs.readdirSync(galleryPath)
        .filter(f => !f.startsWith('.'))
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));

    const gallery = galleries.get(galleryId);
    if (gallery && !gallery.dimensions) gallery.dimensions = {};

    // Fill in missing dimensions for legacy galleries (one-time cost per photo).
    // Subsequent requests hit the in-memory cache.
    const missing = gallery
        ? files.filter(f => !gallery.dimensions[f])
        : [];

    if (missing.length > 0) {
        await Promise.all(missing.map(async filename => {
            const src = safeResolvePath(galleryPath, filename);
            const dims = await readDimensions(src);
            if (dims) {
                gallery.dimensions[filename] = { w: dims.w, h: dims.h };
            }
        }));
        saveGalleries();
    }

    const photos = files.map(filename => {
        const dims = gallery && gallery.dimensions ? gallery.dimensions[filename] : null;
        return {
            filename,
            url:         `/api/gallery/${galleryId}/photo/${encodeURIComponent(filename)}`,
            previewUrl:  `/api/gallery/${galleryId}/photo/${encodeURIComponent(filename)}?preview=1`,
            thumbnailUrl:`/api/gallery/${galleryId}/photo/${encodeURIComponent(filename)}?thumb=1`,
            downloadUrl: `/api/gallery/${galleryId}/download/${encodeURIComponent(filename)}`,
            width:  dims ? dims.w : null,
            height: dims ? dims.h : null
        };
    });

    // Return shape matches what preview.html expects: { id, eventName, photos: [...] }
    res.json({
        id: galleryId,
        eventName: gallery ? gallery.eventName : 'Untitled Event',
        photos
    });
});

// Serve a single photo (original or thumbnail)
app.get('/api/gallery/:galleryId/photo/:filename', imageLimiter, validateGalleryId, validateFilename, async (req, res) => {
    const { galleryId, filename } = req.params;

    if (req.query.thumb === '1') {
        const thumbPath = safeResolvePath(safeResolvePath(THUMBNAILS_DIR, galleryId), filename + '.jpg');

        if (!fs.existsSync(thumbPath)) {
            // Generate on-the-fly if missing
            await generateThumbnail(galleryId, filename);
        }

        if (fs.existsSync(thumbPath)) {
            return res.sendFile(thumbPath);
        }
        // Fall through to original if thumbnail generation failed
    }

    if (req.query.preview === '1') {
        const previewPath = safeResolvePath(safeResolvePath(PREVIEWS_DIR, galleryId), filename + '.jpg');

        if (fs.existsSync(previewPath)) {
            return res.sendFile(previewPath);
        }

        // Preview missing — serve original immediately and generate in background
        generatePreview(galleryId, filename).catch(() => {});
        // Fall through to serve original
    }

    const filePath = safeResolvePath(safeResolvePath(path.join(DATA_DIR, 'uploads'), galleryId), filename);
    if (!fs.existsSync(filePath)) {
        return res.status(404).send('Photo not found');
    }
    res.sendFile(filePath);
});

// Returns true if any collection containing this gallery has downloadsEnabled === false
function isGalleryBlockedByCollection(galleryId) {
    for (const collection of collections.values()) {
        if (collection.galleryIds.includes(galleryId) && collection.downloadsEnabled === false) {
            return true;
        }
    }
    return false;
}

// Download a single photo as an attachment
app.get('/api/gallery/:galleryId/download/:filename', downloadLimiter, validateGalleryId, validateFilename, (req, res) => {
    const { galleryId, filename } = req.params;

    const gallery = galleries.get(galleryId);
    if (gallery && gallery.downloadsEnabled === false) {
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
    const gallery = galleries.get(galleryId);
    if (!gallery) return res.status(404).json({ error: 'Gallery not found' });

    const uploadPath = safeResolvePath(safeResolvePath(path.join(DATA_DIR, 'uploads'), galleryId), filename);
    if (!fs.existsSync(uploadPath)) return res.status(404).json({ error: 'Photo not found' });

    // Remove file
    fs.unlinkSync(uploadPath);

    // Remove thumbnail (ignore if missing)
    try { fs.unlinkSync(safeResolvePath(safeResolvePath(THUMBNAILS_DIR, galleryId), filename + '.jpg')); } catch (_) {}

    // Remove preview (ignore if missing)
    try { fs.unlinkSync(safeResolvePath(safeResolvePath(PREVIEWS_DIR, galleryId), filename + '.jpg')); } catch (_) {}

    // Remove from gallery.files
    gallery.files = (gallery.files || []).filter(f => f !== filename);

    // Invalidate OG cache (it may have used this photo)
    try { fs.unlinkSync(safeResolvePath(OG_CACHE_DIR, `${galleryId}.jpg`)); } catch (_) {}

    saveGalleries();
    res.json({ success: true, fileCount: gallery.files.length });
});

// Serve/generate OG image (1200×630 JPEG, cached)
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
        if (bgFile) sourceFile = path.join(backgroundsDir, bgFile);
    }

    if (!sourceFile) {
        const galleryPath = safeResolvePath(path.join(DATA_DIR, 'uploads'), galleryId);
        if (!fs.existsSync(galleryPath)) return res.status(404).send('Gallery not found');
        const files = fs.readdirSync(galleryPath).filter(f => !f.startsWith('.'));
        if (files.length === 0) return res.status(404).send('No photos');
        sourceFile = path.join(galleryPath, files[0]);
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
        if (colBg) sourceFile = path.join(backgroundsDir, colBg);
    }
    if (!sourceFile) {
        const collection = collections.get(collectionId);
        if (collection) {
            for (const gid of collection.galleryIds) {
                if (sourceFile) break;
                if (fs.existsSync(backgroundsDir)) {
                    const gbg = fs.readdirSync(backgroundsDir).find(f => f.startsWith(gid));
                    if (gbg) { sourceFile = path.join(backgroundsDir, gbg); break; }
                }
                const gPath = safeResolvePath(path.join(DATA_DIR, 'uploads'), gid);
                if (fs.existsSync(gPath)) {
                    const files = fs.readdirSync(gPath).filter(f => !f.startsWith('.'));
                    if (files.length > 0) sourceFile = path.join(gPath, files[0]);
                }
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

// Customer download page — serves HTML with OG meta tags injected
app.get('/download/:galleryId', publicReadLimiter, validateGalleryId, (req, res) => {
    const { galleryId } = req.params;
    const galleryPath = safeResolvePath(path.join(DATA_DIR, 'uploads'), galleryId);

    if (!fs.existsSync(galleryPath) || !getActiveGallery(galleryId)) {
        return res.status(404).send('Gallery not found');
    }

    const gallery = galleries.get(galleryId);
    const eventName = gallery ? gallery.eventName : 'Your Photos';
    const baseUrl = `${req.protocol}://${req.get('host')}`;

    const ogTags = [
        `<meta property="og:title" content="${escapeHtml(eventName)}">`,
        `<meta property="og:description" content="Your photos are ready to download.">`,
        `<meta property="og:image" content="${escapeHtml(baseUrl)}/api/gallery/${escapeHtml(galleryId)}/og-image">`,
        `<meta property="og:type" content="website">`,
        `<meta property="og:url" content="${escapeHtml(baseUrl)}/download/${escapeHtml(galleryId)}">`
    ].join('\n    ');

    const html = fs.readFileSync(path.join(__dirname, 'public', 'customer.html'), 'utf8');
    res.send(html.replace('<head>', `<head>\n    ${ogTags}`));
});

// Preview page — serves HTML with OG meta tags injected
app.get('/preview/:galleryId', publicReadLimiter, validateGalleryId, (req, res) => {
    const { galleryId } = req.params;
    const galleryPath = safeResolvePath(path.join(DATA_DIR, 'uploads'), galleryId);

    if (!fs.existsSync(galleryPath) || !getActiveGallery(galleryId)) {
        return res.status(404).send('Gallery not found');
    }

    const gallery = galleries.get(galleryId);
    const eventName = gallery ? gallery.eventName : 'Your Photos';
    const baseUrl = `${req.protocol}://${req.get('host')}`;

    const ogTags = [
        `<meta property="og:title" content="${escapeHtml(eventName)}">`,
        `<meta property="og:description" content="Browse and download individual photos.">`,
        `<meta property="og:image" content="${escapeHtml(baseUrl)}/api/gallery/${escapeHtml(galleryId)}/og-image">`,
        `<meta property="og:type" content="website">`,
        `<meta property="og:url" content="${escapeHtml(baseUrl)}/preview/${escapeHtml(galleryId)}">`
    ].join('\n    ');

    const html = fs.readFileSync(path.join(__dirname, 'public', 'preview.html'), 'utf8');
    res.send(html.replace('<head>', `<head>\n    ${ogTags}`));
});

// Get gallery info (for customer and preview pages)
app.get('/api/gallery/:galleryId/info', publicReadLimiter, validateGalleryId, (req, res) => {
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

    const gallery = galleries.get(galleryId);
    const eventName = gallery ? gallery.eventName : 'Your Photos';

    // Track unique views via hash of IP + User-Agent
    if (gallery) {
        const ip = resolveClientIp(req);
        const ua = req.headers['user-agent'] || '';
        const hash = crypto.createHash('sha256').update(ip + ua).digest('hex');
        if (!Array.isArray(gallery.viewerHashes)) gallery.viewerHashes = [];
        if (!gallery.viewerHashes.includes(hash)) {
            gallery.viewerHashes.push(hash);
            gallery.viewCount = (gallery.viewCount || 0) + 1;
            saveGalleries();
        }
    }

    let totalSizeBytes = 0;
    if (fs.existsSync(galleryPath)) {
        fs.readdirSync(galleryPath).filter(f => !f.startsWith('.')).forEach(f => {
            try { totalSizeBytes += fs.statSync(path.join(galleryPath, f)).size; } catch (_) {}
        });
    }

    res.json({
        galleryId,
        eventName,
        background: backgroundFile ? `/api/gallery/${galleryId}/background` : null,
        fileCount,
        totalSizeBytes,
        downloadsEnabled: gallery ? (gallery.downloadsEnabled !== false && !isGalleryBlockedByCollection(galleryId)) : true,
        downloadCount: gallery ? (gallery.downloadCount || 0) : 0,
        viewCount: gallery ? (gallery.viewCount || 0) : 0
    });
});

// Download all photos as ZIP
app.get('/api/gallery/:galleryId/download', downloadLimiter, validateGalleryId, (req, res) => {
    const { galleryId } = req.params;
    const galleryPath = safeResolvePath(path.join(DATA_DIR, 'uploads'), galleryId);

    if (!fs.existsSync(galleryPath)) {
        return res.status(404).json({ error: 'Gallery not found' });
    }

    const gallery = galleries.get(galleryId);
    if (gallery && gallery.downloadsEnabled === false) {
        return res.status(403).json({ error: 'Downloads are disabled for this gallery' });
    }
    if (isGalleryBlockedByCollection(galleryId)) {
        return res.status(403).json({ error: 'Downloads are disabled for this collection' });
    }

    // Track download count
    if (gallery) {
        gallery.downloadCount = (gallery.downloadCount || 0) + 1;
        saveGalleries();
        console.log(`[DOWNLOAD] Gallery "${gallery.eventName}" (${galleryId}) — #${gallery.downloadCount} from ${resolveClientIp(req)}`);
    }

    const files = fs.readdirSync(galleryPath).filter(f => !f.startsWith('.'));

    if (files.length === 0) {
        return res.status(404).json({ error: 'No files in gallery' });
    }

    const eventName = gallery && gallery.eventName ? gallery.eventName : 'photos';
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
    archive.finalize();
});

// Toggle favorite for a photo (public, no auth) — per visitor
app.post('/api/gallery/:galleryId/favorites', publicWriteLimiter, validateGalleryId, (req, res) => {
    const { galleryId } = req.params;
    const { filename, visitorId } = req.body;

    if (typeof filename !== 'string' || !SAFE_FILENAME_RE.test(filename)) {
        return res.status(400).json({ error: 'Invalid filename' });
    }
    if (typeof visitorId !== 'string' || visitorId.length < 4 || visitorId.length > 64 || !/^[a-zA-Z0-9_-]+$/.test(visitorId)) {
        return res.status(400).json({ error: 'Invalid visitorId' });
    }

    const gallery = galleries.get(galleryId);
    if (!gallery) {
        return res.status(404).json({ error: 'Gallery not found' });
    }

    if (!gallery.favorites || Array.isArray(gallery.favorites)) gallery.favorites = {};

    if (!gallery.favorites[filename]) gallery.favorites[filename] = [];

    const idx = gallery.favorites[filename].indexOf(visitorId);
    if (idx === -1) {
        gallery.favorites[filename].push(visitorId);
    } else {
        gallery.favorites[filename].splice(idx, 1);
        if (gallery.favorites[filename].length === 0) {
            delete gallery.favorites[filename];
        }
    }

    saveGalleries();
    res.json({
        success: true,
        favorited: idx === -1,
        votes: (gallery.favorites[filename] || []).length
    });
});

// Get favorites for this visitor (public — used by preview page on load)
app.get('/api/gallery/:galleryId/favorites-public', publicReadLimiter, validateGalleryId, (req, res) => {
    const { galleryId } = req.params;
    const { visitorId } = req.query;
    const gallery = galleries.get(galleryId);
    if (!gallery) {
        return res.status(404).json({ error: 'Gallery not found' });
    }
    const favs = gallery.favorites || {};
    // Return only the photos this visitor has voted for
    const myFavorites = Object.keys(favs).filter(f => favs[f].includes(visitorId));
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
        `<meta property="og:description" content="Client favorite photos from ${escapeHtml(eventName)}.">`,
        `<meta property="og:image" content="${escapeHtml(baseUrl)}/api/gallery/${escapeHtml(galleryId)}/og-image">`,
        `<meta property="og:type" content="website">`,
        `<meta property="og:url" content="${escapeHtml(baseUrl)}/favorites/${escapeHtml(galleryId)}">`
    ].join('\n    ');
    const html = fs.readFileSync(path.join(__dirname, 'public', 'favorites.html'), 'utf8');
    res.send(html.replace('<head>', `<head>\n    ${ogTags}`));
});

// Public API: favorites sorted by vote count (used by favorites.html)
app.get('/api/gallery/:galleryId/favorites-ranked', publicReadLimiter, validateGalleryId, (req, res) => {
    const { galleryId } = req.params;
    const gallery = getActiveGallery(galleryId);
    if (!gallery) return res.status(404).json({ error: 'Gallery not found' });

    const favs = gallery.favorites || {};
    const photos = Object.entries(favs)
        .map(([filename, voters]) => ({ filename, votes: voters.length }))
        .filter(r => r.votes > 0)
        .sort((a, b) => b.votes - a.votes)
        .map(({ filename, votes }) => {
            const dims = gallery.dimensions?.[filename];
            return {
                filename, votes,
                thumbnailUrl: `/api/gallery/${galleryId}/photo/${encodeURIComponent(filename)}?thumb=1`,
                previewUrl:   `/api/gallery/${galleryId}/photo/${encodeURIComponent(filename)}?preview=1`,
                width: dims?.w || null,
                height: dims?.h || null
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
app.get('/api/gallery/:galleryId/favorites', requireAuth, validateGalleryId, (req, res) => {
    const { galleryId } = req.params;
    const gallery = galleries.get(galleryId);
    if (!gallery) {
        return res.status(404).json({ error: 'Gallery not found' });
    }
    const favs = gallery.favorites || {};
    const sorted = Object.entries(favs)
        .map(([filename, voters]) => ({ filename, votes: voters.length }))
        .sort((a, b) => b.votes - a.votes);
    res.json({ favorites: sorted });
});

// Reset view count for a gallery (admin only)
app.delete('/api/gallery/:galleryId/views', adminLimiter, requireAuth, validateGalleryId, (req, res) => {
    const { galleryId } = req.params;
    const gallery = galleries.get(galleryId);
    if (!gallery) return res.status(404).json({ error: 'Gallery not found' });
    gallery.viewCount = 0;
    gallery.viewerHashes = [];
    saveGalleries();
    console.log(`[GALLERY] Views reset for "${gallery.eventName}" (${galleryId})`);
    res.json({ success: true });
});

app.delete('/api/gallery/:galleryId/favorites', requireAuth, validateGalleryId, (req, res) => {
    const { galleryId } = req.params;
    const gallery = galleries.get(galleryId);
    if (!gallery) {
        return res.status(404).json({ error: 'Gallery not found' });
    }
    gallery.favorites = {};
    saveGalleries();
    console.log(`[GALLERY] Favorites reset for "${gallery.eventName}" (${galleryId})`);
    res.json({ success: true });
});

// Export favorites as CSV
app.get('/api/gallery/:galleryId/favorites/export', publicReadLimiter, validateGalleryId, (req, res) => {
    const { galleryId } = req.params;
    const gallery = galleries.get(galleryId);
    if (!gallery) return res.status(404).json({ error: 'Gallery not found' });

    const favs = gallery.favorites || {};
    const rows = Object.entries(favs)
        .map(([filename, voters]) => ({ filename, votes: voters.length }))
        .filter(r => r.votes > 0)
        .sort((a, b) => b.votes - a.votes);

    const eventName = gallery.eventName || 'favorites';
    const asciiName = eventName.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_').substring(0, 50) + '_favorites';
    const encodedName = encodeURIComponent(eventName.substring(0, 200) + '_favorites.csv');

    // UTF-8 BOM so Excel opens the file with correct encoding
    const bom = '﻿';
    const csv = bom + ['filename,votes', ...rows.map(r => `"${r.filename.replace(/"/g, '""')}",${r.votes}`)].join('\r\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${asciiName}.csv"; filename*=UTF-8''${encodedName}`);
    res.send(csv);
});

// Download favorite photos as ZIP
app.get('/api/gallery/:galleryId/favorites/download', downloadLimiter, requireAuth, validateGalleryId, (req, res) => {
    const { galleryId } = req.params;
    const gallery = galleries.get(galleryId);
    if (!gallery) return res.status(404).json({ error: 'Gallery not found' });

    const favs = gallery.favorites || {};
    const filenames = Object.entries(favs)
        .filter(([, voters]) => voters.length > 0)
        .sort((a, b) => b[1].length - a[1].length)
        .map(([filename]) => filename);

    if (filenames.length === 0) return res.status(404).json({ error: 'No favorites' });

    const galleryPath = safeResolvePath(path.join(DATA_DIR, 'uploads'), galleryId);
    const name = (gallery.eventName || 'favorites').replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_').substring(0, 50) || 'favorites';
    const encodedName = encodeURIComponent((gallery.eventName || 'favorites').substring(0, 200) + '_favorites.zip');

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

// --- Collection routes ---

function validateCollectionId(req, res, next) {
    if (!UUID_V4_REGEX.test(req.params.collectionId)) {
        return res.status(400).json({ error: 'Invalid collection ID' });
    }
    next();
}

// Create a new collection (admin only)
app.post('/api/collection/create', requireAuth, (req, res) => {
    const rawName = req.body.name;
    if (typeof rawName !== 'string' && rawName !== undefined) {
        return res.status(400).json({ error: 'name must be a string' });
    }
    const name = (String(rawName || 'Untitled Collection')).trim().substring(0, 200);
    const id = uuidv4();
    collections.set(id, {
        id,
        name,
        created: new Date().toISOString(),
        galleryIds: [],
        downloadsEnabled: true
    });
    saveCollections();
    console.log(`[COLLECTION] Created "${name}" (${id})`);
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    res.json({ success: true, id, collectionUrl: `${baseUrl}/collection/${id}` });
});

// List all collections (admin only)
app.get('/api/collections', adminLimiter, requireAuth, (req, res) => {
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const bgDirC = path.join(DATA_DIR, 'backgrounds');
    const bgFilesC = fs.existsSync(bgDirC) ? new Set(fs.readdirSync(bgDirC)) : new Set();
    const list = Array.from(collections.values())
        .sort((a, b) => new Date(b.created) - new Date(a.created))
        .map(c => ({
            id: c.id,
            name: c.name,
            created: c.created,
            galleryIds: c.galleryIds,
            collectionUrl: `${baseUrl}/collection/${c.id}`,
            hasBackground: [...bgFilesC].some(f => f.startsWith(`collection-${c.id}`))
        }));
    res.json(list);
});

// Get collection info (public — used by collection page)
app.get('/api/collection/:collectionId', publicReadLimiter, validateCollectionId, (req, res) => {
    const { collectionId } = req.params;
    const collection = collections.get(collectionId);
    if (!collection) return res.status(404).json({ error: 'Collection not found' });

    const backgroundsDir = path.join(DATA_DIR, 'backgrounds');
    const bgFiles = fs.existsSync(backgroundsDir)
        ? new Set(fs.readdirSync(backgroundsDir))
        : new Set();

    let totalSizeBytes = 0;
    const galleriesData = collection.galleryIds
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
            const collDownloads = collection.downloadsEnabled !== false;
            return {
                id: gid,
                eventName: gallery.eventName || 'Untitled Event',
                fileCount,
                background: hasBackground ? `/api/gallery/${gid}/background` : null,
                downloadsEnabled: collDownloads && gallery.downloadsEnabled !== false
            };
        })
        .filter(Boolean);

    const collBgFiles = fs.existsSync(backgroundsDir) ? [...new Set(fs.readdirSync(backgroundsDir))] : [];
    const collHasBg = collBgFiles.some(f => f.startsWith(`collection-${collectionId}`));
    res.json({
        id: collectionId,
        name: collection.name,
        background: collHasBg ? `/api/collection/${collectionId}/background` : null,
        downloadsEnabled: collection.downloadsEnabled !== false,
        totalSizeBytes,
        galleries: galleriesData
    });
});

// Rename a collection (admin only)
app.post('/api/collection/:collectionId/rename', requireAuth, validateCollectionId, (req, res) => {
    const { collectionId } = req.params;
    const collection = collections.get(collectionId);
    if (!collection) return res.status(404).json({ error: 'Collection not found' });
    const oldColName = collection.name;
    collection.name = (String(Array.isArray(req.body.name) ? req.body.name[0] : (req.body.name || 'Untitled Collection'))).trim().substring(0, 200);
    saveCollections();
    console.log(`[COLLECTION] Renamed "${oldColName}" → "${collection.name}" (${collectionId})`);
    res.json({ success: true, name: collection.name });
});

// Upload/replace collection background image
app.post('/api/collection/:collectionId/background', adminLimiter, requireAuth, validateCollectionId, uploadBackground.single('background'), async (req, res) => {
    const { collectionId } = req.params;
    const collection = collections.get(collectionId);
    if (!collection) return res.status(404).json({ error: 'Collection not found' });
    if (!req.file) return res.status(400).json({ error: 'No background file provided' });
    try {
        const backgroundsDir = path.join(DATA_DIR, 'backgrounds');
        if (!fs.existsSync(backgroundsDir)) fs.mkdirSync(backgroundsDir, { recursive: true });
        const existing = fs.readdirSync(backgroundsDir).find(f => f.startsWith(`collection-${collectionId}`));
        if (existing) fs.unlinkSync(path.join(backgroundsDir, existing));
        const dest = path.join(backgroundsDir, `collection-${collectionId}.jpg`);
        await sharp(req.file.buffer)
            .resize(2400, null, { withoutEnlargement: true })
            .jpeg({ quality: 85 })
            .toFile(dest);
        collection.background = `collection-${collectionId}.jpg`;
        saveCollections();
        console.log(`[COLLECTION] Background updated for "${collection.name}" (${collectionId})`);
        res.json({ success: true, background: collection.background });
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
            const fullPath = path.join(backgroundsDir, file);
            if (req.query.thumb === '1') {
                res.setHeader('Content-Type', 'image/jpeg');
                res.setHeader('Cache-Control', 'public, max-age=86400');
                return sharp(fullPath)
                    .resize(200, 200, { fit: 'cover' })
                    .jpeg({ quality: 75 })
                    .pipe(res);
            }
            if (req.query.card === '1') {
                res.setHeader('Content-Type', 'image/jpeg');
                res.setHeader('Cache-Control', 'public, max-age=86400');
                return sharp(fullPath)
                    .resize(800, null, { fit: 'inside', withoutEnlargement: true })
                    .jpeg({ quality: 82 })
                    .pipe(res);
            }
            return res.sendFile(fullPath);
        }
    }
    res.status(404).json({ error: 'No background found' });
});

// Add a gallery to a collection (admin only)
app.post('/api/collection/:collectionId/galleries', requireAuth, validateCollectionId, (req, res) => {
    const { collectionId } = req.params;
    const { galleryId } = req.body;

    if (typeof galleryId !== 'string' || !UUID_V4_REGEX.test(galleryId)) {
        return res.status(400).json({ error: 'Invalid gallery ID' });
    }

    const collection = collections.get(collectionId);
    if (!collection) return res.status(404).json({ error: 'Collection not found' });

    if (!galleries.get(galleryId)) {
        return res.status(404).json({ error: 'Gallery not found' });
    }

    // Enforce one gallery = one collection
    for (const [cid, c] of collections.entries()) {
        if (cid !== collectionId && c.galleryIds.includes(galleryId)) {
            return res.status(409).json({ error: 'Gallery already belongs to another collection' });
        }
    }

    if (!collection.galleryIds.includes(galleryId)) {
        collection.galleryIds.push(galleryId);
        saveCollections();
    }

    res.json({ success: true, galleryIds: collection.galleryIds });
});

// Reorder galleries within a collection (admin only)
app.patch('/api/collection/:collectionId/galleries/reorder', requireAuth, validateCollectionId, (req, res) => {
    const { collectionId } = req.params;
    const { galleryIds } = req.body;
    const collection = collections.get(collectionId);
    if (!collection) return res.status(404).json({ error: 'Collection not found' });
    if (!Array.isArray(galleryIds)) return res.status(400).json({ error: 'galleryIds must be an array' });
    // Only accept IDs already in the collection — prevents injection
    const valid = new Set(collection.galleryIds);
    if (!galleryIds.every(id => valid.has(id)) || galleryIds.length !== collection.galleryIds.length) {
        return res.status(400).json({ error: 'Invalid galleryIds' });
    }
    collection.galleryIds = galleryIds;
    saveCollections();
    res.json({ success: true, galleryIds: collection.galleryIds });
});

// Remove a gallery from a collection (admin only)
app.delete('/api/collection/:collectionId/galleries/:galleryId', requireAuth, validateCollectionId, validateGalleryId, (req, res) => {
    const { collectionId, galleryId } = req.params;
    const collection = collections.get(collectionId);
    if (!collection) return res.status(404).json({ error: 'Collection not found' });
    collection.galleryIds = collection.galleryIds.filter(id => id !== galleryId);
    saveCollections();
    res.json({ success: true, galleryIds: collection.galleryIds });
});

// Download all photos in a collection as a ZIP (one sub-folder per gallery)
app.get('/api/collection/:collectionId/download', downloadLimiter, validateCollectionId, (req, res) => {
    const { collectionId } = req.params;
    const collection = collections.get(collectionId);
    if (!collection) return res.status(404).json({ error: 'Collection not found' });
    if (collection.downloadsEnabled === false) {
        return res.status(403).json({ error: 'Downloads are disabled for this collection' });
    }

    const colName = collection.name || 'collection';
    const asciiColName = colName.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_').substring(0, 50) || 'collection';
    const encodedColName = encodeURIComponent(colName.substring(0, 200) + '.zip');

    // Pre-scan files for Content-Length and folder names (store mode)
    const entries = [];
    for (const galleryId of collection.galleryIds) {
        const gallery = galleries.get(galleryId);
        const galleryPath = safeResolvePath(path.join(DATA_DIR, 'uploads'), galleryId);
        if (!fs.existsSync(galleryPath)) continue;
        const folderName = (gallery ? gallery.eventName : galleryId).substring(0, 80) || galleryId;
        const files = fs.readdirSync(galleryPath).filter(f => !f.startsWith('.'));
        files.forEach(file => entries.push({ diskPath: path.join(galleryPath, file), zipName: `${folderName}/${file}` }));
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
    const collection = collections.get(collectionId);
    if (!collection) return res.status(404).json({ error: 'Collection not found' });
    const enabled = req.body.enabled !== false;
    collection.downloadsEnabled = enabled;
    saveCollections();
    res.json({ success: true, downloadsEnabled: collection.downloadsEnabled });
});

// Delete a collection (admin only — does NOT delete the galleries)
app.delete('/api/collection/:collectionId', adminLimiter, requireAuth, validateCollectionId, (req, res) => {
    const { collectionId } = req.params;
    const collection = collections.get(collectionId);
    if (!collection) return res.status(404).json({ error: 'Collection not found' });

    // Delete collection background (any extension)
    const backgroundsDir = path.join(DATA_DIR, 'backgrounds');
    if (fs.existsSync(backgroundsDir)) {
        const bgFile = fs.readdirSync(backgroundsDir).find(f => f.startsWith(`collection-${collectionId}`));
        if (bgFile) {
            try { fs.unlinkSync(path.join(backgroundsDir, bgFile)); } catch (_) {}
        }
    }

    console.log(`[COLLECTION] Deleted "${collection.name}" (${collectionId})`);
    collections.delete(collectionId);
    saveCollections();
    res.json({ success: true });
});

// Collection page — serves HTML with OG meta tags injected
app.get('/collection/:collectionId', publicReadLimiter, validateCollectionId, (req, res) => {
    const { collectionId } = req.params;
    const collection = collections.get(collectionId);
    if (!collection) return res.status(404).send('Collection not found');

    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const ogTags = [
        `<meta property="og:title" content="${escapeHtml(collection.name)}">`,
        `<meta property="og:description" content="Your photo galleries are ready.">`,
        `<meta property="og:image" content="${escapeHtml(baseUrl)}/api/collection/${escapeHtml(collectionId)}/og-image">`,
        `<meta property="og:type" content="website">`,
        `<meta property="og:url" content="${escapeHtml(baseUrl)}/collection/${escapeHtml(collectionId)}">`
    ].join('\n    ');

    const html = fs.readFileSync(path.join(__dirname, 'public', 'collection.html'), 'utf8');
    res.send(html.replace('<head>', `<head>\n    ${ogTags}`));
});

// List all galleries (admin)
app.get('/api/galleries', adminLimiter, requireAuth, (req, res) => {
    const galleryList = [];
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const uploadsDir = path.join(DATA_DIR, 'uploads');
    const backgroundsDir = path.join(DATA_DIR, 'backgrounds');

    const bgFiles = fs.existsSync(backgroundsDir)
        ? new Set(fs.readdirSync(backgroundsDir))
        : new Set();

    if (fs.existsSync(uploadsDir)) {
        const dirs = fs.readdirSync(uploadsDir);

        dirs.forEach(galleryId => {
            const galleryPath = path.join(uploadsDir, galleryId);
            const stats = fs.statSync(galleryPath);

            if (stats.isDirectory()) {
                const files = fs.readdirSync(galleryPath).filter(f => !f.startsWith('.'));

                let gallery = galleries.get(galleryId);
                if (gallery && gallery.deleted) return; // exclude trashed galleries
                if (!gallery) {
                    gallery = {
                        id: galleryId,
                        eventName: 'Untitled Event',
                        created: stats.birthtime.toISOString(),
                        files,
                        background: null
                    };
                    galleries.set(galleryId, gallery);
                    saveGalleries();
                }

                const hasBackground = [...bgFiles].some(f => f.startsWith(galleryId));

                // Find which collection this gallery belongs to (if any)
                let collectionId = null;
                for (const [cid, c] of collections.entries()) {
                    if (c.galleryIds.includes(galleryId)) { collectionId = cid; break; }
                }

                galleryList.push({
                    id: galleryId,
                    eventName: gallery.eventName || 'Untitled Event',
                    created: gallery.created || stats.birthtime.toISOString(),
                    fileCount: files.length,
                    hasBackground,
                    downloadUrl: `${baseUrl}/download/${galleryId}`,
                    favoritesCount: Object.keys(gallery.favorites || {}).length,
                    viewCount: gallery.viewCount || 0,
                    downloadCount: gallery.downloadCount || 0,
                    collectionId,
                    downloadsEnabled: gallery.downloadsEnabled !== false
                });
            }
        });
    }

    galleryList.sort((a, b) => {
        const oa = galleries.get(a.id)?.order;
        const ob = galleries.get(b.id)?.order;
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
    galleryIds.forEach((id, idx) => {
        const g = galleries.get(id);
        if (g) g.order = idx;
    });
    saveGalleries();
    res.json({ success: true });
});

// Soft-delete gallery — moves to trash (files kept for TRASH_RETENTION_MS)
app.delete('/api/gallery/:galleryId', adminLimiter, requireAuth, validateGalleryId, (req, res) => {
    const { galleryId } = req.params;
    const gallery = galleries.get(galleryId);
    if (!gallery) return res.status(404).json({ error: 'Gallery not found' });
    gallery.deleted = true;
    gallery.deletedAt = new Date().toISOString();
    saveGalleries();
    console.log(`[GALLERY] Trashed "${gallery.eventName}" (${galleryId})`);
    // Remove from any collection it belongs to
    let collectionChanged = false;
    for (const collection of collections.values()) {
        const before = collection.galleryIds.length;
        collection.galleryIds = collection.galleryIds.filter(id => id !== galleryId);
        if (collection.galleryIds.length !== before) collectionChanged = true;
    }
    if (collectionChanged) saveCollections();
    res.json({ success: true });
});

// List trashed galleries
app.get('/api/galleries/trash', adminLimiter, requireAuth, (req, res) => {
    const uploadsDir = path.join(DATA_DIR, 'uploads');
    const backgroundsDir = path.join(DATA_DIR, 'backgrounds');
    const bgFiles = fs.existsSync(backgroundsDir) ? new Set(fs.readdirSync(backgroundsDir)) : new Set();
    const trashed = Array.from(galleries.values())
        .filter(g => g.deleted)
        .map(g => {
            const galleryPath = path.join(uploadsDir, g.id);
            const fileCount = fs.existsSync(galleryPath)
                ? fs.readdirSync(galleryPath).filter(f => !f.startsWith('.')).length : 0;
            const hasBackground = [...bgFiles].some(f => f.startsWith(g.id));
            const daysLeft = Math.ceil((TRASH_RETENTION_MS - (Date.now() - new Date(g.deletedAt).getTime())) / 86400000);
            return { id: g.id, eventName: g.eventName, deletedAt: g.deletedAt, daysLeft: Math.max(0, daysLeft), fileCount, hasBackground };
        })
        .sort((a, b) => new Date(b.deletedAt) - new Date(a.deletedAt));
    res.json(trashed);
});

// Restore gallery from trash
app.post('/api/gallery/:galleryId/restore', adminLimiter, requireAuth, validateGalleryId, (req, res) => {
    const { galleryId } = req.params;
    const gallery = galleries.get(galleryId);
    if (!gallery || !gallery.deleted) return res.status(404).json({ error: 'Gallery not in trash' });
    delete gallery.deleted;
    delete gallery.deletedAt;
    saveGalleries();
    console.log(`[GALLERY] Restored "${gallery.eventName}" (${galleryId})`);
    res.json({ success: true });
});

// Permanently delete a single gallery from trash
app.delete('/api/gallery/:galleryId/purge', adminLimiter, requireAuth, validateGalleryId, (req, res) => {
    const { galleryId } = req.params;
    const gallery = galleries.get(galleryId);
    if (!gallery) return res.status(404).json({ error: 'Gallery not found' });
    const purgedName = gallery.eventName;
    hardDeleteGallery(galleryId);
    saveGalleries();
    console.log(`[GALLERY] Purged "${purgedName}" (${galleryId})`);
    res.json({ success: true });
});

// Empty entire trash
app.delete('/api/galleries/trash', adminLimiter, requireAuth, (req, res) => {
    const ids = Array.from(galleries.values()).filter(g => g.deleted).map(g => g.id);
    ids.forEach(id => hardDeleteGallery(id));
    saveGalleries();
    console.log(`[GALLERY] Trash emptied — ${ids.length} gallery(ies) purged`);
    res.json({ success: true, purged: ids.length });
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
    const activeGalleries = Array.from(galleries.values()).filter(g => !g.deleted).length;
    const trashedGalleries = Array.from(galleries.values()).filter(g => g.deleted).length;
    console.log(`[STARTUP] Delyvr running on port ${PORT}`);
    console.log(`[STARTUP] Data dir: ${DATA_DIR} | Trust proxy: ${TRUST_PROXY}`);
    if (ADMIN_ALLOWED_IPS.length > 0) console.log(`[STARTUP] IP allowlist: ${ADMIN_ALLOWED_IPS.join(', ')}`);
    console.log(`[STARTUP] ${activeGalleries} gallery(ies) active, ${trashedGalleries} in trash | ${collections.size} collection(s)`);

    // Generate missing previews in background after server is ready
    setImmediate(async () => {
        let totalMissing = 0;
        for (const [galleryId, gallery] of galleries.entries()) {
            const galleryPath = path.join(DATA_DIR, 'uploads', galleryId);
            if (!fs.existsSync(galleryPath)) continue;
            const files = fs.readdirSync(galleryPath).filter(f => !f.startsWith('.'));
            const missing = files.filter(f => {
                const p = path.join(PREVIEWS_DIR, galleryId, f + '.jpg');
                return !fs.existsSync(p);
            });
            if (missing.length > 0) {
                totalMissing += missing.length;
                generateGalleryPreviews(galleryId, missing).catch(() => {});
            }
        }
        if (totalMissing > 0) console.log(`[STARTUP] Generating ${totalMissing} missing preview(s) in background`);
    });
});