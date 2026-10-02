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

// Applies the schema (every statement is CREATE ... IF NOT EXISTS, so this is
// safe and cheap to re-run on every connection open — self-healing if a table
// were ever dropped by hand).
function applySchema(db) {
    db.exec(fs.readFileSync(SCHEMA_PATH, 'utf8'));
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

module.exports = { openDatabase, applySchema, SCHEMA_PATH };
