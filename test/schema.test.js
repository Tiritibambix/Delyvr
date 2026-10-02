'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { applySchema } = require('../db');

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
