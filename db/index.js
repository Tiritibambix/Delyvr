// Delyvr — SQLite connection + schema bootstrap.
//
// better-sqlite3 (not the built-in node:sqlite, still stability "1.2 release
// candidate" as of mid-2026 and without a transaction() helper — see
// CLAUDE.md's "Data persistence" section for the full rationale).
//
// This module intentionally exposes only connection-opening and schema
// application, not a repository/DAO layer: every route in server.js keeps
// its own prepared statements inline, exactly mirroring how the old
// Map-backed helpers (getActiveGallery, hardDeleteGallery, ...) lived there
// too. Delyvr is a single-file server by design — this module exists only
// because connection setup and schema loading are genuinely shared between
// server.js and scripts/migrate-json-to-sqlite.js, not to start a new layer.

const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

// Columns added to `settings` after the first installs had already migrated.
// CREATE TABLE IF NOT EXISTS does NOT alter an existing table, so a column
// added to schema.sql alone would simply never appear on those installs and
// every SELECT naming it would throw at startup. Each entry is the exact
// column definition from schema.sql — keep the two in sync.
//
// ALTER TABLE ADD COLUMN accepts a CHECK constraint; its documented
// restrictions are PRIMARY KEY/UNIQUE, non-constant defaults, REFERENCES with
// foreign_keys on, and STORED generated columns. A NOT NULL column needs a
// non-null default, which every entry below has — existing rows take that
// default, which satisfies the CHECK by construction.
const SETTINGS_ADDED_COLUMNS = [
    ['slideshow_interval', `slideshow_interval INTEGER NOT NULL DEFAULT 5 CHECK (slideshow_interval IN (3,5,8,12))`],
    ['slideshow_transition', `slideshow_transition TEXT NOT NULL DEFAULT 'fade' CHECK (slideshow_transition IN ('fade','slide','kenburns'))`]
];

// Idempotent: reads the live column list and adds only what is missing. A no-op
// on a fresh database (schema.sql already created the columns) and on an
// already-upgraded one.
function ensureSettingsColumns(db) {
    const existing = db.pragma('table_info(settings)').map(c => c.name);
    if (existing.length === 0) return; // table absent — applySchema creates it with all columns
    for (const [name, ddl] of SETTINGS_ADDED_COLUMNS) {
        if (!existing.includes(name)) db.exec(`ALTER TABLE settings ADD COLUMN ${ddl}`);
    }
}

// Applies the schema (every statement is CREATE ... IF NOT EXISTS, so this is
// safe and cheap to re-run on every connection open — self-healing if a table
// were ever dropped by hand), then backfills any column added to an existing
// table after the fact.
function applySchema(db) {
    db.exec(fs.readFileSync(SCHEMA_PATH, 'utf8'));
    ensureSettingsColumns(db);
}

// Opens the server's long-lived connection to an EXISTING database file and
// fails fast if it is missing — the one-time migration script
// (scripts/migrate-json-to-sqlite.js) must create it first. This mirrors the
// existing fail-fast pattern for a missing ADMIN_PASSWORD in server.js: no
// auto-migrate-on-boot branch, so a deleted/corrupted .sqlite file can never
// silently resurrect stale data from the original JSON files.
//
// WAL is enabled here because this is the connection that serves live
// traffic. The migration script's own connection to its temporary file
// deliberately does NOT enable WAL — see that script for why.
function openDatabase(dbPath) {
    if (!fs.existsSync(dbPath)) {
        throw new Error(
            `SQLite database not found at ${dbPath}.\n` +
            `Run the one-time migration first: npm run migrate`
        );
    }
    const db = new Database(dbPath);
    // journal_mode is persisted in the database file header (so this only
    // strictly needs to be set once, ever) — synchronous, foreign_keys and
    // busy_timeout are NOT persisted and reset to SQLite's defaults
    // (foreign_keys defaults OFF) on every single connection open. All four
    // are applied here unconditionally: forgetting foreign_keys = ON on any
    // one connection would silently disable every cascade this schema
    // depends on (gallery delete -> files/favorites/comments/viewer_hashes/
    // collection_galleries all cascading away).
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('busy_timeout = 5000');
    db.pragma('foreign_keys = ON');
    applySchema(db);
    return db;
}

module.exports = { openDatabase, applySchema, ensureSettingsColumns, SCHEMA_PATH };
