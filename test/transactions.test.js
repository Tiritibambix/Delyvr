'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { applySchema } = require('../db');
const {
    deleteGalleryRow,
    softDeleteGallery,
    restoreGallery,
    addGalleryToCollection,
    bumpGalleryDownloadCounts,
    purgeWithTolerance
} = require('../db/operations');

function freshDb() {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applySchema(db);
    return db;
}

function seedGallery(db, id) {
    db.prepare(`INSERT INTO galleries (id, created_at) VALUES (?, ?)`).run(id, new Date().toISOString());
}

function seedCollectionWithMembers(db, collectionId, galleryIds) {
    db.prepare(`INSERT INTO collections (id, created_at) VALUES (?, ?)`).run(collectionId, new Date().toISOString());
    galleryIds.forEach((gid, position) => {
        seedGallery(db, gid);
        db.prepare(`INSERT INTO collection_galleries (collection_id, gallery_id, position) VALUES (?, ?, ?)`).run(collectionId, gid, position);
    });
}

// ── A: deleteGalleryRow ─────────────────────────────────────────────────────

describe('deleteGalleryRow (transaction A — DB half of hardDeleteGallery)', () => {
    test('removes the gallery from its collection, and sibling members keep their ORIGINAL, non-renumbered positions', () => {
        const db = freshDb();
        seedCollectionWithMembers(db, 'c1', ['g1', 'g2', 'g3']); // positions 0, 1, 2

        const result = deleteGalleryRow(db, 'g2');

        assert.equal(result.deleted, true);
        const remaining = db.prepare(`SELECT gallery_id, position FROM collection_galleries WHERE collection_id = 'c1' ORDER BY position`).all();
        assert.deepEqual(remaining, [{ gallery_id: 'g1', position: 0 }, { gallery_id: 'g3', position: 2 }]);
        assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM galleries WHERE id = 'g2'`).get().n, 0);
        db.close();
    });

    test('is a no-op (deleted: false) for a gallery id that does not exist', () => {
        const db = freshDb();
        const result = deleteGalleryRow(db, 'does-not-exist');
        assert.equal(result.deleted, false);
        db.close();
    });
});

// ── B: softDeleteGallery / restoreGallery ───────────────────────────────────

describe('softDeleteGallery (transaction B)', () => {
    test('marks the gallery deleted and strips ONLY its own collection membership — a sibling member is untouched', () => {
        const db = freshDb();
        seedCollectionWithMembers(db, 'c1', ['g1', 'g2']);

        const result = softDeleteGallery(db, 'g1', '2026-06-01T00:00:00.000Z');

        assert.equal(result.found, true);
        const row = db.prepare(`SELECT deleted, deleted_at FROM galleries WHERE id = 'g1'`).get();
        assert.equal(row.deleted, 1);
        assert.equal(row.deleted_at, '2026-06-01T00:00:00.000Z');
        assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM collection_galleries WHERE gallery_id = 'g1'`).get().n, 0);
        assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM collection_galleries WHERE gallery_id = 'g2'`).get().n, 1);
        db.close();
    });

    test('found: false for a gallery id that does not exist', () => {
        const db = freshDb();
        const result = softDeleteGallery(db, 'does-not-exist', new Date().toISOString());
        assert.equal(result.found, false);
        db.close();
    });

    test('calling it again on an already-trashed gallery is an idempotent no-op — it no longer resets the retention clock', () => {
        const db = freshDb();
        seedGallery(db, 'g1');
        const first = softDeleteGallery(db, 'g1', '2026-06-01T00:00:00.000Z');
        const second = softDeleteGallery(db, 'g1', '2026-06-05T00:00:00.000Z');
        assert.equal(first.found, true);
        assert.equal(second.found, true); // gallery exists — just already trashed, not an error
        assert.equal(db.prepare(`SELECT deleted_at FROM galleries WHERE id = 'g1'`).get().deleted_at, '2026-06-01T00:00:00.000Z');
        db.close();
    });
});

describe('restoreGallery', () => {
    test('clears deleted/deleted_at for a trashed gallery', () => {
        const db = freshDb();
        seedGallery(db, 'g1');
        softDeleteGallery(db, 'g1', new Date().toISOString());

        const result = restoreGallery(db, 'g1');

        assert.equal(result.restored, true);
        const row = db.prepare(`SELECT deleted, deleted_at FROM galleries WHERE id = 'g1'`).get();
        assert.equal(row.deleted, 0);
        assert.equal(row.deleted_at, null);
        db.close();
    });

    test('is a no-op on a gallery that is not currently trashed', () => {
        const db = freshDb();
        seedGallery(db, 'g1'); // never soft-deleted
        const result = restoreGallery(db, 'g1');
        assert.equal(result.restored, false);
        db.close();
    });
});

// ── C: purgeWithTolerance ────────────────────────────────────────────────────

describe('purgeWithTolerance (transaction C — the empty-trash per-item guard)', () => {
    test('a failure on one id does not abort the rest, and the returned count reflects only real successes', () => {
        const attempted = [];
        const deleteOneFn = (id) => {
            attempted.push(id);
            if (id === 'g2') throw new Error('simulated filesystem failure');
        };

        const purged = purgeWithTolerance(['g1', 'g2', 'g3'], deleteOneFn);

        assert.equal(purged, 2);
        assert.deepEqual(attempted, ['g1', 'g2', 'g3']); // g3 still attempted despite g2's failure
    });

    test('an empty id list purges nothing and does not call deleteOneFn', () => {
        let calls = 0;
        const purged = purgeWithTolerance([], () => calls++);
        assert.equal(purged, 0);
        assert.equal(calls, 0);
    });
});

// ── D: addGalleryToCollection ────────────────────────────────────────────────

describe('addGalleryToCollection (transaction D)', () => {
    test('adding to a brand-new collection succeeds at position 0', () => {
        const db = freshDb();
        db.prepare(`INSERT INTO collections (id, created_at) VALUES ('c1', ?)`).run(new Date().toISOString());
        seedGallery(db, 'g1');

        const result = addGalleryToCollection(db, 'c1', 'g1');

        assert.deepEqual(result, { galleryIds: ['g1'] });
        assert.equal(db.prepare(`SELECT position FROM collection_galleries WHERE gallery_id = 'g1'`).get().position, 0);
        db.close();
    });

    test('a second gallery is appended at the next position, not position 0', () => {
        const db = freshDb();
        db.prepare(`INSERT INTO collections (id, created_at) VALUES ('c1', ?)`).run(new Date().toISOString());
        seedGallery(db, 'g1');
        seedGallery(db, 'g2');
        addGalleryToCollection(db, 'c1', 'g1');

        const result = addGalleryToCollection(db, 'c1', 'g2');

        assert.deepEqual(result, { galleryIds: ['g1', 'g2'] });
        assert.equal(db.prepare(`SELECT position FROM collection_galleries WHERE gallery_id = 'g2'`).get().position, 1);
        db.close();
    });

    test('returns already_in_another_collection, and makes no change, when the gallery belongs elsewhere', () => {
        const db = freshDb();
        seedCollectionWithMembers(db, 'c1', ['g1']);
        db.prepare(`INSERT INTO collections (id, created_at) VALUES ('c2', ?)`).run(new Date().toISOString());

        const result = addGalleryToCollection(db, 'c2', 'g1');

        assert.deepEqual(result, { error: 'already_in_another_collection' });
        assert.equal(db.prepare(`SELECT collection_id FROM collection_galleries WHERE gallery_id = 'g1'`).get().collection_id, 'c1');
        db.close();
    });

    test('re-adding a gallery already in the SAME collection is an idempotent no-op returning the unchanged membership list', () => {
        const db = freshDb();
        seedCollectionWithMembers(db, 'c1', ['g1', 'g2']);

        const result = addGalleryToCollection(db, 'c1', 'g1');

        assert.deepEqual(result, { galleryIds: ['g1', 'g2'] });
        assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM collection_galleries`).get().n, 2); // no duplicate row inserted
        db.close();
    });

    test('returns collection_not_found for an unknown collection', () => {
        const db = freshDb();
        seedGallery(db, 'g1');
        assert.deepEqual(addGalleryToCollection(db, 'does-not-exist', 'g1'), { error: 'collection_not_found' });
        db.close();
    });

    test('returns gallery_not_found for an unknown gallery', () => {
        const db = freshDb();
        db.prepare(`INSERT INTO collections (id, created_at) VALUES ('c1', ?)`).run(new Date().toISOString());
        assert.deepEqual(addGalleryToCollection(db, 'c1', 'does-not-exist'), { error: 'gallery_not_found' });
        db.close();
    });
});

// ── E: bumpGalleryDownloadCounts ────────────────────────────────────────────

describe('bumpGalleryDownloadCounts (transaction E)', () => {
    test('increments every listed gallery by exactly 1, leaving an unrelated gallery untouched', () => {
        const db = freshDb();
        ['g1', 'g2', 'g3', 'g4'].forEach(id => seedGallery(db, id));

        bumpGalleryDownloadCounts(db, ['g1', 'g2', 'g3']);

        const counts = db.prepare(`SELECT id, download_count FROM galleries ORDER BY id`).all();
        assert.deepEqual(counts, [
            { id: 'g1', download_count: 1 },
            { id: 'g2', download_count: 1 },
            { id: 'g3', download_count: 1 },
            { id: 'g4', download_count: 0 }
        ]);
        db.close();
    });

    test('an empty list is a no-op', () => {
        const db = freshDb();
        seedGallery(db, 'g1');
        assert.doesNotThrow(() => bumpGalleryDownloadCounts(db, []));
        assert.equal(db.prepare(`SELECT download_count FROM galleries WHERE id = 'g1'`).get().download_count, 0);
        db.close();
    });
});
