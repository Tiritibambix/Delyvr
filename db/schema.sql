-- Delyvr SQLite schema.
--
-- Every statement is CREATE ... IF NOT EXISTS: this file is executed on every
-- connection open (see db/index.js), which is cheap and makes the schema
-- self-healing if a table were ever dropped by hand.
--
-- PRAGMAs are applied by the caller (db/index.js's openDatabase(), or the
-- migration script), not here — journal_mode is persisted in the database
-- file header, but synchronous/foreign_keys/busy_timeout are per-connection
-- and must be re-applied on every open. See CLAUDE.md's "Data persistence"
-- section for the full rationale behind every design choice below.

CREATE TABLE IF NOT EXISTS galleries (
    id                 TEXT PRIMARY KEY,                     -- UUID v4; format validated at the app layer (validateGalleryId) before any DB access
    event_name         TEXT NOT NULL DEFAULT 'Untitled Event',
    created_at         TEXT NOT NULL,                         -- ISO-8601 string; SQLite has no native datetime type
    background         TEXT,                                  -- bookkeeping only — presence is ALWAYS re-derived from disk at read time, never gate a response on this column alone
    downloads_enabled  INTEGER NOT NULL DEFAULT 1 CHECK (downloads_enabled IN (0,1)),
    comments_enabled   INTEGER NOT NULL DEFAULT 1 CHECK (comments_enabled IN (0,1)),
    download_count     INTEGER NOT NULL DEFAULT 0 CHECK (download_count >= 0),
    view_count         INTEGER NOT NULL DEFAULT 0 CHECK (view_count >= 0),
    client_language    TEXT CHECK (client_language IS NULL OR client_language IN ('en','fr','es','pt','it')),  -- NULL = "auto"; the literal string 'auto' is never stored here
    deleted            INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0,1)),
    deleted_at         TEXT,
    sort_order         INTEGER,                                -- NULL = never manually reordered; app sorts NULL-last, same as `undefined` today
    audio_filename     TEXT,
    audio_stored       TEXT,
    audio_size         INTEGER CHECK (audio_size IS NULL OR audio_size >= 0),
    audio_duration     REAL CHECK (audio_duration IS NULL OR audio_duration >= 0),  -- NULL is legitimate even when audio is present (ffprobe can fail) — deliberately outside the all-or-nothing group below
    audio_uploaded_at  TEXT,
    CHECK ( (deleted = 0 AND deleted_at IS NULL) OR (deleted = 1 AND deleted_at IS NOT NULL) ),
    CHECK ( (audio_filename IS NULL AND audio_stored IS NULL AND audio_size IS NULL AND audio_uploaded_at IS NULL)
         OR (audio_filename IS NOT NULL AND audio_stored IS NOT NULL AND audio_size IS NOT NULL AND audio_uploaded_at IS NOT NULL) )
);
CREATE INDEX IF NOT EXISTS idx_galleries_deleted_at ON galleries(deleted, deleted_at);

CREATE TABLE IF NOT EXISTS collections (
    id                 TEXT PRIMARY KEY,
    name               TEXT NOT NULL DEFAULT 'Untitled Collection',
    created_at         TEXT NOT NULL,
    background         TEXT,                                   -- same disk-authoritative caveat as galleries.background
    downloads_enabled  INTEGER NOT NULL DEFAULT 1 CHECK (downloads_enabled IN (0,1)),
    comments_enabled   INTEGER NOT NULL DEFAULT 1 CHECK (comments_enabled IN (0,1)),
    client_language    TEXT CHECK (client_language IS NULL OR client_language IN ('en','fr','es','pt','it')),
    audio_filename     TEXT,
    audio_stored       TEXT,
    audio_size         INTEGER CHECK (audio_size IS NULL OR audio_size >= 0),
    audio_duration     REAL CHECK (audio_duration IS NULL OR audio_duration >= 0),
    audio_uploaded_at  TEXT
    -- Deliberately NO deleted/deleted_at/sort_order columns: collections have no
    -- trash and no manual card ordering today — DELETE /api/collection/:id is a
    -- straight hard delete that never touches member galleries.
    ,
    CHECK ( (audio_filename IS NULL AND audio_stored IS NULL AND audio_size IS NULL AND audio_uploaded_at IS NULL)
         OR (audio_filename IS NOT NULL AND audio_stored IS NOT NULL AND audio_size IS NOT NULL AND audio_uploaded_at IS NOT NULL) )
);

-- Replaces collection.galleryIds[]. UNIQUE on gallery_id ALONE (not the composite
-- key) is what declaratively enforces "one gallery belongs to at most one
-- collection" — this is the entire point of normalizing this relationship into
-- its own table instead of leaving it as an array scanned by the app.
CREATE TABLE IF NOT EXISTS collection_galleries (
    collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
    gallery_id    TEXT NOT NULL UNIQUE REFERENCES galleries(id) ON DELETE CASCADE,
    position      INTEGER NOT NULL CHECK (position >= 0),      -- preserves galleryIds[] order, which IS the client-facing display order here (unlike gallery.files[] — see files table below)
    PRIMARY KEY (collection_id, gallery_id)
);
CREATE INDEX IF NOT EXISTS idx_collection_galleries_position ON collection_galleries(collection_id, position);

-- New first-class entity: replaces gallery.files[] (membership) and
-- gallery.dimensions{} (per-file optional metadata). Deliberately holds no
-- `type`/`kind` column — the type is always derived from the filename
-- extension via isVideoFile() at read time, never persisted, so storing one
-- here would be a redundant, driftable duplicate. Deliberately holds no
-- proofing/rating/color/status columns yet either — this table already has
-- the right shape (one row per gallery+filename) for that future work to be a
-- plain ALTER TABLE, without speculatively adding columns nobody has asked
-- for yet.
CREATE TABLE IF NOT EXISTS files (
    gallery_id TEXT NOT NULL REFERENCES galleries(id) ON DELETE CASCADE,
    filename   TEXT NOT NULL,
    width      INTEGER CHECK (width IS NULL OR width > 0),
    height     INTEGER CHECK (height IS NULL OR height > 0),
    duration   REAL CHECK (duration IS NULL OR duration >= 0),   -- video only
    animated   INTEGER CHECK (animated IS NULL OR animated IN (0,1)),  -- image only
    PRIMARY KEY (gallery_id, filename),
    CHECK (duration IS NULL OR animated IS NULL)                 -- never both set on the same row
);

-- Replaces gallery.favorites = { [filename]: visitorId[] }. The FK to `files`
-- means favoriting a filename with no files row (e.g. a photo already deleted)
-- fails with a constraint error instead of silently creating a permanent
-- phantom entry — see CLAUDE.md for why this is a deliberate, surfaced
-- behavior change from the old JSON model.
CREATE TABLE IF NOT EXISTS favorites (
    gallery_id TEXT NOT NULL,
    filename   TEXT NOT NULL,
    visitor_id TEXT NOT NULL CHECK (length(visitor_id) BETWEEN 4 AND 64),
    PRIMARY KEY (gallery_id, filename, visitor_id),
    FOREIGN KEY (gallery_id, filename) REFERENCES files(gallery_id, filename) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_favorites_gallery_visitor ON favorites(gallery_id, visitor_id);

-- Replaces gallery.comments = { [filename]: {...}[] }.
CREATE TABLE IF NOT EXISTS comments (
    id         TEXT PRIMARY KEY,                                -- uuidv4() at creation; no format CHECK — the app itself never validates this ID's shape on delete/lookup either (plain string equality), so this migration does not add new validation that wasn't there before
    gallery_id TEXT NOT NULL,
    filename   TEXT NOT NULL,
    visitor_id TEXT NOT NULL CHECK (length(visitor_id) BETWEEN 4 AND 64),
    name       TEXT CHECK (name IS NULL OR length(name) <= 60),
    text       TEXT NOT NULL CHECK (length(text) > 0 AND length(text) <= 500),
    created_at TEXT NOT NULL,
    FOREIGN KEY (gallery_id, filename) REFERENCES files(gallery_id, filename) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_comments_gallery_filename ON comments(gallery_id, filename);
CREATE INDEX IF NOT EXISTS idx_comments_gallery_created  ON comments(gallery_id, created_at);

-- Replaces gallery.viewerHashes[] (SHA-256 hex of IP+UA, dedup for unique-view counting).
CREATE TABLE IF NOT EXISTS viewer_hashes (
    gallery_id TEXT NOT NULL REFERENCES galleries(id) ON DELETE CASCADE,
    hash       TEXT NOT NULL CHECK (length(hash) = 64),          -- SHA-256 hex digest is always exactly 64 chars
    PRIMARY KEY (gallery_id, hash)
);

-- True singleton: exactly one row, id=1, enforced by the CHECK below.
-- NOTE: client_language here is a DIFFERENT domain than galleries/collections'
-- client_language above — this one is NOT NULL and DOES store the literal
-- string 'auto' (a singleton settings row has no "unset" concept; it must
-- always hold a concrete value). Do not unify these two CHECK lists.
CREATE TABLE IF NOT EXISTS settings (
    id              INTEGER PRIMARY KEY CHECK (id = 1),
    theme           TEXT NOT NULL DEFAULT 'dark' CHECK (theme IN ('light','dark')),
    website         TEXT NOT NULL DEFAULT '' CHECK (length(website) <= 500),
    admin_language  TEXT NOT NULL DEFAULT 'en' CHECK (admin_language IN ('en','fr','es','pt','it')),
    client_language TEXT NOT NULL DEFAULT 'auto' CHECK (client_language IN ('auto','en','fr','es','pt','it')),
    date_format     TEXT NOT NULL DEFAULT 'auto' CHECK (date_format IN ('auto','dmy','mdy','ymd')),
    -- Gallery slideshow, global for the whole site. Both are also added by
    -- ensureSettingsColumns() in db/index.js, because CREATE TABLE IF NOT EXISTS
    -- does nothing to an install that was migrated before these existed. Keep the
    -- two definitions identical.
    slideshow_interval   INTEGER NOT NULL DEFAULT 5 CHECK (slideshow_interval IN (3,5,8,12)),
    slideshow_transition TEXT NOT NULL DEFAULT 'fade' CHECK (slideshow_transition IN ('fade','slide','kenburns'))
);

-- Replaces settings.socials = { [networkKey]: url }. A key-value table rather
-- than a fixed-column layout or a JSON column: the server enforces NO fixed
-- key set (any key is accepted — the instagram/facebook/... list is purely a
-- client-side UI convention in shared.js), and a key-value table keeps every
-- query in this project plain SQL (SELECT/INSERT/DELETE) without introducing
-- SQLite's JSON functions anywhere else in the codebase.
CREATE TABLE IF NOT EXISTS settings_socials (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL CHECK (length(value) <= 500)
);
