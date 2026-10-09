'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { applySchema, ensureSettingsColumns, ensureGalleriesColumns, ensureFilesColumns } = require('../db');

// In-memory, freshly schema'd database per test. foreign_keys is OFF by
// default on every new connection (even :memory: ones) — turned on here the
// same way db/index.js does for the real server connection, since the whole
// point of several tests below is to exercise the cascades that pragma gates.
function freshDb() {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applySchema(db);
    return db;
}

function seedGallery(db, id = 'g1') {
    db.prepare(`INSERT INTO galleries (id, created_at) VALUES (?, ?)`).run(id, new Date().toISOString());
    return id;
}

function seedFile(db, galleryId, filename = 'a.jpg') {
    db.prepare(`INSERT INTO files (gallery_id, filename) VALUES (?, ?)`).run(galleryId, filename);
    return filename;
}

describe('connection pragmas', () => {
    test('foreign_keys reads back as 1 immediately after connection open', () => {
        const db = freshDb();
        assert.strictEqual(db.pragma('foreign_keys', { simple: true }), 1);
        db.close();
    });
});

// The scenario that CREATE TABLE IF NOT EXISTS cannot handle on its own: an
// install that migrated to SQLite BEFORE a column was added to schema.sql. The
// table already exists, so the CREATE is skipped and the column would never
// appear — every SELECT naming it would throw at startup.
describe('ensureSettingsColumns — upgrading an already-migrated database', () => {
    // The `settings` DDL as it stood before the slideshow columns were added.
    const LEGACY_SETTINGS_DDL = `
        CREATE TABLE settings (
            id              INTEGER PRIMARY KEY CHECK (id = 1),
            theme           TEXT NOT NULL DEFAULT 'dark' CHECK (theme IN ('light','dark')),
            website         TEXT NOT NULL DEFAULT '' CHECK (length(website) <= 500),
            admin_language  TEXT NOT NULL DEFAULT 'en' CHECK (admin_language IN ('en','fr','es','pt','it')),
            client_language TEXT NOT NULL DEFAULT 'auto' CHECK (client_language IN ('auto','en','fr','es','pt','it')),
            date_format     TEXT NOT NULL DEFAULT 'auto' CHECK (date_format IN ('auto','dmy','mdy','ymd'))
        )`;

    function legacyDb() {
        const db = new Database(':memory:');
        db.pragma('foreign_keys = ON');
        db.exec(LEGACY_SETTINGS_DDL);
        db.prepare(`INSERT INTO settings (id, theme, website, admin_language, client_language, date_format)
                    VALUES (1, 'light', 'https://example.com', 'fr', 'fr', 'dmy')`).run();
        return db;
    }

    test('applySchema adds the missing columns and the existing row takes their defaults', () => {
        const db = legacyDb();
        const before = db.pragma('table_info(settings)').map(c => c.name);
        assert.ok(!before.includes('slideshow_interval'));

        applySchema(db);

        const row = db.prepare(`SELECT theme, website, admin_language, client_language, date_format,
                                       slideshow_interval, slideshow_transition
                                FROM settings WHERE id = 1`).get();
        // Defaults applied...
        assert.equal(row.slideshow_interval, 5);
        assert.equal(row.slideshow_transition, 'fade');
        // ...and nothing else about the pre-existing row was disturbed.
        assert.equal(row.theme, 'light');
        assert.equal(row.website, 'https://example.com');
        assert.equal(row.admin_language, 'fr');
        assert.equal(row.client_language, 'fr');
        assert.equal(row.date_format, 'dmy');
        db.close();
    });

    test('the new columns keep their CHECK constraints after being added by ALTER TABLE', () => {
        const db = legacyDb();
        applySchema(db);
        assert.throws(() => {
            db.prepare(`UPDATE settings SET slideshow_interval = 7 WHERE id = 1`).run();
        }, /CHECK constraint failed/);
        assert.throws(() => {
            db.prepare(`UPDATE settings SET slideshow_transition = 'wipe' WHERE id = 1`).run();
        }, /CHECK constraint failed/);
        db.close();
    });

    test('re-running it is an idempotent no-op — no duplicate-column error, values preserved', () => {
        const db = legacyDb();
        applySchema(db);
        db.prepare(`UPDATE settings SET slideshow_interval = 12, slideshow_transition = 'kenburns' WHERE id = 1`).run();

        assert.doesNotThrow(() => ensureSettingsColumns(db));
        assert.doesNotThrow(() => applySchema(db));

        const row = db.prepare(`SELECT slideshow_interval, slideshow_transition FROM settings WHERE id = 1`).get();
        assert.deepEqual(row, { slideshow_interval: 12, slideshow_transition: 'kenburns' });
        db.close();
    });

    test('it is also a no-op on a fresh database, where schema.sql already created the columns', () => {
        const db = freshDb();
        assert.doesNotThrow(() => ensureSettingsColumns(db));
        const cols = db.pragma('table_info(settings)').map(c => c.name);
        assert.equal(cols.filter(c => c === 'slideshow_interval').length, 1);
        db.close();
    });
});

// Same scenario as ensureSettingsColumns above, for the columns added to
// `galleries` (per-gallery password/expiration/lightbox appearance) and
// `files` (the proofing flag) after the first installs had already migrated.
describe('ensureGalleriesColumns / ensureFilesColumns — upgrading an already-migrated database', () => {
    const LEGACY_GALLERIES_DDL = `
        CREATE TABLE galleries (
            id                 TEXT PRIMARY KEY,
            event_name         TEXT NOT NULL DEFAULT 'Untitled Event',
            created_at         TEXT NOT NULL,
            background         TEXT,
            downloads_enabled  INTEGER NOT NULL DEFAULT 1 CHECK (downloads_enabled IN (0,1)),
            comments_enabled   INTEGER NOT NULL DEFAULT 1 CHECK (comments_enabled IN (0,1)),
            download_count     INTEGER NOT NULL DEFAULT 0 CHECK (download_count >= 0),
            view_count         INTEGER NOT NULL DEFAULT 0 CHECK (view_count >= 0),
            client_language    TEXT CHECK (client_language IS NULL OR client_language IN ('en','fr','es','pt','it')),
            deleted            INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0,1)),
            deleted_at         TEXT,
            sort_order         INTEGER,
            audio_filename     TEXT,
            audio_stored       TEXT,
            audio_size         INTEGER CHECK (audio_size IS NULL OR audio_size >= 0),
            audio_duration     REAL CHECK (audio_duration IS NULL OR audio_duration >= 0),
            audio_uploaded_at  TEXT,
            CHECK ( (deleted = 0 AND deleted_at IS NULL) OR (deleted = 1 AND deleted_at IS NOT NULL) )
        )`;
    const LEGACY_FILES_DDL = `
        CREATE TABLE files (
            gallery_id TEXT NOT NULL REFERENCES galleries(id) ON DELETE CASCADE,
            filename   TEXT NOT NULL,
            width      INTEGER CHECK (width IS NULL OR width > 0),
            height     INTEGER CHECK (height IS NULL OR height > 0),
            duration   REAL CHECK (duration IS NULL OR duration >= 0),
            animated   INTEGER CHECK (animated IS NULL OR animated IN (0,1)),
            PRIMARY KEY (gallery_id, filename)
        )`;

    function legacyDb() {
        const db = new Database(':memory:');
        db.pragma('foreign_keys = ON');
        db.exec(LEGACY_GALLERIES_DDL);
        db.exec(LEGACY_FILES_DDL);
        db.exec(`CREATE TABLE collections (id TEXT PRIMARY KEY, created_at TEXT NOT NULL)`); // referenced by nothing here, just keeps applySchema's other CREATE IF NOT EXISTS statements harmless
        db.prepare(`INSERT INTO galleries (id, created_at) VALUES ('g1', ?)`).run(new Date().toISOString());
        db.prepare(`INSERT INTO files (gallery_id, filename) VALUES ('g1', 'a.jpg')`).run();
        return db;
    }

    test('applySchema adds the missing galleries/files columns and existing rows take their defaults', () => {
        const db = legacyDb();
        const galBefore = db.pragma('table_info(galleries)').map(c => c.name);
        const fileBefore = db.pragma('table_info(files)').map(c => c.name);
        assert.ok(!galBefore.includes('password_hash'));
        assert.ok(!fileBefore.includes('flag'));

        applySchema(db);

        const gal = db.prepare(`SELECT password_hash, expires_at, lightbox_size, grid_spacing, corner_style, grid_layout FROM galleries WHERE id = 'g1'`).get();
        assert.equal(gal.password_hash, null);
        assert.equal(gal.expires_at, null);
        assert.equal(gal.lightbox_size, 'medium');
        assert.equal(gal.grid_spacing, 'medium');
        assert.equal(gal.corner_style, 'square');
        assert.equal(gal.grid_layout, 'justified');

        const file = db.prepare(`SELECT flag FROM files WHERE gallery_id = 'g1' AND filename = 'a.jpg'`).get();
        assert.equal(file.flag, null);
        db.close();
    });

    test('the new columns keep their CHECK constraints after being added by ALTER TABLE', () => {
        const db = legacyDb();
        applySchema(db);
        assert.throws(() => {
            db.prepare(`UPDATE galleries SET lightbox_size = 'huge' WHERE id = 'g1'`).run();
        }, /CHECK constraint failed/);
        assert.throws(() => {
            db.prepare(`UPDATE galleries SET grid_spacing = 'huge' WHERE id = 'g1'`).run();
        }, /CHECK constraint failed/);
        assert.throws(() => {
            db.prepare(`UPDATE galleries SET corner_style = 'triangle' WHERE id = 'g1'`).run();
        }, /CHECK constraint failed/);
        assert.throws(() => {
            db.prepare(`UPDATE galleries SET grid_layout = 'carousel' WHERE id = 'g1'`).run();
        }, /CHECK constraint failed/);
        assert.throws(() => {
            db.prepare(`UPDATE files SET flag = 'blue' WHERE gallery_id = 'g1' AND filename = 'a.jpg'`).run();
        }, /CHECK constraint failed/);
        db.close();
    });

    test('re-running it is an idempotent no-op — no duplicate-column error, values preserved', () => {
        const db = legacyDb();
        applySchema(db);
        db.prepare(`UPDATE galleries SET password_hash = 'salt:hash', lightbox_size = 'large' WHERE id = 'g1'`).run();
        db.prepare(`UPDATE files SET flag = 'red' WHERE gallery_id = 'g1' AND filename = 'a.jpg'`).run();

        assert.doesNotThrow(() => ensureGalleriesColumns(db));
        assert.doesNotThrow(() => ensureFilesColumns(db));
        assert.doesNotThrow(() => applySchema(db));

        const gal = db.prepare(`SELECT password_hash, lightbox_size FROM galleries WHERE id = 'g1'`).get();
        assert.deepEqual(gal, { password_hash: 'salt:hash', lightbox_size: 'large' });
        const file = db.prepare(`SELECT flag FROM files WHERE gallery_id = 'g1' AND filename = 'a.jpg'`).get();
        assert.equal(file.flag, 'red');
        db.close();
    });

    test('it is also a no-op on a fresh database, where schema.sql already created the columns', () => {
        const db = freshDb();
        assert.doesNotThrow(() => ensureGalleriesColumns(db));
        assert.doesNotThrow(() => ensureFilesColumns(db));
        const galCols = db.pragma('table_info(galleries)').map(c => c.name);
        const fileCols = db.pragma('table_info(files)').map(c => c.name);
        assert.equal(galCols.filter(c => c === 'password_hash').length, 1);
        assert.equal(fileCols.filter(c => c === 'flag').length, 1);
        db.close();
    });

    test('grid_own: a gallery already off the default grid keeps it, the others follow their collection', () => {
        const db = legacyDb();
        // An install upgraded before grid_own existed: the four grid columns are
        // there, grid_own is not.
        for (const ddl of [
            `lightbox_size TEXT NOT NULL DEFAULT 'medium' CHECK (lightbox_size IN ('small','medium','large'))`,
            `grid_spacing TEXT NOT NULL DEFAULT 'medium' CHECK (grid_spacing  IN ('small','medium','large'))`,
            `corner_style TEXT NOT NULL DEFAULT 'square' CHECK (corner_style IN ('rounded','square'))`,
            `grid_layout TEXT NOT NULL DEFAULT 'justified' CHECK (grid_layout IN ('justified','masonry','square','column'))`
        ]) db.exec(`ALTER TABLE galleries ADD COLUMN ${ddl}`);
        db.prepare(`INSERT INTO galleries (id, created_at, grid_layout) VALUES ('g2', ?, 'masonry')`).run(new Date().toISOString());
        db.prepare(`INSERT INTO galleries (id, created_at, corner_style) VALUES ('g3', ?, 'rounded')`).run(new Date().toISOString());

        applySchema(db);

        const own = id => db.prepare(`SELECT grid_own FROM galleries WHERE id = ?`).get(id).grid_own;
        assert.equal(own('g1'), 0);
        assert.equal(own('g2'), 1);
        assert.equal(own('g3'), 1);

        // The backfill runs only when the column is created: a later choice to
        // follow the collection is never overwritten by the next start.
        db.prepare(`UPDATE galleries SET grid_own = 0 WHERE id = 'g2'`).run();
        applySchema(db);
        assert.equal(own('g2'), 0);
        assert.throws(() => {
            db.prepare(`UPDATE galleries SET grid_own = 2 WHERE id = 'g1'`).run();
        }, /CHECK constraint failed/);
        db.close();
    });

    test('collections get the grid columns, with the gallery defaults and their CHECKs', () => {
        const db = legacyDb();
        db.prepare(`INSERT INTO collections (id, created_at) VALUES ('c1', ?)`).run(new Date().toISOString());
        applySchema(db);
        const col = db.prepare(`SELECT grid_layout, lightbox_size, grid_spacing, corner_style FROM collections WHERE id = 'c1'`).get();
        assert.deepEqual(col, { grid_layout: 'justified', lightbox_size: 'medium', grid_spacing: 'medium', corner_style: 'square' });
        assert.throws(() => {
            db.prepare(`UPDATE collections SET grid_layout = 'carousel' WHERE id = 'c1'`).run();
        }, /CHECK constraint failed/);
        assert.doesNotThrow(() => applySchema(db));
        db.close();
    });

    test('collections get password_hash and expires_at, NULL (unprotected) on existing rows', () => {
        const db = legacyDb();
        db.prepare(`INSERT INTO collections (id, created_at) VALUES ('c1', ?)`).run(new Date().toISOString());
        applySchema(db);
        const col = db.prepare(`SELECT password_hash, expires_at FROM collections WHERE id = 'c1'`).get();
        assert.deepEqual(col, { password_hash: null, expires_at: null });
        db.close();
    });
});

describe('CHECK constraints — enums', () => {
    test('settings.theme rejects a value outside light/dark', () => {
        const db = freshDb();
        assert.throws(() => {
            db.prepare(`INSERT INTO settings (id, theme, admin_language, client_language, date_format)
                        VALUES (1, 'blue', 'en', 'auto', 'auto')`).run();
        }, /CHECK constraint failed/);
        db.close();
    });

    test('settings.date_format rejects a value outside auto/dmy/mdy/ymd', () => {
        const db = freshDb();
        assert.throws(() => {
            db.prepare(`INSERT INTO settings (id, theme, admin_language, client_language, date_format)
                        VALUES (1, 'dark', 'en', 'auto', 'yyyy-mm-dd')`).run();
        }, /CHECK constraint failed/);
        db.close();
    });

    test('settings.admin_language rejects an unsupported language code', () => {
        const db = freshDb();
        assert.throws(() => {
            db.prepare(`INSERT INTO settings (id, theme, admin_language, client_language, date_format)
                        VALUES (1, 'dark', 'de', 'auto', 'auto')`).run();
        }, /CHECK constraint failed/);
        db.close();
    });

    test('settings.slideshow_interval rejects a value outside 3/5/8/12', () => {
        const db = freshDb();
        assert.throws(() => {
            db.prepare(`INSERT INTO settings (id, theme, admin_language, client_language, date_format, slideshow_interval)
                        VALUES (1, 'dark', 'en', 'auto', 'auto', 7)`).run();
        }, /CHECK constraint failed/);
        db.close();
    });

    test('settings.slideshow_transition rejects a value outside fade/slide/kenburns', () => {
        const db = freshDb();
        assert.throws(() => {
            db.prepare(`INSERT INTO settings (id, theme, admin_language, client_language, date_format, slideshow_transition)
                        VALUES (1, 'dark', 'en', 'auto', 'auto', 'wipe')`).run();
        }, /CHECK constraint failed/);
        db.close();
    });

    test('a settings row inserted without the slideshow columns takes the 5 / fade defaults', () => {
        const db = freshDb();
        db.prepare(`INSERT INTO settings (id, theme, admin_language, client_language, date_format)
                    VALUES (1, 'dark', 'en', 'auto', 'auto')`).run();
        const row = db.prepare(`SELECT slideshow_interval, slideshow_transition FROM settings WHERE id = 1`).get();
        assert.deepEqual(row, { slideshow_interval: 5, slideshow_transition: 'fade' });
        db.close();
    });

    test('galleries.client_language rejects the literal string "auto" (NULL means auto on this table, not the string)', () => {
        const db = freshDb();
        const id = seedGallery(db);
        assert.throws(() => {
            db.prepare(`UPDATE galleries SET client_language = 'auto' WHERE id = ?`).run(id);
        }, /CHECK constraint failed/);
        db.close();
    });

    test('galleries.client_language accepts NULL (the actual "auto" representation) and a supported code', () => {
        const db = freshDb();
        const id = seedGallery(db);
        assert.doesNotThrow(() => db.prepare(`UPDATE galleries SET client_language = NULL WHERE id = ?`).run(id));
        assert.doesNotThrow(() => db.prepare(`UPDATE galleries SET client_language = 'fr' WHERE id = ?`).run(id));
        db.close();
    });

    test('files.flag rejects a color outside red/orange/green/white', () => {
        const db = freshDb();
        const gid = seedGallery(db);
        const fn = seedFile(db, gid);
        assert.throws(() => {
            db.prepare(`UPDATE files SET flag = 'blue' WHERE gallery_id = ? AND filename = ?`).run(gid, fn);
        }, /CHECK constraint failed/);
        db.close();
    });

    test('files.flag accepts NULL (unflagged) and each of the four colors', () => {
        const db = freshDb();
        const gid = seedGallery(db);
        const fn = seedFile(db, gid);
        for (const flag of ['red', 'orange', 'green', 'white', null]) {
            assert.doesNotThrow(() => db.prepare(`UPDATE files SET flag = ? WHERE gallery_id = ? AND filename = ?`).run(flag, gid, fn));
        }
        db.close();
    });

    test('a gallery row with no explicit appearance columns takes medium/medium/square/justified defaults (exact no-op for existing galleries)', () => {
        const db = freshDb();
        const id = seedGallery(db);
        const row = db.prepare(`SELECT lightbox_size, grid_spacing, corner_style, grid_layout, password_hash, expires_at FROM galleries WHERE id = ?`).get(id);
        assert.deepEqual(row, { lightbox_size: 'medium', grid_spacing: 'medium', corner_style: 'square', grid_layout: 'justified', password_hash: null, expires_at: null });
        db.close();
    });
});

describe('CHECK constraints — paired/grouped columns', () => {
    test('deleted=1 with deleted_at IS NULL is rejected', () => {
        const db = freshDb();
        assert.throws(() => {
            db.prepare(`INSERT INTO galleries (id, created_at, deleted, deleted_at) VALUES ('g1', ?, 1, NULL)`).run(new Date().toISOString());
        }, /CHECK constraint failed/);
        db.close();
    });

    test('deleted=0 with deleted_at set is rejected', () => {
        const db = freshDb();
        assert.throws(() => {
            db.prepare(`INSERT INTO galleries (id, created_at, deleted, deleted_at) VALUES ('g1', ?, 0, ?)`).run(new Date().toISOString(), new Date().toISOString());
        }, /CHECK constraint failed/);
        db.close();
    });

    test('deleted=1 with deleted_at set is accepted', () => {
        const db = freshDb();
        assert.doesNotThrow(() => {
            db.prepare(`INSERT INTO galleries (id, created_at, deleted, deleted_at) VALUES ('g1', ?, 1, ?)`).run(new Date().toISOString(), new Date().toISOString());
        });
        db.close();
    });

    test('a gallery with only SOME audio columns set (all-or-nothing violated) is rejected', () => {
        const db = freshDb();
        assert.throws(() => {
            db.prepare(`INSERT INTO galleries (id, created_at, audio_filename) VALUES ('g1', ?, 'track.mp3')`).run(new Date().toISOString());
        }, /CHECK constraint failed/);
        db.close();
    });

    test('a collection with only SOME audio columns set is rejected', () => {
        const db = freshDb();
        assert.throws(() => {
            db.prepare(`INSERT INTO collections (id, created_at, audio_stored) VALUES ('c1', ?, 'collection-c1.mp3')`).run(new Date().toISOString());
        }, /CHECK constraint failed/);
        db.close();
    });

    test('a gallery with all four audio columns set is accepted', () => {
        const db = freshDb();
        assert.doesNotThrow(() => {
            db.prepare(`INSERT INTO galleries (id, created_at, audio_filename, audio_stored, audio_size, audio_uploaded_at)
                        VALUES ('g1', ?, 'song.mp3', 'gallery-g1.mp3', 1000, ?)`).run(new Date().toISOString(), new Date().toISOString());
        });
        db.close();
    });

    test('files row with both duration and animated set is rejected', () => {
        const db = freshDb();
        const gid = seedGallery(db);
        assert.throws(() => {
            db.prepare(`INSERT INTO files (gallery_id, filename, duration, animated) VALUES (?, 'v.mp4', 10, 1)`).run(gid);
        }, /CHECK constraint failed/);
        db.close();
    });

    test('files row with only duration set (video) is accepted', () => {
        const db = freshDb();
        const gid = seedGallery(db);
        assert.doesNotThrow(() => db.prepare(`INSERT INTO files (gallery_id, filename, duration) VALUES (?, 'v.mp4', 10)`).run(gid));
        db.close();
    });

    test('files row with only animated set (image) is accepted', () => {
        const db = freshDb();
        const gid = seedGallery(db);
        assert.doesNotThrow(() => db.prepare(`INSERT INTO files (gallery_id, filename, animated) VALUES (?, 'a.gif', 1)`).run(gid));
        db.close();
    });
});

describe('UNIQUE constraints', () => {
    test('a gallery cannot belong to two collections at once', () => {
        const db = freshDb();
        const gid = seedGallery(db);
        db.prepare(`INSERT INTO collections (id, created_at) VALUES ('c1', ?)`).run(new Date().toISOString());
        db.prepare(`INSERT INTO collections (id, created_at) VALUES ('c2', ?)`).run(new Date().toISOString());
        db.prepare(`INSERT INTO collection_galleries (collection_id, gallery_id, position) VALUES ('c1', ?, 0)`).run(gid);
        assert.throws(() => {
            db.prepare(`INSERT INTO collection_galleries (collection_id, gallery_id, position) VALUES ('c2', ?, 0)`).run(gid);
        }, /UNIQUE constraint failed/);
        db.close();
    });

    test('the same visitor cannot favorite the same filename twice', () => {
        const db = freshDb();
        const gid = seedGallery(db);
        const fn = seedFile(db, gid);
        db.prepare(`INSERT INTO favorites (gallery_id, filename, visitor_id) VALUES (?, ?, 'visitor1')`).run(gid, fn);
        assert.throws(() => {
            db.prepare(`INSERT INTO favorites (gallery_id, filename, visitor_id) VALUES (?, ?, 'visitor1')`).run(gid, fn);
        }, /UNIQUE constraint failed/);
        db.close();
    });

    test('two comments cannot share the same id', () => {
        const db = freshDb();
        const gid = seedGallery(db);
        const fn = seedFile(db, gid);
        const now = new Date().toISOString();
        db.prepare(`INSERT INTO comments (id, gallery_id, filename, visitor_id, text, created_at) VALUES ('c-1', ?, ?, 'visitor1', 'hi', ?)`).run(gid, fn, now);
        assert.throws(() => {
            db.prepare(`INSERT INTO comments (id, gallery_id, filename, visitor_id, text, created_at) VALUES ('c-1', ?, ?, 'visitor2', 'hi again', ?)`).run(gid, fn, now);
        }, /UNIQUE constraint failed/);
        db.close();
    });
});

describe('foreign keys and cascades', () => {
    test('deleting a gallery cascades to files, favorites, comments, viewer_hashes and collection_galleries', () => {
        const db = freshDb();
        const gid = seedGallery(db);
        const fn = seedFile(db, gid);
        db.prepare(`INSERT INTO favorites (gallery_id, filename, visitor_id) VALUES (?, ?, 'visitor1')`).run(gid, fn);
        db.prepare(`INSERT INTO comments (id, gallery_id, filename, visitor_id, text, created_at) VALUES ('c-1', ?, ?, 'visitor1', 'hi', ?)`).run(gid, fn, new Date().toISOString());
        db.prepare(`INSERT INTO viewer_hashes (gallery_id, hash) VALUES (?, ?)`).run(gid, 'a'.repeat(64));
        db.prepare(`INSERT INTO collections (id, created_at) VALUES ('c1', ?)`).run(new Date().toISOString());
        db.prepare(`INSERT INTO collection_galleries (collection_id, gallery_id, position) VALUES ('c1', ?, 0)`).run(gid);

        db.prepare(`DELETE FROM galleries WHERE id = ?`).run(gid);

        assert.strictEqual(db.prepare(`SELECT COUNT(*) AS n FROM files WHERE gallery_id = ?`).get(gid).n, 0);
        assert.strictEqual(db.prepare(`SELECT COUNT(*) AS n FROM favorites WHERE gallery_id = ?`).get(gid).n, 0);
        assert.strictEqual(db.prepare(`SELECT COUNT(*) AS n FROM comments WHERE gallery_id = ?`).get(gid).n, 0);
        assert.strictEqual(db.prepare(`SELECT COUNT(*) AS n FROM viewer_hashes WHERE gallery_id = ?`).get(gid).n, 0);
        assert.strictEqual(db.prepare(`SELECT COUNT(*) AS n FROM collection_galleries WHERE gallery_id = ?`).get(gid).n, 0);
        // The collection itself must survive — only the membership link is gone.
        assert.strictEqual(db.prepare(`SELECT COUNT(*) AS n FROM collections WHERE id = 'c1'`).get().n, 1);
        db.close();
    });

    test('deleting a collection removes ONLY the membership link — the member gallery and its files/favorites/comments survive', () => {
        const db = freshDb();
        const gid = seedGallery(db);
        const fn = seedFile(db, gid);
        db.prepare(`INSERT INTO favorites (gallery_id, filename, visitor_id) VALUES (?, ?, 'visitor1')`).run(gid, fn);
        db.prepare(`INSERT INTO collections (id, created_at) VALUES ('c1', ?)`).run(new Date().toISOString());
        db.prepare(`INSERT INTO collection_galleries (collection_id, gallery_id, position) VALUES ('c1', ?, 0)`).run(gid);

        db.prepare(`DELETE FROM collections WHERE id = 'c1'`).run();

        assert.strictEqual(db.prepare(`SELECT COUNT(*) AS n FROM collection_galleries`).get().n, 0);
        assert.strictEqual(db.prepare(`SELECT COUNT(*) AS n FROM galleries WHERE id = ?`).get(gid).n, 1);
        assert.strictEqual(db.prepare(`SELECT COUNT(*) AS n FROM files WHERE gallery_id = ?`).get(gid).n, 1);
        assert.strictEqual(db.prepare(`SELECT COUNT(*) AS n FROM favorites WHERE gallery_id = ?`).get(gid).n, 1);
        db.close();
    });

    test('deleting one file cascades only that file\'s favorites/comments, leaving a sibling filename untouched', () => {
        const db = freshDb();
        const gid = seedGallery(db);
        const fnA = seedFile(db, gid, 'a.jpg');
        const fnB = seedFile(db, gid, 'b.jpg');
        db.prepare(`INSERT INTO favorites (gallery_id, filename, visitor_id) VALUES (?, ?, 'visitor1')`).run(gid, fnA);
        db.prepare(`INSERT INTO favorites (gallery_id, filename, visitor_id) VALUES (?, ?, 'visitor1')`).run(gid, fnB);

        db.prepare(`DELETE FROM files WHERE gallery_id = ? AND filename = ?`).run(gid, fnA);

        assert.strictEqual(db.prepare(`SELECT COUNT(*) AS n FROM favorites WHERE gallery_id = ? AND filename = ?`).get(gid, fnA).n, 0);
        assert.strictEqual(db.prepare(`SELECT COUNT(*) AS n FROM favorites WHERE gallery_id = ? AND filename = ?`).get(gid, fnB).n, 1);
        db.close();
    });

    test('favoriting a filename with no matching files row is rejected (the behavior change documented in CLAUDE.md)', () => {
        const db = freshDb();
        const gid = seedGallery(db);
        assert.throws(() => {
            db.prepare(`INSERT INTO favorites (gallery_id, filename, visitor_id) VALUES (?, 'never-uploaded.jpg', 'visitor1')`).run(gid);
        }, /FOREIGN KEY constraint failed/);
        db.close();
    });
});
