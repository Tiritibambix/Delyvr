'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const Database = require('better-sqlite3');

const {
    planGalleryMigration,
    planCollectionMigration,
    planAllCollections,
    planSettingsMigration,
    verifyCounts
} = require('../scripts/lib/migrate-core');

describe('planGalleryMigration', () => {
    test('happy path: a well-formed gallery migrates every field and sub-record', () => {
        const g = {
            id: 'g1',
            eventName: 'Wedding',
            created: '2026-01-01T00:00:00.000Z',
            files: ['a.jpg', 'b.mp4'],
            background: 'g1.jpg',
            downloadsEnabled: true,
            commentsEnabled: true,
            downloadCount: 3,
            viewCount: 10,
            viewerHashes: ['a'.repeat(64), 'b'.repeat(64)],
            clientLanguage: 'fr',
            order: 2,
            dimensions: {
                'a.jpg': { w: 800, h: 600, animated: false },
                'b.mp4': { w: 1920, h: 1080, duration: 42 }
            },
            favorites: { 'a.jpg': ['visitor1', 'visitor2'] },
            comments: { 'a.jpg': [{ id: 'c1', visitorId: 'visitor1', name: 'Alice', text: 'Lovely!', createdAt: '2026-01-02T00:00:00.000Z' }] },
            audio: { filename: 'song.mp3', stored: 'gallery-g1.mp3', size: 1000, duration: 120, uploadedAt: '2026-01-01T00:00:00.000Z' }
        };

        const plan = planGalleryMigration(g);

        assert.equal(plan.row.id, 'g1');
        assert.equal(plan.row.event_name, 'Wedding');
        assert.equal(plan.row.created_at, '2026-01-01T00:00:00.000Z');
        assert.equal(plan.row.downloads_enabled, 1);
        assert.equal(plan.row.comments_enabled, 1);
        assert.equal(plan.row.download_count, 3);
        assert.equal(plan.row.view_count, 10);
        assert.equal(plan.row.client_language, 'fr');
        assert.equal(plan.row.deleted, 0);
        assert.equal(plan.row.deleted_at, null);
        assert.equal(plan.row.sort_order, 2);
        assert.equal(plan.row.audio_filename, 'song.mp3');
        assert.equal(plan.row.audio_duration, 120);

        assert.equal(plan.files.length, 2);
        const fileA = plan.files.find(f => f.filename === 'a.jpg');
        assert.equal(fileA.width, 800);
        assert.equal(fileA.animated, 0);
        assert.equal(fileA.duration, null);
        const fileB = plan.files.find(f => f.filename === 'b.mp4');
        assert.equal(fileB.duration, 42);
        assert.equal(fileB.animated, null);

        assert.deepEqual(plan.favorites, [{ filename: 'a.jpg', visitorId: 'visitor1' }, { filename: 'a.jpg', visitorId: 'visitor2' }]);
        assert.equal(plan.comments.length, 1);
        assert.equal(plan.comments[0].text, 'Lovely!');
        assert.equal(plan.viewerHashes.length, 2);
        assert.equal(plan.favoritesDropped, 0);
        assert.equal(plan.commentsDropped, 0);
        assert.deepEqual(plan.warnings, []);
    });

    test('throws on a record with no id', () => {
        assert.throws(() => planGalleryMigration({ eventName: 'No id' }), /missing a valid id/);
    });

    test('legacy array-shaped favorites/comments are treated as empty, per-gallery (a sibling gallery with normal data is unaffected)', () => {
        const legacy = {
            id: 'g1', created: '2026-01-01T00:00:00.000Z', files: ['a.jpg'],
            favorites: ['visitor1', 'visitor2'], // old array shape
            comments: ['not', 'an', 'object']
        };
        const normal = {
            id: 'g2', created: '2026-01-01T00:00:00.000Z', files: ['a.jpg'],
            favorites: { 'a.jpg': ['visitor1'] },
            comments: { 'a.jpg': [{ id: 'c1', visitorId: 'visitor1', text: 'hi', createdAt: '2026-01-01T00:00:00.000Z' }] }
        };

        const planLegacy = planGalleryMigration(legacy);
        assert.deepEqual(planLegacy.favorites, []);
        assert.deepEqual(planLegacy.comments, []);
        assert.equal(planLegacy.favoritesDropped, 0); // legacy-shape is treated as "nothing to migrate", not "orphans dropped"
        assert.equal(planLegacy.commentsDropped, 0);

        const planNormal = planGalleryMigration(normal);
        assert.equal(planNormal.favorites.length, 1);
        assert.equal(planNormal.comments.length, 1);
    });

    test('missing optional fields fall back to documented defaults', () => {
        const plan = planGalleryMigration({ id: 'g1', created: '2026-01-01T00:00:00.000Z' });
        assert.equal(plan.row.event_name, 'Untitled Event');
        assert.equal(plan.row.background, null);
        assert.equal(plan.row.downloads_enabled, 1);
        assert.equal(plan.row.comments_enabled, 1);
        assert.equal(plan.row.download_count, 0);
        assert.equal(plan.row.view_count, 0);
        assert.equal(plan.row.client_language, null);
        assert.equal(plan.row.sort_order, null);
        assert.equal(plan.row.audio_filename, null);
        assert.deepEqual(plan.files, []);
        assert.deepEqual(plan.favorites, []);
        assert.deepEqual(plan.comments, []);
        assert.deepEqual(plan.viewerHashes, []);
    });

    test('a completely missing "created" defaults to now and emits a warning', () => {
        const plan = planGalleryMigration({ id: 'g1' });
        assert.ok(plan.row.created_at);
        assert.ok(plan.warnings.some(w => w.includes('missing "created"')));
    });

    test('deleted:true with a missing deletedAt falls back defensively and warns, rather than violating the schema\'s pairing CHECK', () => {
        const plan = planGalleryMigration({ id: 'g1', created: '2026-01-01T00:00:00.000Z', deleted: true });
        assert.equal(plan.row.deleted, 1);
        assert.equal(plan.row.deleted_at, '2026-01-01T00:00:00.000Z'); // falls back to created
        assert.ok(plan.warnings.some(w => w.includes('deletedAt')));
    });

    test('an incomplete audio object (missing a required sub-field) is dropped entirely and warned about, not partially migrated', () => {
        const plan = planGalleryMigration({
            id: 'g1', created: '2026-01-01T00:00:00.000Z',
            audio: { filename: 'song.mp3' /* missing stored/size/uploadedAt */ }
        });
        assert.equal(plan.row.audio_filename, null);
        assert.equal(plan.row.audio_stored, null);
        assert.ok(plan.warnings.some(w => w.includes('audio') && w.includes('incomplete')));
    });

    test('a favorite/comment referencing a filename no longer in files[] is DROPPED, not thrown — the pre-existing orphan case', () => {
        const plan = planGalleryMigration({
            id: 'g1', created: '2026-01-01T00:00:00.000Z',
            files: ['still-here.jpg'], // 'deleted-photo.jpg' is NOT in this list
            favorites: { 'still-here.jpg': ['visitor1'], 'deleted-photo.jpg': ['visitor2', 'visitor3'] },
            comments: { 'deleted-photo.jpg': [{ id: 'c1', visitorId: 'visitor1', text: 'orphaned', createdAt: '2026-01-01T00:00:00.000Z' }] }
        });
        assert.deepEqual(plan.favorites, [{ filename: 'still-here.jpg', visitorId: 'visitor1' }]);
        assert.equal(plan.favoritesDropped, 2); // two distinct voters on the orphaned filename
        assert.equal(plan.comments.length, 0);
        assert.equal(plan.commentsDropped, 1);
        assert.ok(plan.warnings.some(w => w.includes('dropped 2 favorite(s)')));
    });

    test('duplicate filenames in files[] are deduped', () => {
        const plan = planGalleryMigration({ id: 'g1', created: '2026-01-01T00:00:00.000Z', files: ['a.jpg', 'a.jpg', 'b.jpg'] });
        assert.equal(plan.files.length, 2);
    });
});

describe('planCollectionMigration', () => {
    test('happy path', () => {
        const c = { id: 'c1', name: 'Honeymoon', created: '2026-01-01T00:00:00.000Z', galleryIds: ['g1', 'g2'], downloadsEnabled: true };
        const plan = planCollectionMigration(c, new Set(['g1', 'g2']));
        assert.equal(plan.row.id, 'c1');
        assert.equal(plan.row.name, 'Honeymoon');
        assert.deepEqual(plan.memberships, [{ galleryId: 'g1', position: 0 }, { galleryId: 'g2', position: 1 }]);
    });

    test('throws on no id', () => {
        assert.throws(() => planCollectionMigration({ name: 'x' }, new Set()), /missing a valid id/);
    });

    test('throws on a dangling gallery reference — this is NOT treated as a benign orphan, unlike favorites/comments', () => {
        const c = { id: 'c1', created: '2026-01-01T00:00:00.000Z', galleryIds: ['ghost-gallery'] };
        assert.throws(() => planCollectionMigration(c, new Set(['g1'])), /does not exist in galleries\.json/);
    });

    test('missing optional fields fall back to documented defaults', () => {
        const plan = planCollectionMigration({ id: 'c1', created: '2026-01-01T00:00:00.000Z' }, new Set());
        assert.equal(plan.row.name, 'Untitled Collection');
        assert.equal(plan.row.downloads_enabled, 1);
        assert.equal(plan.row.comments_enabled, 1);
        assert.deepEqual(plan.memberships, []);
    });
});

describe('planAllCollections', () => {
    test('throws naming both collections and the contested gallery when the same gallery appears in two collections', () => {
        const collectionsJson = [
            { id: 'c1', created: '2026-01-01T00:00:00.000Z', galleryIds: ['g1'] },
            { id: 'c2', created: '2026-01-01T00:00:00.000Z', galleryIds: ['g1'] }
        ];
        assert.throws(
            () => planAllCollections(collectionsJson, new Set(['g1'])),
            /gallery g1 appears in both collection c1 and collection c2/
        );
    });

    test('a gallery appearing twice in the SAME collection\'s own list is not a cross-collection conflict', () => {
        // (Malformed input in principle — the live app never produces this —
        // but planAllCollections should not misreport it as cross-collection.)
        const collectionsJson = [{ id: 'c1', created: '2026-01-01T00:00:00.000Z', galleryIds: ['g1', 'g1'] }];
        assert.doesNotThrow(() => planAllCollections(collectionsJson, new Set(['g1'])));
    });
});

describe('planSettingsMigration', () => {
    test('merges with defaults exactly like the live app\'s loadSettings()', () => {
        const plan = planSettingsMigration({ theme: 'light', socials: { instagram: 'https://instagram.com/x' } });
        assert.equal(plan.row.theme, 'light');
        assert.equal(plan.row.admin_language, 'en'); // default, since not overridden
        assert.equal(plan.row.client_language, 'auto'); // settings DOES store the literal string here
        assert.deepEqual(plan.socials, [{ key: 'instagram', value: 'https://instagram.com/x' }]);
    });

    test('an absent settings.json (brand-new install) produces an all-defaults row with no socials', () => {
        const plan = planSettingsMigration({});
        assert.equal(plan.row.theme, 'dark');
        assert.equal(plan.row.date_format, 'auto');
        assert.deepEqual(plan.socials, []);
    });
});

describe('verifyCounts', () => {
    test('passes silently when every table matches', () => {
        assert.doesNotThrow(() => verifyCounts({ galleries: 3, files: 10 }, { galleries: 3, files: 10 }));
    });

    test('throws, naming every mismatching table, when counts disagree', () => {
        assert.throws(
            () => verifyCounts({ galleries: 3, files: 10 }, { galleries: 2, files: 10 }),
            /galleries: expected 3, got 2/
        );
    });
});

// ─────────────────────────────────────────────────────────────────────────
// End-to-end CLI tests. These spawn the real script as a subprocess rather
// than calling its exported main() in-process, because the script calls
// process.exit() on both success and failure — calling that in-process
// inside a test would kill the whole test runner.
// ─────────────────────────────────────────────────────────────────────────

describe('migrate-json-to-sqlite.js (subprocess)', () => {
    let tmpDir;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'delyvr-migrate-test-'));
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    function runMigrate(extraArgs = []) {
        const scriptPath = path.join(__dirname, '..', 'scripts', 'migrate-json-to-sqlite.js');
        return spawnSync(process.execPath, [scriptPath, ...extraArgs], {
            env: { ...process.env, INSTALL_DIR: tmpDir },
            encoding: 'utf8'
        });
    }

    function writeFixtures({ galleries = [], collections = [], settings = {} } = {}) {
        fs.writeFileSync(path.join(tmpDir, 'galleries.json'), JSON.stringify(galleries));
        fs.writeFileSync(path.join(tmpDir, 'collections.json'), JSON.stringify(collections));
        fs.writeFileSync(path.join(tmpDir, 'settings.json'), JSON.stringify(settings));
    }

    test('happy path: creates delyvr.sqlite and leaves the source JSON files byte-identical', () => {
        const fixture = {
            galleries: [{ id: 'g1', eventName: 'Test', created: '2026-01-01T00:00:00.000Z', files: ['a.jpg'] }],
            collections: [],
            settings: { theme: 'light' }
        };
        writeFixtures(fixture);
        const before = fs.readFileSync(path.join(tmpDir, 'galleries.json'), 'utf8');

        const result = runMigrate();

        assert.equal(result.status, 0, result.stderr);
        assert.ok(fs.existsSync(path.join(tmpDir, 'delyvr.sqlite')));
        assert.equal(fs.readFileSync(path.join(tmpDir, 'galleries.json'), 'utf8'), before);

        const db = new Database(path.join(tmpDir, 'delyvr.sqlite'), { readonly: true });
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM galleries').get().n, 1);
        assert.equal(db.prepare('SELECT theme FROM settings WHERE id = 1').get().theme, 'light');
        db.close();
    });

    test('a brand-new install with no JSON files at all bootstraps an all-defaults database', () => {
        const result = runMigrate();
        assert.equal(result.status, 0, result.stderr);
        assert.ok(fs.existsSync(path.join(tmpDir, 'delyvr.sqlite')));
    });

    test('refuses to re-run without --force, and does not touch the existing database', () => {
        writeFixtures({ galleries: [{ id: 'g1', created: '2026-01-01T00:00:00.000Z', files: [] }] });
        assert.equal(runMigrate().status, 0);

        const dbPath = path.join(tmpDir, 'delyvr.sqlite');
        const beforeBytes = fs.readFileSync(dbPath);

        const second = runMigrate();
        assert.equal(second.status, 1);
        assert.match(second.stderr, /already exists/);
        assert.deepEqual(fs.readFileSync(dbPath), beforeBytes);
    });

    test('--force rebuilds from the JSON files', () => {
        writeFixtures({ galleries: [{ id: 'g1', created: '2026-01-01T00:00:00.000Z', files: [] }] });
        assert.equal(runMigrate().status, 0);

        writeFixtures({ galleries: [{ id: 'g1', created: '2026-01-01T00:00:00.000Z', files: [] }, { id: 'g2', created: '2026-01-01T00:00:00.000Z', files: [] }] });
        const result = runMigrate(['--force']);
        assert.equal(result.status, 0, result.stderr);

        const db = new Database(path.join(tmpDir, 'delyvr.sqlite'), { readonly: true });
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM galleries').get().n, 2);
        db.close();
    });

    test('a gallery referenced by two different collections aborts the whole migration without creating a database or touching the source files', () => {
        writeFixtures({
            galleries: [{ id: 'g1', created: '2026-01-01T00:00:00.000Z', files: [] }],
            collections: [
                { id: 'c1', created: '2026-01-01T00:00:00.000Z', galleryIds: ['g1'] },
                { id: 'c2', created: '2026-01-01T00:00:00.000Z', galleryIds: ['g1'] }
            ]
        });
        const before = fs.readFileSync(path.join(tmpDir, 'collections.json'), 'utf8');

        const result = runMigrate();

        assert.equal(result.status, 1);
        assert.match(result.stderr, /appears in both collection c1 and collection c2/);
        assert.ok(!fs.existsSync(path.join(tmpDir, 'delyvr.sqlite')));
        assert.ok(!fs.existsSync(path.join(tmpDir, 'delyvr.sqlite.migrating')));
        assert.equal(fs.readFileSync(path.join(tmpDir, 'collections.json'), 'utf8'), before);
    });

    test('a corrupt (unparseable) JSON source file aborts loudly instead of silently defaulting to empty', () => {
        fs.writeFileSync(path.join(tmpDir, 'galleries.json'), '{ not valid json');
        const result = runMigrate();
        assert.equal(result.status, 1);
        assert.match(result.stderr, /could not be parsed as JSON/);
        assert.ok(!fs.existsSync(path.join(tmpDir, 'delyvr.sqlite')));
    });
});
