// Delyvr — the handful of operations that touch more than one table (or
// otherwise deserve their own name) in one atomic unit.
//
// These live here, separate from server.js, for one concrete reason:
// server.js is not require()-able as a module (it immediately registers
// routes and calls app.listen()/process.exit()), so it cannot be exercised
// by test/transactions.test.js directly. Everything else — the hundred-odd
// single-table reads/writes behind each route — stays exactly where it
// always was, inline in server.js's route handlers, matching the rest of
// the file's style. This module exists only for the operations that are
// either (a) multi-statement and must be atomic, or (b) worth a name.
//
// Every function here takes an already-open `db` handle as its first
// argument (opened by db/index.js) and does no filesystem I/O — the
// filesystem side of a hard delete (removing uploads/thumbnails/previews/
// backgrounds/audio) stays in server.js's hardDeleteGallery(), called
// BEFORE deleteGalleryRow() below, exactly as today: disk first, then DB,
// so a crash between the two leaves the DB still pointing at a gallery
// whose files are already gone rather than the other way around — this
// ordering is what lets a future reconcileGalleries() pass notice and
// repair it, the same role it already plays against the filesystem today.

'use strict';

/**
 * Transaction A (the DB half). Deletes the galleries row; ON DELETE CASCADE
 * removes files/favorites/comments/viewer_hashes/collection_galleries for it
 * automatically — this replaces the manual "scan every collection and strip
 * this gallery out of its galleryIds" loop the old JSON-backed code needed.
 * A single DELETE is already atomic in SQLite without an explicit
 * transaction wrapper, but it's wrapped anyway: cheap, harmless, and
 * future-proofs this function against ever growing a second step.
 */
function deleteGalleryRow(db, galleryId) {
    return db.transaction(() => {
        const info = db.prepare(`DELETE FROM galleries WHERE id = ?`).run(galleryId);
        return { deleted: info.changes > 0 };
    })();
}

/**
 * Transaction B. Soft-deletes a gallery (moves it to trash) and strips its
 * collection membership in the same atomic unit — a gallery can never end up
 * marked deleted while still listed as a live member of a collection, or
 * vice versa.
 *
 * Deliberately has NO "AND deleted = 0" guard on the UPDATE, matching the
 * live app's existing behaviour exactly: calling this again on an already-
 * trashed gallery re-stamps deleted_at to `deletedAtIso`, silently resetting
 * the 3-day retention clock. This is a pre-existing quirk, not something
 * introduced by this migration — see CLAUDE.md's "Noted but out of scope".
 */
function softDeleteGallery(db, galleryId, deletedAtIso) {
    return db.transaction(() => {
        const info = db.prepare(`UPDATE galleries SET deleted = 1, deleted_at = ? WHERE id = ?`).run(deletedAtIso, galleryId);
        if (info.changes === 0) return { found: false };
        db.prepare(`DELETE FROM collection_galleries WHERE gallery_id = ?`).run(galleryId);
        return { found: true };
    })();
}

/**
 * Inverse of softDeleteGallery — restores a trashed gallery. Guarded by
 * "AND deleted = 1" so restoring a gallery that isn't actually in trash is a
 * no-op (0 rows changed), matching the live route's own
 * `if (!gallery || !gallery.deleted) return 404` check.
 */
function restoreGallery(db, galleryId) {
    const info = db.prepare(`UPDATE galleries SET deleted = 0, deleted_at = NULL WHERE id = ? AND deleted = 1`).run(galleryId);
    return { restored: info.changes > 0 };
}

/**
 * Transaction D. Adds a gallery to a collection, enforcing "a gallery
 * belongs to at most one collection" via the collection_galleries.gallery_id
 * UNIQUE constraint rather than the old code's per-request scan of every
 * other collection. Returns one of:
 *   { error: 'collection_not_found' | 'gallery_not_found' | 'already_in_another_collection' }
 *   { galleryIds: string[] }   (the collection's full, ordered membership — unchanged if the gallery was already a member)
 */
function addGalleryToCollection(db, collectionId, galleryId) {
    return db.transaction(() => {
        const collection = db.prepare(`SELECT id FROM collections WHERE id = ?`).get(collectionId);
        if (!collection) return { error: 'collection_not_found' };

        const gallery = db.prepare(`SELECT id FROM galleries WHERE id = ?`).get(galleryId);
        if (!gallery) return { error: 'gallery_not_found' };

        const existing = db.prepare(`SELECT collection_id FROM collection_galleries WHERE gallery_id = ?`).get(galleryId);
        if (existing && existing.collection_id !== collectionId) {
            return { error: 'already_in_another_collection' };
        }
        if (!existing) {
            const maxPos = db.prepare(`SELECT MAX(position) AS maxPos FROM collection_galleries WHERE collection_id = ?`).get(collectionId).maxPos;
            const nextPos = maxPos === null ? 0 : maxPos + 1;
            db.prepare(`INSERT INTO collection_galleries (collection_id, gallery_id, position) VALUES (?, ?, ?)`).run(collectionId, galleryId, nextPos);
        }
        // existing && existing.collection_id === collectionId -> no-op, matching
        // the old `if (!collection.galleryIds.includes(galleryId))` idempotent
        // re-add behaviour exactly.

        const galleryIds = db.prepare(`SELECT gallery_id FROM collection_galleries WHERE collection_id = ? ORDER BY position`)
            .all(collectionId).map(r => r.gallery_id);
        return { galleryIds };
    })();
}

/**
 * Transaction E. Bumps download_count by 1 on every gallery id given, as one
 * atomic unit — called from the collection-ZIP-download route, BEFORE the
 * ZIP stream starts (preserving the existing "counted even if the client
 * disconnects mid-stream" behaviour rather than moving the bump to a
 * stream-`end` handler, which would be an unreviewed behaviour change).
 */
function bumpGalleryDownloadCounts(db, galleryIds) {
    if (galleryIds.length === 0) return;
    const stmt = db.prepare(`UPDATE galleries SET download_count = download_count + 1 WHERE id = ?`);
    db.transaction(() => { for (const id of galleryIds) stmt.run(id); })();
}

/**
 * Transaction C's missing piece, restored: runs `deleteOneFn` for every id,
 * tolerating a failure on any single one without aborting the rest — the
 * same per-item try/catch purgeExpiredTrash() already had, which the old
 * "empty entire trash" route lacked (confirmed by direct code reading: its
 * `ids.forEach(id => hardDeleteGallery(id))` had no guard at all). Not
 * SQL-specific — `deleteOneFn` is whatever the caller wants to call per id
 * (hardDeleteGallery, with its filesystem side effects, in practice) — kept
 * here only because it's the direct fix for the gap found in transaction C.
 * Returns the count of calls that did NOT throw.
 */
function purgeWithTolerance(ids, deleteOneFn) {
    let purged = 0;
    for (const id of ids) {
        try {
            deleteOneFn(id);
            purged++;
        } catch (e) {
            console.warn(`[TRASH] Purge failed for ${id}: ${e.message}`);
        }
    }
    return purged;
}

module.exports = {
    deleteGalleryRow,
    softDeleteGallery,
    restoreGallery,
    addGalleryToCollection,
    bumpGalleryDownloadCounts,
    purgeWithTolerance
};
