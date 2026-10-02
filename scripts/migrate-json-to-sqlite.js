#!/usr/bin/env node
// One-time JSON -> SQLite migration for Delyvr.
//
//   npm run migrate            (refuses if delyvr.sqlite already exists)
//   npm run migrate -- --force (rebuilds from the JSON files, discarding any
//                                SQL-only writes made since the last migration)
//
// Never auto-run by server.js — see db/index.js and CLAUDE.md for why this is
// a deliberate, operator-initiated step rather than an auto-migrate-on-boot
// branch. Reads galleries.json / collections.json / settings.json READ-ONLY
// from start to finish: they are never written, renamed, or deleted by this
// script, success or failure.
//
// Builds into a temporary file and only renames it into place after every
// row has been inserted AND independently re-verified — so a file at the
// final name either is a fully, correctly migrated database, or does not
// exist at all. There is no state in between.

'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const { applySchema } = require('../db');
const {
    planGalleryMigration,
    planAllCollections,
    planSettingsMigration,
    verifyCounts,
    pickSample,
    diffRow
} = require('./lib/migrate-core');

// Same resolution as server.js's `DATA_DIR = process.env.INSTALL_DIR || __dirname`
// — server.js's own __dirname IS the project root (it lives there), so this
// script (one level down, in scripts/) falls back to `../` to land on the
// same directory. Duplicated rather than shared, same judgment call as
// elsewhere in this migration: three lines, not worth a shared module for.
const DATA_DIR = process.env.INSTALL_DIR || path.join(__dirname, '..');

const FINAL_PATH = path.join(DATA_DIR, 'delyvr.sqlite');
const TMP_PATH = path.join(DATA_DIR, 'delyvr.sqlite.migrating');

const GALLERIES_FILE = path.join(DATA_DIR, 'galleries.json');
const COLLECTIONS_FILE = path.join(DATA_DIR, 'collections.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

const FORCE = process.argv.includes('--force');

// Module-scoped so the top-level catch block (outside main()) can close it
// before removing the temp file on failure, rather than leaving an open
// handle to a file we're about to unlink.
let db = null;

/**
 * Reads and JSON.parses a file, returning `fallback` if it doesn't exist at
 * all (a brand-new install, or settings.json before its first write — both
 * legitimate). Unlike the live server's own loadGalleries/loadCollections/
 * loadSettings, a file that EXISTS but fails to parse is NOT silently
 * swallowed into the fallback here — it throws instead. This is a deliberate
 * divergence from the server's (arguably too lenient) runtime behaviour: for
 * a one-time, one-way migration, silently treating corrupt source data as
 * "no data" would quietly manufacture an empty database from a photographer's
 * real gallery list. A loud abort the operator can investigate is correct;
 * silent data loss is not.
 */
function readJsonStrict(filePath, fallback) {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf8');
    try {
        return JSON.parse(raw);
    } catch (e) {
        throw new Error(`${filePath} exists but could not be parsed as JSON: ${e.message}`);
    }
}

function main() {
    console.log(`[MIGRATE] Data directory: ${DATA_DIR}`);

    if (fs.existsSync(FINAL_PATH) && !FORCE) {
        console.error(
            `[MIGRATE] ${FINAL_PATH} already exists — migration already completed.\n` +
            `          Pass --force to rebuild it from the JSON files, discarding any\n` +
            `          writes made through SQLite since the last migration.`
        );
        process.exit(1);
    }

    // Clean up a stale temp file left behind by a previous failed run.
    if (fs.existsSync(TMP_PATH)) fs.rmSync(TMP_PATH, { force: true });

    const galleriesJson = readJsonStrict(GALLERIES_FILE, []);
    const collectionsJson = readJsonStrict(COLLECTIONS_FILE, []);
    const settingsJson = readJsonStrict(SETTINGS_FILE, {});

    if (!Array.isArray(galleriesJson)) throw new Error(`${GALLERIES_FILE} does not contain a JSON array`);
    if (!Array.isArray(collectionsJson)) throw new Error(`${COLLECTIONS_FILE} does not contain a JSON array`);

    console.log(`[MIGRATE] Read ${galleriesJson.length} gallery record(s), ${collectionsJson.length} collection record(s).`);

    // Built in SQLite's default rollback-journal mode, not WAL: this is a
    // single-writer batch job with no concurrent readers to serve, so WAL's
    // benefit doesn't apply, and skipping it avoids having to also manage
    // -wal/-shm sidecar files for a database that gets deleted or renamed
    // moments later. WAL is enabled by db/index.js's openDatabase() at the
    // server's first connection to the FINAL file, after the rename below.
    db = new Database(TMP_PATH);
    db.pragma('foreign_keys = ON');
    applySchema(db);

    const stmt = {
        gallery: db.prepare(`INSERT INTO galleries
            (id, event_name, created_at, background, downloads_enabled, comments_enabled,
             download_count, view_count, client_language, deleted, deleted_at, sort_order,
             audio_filename, audio_stored, audio_size, audio_duration, audio_uploaded_at)
            VALUES (@id, @event_name, @created_at, @background, @downloads_enabled, @comments_enabled,
             @download_count, @view_count, @client_language, @deleted, @deleted_at, @sort_order,
             @audio_filename, @audio_stored, @audio_size, @audio_duration, @audio_uploaded_at)`),
        file: db.prepare(`INSERT INTO files (gallery_id, filename, width, height, duration, animated)
            VALUES (?, ?, ?, ?, ?, ?)`),
        favorite: db.prepare(`INSERT INTO favorites (gallery_id, filename, visitor_id) VALUES (?, ?, ?)`),
        comment: db.prepare(`INSERT INTO comments (id, gallery_id, filename, visitor_id, name, text, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)`),
        viewerHash: db.prepare(`INSERT INTO viewer_hashes (gallery_id, hash) VALUES (?, ?)`),
        collection: db.prepare(`INSERT INTO collections
            (id, name, created_at, background, downloads_enabled, comments_enabled, client_language,
             audio_filename, audio_stored, audio_size, audio_duration, audio_uploaded_at)
            VALUES (@id, @name, @created_at, @background, @downloads_enabled, @comments_enabled, @client_language,
             @audio_filename, @audio_stored, @audio_size, @audio_duration, @audio_uploaded_at)`),
        membership: db.prepare(`INSERT INTO collection_galleries (collection_id, gallery_id, position) VALUES (?, ?, ?)`),
        settings: db.prepare(`INSERT INTO settings (id, theme, website, admin_language, client_language, date_format)
            VALUES (1, @theme, @website, @admin_language, @client_language, @date_format)`),
        social: db.prepare(`INSERT INTO settings_socials (key, value) VALUES (?, ?)`)
    };

    const expected = { galleries: 0, collections: 0, collection_galleries: 0, files: 0, favorites: 0, comments: 0, viewer_hashes: 0, settings: 1, settings_socials: 0 };
    const warnings = [];
    let favoritesDropped = 0;
    let commentsDropped = 0;
    const galleryPlans = []; // kept for the post-commit field-level sample diff

    const run = db.transaction(() => {
        // ── Galleries first (and everything that hangs off a gallery) ──────
        for (const g of galleriesJson) {
            const plan = planGalleryMigration(g);
            warnings.push(...plan.warnings);
            favoritesDropped += plan.favoritesDropped;
            commentsDropped += plan.commentsDropped;
            galleryPlans.push(plan);

            stmt.gallery.run(plan.row);
            expected.galleries++;

            for (const f of plan.files) {
                stmt.file.run(plan.row.id, f.filename, f.width, f.height, f.duration, f.animated);
                expected.files++;
            }
            for (const fav of plan.favorites) {
                stmt.favorite.run(plan.row.id, fav.filename, fav.visitorId);
                expected.favorites++;
            }
            for (const c of plan.comments) {
                stmt.comment.run(c.id, plan.row.id, c.filename, c.visitorId, c.name, c.text, c.createdAt);
                expected.comments++;
            }
            for (const hash of plan.viewerHashes) {
                stmt.viewerHash.run(plan.row.id, hash);
                expected.viewer_hashes++;
            }
        }

        const knownGalleryIds = new Set(galleryPlans.map(p => p.row.id));

        // Cross-collection "one gallery, one collection" dup-checking happens
        // inside planAllCollections (it needs visibility across the whole
        // batch, which a single collection's plan can't have) — see
        // scripts/lib/migrate-core.js.
        const collectionPlans = planAllCollections(collectionsJson, knownGalleryIds);
        for (const plan of collectionPlans) {
            warnings.push(...plan.warnings);

            stmt.collection.run(plan.row);
            expected.collections++;

            for (const m of plan.memberships) {
                stmt.membership.run(plan.row.id, m.galleryId, m.position);
                expected.collection_galleries++;
            }
        }

        // ── Settings (singleton) ────────────────────────────────────────────
        const settingsPlan = planSettingsMigration(settingsJson);
        stmt.settings.run(settingsPlan.row);
        for (const s of settingsPlan.socials) {
            stmt.social.run(s.key, s.value);
            expected.settings_socials++;
        }
    });

    run();

    // ── Verification: independent SQL-side counts vs. the JS-side tally ────
    const actual = {};
    for (const table of Object.keys(expected)) {
        actual[table] = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
    }
    verifyCounts(expected, actual);

    // ── Field-level spot-check on a bounded sample ──────────────────────────
    const sampleMismatches = [];
    for (const plan of pickSample(galleryPlans)) {
        const actualRow = db.prepare('SELECT * FROM galleries WHERE id = ?').get(plan.row.id);
        const diffs = diffRow(plan.row, actualRow);
        if (diffs.length > 0) sampleMismatches.push({ id: plan.row.id, diffs });
    }
    if (sampleMismatches.length > 0) {
        throw new Error(
            `Field-level verification failed for ${sampleMismatches.length} sampled gallery row(s):\n` +
            sampleMismatches.map(m => `  ${m.id}: ${m.diffs.map(d => `${d.field} expected=${JSON.stringify(d.expected)} actual=${JSON.stringify(d.actual)}`).join(', ')}`).join('\n')
        );
    }

    db.close();
    fs.renameSync(TMP_PATH, FINAL_PATH);

    console.log('[MIGRATE] Row counts:');
    for (const table of Object.keys(expected)) console.log(`[MIGRATE]   ${table}: ${actual[table]}`);
    if (favoritesDropped > 0 || commentsDropped > 0) {
        console.log(
            `[MIGRATE] Dropped ${favoritesDropped} favorite(s) and ${commentsDropped} comment(s) that referenced ` +
            `a photo no longer present in its gallery's file list — pre-existing orphans from deleted photos, ` +
            `invisible in the old JSON model and never reachable there either. See CLAUDE.md for why.`
        );
    }
    for (const w of warnings) console.warn(`[MIGRATE] WARNING: ${w}`);
    console.log(`[MIGRATE] Migration succeeded. Database created at ${FINAL_PATH}`);
    console.log(`[MIGRATE] Your original galleries.json/collections.json/settings.json were not modified.`);
}

try {
    main();
    process.exit(0);
} catch (e) {
    try { if (db) db.close(); } catch (_) {}
    try { if (fs.existsSync(TMP_PATH)) fs.rmSync(TMP_PATH, { force: true }); } catch (_) {}
    console.error(`[MIGRATE] Migration FAILED and was rolled back: ${e.message}`);
    console.error(`[MIGRATE] Your original galleries.json/collections.json/settings.json are untouched.`);
    console.error(`[MIGRATE] The server will not start until this is resolved.`);
    process.exit(1);
}
