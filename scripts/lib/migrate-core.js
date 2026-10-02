// Pure transform/decision logic for the JSON -> SQLite migration, kept
// separate from scripts/migrate-json-to-sqlite.js (the thin CLI wrapper that
// does file I/O, opens the database, and drives the transaction) so that:
//   1. test/migration.test.js can exercise every edge case without touching
//      a real database or the filesystem.
//   2. The migration script's own verification pass can recompute "what
//      should have been inserted" by calling these SAME functions a second
//      time, independently of the INSERT statements — so verification
//      catches a bug in the SQL binding code, not just a bug in the decision
//      logic (which would be invisible if verification reused the exact
//      same tally the insert path produced).
//
// No I/O happens in this file at all — every function here is a pure
// transform over plain JS values.

'use strict';

// Duplicated from server.js's isVideoFile()/VIDEO_EXTENSIONS rather than
// required from it: server.js is not requireable as a module (requiring it
// would execute the whole server — bind a port, exit(1) if ADMIN_PASSWORD is
// unset, etc.). Same judgment call as DATA_DIR resolution in the migration
// CLI: a 2-line duplication beats adding a shared module just for this.
const VIDEO_EXTENSIONS = new Set(['mp4', 'mov', 'webm', 'm4v']);
function isVideoFile(filename) {
    const ext = String(filename).split('.').pop().toLowerCase();
    return VIDEO_EXTENSIONS.has(ext);
}

const SETTINGS_DEFAULTS = {
    theme: 'dark',
    website: '',
    socials: {},
    adminLanguage: 'en',
    clientLanguage: 'auto',
    dateFormat: 'auto'
};

/**
 * Reproduces the live app's own defensive guard EXACTLY:
 *   if (!gallery.favorites || Array.isArray(gallery.favorites)) gallery.favorites = {};
 * A legacy array-shaped record (or an absent one) is treated as empty — its
 * contents are not recovered, matching what the running app itself already
 * does on every read. This is parity, not a migration bug.
 */
function legacyMapOrEmpty(raw) {
    if (!raw || Array.isArray(raw)) return {};
    return raw;
}

/**
 * Plans the full migration of one gallery object into row data for
 * `galleries`, `files`, `favorites`, `comments`, and `viewer_hashes`. Pure:
 * returns a plan, performs no I/O, throws only on a genuinely unrecoverable
 * record (no `id`).
 *
 * Non-fatal issues collected into `warnings` (one line each) rather than
 * thrown, mirroring exactly which cases the server's own code already
 * tolerates defensively:
 *   - missing `created` -> falls back to now(), warned
 *   - `deleted: true` with no matching `deletedAt` -> falls back to
 *     `created` (or now()), warned
 *   - a present but malformed `audio` object (missing one of
 *     filename/stored/size/uploadedAt) -> dropped entirely, warned (the
 *     schema's all-or-nothing CHECK on the audio columns would otherwise
 *     reject a half-populated row outright)
 *
 * Favorites/comments referencing a filename NOT present in this gallery's
 * (deduped) `files[]` are dropped, counted, and warned about rather than
 * inserted. This is a DELIBERATE, disclosed extension beyond what the
 * approved plan's prose spelled out: `DELETE /api/gallery/:id/photo/:filename`
 * has never cleaned up favorites/comments/dimensions for the deleted
 * filename (confirmed by direct code reading — see CLAUDE.md), so any
 * installation that has ever deleted a photo with existing favorites or
 * comments on it has such orphans sitting in its real galleries.json today.
 * The new `files` foreign key makes creating NEW orphans impossible going
 * forward (a deliberate, announced behavior change — see CLAUDE.md), but
 * migrating pre-existing ones verbatim would violate that same foreign key
 * and abort the ENTIRE migration over harmless, already-invisible cruft.
 * Dropping them here — loudly, with a count in the final summary, never
 * silently — is the correct one-time resolution.
 */
function planGalleryMigration(g) {
    if (!g || typeof g.id !== 'string' || !g.id) {
        throw new Error('Gallery record is missing a valid id — refusing to migrate it');
    }

    const warnings = [];

    const eventName = (typeof g.eventName === 'string' && g.eventName) ? g.eventName : 'Untitled Event';

    let createdAt = typeof g.created === 'string' && g.created ? g.created : null;
    if (!createdAt) {
        createdAt = new Date().toISOString();
        warnings.push(`gallery ${g.id}: missing "created" — defaulted to now (${createdAt})`);
    }

    const downloadsEnabled = g.downloadsEnabled === false ? 0 : 1;
    const commentsEnabled = g.commentsEnabled === false ? 0 : 1;
    const downloadCount = Number.isFinite(g.downloadCount) && g.downloadCount > 0 ? Math.floor(g.downloadCount) : 0;
    const viewCount = Number.isFinite(g.viewCount) && g.viewCount > 0 ? Math.floor(g.viewCount) : 0;

    // Null = "auto" (never the literal string 'auto' on this table — matches
    // the live app's own convention exactly). Any other value is passed
    // through as-is and left for the CHECK constraint to reject if invalid;
    // this script does not pre-validate against the language list itself —
    // one source of truth for "what's a valid language" (the schema), not two.
    const clientLanguage = (g.clientLanguage === null || g.clientLanguage === undefined) ? null : g.clientLanguage;

    const sortOrder = Number.isInteger(g.order) ? g.order : null;

    let deleted = 0;
    let deletedAt = null;
    if (g.deleted === true) {
        deleted = 1;
        if (typeof g.deletedAt === 'string' && g.deletedAt) {
            deletedAt = g.deletedAt;
        } else {
            deletedAt = createdAt;
            warnings.push(`gallery ${g.id}: deleted=true with no valid "deletedAt" — defaulted to ${deletedAt}`);
        }
    }

    let audio = { filename: null, stored: null, size: null, duration: null, uploadedAt: null };
    if (g.audio && typeof g.audio === 'object') {
        const a = g.audio;
        const complete = typeof a.filename === 'string' && a.filename
            && typeof a.stored === 'string' && a.stored
            && Number.isFinite(a.size)
            && typeof a.uploadedAt === 'string' && a.uploadedAt;
        if (complete) {
            audio = {
                filename: a.filename,
                stored: a.stored,
                size: a.size,
                duration: Number.isFinite(a.duration) ? a.duration : null,
                uploadedAt: a.uploadedAt
            };
        } else {
            warnings.push(`gallery ${g.id}: "audio" present but incomplete (missing filename/stored/size/uploadedAt) — dropped`);
        }
    }

    const row = {
        id: g.id,
        event_name: eventName.trim().substring(0, 200) || 'Untitled Event',
        created_at: createdAt,
        background: (typeof g.background === 'string' && g.background) ? g.background : null,
        downloads_enabled: downloadsEnabled,
        comments_enabled: commentsEnabled,
        download_count: downloadCount,
        view_count: viewCount,
        client_language: clientLanguage,
        deleted,
        deleted_at: deletedAt,
        sort_order: sortOrder,
        audio_filename: audio.filename,
        audio_stored: audio.stored,
        audio_size: audio.size,
        audio_duration: audio.duration,
        audio_uploaded_at: audio.uploadedAt
    };

    // files[] is a SET, not a display-ordered list (confirmed: GET /photos
    // always recomputes display order from a fresh disk readdir + stem sort,
    // never from this array — see CLAUDE.md's "Justified gallery layout").
    // Dedup defensively; iteration order is irrelevant.
    const fileSet = new Set(Array.isArray(g.files) ? g.files.filter(f => typeof f === 'string' && f) : []);
    const dimensions = (g.dimensions && typeof g.dimensions === 'object' && !Array.isArray(g.dimensions)) ? g.dimensions : {};

    const files = [...fileSet].map(filename => {
        const dims = dimensions[filename];
        const video = isVideoFile(filename);
        let width = null, height = null, duration = null, animated = null;
        if (dims && typeof dims === 'object') {
            if (Number.isFinite(dims.w) && dims.w > 0) width = dims.w;
            if (Number.isFinite(dims.h) && dims.h > 0) height = dims.h;
            if (video) {
                if (Number.isFinite(dims.duration)) duration = dims.duration;
                // animated deliberately stays null for a video row — the schema's
                // CHECK forbids setting both, and only images carry this flag.
            } else if ('animated' in dims) {
                animated = dims.animated ? 1 : 0;
            }
        }
        return { filename, width, height, duration, animated };
    });

    const favorites = [];
    let favoritesDropped = 0;
    const favSource = legacyMapOrEmpty(g.favorites);
    if (favSource && typeof favSource === 'object') {
        for (const [filename, voters] of Object.entries(favSource)) {
            if (!Array.isArray(voters) || voters.length === 0) continue;
            const visitorIds = [...new Set(voters.filter(v => typeof v === 'string' && v))];
            if (!fileSet.has(filename)) { favoritesDropped += visitorIds.length; continue; }
            for (const visitorId of visitorIds) favorites.push({ filename, visitorId });
        }
    }
    if (favoritesDropped > 0) {
        // Counts dropped FAVORITE ROWS (one per visitor per filename), matching
        // the granularity `commentsDropped` counts comments at below — both are
        // "how many rows would this have been" so the final summary line
        // ("dropped N favorite(s) and M comment(s)") compares like with like.
        warnings.push(`gallery ${g.id}: dropped ${favoritesDropped} favorite(s) referencing a photo no longer in this gallery's file list`);
    }

    const comments = [];
    let commentsDropped = 0;
    const commentSource = legacyMapOrEmpty(g.comments);
    if (commentSource && typeof commentSource === 'object') {
        for (const [filename, list] of Object.entries(commentSource)) {
            if (!Array.isArray(list) || list.length === 0) continue;
            if (!fileSet.has(filename)) { commentsDropped += list.length; continue; }
            for (const c of list) {
                if (!c || typeof c.id !== 'string' || !c.id) continue; // unrecoverable single comment, skip it defensively
                comments.push({
                    id: c.id,
                    filename,
                    visitorId: typeof c.visitorId === 'string' ? c.visitorId : '',
                    name: typeof c.name === 'string' && c.name ? c.name : null,
                    text: typeof c.text === 'string' ? c.text : '',
                    createdAt: typeof c.createdAt === 'string' && c.createdAt ? c.createdAt : new Date().toISOString()
                });
            }
        }
    }
    if (commentsDropped > 0) {
        warnings.push(`gallery ${g.id}: dropped ${commentsDropped} comment(s) referencing a photo no longer in this gallery's file list`);
    }

    const viewerHashes = [...new Set(Array.isArray(g.viewerHashes) ? g.viewerHashes.filter(h => typeof h === 'string' && h.length === 64) : [])];

    return { row, files, favorites, favoritesDropped, comments, commentsDropped, viewerHashes, warnings };
}

/**
 * Plans the migration of one collection object into row data for
 * `collections` and `collection_galleries`. Throws (does not warn-and-drop)
 * when a `galleryIds[]` entry references a gallery id that doesn't exist in
 * `knownGalleryIds` — unlike the favorites/comments orphan case above, no
 * code path in the live app can produce this: hardDeleteGallery() and the
 * soft-delete route both strip collection membership in the SAME operation
 * that removes/trashes the gallery, so a dangling reference here indicates
 * genuine corruption (manual edits, or a bug) worth surfacing loudly rather
 * than quietly dropping.
 */
function planCollectionMigration(c, knownGalleryIds) {
    if (!c || typeof c.id !== 'string' || !c.id) {
        throw new Error('Collection record is missing a valid id — refusing to migrate it');
    }

    const warnings = [];
    const name = (typeof c.name === 'string' && c.name) ? c.name : 'Untitled Collection';

    let createdAt = typeof c.created === 'string' && c.created ? c.created : null;
    if (!createdAt) {
        createdAt = new Date().toISOString();
        warnings.push(`collection ${c.id}: missing "created" — defaulted to now (${createdAt})`);
    }

    const downloadsEnabled = c.downloadsEnabled === false ? 0 : 1;
    const commentsEnabled = c.commentsEnabled === false ? 0 : 1;
    const clientLanguage = (c.clientLanguage === null || c.clientLanguage === undefined) ? null : c.clientLanguage;

    let audio = { filename: null, stored: null, size: null, duration: null, uploadedAt: null };
    if (c.audio && typeof c.audio === 'object') {
        const a = c.audio;
        const complete = typeof a.filename === 'string' && a.filename
            && typeof a.stored === 'string' && a.stored
            && Number.isFinite(a.size)
            && typeof a.uploadedAt === 'string' && a.uploadedAt;
        if (complete) {
            audio = {
                filename: a.filename,
                stored: a.stored,
                size: a.size,
                duration: Number.isFinite(a.duration) ? a.duration : null,
                uploadedAt: a.uploadedAt
            };
        } else {
            warnings.push(`collection ${c.id}: "audio" present but incomplete (missing filename/stored/size/uploadedAt) — dropped`);
        }
    }

    const row = {
        id: c.id,
        name: name.trim().substring(0, 200) || 'Untitled Collection',
        created_at: createdAt,
        background: (typeof c.background === 'string' && c.background) ? c.background : null,
        downloads_enabled: downloadsEnabled,
        comments_enabled: commentsEnabled,
        client_language: clientLanguage,
        audio_filename: audio.filename,
        audio_stored: audio.stored,
        audio_size: audio.size,
        audio_duration: audio.duration,
        audio_uploaded_at: audio.uploadedAt
    };

    const galleryIds = Array.isArray(c.galleryIds) ? c.galleryIds : [];
    const memberships = galleryIds.map((galleryId, position) => {
        if (typeof galleryId !== 'string' || !galleryId) {
            throw new Error(`collection ${c.id}: galleryIds[${position}] is not a valid id`);
        }
        if (!knownGalleryIds.has(galleryId)) {
            throw new Error(
                `collection ${c.id}: references gallery ${galleryId}, which does not exist in galleries.json. ` +
                `This is not a known/benign state (gallery deletion always cleans up collection membership in ` +
                `the live app) — refusing to guess, migration aborted.`
            );
        }
        return { galleryId, position };
    });

    return { row, memberships, warnings };
}

/**
 * Plans every collection, enforcing the cross-collection "a gallery belongs
 * to at most one collection" invariant ACROSS the whole batch (a single
 * `planCollectionMigration` call only ever sees one collection at a time, so
 * this cannot live there). Throws immediately, naming both collection ids
 * and the contested gallery id, the moment a second collection claims a
 * gallery an earlier one in this same list already claimed — never resolved
 * by silently picking a winner.
 */
function planAllCollections(collectionsJson, knownGalleryIds) {
    const plans = [];
    const assignedTo = new Map(); // galleryId -> collectionId that already claimed it
    for (const c of collectionsJson) {
        const plan = planCollectionMigration(c, knownGalleryIds);
        for (const m of plan.memberships) {
            const claimedBy = assignedTo.get(m.galleryId);
            if (claimedBy && claimedBy !== plan.row.id) {
                throw new Error(
                    `gallery ${m.galleryId} appears in both collection ${claimedBy} and collection ${plan.row.id} — ` +
                    `a gallery may belong to at most one collection. Refusing to guess which is correct; fix the ` +
                    `source collections.json and re-run.`
                );
            }
            assignedTo.set(m.galleryId, plan.row.id);
        }
        plans.push(plan);
    }
    return plans;
}

/**
 * Plans settings.json -> `settings` + `settings_socials`, merging with
 * SETTINGS_DEFAULTS exactly like the live app's loadSettings(). Unlike
 * galleries/collections, settings.clientLanguage DOES store the literal
 * string 'auto' (it's a singleton with no "unset" concept) — do not apply
 * the null-means-auto convention here.
 */
function planSettingsMigration(settingsJson) {
    const data = (settingsJson && typeof settingsJson === 'object' && !Array.isArray(settingsJson)) ? settingsJson : {};
    const merged = {
        ...SETTINGS_DEFAULTS,
        ...data,
        socials: { ...SETTINGS_DEFAULTS.socials, ...((data.socials && typeof data.socials === 'object') ? data.socials : {}) }
    };

    const row = {
        theme: merged.theme,
        website: typeof merged.website === 'string' ? merged.website.trim().substring(0, 500) : '',
        admin_language: merged.adminLanguage,
        client_language: merged.clientLanguage,
        date_format: merged.dateFormat
    };

    const socials = Object.entries(merged.socials)
        .filter(([, v]) => typeof v === 'string' && v)
        .map(([key, value]) => ({ key, value: value.trim().substring(0, 500) }));

    return { row, socials };
}

/**
 * Compares two { tableName: count } maps and throws a single Error listing
 * every mismatch if any table disagrees. Deliberately isolated so it is
 * directly unit-testable with a hand-built mismatched pair, rather than
 * only reachable by engineering an end-to-end migration failure.
 */
function verifyCounts(expected, actual) {
    const mismatches = [];
    for (const table of Object.keys(expected)) {
        if (expected[table] !== actual[table]) {
            mismatches.push(`${table}: expected ${expected[table]}, got ${actual[table]}`);
        }
    }
    if (mismatches.length > 0) {
        throw new Error(`Row count verification failed:\n  ${mismatches.join('\n  ')}`);
    }
}

/** First `n` + last `n` elements of `arr` (deduped by index), or the whole
 *  array when it already has `2n` elements or fewer. Used to bound the
 *  field-level spot-check to a fixed cost regardless of library size. */
function pickSample(arr, n = 5) {
    if (arr.length <= n * 2) return arr.slice();
    const seen = new Set();
    const out = [];
    for (const item of [...arr.slice(0, n), ...arr.slice(-n)]) {
        const key = item && item.id;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(item);
    }
    return out;
}

/** Diffs two flat row objects field-by-field. Numbers compare with a small
 *  epsilon (duration/size are floats round-tripped through SQLite REAL);
 *  everything else compares strictly, with `undefined` normalized to `null`
 *  since SQLite can only ever return the latter. Returns a list of
 *  { field, expected, actual } mismatches — empty when the rows agree. */
function diffRow(expectedRow, actualRow) {
    const mismatches = [];
    for (const field of Object.keys(expectedRow)) {
        const expected = expectedRow[field] === undefined ? null : expectedRow[field];
        const actual = actualRow ? actualRow[field] : undefined;
        const match = typeof expected === 'number' && typeof actual === 'number'
            ? Math.abs(expected - actual) < 1e-9
            : expected === actual;
        if (!match) mismatches.push({ field, expected, actual });
    }
    return mismatches;
}

module.exports = {
    legacyMapOrEmpty,
    planGalleryMigration,
    planCollectionMigration,
    planAllCollections,
    planSettingsMigration,
    verifyCounts,
    pickSample,
    diffRow,
    isVideoFile
};
