# CLAUDE.md — Delyvr

This file describes the architecture, conventions, and key decisions in Delyvr so that AI assistants and contributors can work on the codebase effectively.

---

## What is Delyvr?

Delyvr is a **self-hosted photo delivery platform** for photographers. A photographer logs into a private dashboard, creates named galleries by uploading photos, groups them into collections, then shares links with clients. Clients browse photos in a justified gallery, open them in a pinch-zoomable lightbox, mark favorites, and download photos or full collections as ZIP files.

There is no public registration. The entire admin side is protected by a single shared password.

> Based on the original work of [Andre Padua (apadua)](https://github.com/apadua/MeTransfer).

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js 22+ (Docker image: `node:24-alpine`) |
| Server framework | Express 5 |
| Database | SQLite via `better-sqlite3` (embedded, single file — no separate DB server/container) |
| File uploads | multer (disk storage) |
| Image processing | sharp (thumbnails, previews, OG images, background normalisation) |
| ZIP creation | archiver |
| Unique IDs | uuid v4 |
| Environment config | dotenv |
| Rate limiting | express-rate-limit |
| HTML escaping | escape-html (used server-side for OG tag injection) |
| IP/CIDR parsing | Node built-in `net` module (no extra dependency) |
| Frontend | Vanilla HTML/CSS/JS — no framework, no build step |
| Fonts | Google Fonts (Instrument Sans, Fraunces) |

---

## File Structure

```
delyvr/
├── server.js           # All server logic — Express app, routes, middleware
├── db/
│   ├── index.js        # openDatabase() — connection + PRAGMAs + schema bootstrap
│   ├── operations.js   # The handful of multi-table operations, kept testable (see "Data persistence")
│   └── schema.sql       # CREATE TABLE/INDEX statements, applied on every connection open
├── scripts/
│   ├── migrate-json-to-sqlite.js  # One-time migration CLI — `npm run migrate`
│   └── lib/migrate-core.js         # Pure transform/decision logic the migration + its tests share
├── test/                # node --test — schema constraints, the multi-table operations, the migration
├── package.json
├── Dockerfile
├── docker-compose.yml
├── .env                # Secret config (gitignored) — copy from .env.example
├── .env.example        # Template showing required env vars
├── .dockerignore
├── .gitignore
├── public/
│   ├── admin.html      # Photographer dashboard (sidebar shell + hash-routed views)
│   ├── admin.css       # Dashboard stylesheet, split out of admin.html
│   ├── admin-i18n.js   # adminTranslations (en/fr/es/pt/it), split out of admin.html
│   ├── preview.html    # THE client document: gallery view + collection index + audio player
│   │                   # (also serves /collection/:id — see "One client document")
│   ├── favorites.html  # Public favorites ranking page (/favorites/:id)
│   └── shared.js       # Shared client JS — SOCIAL_ICONS, applyTheme(), renderSocialFooter()
└── data/               # Runtime data root (Docker volume mount at /data)
    ├── uploads/        # Gallery photos, organised as uploads/{galleryId}/
    ├── backgrounds/    # Background images — {galleryId}.jpg for galleries,
    │                   # collection-{collectionId}.jpg for collections (normalised JPEG)
    ├── thumbnails/     # 400px JPEG thumbnails, generated on upload or first request
    ├── previews/       # 1920px JPEG previews for lightbox, generated on upload or first request
    ├── og-cache/       # 1200×630 OG images, generated on first share
    ├── audio/          # Audio montages — collection-{id}.{ext} / gallery-{id}.{ext}, verbatim
    ├── delyvr.sqlite   # THE database — galleries, collections, settings, everything (see "Data persistence")
    ├── delyvr.sqlite-wal / -shm  # WAL mode sidecar files — persist only because this whole
    │                              # directory, not just the .sqlite file, is the Docker volume
    ├── galleries.json  # Pre-migration data — kept on disk, UNUSED by the running server (see "Data persistence")
    ├── collections.json # Pre-migration data — same
    └── settings.json   # Pre-migration data — same
```

---

## Configuration

| Variable | Default | Notes |
|----------|---------|-------|
| `ADMIN_PASSWORD` | *(none — must be set)* | Password for the admin dashboard |
| `PORT` | `3000` | TCP port the server listens on |
| `MAX_UPLOAD_MB` | `200` | Per-file size limit for photo uploads, in MB |
| `MAX_VIDEO_MB` | `500` | Per-file size limit for video uploads, in MB |
| `MAX_BACKGROUND_MB` | `25` | Size limit for background image uploads, in MB |
| `MAX_AUDIO_MB` | `150` | Size limit for a collection's audio montage, in MB |
| `INSTALL_DIR` | *(project dir)* | Set to `/data` in Docker. Controls where all data files are written. |
| `TRUST_PROXY` | `0` | Set to `1` behind a single reverse proxy. Also accepts: integer hop count, IP, CIDR, comma-separated IPs/CIDRs, or `loopback`/`uniquelocal`. |
| `ADMIN_ALLOWED_IPS` | *(unset — all IPs allowed)* | Comma-separated IPs or CIDR ranges. When set, all admin routes (including login) reject requests from unlisted IPs with 403. |

---

## Server Architecture (`server.js`)

### Data persistence

**SQLite (`data/delyvr.sqlite`), via `better-sqlite3`, is the sole source of truth** for
galleries, collections and settings. Until late 2026 this was three JSON files
(`galleries.json`/`collections.json`/`settings.json`) loaded into in-memory `Map`s at
startup and rewritten whole on every mutation; it moved to a normalized schema ahead of
the proofing/analytics work (client selection with quotas, per-photo star/color/status,
engagement funnel), which needs joins and aggregates a `Map` scan can't give cheaply.

Not `node:sqlite` (Node's own built-in module): as of the migration it was still
stability "1.2 — release candidate", and critically has no `transaction()` helper —
meaning hand-written `BEGIN`/`COMMIT`/`ROLLBACK` around every multi-table write, more
surface for a mistake than this project wants. `better-sqlite3`'s synchronous API also
matches the rest of `server.js`'s style (no new async plumbing needed anywhere this
touches), and its v13+ line ships prebuilt N-API binaries for `linux-musl` — no compiler
toolchain needed in the Alpine-based Docker image.

**Schema** (`db/schema.sql`, applied — all `CREATE ... IF NOT EXISTS` — on every
connection open, so it's self-healing if a table were ever dropped by hand):

| Table | Replaces | Notes |
|---|---|---|
| `galleries` | the old gallery JSON object's scalar fields | `id`, `event_name`, `created_at`, `background` (bookkeeping only — see below), `downloads_enabled`/`comments_enabled` (`INTEGER` 0/1, `NOT NULL DEFAULT 1`), `download_count`, `view_count`, `client_language` (`NULL` = "auto" — never the literal string), `deleted`/`deleted_at` (paired by a `CHECK`), `sort_order` (`NULL` = never manually reordered), `audio_filename`/`audio_stored`/`audio_size`/`audio_duration`/`audio_uploaded_at` (all-or-nothing, enforced by a `CHECK`) |
| `collections` | the old collection JSON object | same shape minus `deleted`/`deleted_at`/`sort_order` — collections have no trash and no manual card order |
| `collection_galleries` | `collection.galleryIds[]` | `(collection_id, gallery_id, position)` — `UNIQUE(gallery_id)` is what declares "a gallery belongs to at most one collection" instead of the old per-request scan of every collection; `position` preserves display order (this IS meaningful here, unlike `files` below) |
| `files` | `gallery.files[]` **and** `gallery.dimensions{}` | one row per `(gallery_id, filename)` — membership and cached `width`/`height`/`duration`(video)/`animated`(image) live together now. **No `type`/`kind` column**: still derived from the extension via `isVideoFile()` at read time, same as before — storing it would be a redundant, driftable duplicate. **No proofing/rating/color/status columns yet** — the shape is already right for that work to be a plain `ALTER TABLE` when it starts, deliberately not added speculatively before then |
| `favorites` | `gallery.favorites{}` | `(gallery_id, filename, visitor_id)` — `FOREIGN KEY (gallery_id, filename) REFERENCES files` means favoriting an already-deleted photo now 404s instead of silently creating a permanent orphan entry (see "Soft-delete and trash" and the photo-delete route — this is a deliberate, announced behavior change) |
| `comments` | `gallery.comments{}` | same FK-to-`files` shape; `id` has no format `CHECK` — the app never validated a comment id's shape on delete either (plain string equality), so this isn't a regression |
| `viewer_hashes` | `gallery.viewerHashes[]` | `(gallery_id, hash)` — SHA-256 hex of IP+UA, dedup for unique-view counting |
| `settings` | `settings.json` | **singleton**, `id` pinned to `1` by a `CHECK`. `client_language` here is a **different domain** than the galleries/collections column of the same name: this one is `NOT NULL` and DOES store the literal string `'auto'` (a singleton has no "unset" state). `slideshow_interval`/`slideshow_transition` were added after the first installs migrated, so they also live in `SETTINGS_ADDED_COLUMNS` — see the `ensureSettingsColumns()` note below |
| `settings_socials` | `settings.socials{}` | key-value, not fixed columns or a JSON column — the server never enforced a fixed social-network key set (that list is a `shared.js` UI convention only), and a key-value table keeps every query in this project plain SQL |

**PRAGMAs** (`db/index.js`'s `openDatabase()`, re-applied on **every** connection open —
`journal_mode` is persisted in the file header, but `synchronous`/`foreign_keys`/
`busy_timeout` are **not**, and reset to SQLite's own defaults — `foreign_keys` defaults
**OFF** — on each new connection): `journal_mode = WAL`, `synchronous = NORMAL`,
`busy_timeout = 5000`, `foreign_keys = ON`. Forgetting `foreign_keys = ON` on any one
connection would silently disable every cascade this schema leans on.

**`background` (on both `galleries` and `collections`) is bookkeeping only, never the
source of truth** — every route that needs to know whether a cover exists re-scans
`data/backgrounds/` directly (`fs.readdirSync(...).find(f => f.startsWith(id))`), exactly
as before the migration. This is a deliberate self-healing behavior (deleting a cover file
by hand on the mounted volume makes it disappear instantly, no DB write involved) —
preserved on purpose, don't "fix" it into trusting the column.

**Migration (one-time, not auto-run).** `scripts/migrate-json-to-sqlite.js` reads the 3
JSON files **read-only**, builds a temp SQLite file, verifies row counts and a sampled
field-level diff, and only then renames it into place — a file at the final name is either
a fully, correctly migrated database or doesn't exist at all. `server.js` fails fast (like
the `ADMIN_PASSWORD` check) if `delyvr.sqlite` is missing; there is **no**
auto-migrate-on-boot branch, so a deleted/corrupted `.sqlite` file can never silently
resurrect stale JSON data. The original JSON files are **never** touched — they stay on
disk as a permanent manual fallback, even though the server never reads them again after a
successful migration. Run it via `docker compose run --rm delyvr npm run migrate`
(idempotent per the guard above; `--force` rebuilds from the JSON, discarding any SQL-only
writes since). The script also bootstraps a brand-new install with no JSON files at all
(same code path, tolerating their absence), so it's required before the very first boot too.

**Adding a column to an existing table needs `ensureSettingsColumns()` (`db/index.js`), not
just a schema edit.** Every statement in `schema.sql` is `CREATE TABLE IF NOT EXISTS`, which
does **nothing** to a table that already exists — so a column added to `schema.sql` alone
never appears on an install that migrated before it was written, and the first `SELECT`
naming it throws at startup. `SETTINGS_ADDED_COLUMNS` is the declarative list of such
columns; `ensureSettingsColumns()` reads `PRAGMA table_info` and `ALTER TABLE ... ADD
COLUMN`s only what's missing, and it is called from `applySchema()` so the server, the
migration script and the tests all get it. Each entry must be byte-identical to the column
definition in `schema.sql`. Constraints: `ADD COLUMN` rejects `PRIMARY KEY`/`UNIQUE`,
non-constant defaults, `REFERENCES` while `foreign_keys` is on, and `STORED` generated
columns; a `NOT NULL` column needs a non-null default (existing rows take it, which is also
what satisfies any `CHECK` by construction). `CHECK` itself is allowed.
`test/schema.test.js` covers this against a hand-built pre-change `settings` table.

**`db/operations.js`** holds only the handful of operations that touch more than one table
— `deleteGalleryRow`, `softDeleteGallery`, `restoreGallery`, `addGalleryToCollection`,
`bumpGalleryDownloadCounts`, `purgeWithTolerance` — kept out of `server.js` for exactly one
reason: `server.js` can't be `require()`d by a test (it immediately calls `app.listen()`),
so anything with a `test/transactions.test.js` case has to live somewhere else. Everything
else — the ~70 routes' single-table reads/writes — stays inline in `server.js`, same as
the Map-based code it replaced.

**`dateFormat` is an admin-only display preference** (validated server-side against
`DATE_FORMATS`, `CHECK`-enforced at the schema level too). Client pages deliberately keep
formatting by the *visitor's* resolved locale — the photographer's own preference has no
business changing what a client sees. `admin.html` reads it into `_dateFormat` in
`applyTheme()` and renders every date through `formatAdminDate(iso, withTime)`; the
explicit formats also fix the clock (24 h, except `mdy` which pairs with the 12 h
convention), while `'auto'` defers to `toLocaleString()`. Add new admin date output through
that helper, never `toLocaleDateString()` directly.

### Authentication & IP allowlist

`requireAuth` middleware:
1. If `ADMIN_ALLOWED_IPS` is non-empty, resolves the request IP (stripping `::ffff:` prefix for IPv4-mapped IPv6) and checks it against every entry using `ipMatchesCIDR`. Blocks with 403 and logs `[AUTH] IP blocked` if not matched.
2. Checks the `X-Admin-Password` header against `ADMIN_PASSWORD`. Blocks with 401 and logs `[AUTH] Failed auth attempt` on mismatch.

`requireAllowedIP` is also applied independently on `POST /api/auth/verify` so IP blocking happens before the password is even evaluated.

All `[AUTH]` log lines go to stdout and are visible via `docker logs`.

CIDR matching is implemented with BigInt bitwise arithmetic using the Node built-in `net` module — no extra dependency.

`validateGalleryId` and `validateCollectionId` enforce UUID v4 format before any filesystem operation. `validateFilename` enforces `/^[a-zA-Z0-9._\-]+$/`.

### Path safety

All filesystem paths incorporating user-controlled values go through `safeResolvePath(base, ...segments)`. This resolves the final path and throws if it would escape the base directory. This includes `data/backgrounds/` and `data/audio/` — a filename discovered via `fs.readdirSync(...).find(f => f.startsWith(id))` is still resolved through `safeResolvePath(dir, filename)` before being opened, deleted, or stat'd, not just `path.join`'d directly. There is no exception left anywhere in `server.js`.

### Rate limiting

| Limiter | Limit | Applied to |
|---------|-------|-----------|
| `authLimiter` | 10 / 15 min | `POST /api/auth/verify` |
| `imageLimiter` | 600 / min | Photo and OG image serving |
| `publicReadLimiter` | 300 / min | All public GET routes |
| `publicWriteLimiter` | 120 / min | `POST /favorites`, `POST /comments` |
| `downloadLimiter` | 10 / min | ZIP downloads |
| `adminLimiter` | 300 / min | Admin routes with filesystem access |

**Each limiter has a distinct message.** `adminLimiter` and `publicReadLimiter` used to share the exact same text (`Too many requests, please slow down`), which made a real report impossible to diagnose — the wrong limiter got raised. They are now `Too many admin requests…`, `Too many read requests…`, `Too many write requests…`, etc. Keep them distinct.

**Background/cover images are served under `publicReadLimiter`, not `adminLimiter`** (`/api/gallery/:id/background`, `/api/collection/:id/background`) even though the admin dashboard is their heaviest consumer — one request per gallery/collection card. This is why the admin card thumbnails must stay cacheable (see `bgVersion` below).

`adminLimiter` also covers the list routes (`/api/galleries`, `/api/collections`) that the dashboard re-fetches after every action, so its cap is deliberately high (300/min): bulk admin work — e.g. resetting favorites/views/comments across many galleries in a row, each followed by a refetch — must not trip `Too many admin requests, please slow down`. The routes are already behind `requireAuth` (+ optional IP allowlist), so the abuse surface is low.

### Settings persistence

`getSettings()` reads the singleton `settings` row plus every `settings_socials` row and reassembles the same `{ theme, website, socials, adminLanguage, clientLanguage, dateFormat, slideshowInterval, slideshowTransition }` shape the JSON-era code returned. `updateSettings(patch)` applies only the keys present in `patch` — route handlers keep doing their own validation first, exactly as before, and only pass through fields that already passed it — in one `db.transaction()`.

`GET /api/settings` is public — all client pages call it on load to apply the theme, render the social footer and read the slideshow settings.

`POST /api/settings` is admin-only — accepts `{ theme, website, socials, adminLanguage, clientLanguage, dateFormat, slideshowInterval, slideshowTransition }` and saves the merged result.

**`slideshowInterval` must be coerced with `Number()` before it reaches the DB.** It arrives
from a `<select>`, so the browser sends `"5"`, and SQLite's `'5' IN (3,5,8,12)` is **false**
(no type coercion against integer literals) — a bare string trips the `CHECK` and throws.
The route coerces, and `admin.html` sends a number as well. Conversely `openProfileModal()`
has to `String()` it back when populating the `<select>`, since assigning the number `5` to
`select.value` matches no `<option>` and silently leaves the control on its first entry.

`PATCH /api/settings/theme` is used by the admin theme toggle.

### Language settings

Two independent language concerns, with different scopes:

- **Admin dashboard language** (`settings.adminLanguage`) — a single global preference, one of `en`/`fr`/`es`/`pt`/`it`. Set via the "Dashboard language" `<select>` in `admin.html`'s Settings modal (`POST /api/settings`). `admin.html` holds a full `adminTranslations` object (5 locales) and a global `t` reference reassigned by `applyAdminTranslations(lang)`, which also re-runs `loadGalleries()`/`loadCollections()`/`loadTrash()` so dynamically-rendered card templates pick up the new language. **Saving a language change triggers `location.reload()`** rather than attempting to live-retranslate every render call site — simpler and more robust given the size of the file.
- **Client-facing language** (for the client document `preview.html` and the OG share-preview text) — resolved per gallery/collection through a 3-tier cascade, **most specific wins**: the gallery's own `clientLanguage` override, else its containing collection's override (at most one, by construction — `collection_galleries.gallery_id` is `UNIQUE`), else the global default `settings.clientLanguage` (`'auto'` = browser-detected, like before this feature existed). Implemented by two resolver functions reused everywhere a language decision is needed (OG tags, `/info`, `/api/collection/:id`):
  ```js
  function resolveGalleryClientLanguage(galleryId) { /* gallery's client_language → its single collection's client_language (one indexed lookup) → settings.clientLanguage */ }
  function resolveCollectionClientLanguage(collectionId) { /* collection's client_language → settings.clientLanguage */ }
  ```
  Set via `PATCH /api/gallery/:id/client-language` / `PATCH /api/collection/:id/client-language` (body `{ language }`, `'auto'` stored as `NULL`). The admin UI exposes this as a compact `<select>` on each gallery/collection card's `.gallery-bottom` row, plus a "Default client language" `<select>` (global) in the Settings modal.

  Client pages no longer detect the browser language themselves. `GET /api/gallery/:id/info` and `GET /api/collection/:id` both include the resolved `clientLanguage` (`'auto'` or a specific code) in their response; each page reads `locale = resolveClientLocale(info.clientLanguage)` (defined in `shared.js`) only after that fetch resolves, then re-applies its static translations via an `applyStaticTranslations()` helper. `resolveClientLocale()` only handles the final `'auto'` → browser-detection step — the gallery/collection/global precedence itself lives server-side as the single source of truth, shared with the OG-tag generation below. `favorites.html` has no client-side i18n today and was left untouched.
- **OG share-preview localization**: `OG_DESCRIPTIONS` (server.js) is a 3-key × 5-language map (`preview`, `collection`, `favorites`) read via `ogDescription(key, language)`, applied at all OG injection sites using the resolver functions above (gallery routes use `resolveGalleryClientLanguage`, the collection route uses `resolveCollectionClientLanguage`). `'auto'` falls back to English since OG crawlers have no browser to detect from.

### Preview generation

1920px JPEG previews (`fit: inside`, quality 85) are generated via sharp:
- **On upload** — fire-and-forget via `generateGalleryPreviews`
- **On startup** — `setImmediate` scans all galleries for missing previews and generates them in the background after directory creation
- **On first request** — if still missing, the original is served immediately and generation is triggered in the background (non-blocking)

The lightbox uses `previewUrl`. Originals are only served on explicit download via `downloadUrl`.

**ICC color profile preservation:** **Every** Sharp pipeline that writes an image — thumbnails, previews, OG images, **and gallery/collection backgrounds (the hero) including their `?thumb=1`/`?card=1` variants** — uses `.withMetadata()` so the original embedded ICC profile (Adobe RGB, Display P3, etc.) is carried through to the derived image. Without this, browsers assume sRGB and colors diverge from Lightroom or the OS file viewer — wide-gamut pixels read as sRGB look noticeably **warmer and oversaturated**. If existing thumbnails/previews were generated before this was added, delete `data/thumbnails/` and `data/previews/` to force regeneration.

> **Backgrounds are not regenerable.** `uploadBackground` uses `multer.memoryStorage()` and persists only the processed JPEG — the original is never stored. Covers uploaded before `.withMetadata()` was added to the background pipelines lost their ICC profile irrecoverably, and no amount of reprocessing can bring it back (the profile is unknown, not merely detached). Those galleries must have their **cover re-uploaded** to display correctly. This is the one case where deleting a derived-image directory is not enough.

### Video support

Galleries can contain video clips (`.mp4`, `.mov`, `.webm`, `.m4v`) alongside photos. There is no persisted "type" field — videos are detected purely by file extension via `isVideoFile()` (server), `isVideoFilename()`/`isMediaFile()` (admin.html), and `isVideoPhoto()` (preview.html).

- A video's `files` row gains a `duration` (seconds) value, captured via `ffprobe`.
- **Posters**: `generateVideoPoster()` extracts a frame with `ffmpeg` (1s into the clip, falling back to 0s for very short clips) and runs it through the same sharp pipeline as photo thumbnails/previews (400px/1920px JPEG, `.withMetadata()`), writing to `thumbnails/{galleryId}/{filename}.jpg` and `previews/{galleryId}/{filename}.jpg`. Triggered on upload, on startup (missing-preview scan), and on first `?thumb=1`/`?preview=1` request.
- `ffmpeg`/`ffprobe` must be on `PATH` (installed via `apk add ffmpeg` in the Docker image). If missing, poster/metadata generation fails gracefully (caught and logged) — uploads still succeed, `/photos` returns `width/height/duration: null`, and the grid shows the ▶ badge without a poster image.
- `?thumb=1`/`?preview=1` for a video filename serve the generated poster JPEG and return 404 if generation failed — they never fall back to the raw video file (an `<img>`/`<video poster>` src can't render a video container).
- The original video (no query params) is served via `res.sendFile`, which already supports HTTP Range / 206 Partial Content — required for `<video>` seeking. No server change was needed for this.
- **Single fullscreen control**: `#lightboxVideo` has `controlsList="nofullscreen noremoteplayback"` and `disablePictureInPicture` so the only fullscreen entry point is the lightbox's own `toggleFullscreen()` button (fullscreens `.lightbox`, same as for photos). Safari does not honor `controlsList`, so iOS may still show its native expand icon — if tapped, the existing `fullscreenchange` handler's `document.exitFullscreen()` still works to exit it via the lightbox's button.
- **Keyboard nav**: the lightbox's `keydown` listener (Escape/ArrowLeft/ArrowRight) is registered on the capture phase so it fires before a focused `<video>`'s native seek/volume key handling can intercept arrow keys.
- **Fast-start remux**: `remuxVideoFastStart()` runs `ffmpeg -c copy -movflags +faststart` on `.mp4`/`.mov`/`.m4v` files (container rewrite only, no re-encode) so the moov atom is at the front. Without this, `<video>` often shows a stuck/gray frame on first play until a seek forces a range request that happens to land on the moov atom at the end of the file. Run via `processUploadedVideo()` on upload (before poster/probe), and lazily once per legacy file via `ensureVideoFastStart()` on first original-file request, guarded by a `data/tmp/{galleryId}-{filename}.faststart-checked` marker so ffmpeg isn't re-run on every request. No-op for `.webm` (no faststart equivalent).
- `MAX_VIDEO_MB` (default 500) is enforced separately from `MAX_UPLOAD_MB` (photos) via `enforcePerTypeFileSizeLimits()`, which deletes oversized files post-upload and returns a `rejected` list in the API response.
- OG image generation (gallery and collection) skips video files when picking a fallback source image, using `files.find(f => !isVideoFile(f))`; if a gallery is all-video, the gallery OG route generates a poster for the first video and uses that.

### Animated images (GIF / animated WebP)

Animated images play in the lightbox while keeping a static thumbnail in the grid — the same "original served for playback, static derivative for the grid" split used for video. They are still `type: 'image'` (no separate media type); animation is detected structurally, not by extension.

- **Detection**: `readDimensions()` reads `meta.pages` from sharp; `animated = pages > 1`. For animated images it uses `meta.pageHeight` (a single frame's height) rather than `meta.height`, which is the full vertical filmstrip height (`pageHeight × pages`) — without this the justified grid computes absurdly tall cells. The flag is cached on the file's row, `files.animated` (`0`/`1` once probed via `setPhotoDimensions()`, so animatable formats aren't re-probed every request; `NULL` = never checked). `isAnimatableFile()` (ext ∈ `gif`/`webp`) gates whether probing is even worthwhile.
- **Thumbnail (`?thumb=1`)**: unchanged — `generateThumbnail()` writes a static first-frame JPEG (sharp reads only frame 1 without `{ animated: true }`), keeping the grid light.
- **Preview (`?preview=1`)**: for animated images the route serves the **original file** (`res.sendFile`, correct `image/gif`/`image/webp` Content-Type → the `<img>` animates natively). This branch runs **before** the `existsSync(previewPath)` check so a stale/legacy flattened JPEG is never served, and probes once (self-healing) for animatable files whose flag isn't recorded yet. `generatePreview()` early-returns for animated images so no JPEG preview is ever generated for them.
- **`/photos` response**: each photo gains `animated: boolean`. `previewUrl`/`thumbnailUrl` are unchanged — the server decides per-file what those URLs return.
- **preview.html**: a `GIF` pill badge (`.gif-badge`) is shown on grid cards where `photo.animated` (and not a video). The lightbox needs no change: `imgEl.src = photo.previewUrl` already resolves to the animated original, and mobile pinch-zoom (CSS transform on the `<img>`) stays compatible.
- **Deliberately unchanged**: OG images (sharp flattens to a static first-frame JPEG — correct, crawlers require static); gallery/collection backgrounds (GIF normalized to static JPEG); `favorites.html` (shows the static thumbnail).

### Audio montage (collection **or** gallery)

**Both a collection and a single gallery can carry one optional audio track** — the
gallery-level one is what makes audio possible for a gallery belonging to no collection.
Stored verbatim — no transcoding — in `data/audio/` (in the startup directory list) under
a prefix that says who owns it:

```
collection-{collectionId}.{ext}      gallery-{galleryId}.{ext}
```

`audioKey(req)` derives that basename from whichever route param is present, so **one**
multer instance and the `findAudioFile(key)` / `deleteAudioFiles(key)` helpers serve both
owners. The gallery routes (`POST`/`DELETE`/`GET /api/gallery/:id/audio`) mirror the
collection ones exactly; `hardDeleteGallery()` removes the gallery's own track.

**Precedence is decided client-side, not on the server** (`preview.html`):

| Context | What plays |
|---|---|
| Gallery opened standalone (`/preview/:id`) | its own montage |
| Inside a collection **that has** a montage | the collection's — **continuous**, gallery tracks ignored |
| Inside a collection **without** one | each gallery's own, switching as you move |

The rule exists because a collection montage is meant to play unbroken across the whole
event; letting a gallery override it mid-browse would defeat the entire design.
`collectionOwnsMontage()` encodes the test.

The continuity itself rests on one guard in `setMontage()`: **re-passing the track that is
already loaded returns early**, so re-entering the index or mounting another gallery never
reassigns `audio.src` (which would restart playback). Listeners are attached once by
`wireMontageOnce()` — `setMontage()` runs on every gallery mount, and re-attaching would
stack one handler set per gallery visited.

**Admin control** (`renderAudioButtons(kind, ownerId, audio)`): an icon button in the
card's action cluster (gallery and collection), not a bespoke row. Empty → one muted
music-note button (tooltip `t.addAudio`) that opens the file picker. Present → the button
turns gold (`.btn-icon-audio`), its click replaces the file, its `title` is
`filename · duration · size`, and a `.btn-icon-danger` trash button appears beside it to
remove. A thin `.action-sep` rule separates this "attach" group (audio, plus add-to-collection
on gallery cards) from the share/manage buttons. **Collection cards set `overflow: hidden`
for their rounded corners, which clips the OG-regenerate tooltip when it opens upward from
the header — so that tooltip carries `.og-tooltip--down` to open downward and stay inside
the card.**

- **Never added to the `files` table.** That table drives the photo grid, the ZIP,
  counts, dimension probing, the OG image fallback and the stem sort — an audio file has
  no business in any of them. Its metadata lives only in the owning gallery/collection's
  own `audio_filename`/`audio_stored`/`audio_size`/`audio_duration`/`audio_uploaded_at`
  columns (all-or-nothing, enforced by a schema `CHECK`).
- **Upload**: `uploadAudio` is a third multer instance — **disk** storage (a montage is
  50–150 MB, `memoryStorage` would be wrong), `MAX_AUDIO_MB` (default 150),
  filter on `AUDIO_EXTENSIONS` or an `audio/*` MIME. `POST /api/collection/:id/audio`
  replaces any existing track (multer overwrites a same-extension file; the route then
  deletes any leftover under a *different* extension so only one montage remains).
  `probeAudioDuration()` reads the length via ffprobe, degrading to `null` like `probeVideo`.
- **Serving**: `GET /api/collection/:id/audio` is a plain `res.sendFile` — Express handles
  **Range/206 on its own**, which is what makes seeking work (same reason video seeking
  already worked). Content-Type is set from the extension *before* `sendFile`, since the
  `send` library skips its own guess when the header already exists.
  **It is served under `imageLimiter` (600/min), deliberately NOT `publicReadLimiter`
  (300/min)**: a media element fires many range requests while streaming and seeking, and
  a tripped limiter surfaces as a hard, visible error.
- `GET /api/collection/:id` returns `audio: { url, filename, duration, size }` with an
  **mtime `?v=` token** on the URL (same idea as `bgVersion`) so a replaced track busts the
  24 h cache while an unchanged one stays cached — it matters a lot at this file size.
  `totalSizeBytes` stays **photos only**; the montage is excluded, as is the ZIP.
- Deleting a collection removes the file via `deleteAudioFiles()`; deleting a gallery (hard-delete) does the same for its own montage.
- **Client player** (`preview.html`): `preload="none"` so nothing is fetched until the
  visitor asks. The UI is a **single small button** — scrubbing, skipping and the title are
  handed to the OS lock-screen controls via the **Media Session API** instead of costing
  screen space. Progress is a `conic-gradient` ring driven by a `--audio-progress` custom
  property, so it occupies no layout. **Playback is never started automatically** (the
  first play must be a user gesture, which every browser requires anyway).
- **The button is docked into existing chrome, never floating.** As a `position: fixed`
  overlay it collided with the hero title, the photos, the footer and the lightbox's "@"
  widget — and, being a *sibling* of `.lightbox`, it **vanished in fullscreen**, since
  `requestFullscreen()` renders only the fullscreen element's subtree.
  `placeAudioButton()` moves the one element (so: one state, one ring, and re-parenting a
  `<button>` never interrupts the `<audio>`, which stays put) between four hosts:
  `#collAudioSlot` (collection index), `#heroAudioSlot` (hero cluster), `#barAudioSlot`
  (sticky actions bar, once it reaches the top), and inside `.lightbox` —
  `#lbAudioSlotDesktop` (continuing the right-hand stack at `top: 170px`, after close 20 /
  fullscreen 50 / comments 80 / favorite 110 / download 140) or `.lb-bottom-bar` on
  mobile, where it inherits the bars' auto-hide. It is called from `openLightbox`,
  `closeLightbox`, `renderRoute`, `loadGallery`, the existing `scroll` listener and
  `resize`, and **no-ops unless the host actually changed** (it runs on every scroll).
  The move is a **cross-fade**, not a teleport: the button fades out (`.audio-moving`,
  `AUDIO_FADE_MS`), is re-parented, then fades back in — re-parenting alone made it pop
  out of the hero and snap into the sticky bar. The pending timer is cleared on each call
  and the target host is **re-read after the fade** (the visitor may have kept scrolling),
  and `audioHostFor()` uses a 2 px margin on the sticky-bar test as hysteresis, so a scroll
  resting exactly on the boundary cannot flip hosts back and forth and flicker.
  The lightbox host test uses `matchMedia('(max-width: 768px)')`, **not** `_isMobileLB()`:
  the latter also matches `(max-height: 500px)`, but `.lb-mobile-overlay` only renders
  under `max-width: 768px`, so a landscape phone would park the button in a hidden bar.
- **The montage survives moving between galleries**, which is the whole point — see
  "One client document" below.

### Gallery slideshow

A fullscreen, auto-advancing slideshow of a gallery's **stills**, launched from the
`.slideshow-btn` in the sticky `.actions-bar` (shown unconditionally by `loadGallery()`, so
the button appears on a standalone gallery as well as inside a collection). Two global,
photographer-set values in `settings`: `slideshow_interval` (3/5/8/12 s, default 5) and
`slideshow_transition` (`fade`/`slide`/`kenburns`, default `fade`), edited in the Settings
modal and read by `preview.html` through `getSiteSettings()`.

**It is a separate overlay (`#slideshow`), deliberately not a mode of `.lightbox`.** The
lightbox carries pinch-zoom-toward-midpoint, swipe navigation, the comment drawer and its
own fullscreen handling; overloading it would put all of that at risk for no gain. The two
share nothing but the audio button host.

- **Same `position: fixed` ban as `.lightbox`** applies inside `#slideshow`: it is the
  element passed to `requestFullscreen()`, so a `fixed` descendant does not resolve
  reliably across engines. `.slideshow` is itself `fixed; inset: 0`, so `absolute` children
  get identical geometry in both modes.
- **Layers, not one `<img>`**: `ssRenderSlide()` appends a fresh `.ss-img` per slide (the
  incoming one paints on top purely by DOM order) and drops the outgoing one once the
  animation has run. That is also why the entry animation is a **keyframe, not a
  transition** — a brand-new element has no previous value to transition from. `kenburns`
  runs two animations at once: the 600 ms crossfade and the 8 s movement, with one of four
  drift directions picked deterministically from `filename.charCodeAt(0) % 4` so a given
  photo always moves the same way. `fade`/`slide` use `object-fit: contain`; `kenburns`
  uses `cover`, because a slow push on a letterboxed image would just drift the bars.
- **Videos are skipped entirely** (`photos.filter(p => !isVideoPhoto(p))`) — a clip of
  arbitrary length has no meaning inside a fixed interval. `syncSlideshowButton()` hides the
  button on an all-video gallery.
- **The timer is re-armed per slide** (`ssArmTimer`), so resuming after a pause gives a full
  interval rather than the remainder of the interrupted one. Manual navigation
  (`slideshowNext`/`Prev`, and the arrow keys) **pauses**; the loop wraps infinitely in both
  directions. The progress bar is *removed* on pause rather than frozen, so a paused
  slideshow shows no bar instead of one that reads as stuck, and `ssStartProgress()` needs
  its forced reflow (`void bar.offsetWidth`) or the restarted animation is coalesced away.
- **Three integration points, each load-bearing:**
  1. **Any fullscreen exit closes the slideshow**, handled in the shared `fullscreenchange`
     listener. `Escape` is swallowed by the browser to exit fullscreen *before* any
     `keydown` listener sees it, so that event is the only reliable signal.
     `_ssUsedFullscreen` is tracked separately from `_ssActive` because
     `requestFullscreen()` can be refused (iOS Safari on an arbitrary element) and the
     slideshow still runs as a plain overlay — without the flag, a `fullscreenchange` fired
     by the *lightbox's* own button would close a slideshow that never went fullscreen.
     It is set from the event, not from the call's return value, which is a promise in
     modern engines but `undefined` in older WebKit.
  2. **`audioHostFor()` returns `#ssAudioSlot` first**, before the lightbox branch: the
     montage button must live *inside* the fullscreened element or it vanishes — and a
     slideshow with music is the montage's whole purpose. `placeAudioButton()` is called
     from both `openSlideshow()` and `closeSlideshow()` (which clears `_ssActive` first).
  3. **Teardown on every path that reassigns `photos`**: `resetGalleryViewState()` and the
     index branch of `renderRoute()` both call `closeSlideshow()`, or a slideshow would
     keep running against a stale array in collection mode.
- **The toolbar auto-hides after 3 s, and re-arms on `pointerdown` as well as
  `pointermove`.** The `pointerdown` half is not optional: a phone fires no `mousemove`, so
  with movement alone the toolbar would hide and never return — taking the close button and
  the montage control with it. A tap on the hidden toolbar passes through
  (`pointer-events: none`) and brings it back, the same two-tap pattern the mobile lightbox
  bars use.
- `#kbHintWidget` is **not** extended for this: that list lives inside `.lightbox` and
  describes *its* shortcuts. The slideshow's own toolbar carries the tooltips instead.

### Justified gallery layout

`preview.html` uses a JS-built justified/row-based layout: photos are grouped into `.gallery-row` flex rows whose children preserve the photo's aspect ratio and together fill the row width. Each row is recomputed on resize. This replaces the previous CSS `columns` masonry so photos are never split and rows always justify edge-to-edge. Photos in the preview page are sorted by filename **stem (name without extension)**, `localeCompare` with `{ numeric: true, sensitivity: 'base' }`, with the full name as a tiebreaker — so a companion file named after the photo it follows (e.g. a GIF `mariage-…-36-gif.gif` beside photo `mariage-…-36.jpg`) sorts right after that photo, matching a file explorer. Sorting on the full name instead lets the differing extension reorder such a pair. This route (`GET /api/gallery/:id/photos`) is the single source of display order — the critique numbering and the admin comments page derive from it.

### Mobile lightbox — swipe, pinch-to-zoom, pan

On mobile (`≤ 768px`), the lightbox image has `touch-action: none` and a unified set of touch handlers on `.lightbox`:
- **1-finger tap** toggles the top/bottom action bars.
- **1-finger swipe** (horizontal, > 45px) navigates to the next/previous photo — only when not zoomed. For videos, `touchstart` still records the single-touch start position (needed by `touchend`'s swipe calc) even though pinch/pan setup is skipped — without this, swipe nav silently does nothing while a video is open.
- **2-finger pinch** zooms from 1× to 5× **toward the pinch midpoint** (not the image centre). Below 1.05× the transform is cleared and swipe-nav re-enables.
- **1-finger drag while zoomed** pans. Translation is clamped using `naturalWidth`/`naturalHeight` with an `object-fit: contain` calculation so the user cannot drag the image past its visible edges.
- Zoom state is always reset on `openLightbox`, `closeLightbox`, and `navigateLightbox`.
- A `_wasGesture` flag suppresses the tap-to-toggle-bars behaviour after a pinch/pan, so ending a gesture does not accidentally toggle the overlay.

**Implementation detail — zoom toward midpoint:** The pinch midpoint is captured in `touchstart` relative to the image centre (`_pinchMidX/Y = midClientX - innerWidth/2`). On each `touchmove`, pan is updated with the formula `panNew = mid + (panBase - mid) * s1 / s0` so the point under the fingers stays fixed as scale changes. `_applyZoomTransform()` writes `transform: translate(${_panX}px, ${_panY}px) scale(${_zoomScale})` on `.lightbox-img` with `transform-origin: center center`.

**Why not native browser zoom:** `requestFullscreen()` disables native visual-viewport zoom on mobile. All zoom is therefore done via CSS `transform` — works identically in fullscreen and normal mode. Do not reintroduce `visualViewport` scaling or viewport meta manipulation.

### Social footer

All client pages (`preview.html`, `favorites.html`) call `GET /api/settings` on load and render inline SVG icons for each non-empty social/website URL. The footer is `position: fixed; bottom: 0` on all screen sizes, with a semi-transparent blurred background. Hidden entirely if no links are configured. (`preview.html` additionally fades it in/out based on scroll position — see its section below — so it never overlaps the full-screen hero.)

### Soft-delete and trash

`DELETE /api/gallery/:id` soft-deletes only — `ops.softDeleteGallery(db, galleryId, deletedAtIso)` sets `deleted = 1`/`deleted_at` and strips the gallery's `collection_galleries` row, in one transaction, leaving files on disk. The `UPDATE` is guarded by `AND deleted = 0`, so calling it again on an already-trashed gallery is an **idempotent no-op** — it no longer re-stamps `deleted_at` and silently resets the 3-day retention clock (a pre-existing quirk in the old JSON-backed code, fixed as a deliberate, separate cleanup). `hardDeleteGallery(id)` removes all files (uploads, thumbnails, previews, background, OG cache, audio) then `ops.deleteGalleryRow(db, galleryId)` — one `DELETE`, whose `ON DELETE CASCADE`s remove `files`/`favorites`/`comments`/`viewer_hashes`/`collection_galleries` automatically (replacing the old manual "scan every collection" loop). `purgeExpiredTrash()` auto-purges galleries where `deleted_at` is older than `TRASH_RETENTION_MS` (3 days). It runs at startup **and** on an hourly `setInterval` (`.unref()`ed) — the startup-only call never fired on a long-running server, so expired trash sat forever until the next restart. Each `hardDeleteGallery` inside the loop (and in `DELETE /api/galleries/trash`, via `ops.purgeWithTolerance()`) is wrapped in `try/catch` so an fs failure can't abort the sweep or crash the timer. All public routes check `getActiveGallery(galleryId)` and return 404 for deleted galleries.

**Favoriting or commenting on an already-deleted photo now 404s** instead of silently creating a permanent, invisible orphan entry — the old JSON model's `favorites[filename]`/`comments[filename]` were created with no existence check at all, and `DELETE /api/gallery/:id/photo/:filename` never cleaned them up. The `favorites`/`comments` tables' `FOREIGN KEY ... REFERENCES files` makes this structurally impossible going forward, and the same cascade retroactively cleans up any favorites/comments still orphaned from the old model once that photo's `files` row is ever touched again. Pre-existing orphans already in a real installation's data are dropped (not migrated, not recovered) by `scripts/migrate-json-to-sqlite.js`, counted and reported in its summary output — recovering them isn't possible since the old model never recorded when the referenced photo was deleted.

### OG images

Gallery OG images are generated at `GET /api/gallery/:id/og-image`, cached in `og-cache/{galleryId}.jpg`. Collection OG images are at `GET /api/collection/:id/og-image`, cached as `og-cache/collection-{collectionId}.jpg`. Both use the background image if set, then fall back to the first photo. The cache is invalidated on background upload, on photo deletion, and via `DELETE /api/gallery/:id/og-image` / `DELETE /api/collection/:id/og-image` (admin). The admin "regenerate" button uses the rotate-ccw Lucide icon with a hover tooltip explaining what share previews are — present on both gallery cards (`regenerateOG()`) and collection cards (`regenerateCollectionOG()`).

### Critique mode

`preview.html` reads `?critique=1` from the URL at load. When set: each photo card shows a numbered badge (bottom-left), the lightbox shows `# N` in the top-left, and a "Critique" indicator appears in the actions bar. The admin copies the critique link (`/preview/:id?critique=1`) using the ordered-list icon button on each gallery card. Regular clients use the plain preview URL and never see numbers.

### Comments

Clients can leave a text comment on individual photos/videos from the lightbox. Comments are **public** — every visitor of the gallery sees every comment under a given photo (guestbook model, not private feedback-to-photographer), confirmed as the intended behavior. `galleries.comments_enabled` (`NOT NULL DEFAULT 1`) lets the photographer turn this off per gallery via the "Comments" toggle next to "Downloads" on each admin gallery card (`PATCH /api/gallery/:id/comments-enabled`).

**Collection-level toggle**: mirrors the existing `downloadsEnabled`/`isGalleryBlockedByCollection()` pattern exactly. `collections.comments_enabled` (`NOT NULL DEFAULT 1`) is toggled via `PATCH /api/collection/:id/comments-enabled` and a "Comments" switch next to "Downloads" on each admin collection card (`toggleCollectionComments()`). `isGalleryBlockedByCollectionForComments(galleryId)` joins `collection_galleries`→`collections` (at most one row, `UNIQUE(gallery_id)`) and checks `comments_enabled = 0`; it's combined with the gallery's own `comments_enabled` in `GET /api/gallery/:id/info`, `GET /api/gallery/:id/photos` (both consumed by `preview.html` to show/hide the comment button), and enforced server-side as a 403 in `POST /api/gallery/:id/comments`. A gallery's comments can therefore be turned off either directly or by being in a collection with comments disabled — same precedence as downloads.

**Collection toggle = global, gallery toggle = case-by-case override**: the collection's downloads/comments toggle is the master switch for every gallery inside it; the gallery's own toggle keeps its stored value underneath but only takes effect once the collection allows it again. To avoid the admin UI looking misleading (a gallery's toggle showing "on" while actually blocked by its collection), `renderGalleryItems()` (admin.html) looks up each gallery's containing collection in `_collectionsData` and adds a `.blocked-by-collection` class (dims the switch via opacity) plus a tooltip naming the blocking collection, while leaving the checkbox's `checked` state — and the ability to keep clicking it — tied to the gallery's own stored value. `toggleCollectionDownloads()`/`toggleCollectionComments()` update `_collectionsData` in place and re-render the gallery list (respecting the active search filter) so the dimmed state appears immediately; `loadCollections()` does the same on initial load in case it resolves after `loadGalleries()`.

- **Identification**: reuses the same anonymous `visitorId` (localStorage) already used for favorites — no accounts. Additionally, a self-declared display **name is optional**: the first time a visitor opens the comment drawer, an editable "Your name" field is shown; once they post, the name is saved to `localStorage` (`delyvr_commenter_name`, separate from `visitorId`) and reused for later comments (with a "change name" link to edit it). Empty name → displayed as "Guest". No verification of any kind.
- **Storage**: one row per comment in the `comments` table (`id (uuidv4)`, `gallery_id`, `filename`, `visitor_id`, `name`, `text`, `created_at`), fetched `ORDER BY created_at ASC` for oldest-first. `POST /api/gallery/:id/comments` validates and trims `text` (required, max 500 chars) and `name` (optional, max 60 chars), strips control characters, and 403s if `comments_enabled = 0`.
- **Routes**: `POST .../comments` (public, `publicWriteLimiter`) to add; `GET .../comments-public?filename=X` (public, `publicReadLimiter`) to fetch one photo's thread — fetched lazily only when its drawer is opened, never preloaded for the whole gallery; `GET .../comments` (admin) flattened across all photos; `DELETE .../comments/:filename/:commentId` (admin) removes a single spam comment; `DELETE .../comments` (admin) clears all, mirroring `resetFavorites()`. `GET .../photos` also returns `commentCount` per photo so the grid badge doesn't need an extra request.
- **Admin moderation is a full page**, not a modal: route `#/gallery/:id/comments` (view `view-gallery-comments`). Delyvr is also used for **peer critique**, so the photo must be readable *beside* its thread — the old 700px modal with 48px cropped thumbnails and every thread in one scroll made that impossible. `loadGalleryCommentsPage()` fetches `GET .../comments` (the threads) and `GET .../photos` (gallery order) in parallel and joins them by `filename`; the photo's index supplies the **critique number**, matching `preview.html`'s numbering. Layout is a left rail of commented photos (uncropped thumbnails, `#N`, count) plus a right pane showing the selected photo large with its full thread. Comments whose photo was since deleted are still listed so they remain removable. `deleteComment()` mutates the local state and **re-renders** rather than doing DOM surgery, and `viewComments(galleryId)` on the gallery card simply sets the hash.
- **UI**: a speech-bubble button (with an unread-style count badge) sits next to the favorite/download buttons in both the desktop cluster and the mobile bottom bar, opening a drawer — a fixed side panel on desktop, a bottom sheet on mobile — with the thread, an optional name field, and a textarea (Enter to send, Shift+Enter for newline). Posting is optimistic, matching `toggleFavorite()`'s update/revert-on-error shape, with a toast reusing the `#favToast` element (`showToast()` was generalized from `showFavToast()`).
- **XSS safety**: `preview.html` has no `escapeHtml()` helper and intentionally doesn't need one for this feature — comment rows are built via `document.createElement` + `textContent` only, never `innerHTML`, since comment text is long-form and free-form. `admin.html` already has `escapeHtml()` (used for `eventName`/filenames elsewhere) and reuses it for the moderation modal's `innerHTML` rows.
- The comment drawer is a child of `.lightbox`, so its own touch/click/keydown handling must opt out of the lightbox's swipe-to-navigate, pinch-zoom, and tap-to-toggle-bars listeners (guarded via `e.target.closest('#commentDrawer')`) and the capture-phase arrow-key navigation listener, otherwise scrolling the comment list or typing would trigger photo navigation.
- **The drawer stays open across photos on desktop** (critique reading): `updateLightbox()` reloads the new photo's thread instead of closing it. On mobile it still closes on navigation — deliberately unchanged, a phone can't show both usefully. `isDrawerMobile()` gates this on the existing breakpoints.
- **The photo is never resized when the drawer opens.** Reserving space (`padding`, or capping `max-width`) would shrink it — on a 1920×1080 screen a 3:2 landscape already has only ~140px of slack, since `.lightbox-content` is capped at `100vw - 160px` for the arrows. Instead `updateDrawerShift()` applies a `transform: translateX(-N)` to `.lightbox-content`: a transform doesn't affect layout, so the computed size is untouched. `N` is 150px (half the 300px drawer, which re-centres the content in the space left over) **clamped to the free margin actually measured on the left**, so a very wide photo can never be pushed off-screen. A `ResizeObserver` on `.lightbox-content` recomputes it on async preview load, photo change and window resize. The backdrop is applied on mobile only — on desktop it would dim the very photo being kept visible — and `.lightbox-next` moves to `right: 320px` so it stays clickable.

### ZIP downloads

Both gallery and collection ZIPs use `archiver` with `store: true` (no compression — JPEGs are already compressed, so this saves CPU without meaningfully increasing size). Content-Disposition uses RFC 5987 encoding (`filename*=UTF-8''...`) with an ASCII fallback for full Unicode support in filenames containing accents, spaces, or special characters. Content-Length is intentionally NOT set because archiver adds variable ZIP metadata during streaming that makes pre-calculation unreliable.

### Filename sanitisation

Multer's `filename` function strips only truly dangerous filesystem characters (`<>:"/\|?*` and control chars) while preserving accents, spaces, ampersands, and all Unicode. `SAFE_FILENAME_RE` used by `validateFilename` middleware follows the same permissive rule. This applies to new uploads only; existing files keep their stored names.

### Gallery name and collection name editing

Gallery names use `contenteditable="false"` by default. Double-clicking (or clicking the pencil icon on mobile) sets `contenteditable="true"`, disables `draggable` on the parent item so text selection works, selects all text, then re-enables drag on blur and saves via `renameGalleryInline`. Collection names use a `<input readonly>` with `onfocus` guard to prevent focus on single click, editable on double-click via `startCollectionRename`. A `.name-edit-btn` pencil icon is hidden on desktop (shown on hover via `@media (hover: hover)`) and always visible on touch devices (`@media (hover: none)`).

---

## API Endpoints

### Gallery

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/` | | Admin dashboard |
| `GET` | `/preview/:id` | | Photo browser |
| `POST` | `/api/auth/verify` | | Verify password |
| `POST` | `/api/gallery/create` | ✓ | Create gallery + upload |
| `POST` | `/api/gallery/:id/upload` | ✓ | Add photos |
| `POST` | `/api/gallery/:id/background` | ✓ | Upload/replace background |
| `POST` | `/api/gallery/:id/rename` | ✓ | Rename |
| `PATCH` | `/api/gallery/:id/downloads` | ✓ | Toggle downloads |
| `GET` | `/api/gallery/:id/info` | | Metadata + totalSizeBytes |
| `GET` | `/api/gallery/:id/photos` | | Photo list with URLs and dimensions |
| `GET` | `/api/gallery/:id/photo/:filename` | | Serve photo; `?thumb=1` for 400px thumbnail, `?preview=1` for 1920px preview |
| `GET` | `/api/gallery/:id/download` | | ZIP download (store mode, RFC 5987) |
| `GET` | `/api/gallery/:id/download/:filename` | | Single photo download |
| `GET` | `/api/gallery/:id/background` | | Serve background; `?thumb=1` 200px, `?card=1` 800px |
| `POST` | `/api/gallery/:id/audio` | ✓ | Upload/replace this gallery's own montage |
| `DELETE` | `/api/gallery/:id/audio` | ✓ | Remove it |
| `GET` | `/api/gallery/:id/audio` | | Stream it (Range/206 via `sendFile`, `imageLimiter`) |
| `GET` | `/api/gallery/:id/og-image` | | Generate/serve OG image |
| `DELETE` | `/api/gallery/:id/og-image` | ✓ | Clear OG cache |
| `DELETE` | `/api/gallery/:id/photo/:filename` | ✓ | Delete single photo |
| `POST` | `/api/gallery/:id/favorites` | | Toggle favorite |
| `GET` | `/api/gallery/:id/favorites-public` | | Visitor's favorites |
| `GET` | `/api/gallery/:id/favorites` | ✓ | All favorites (admin) |
| `DELETE` | `/api/gallery/:id/favorites` | ✓ | Reset favorites |
| `GET` | `/api/gallery/:id/favorites/export` | | Export favorites as CSV (public) |
| `GET` | `/api/gallery/:id/favorites/download` | ✓ | Download favorite photos as ZIP |
| `GET` | `/api/gallery/:id/favorites-ranked` | | Public favorites sorted by votes |
| `GET` | `/favorites/:id` | | Public favorites ranking page |
| `PATCH` | `/api/gallery/:id/comments-enabled` | ✓ | Toggle comments |
| `POST` | `/api/gallery/:id/comments` | | Add a comment (public, guestbook-visible) |
| `GET` | `/api/gallery/:id/comments-public` | | Comments for one photo (`?filename=`) |
| `GET` | `/api/gallery/:id/comments` | ✓ | All comments, flattened (admin) |
| `DELETE` | `/api/gallery/:id/comments/:filename/:commentId` | ✓ | Delete one comment |
| `DELETE` | `/api/gallery/:id/comments` | ✓ | Clear all comments |
| `GET` | `/api/galleries` | ✓ | List active galleries (excludes deleted) |
| `DELETE` | `/api/gallery/:id` | ✓ | Soft-delete (move to trash) |
| `GET` | `/api/galleries/trash` | ✓ | List trashed galleries with daysLeft |
| `POST` | `/api/gallery/:id/restore` | ✓ | Restore from trash |
| `DELETE` | `/api/gallery/:id/purge` | ✓ | Hard-delete from trash |
| `DELETE` | `/api/galleries/trash` | ✓ | Empty entire trash |

### Collection

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/collection/:id` | | Collection page |
| `POST` | `/api/collection/create` | ✓ | Create collection |
| `GET` | `/api/collections` | ✓ | List collections |
| `GET` | `/api/collection/:id` | | Collection info + totalSizeBytes |
| `POST` | `/api/collection/:id/rename` | ✓ | Rename |
| `PATCH` | `/api/collection/:id/downloads` | ✓ | Toggle downloads |
| `PATCH` | `/api/collection/:id/comments-enabled` | ✓ | Toggle comments |
| `POST` | `/api/collection/:id/background` | ✓ | Upload/replace cover |
| `GET` | `/api/collection/:id/background` | | Serve cover; `?thumb=1` 200px, `?card=1` 800px |
| `GET` | `/api/collection/:id/og-image` | | Generate/serve collection OG image |
| `DELETE` | `/api/collection/:id/og-image` | ✓ | Clear collection OG cache |
| `POST` | `/api/collection/:id/galleries` | ✓ | Add gallery |
| `PATCH` | `/api/collection/:id/galleries/reorder` | ✓ | Reorder galleries |
| `DELETE` | `/api/collection/:id/galleries/:galleryId` | ✓ | Remove gallery |
| `POST` | `/api/collection/:id/audio` | ✓ | Upload/replace the audio montage |
| `DELETE` | `/api/collection/:id/audio` | ✓ | Remove the audio montage |
| `GET` | `/api/collection/:id/audio` | | Stream the montage (Range/206 via `sendFile`, `imageLimiter`) |
| `GET` | `/api/collection/:id/download` | | ZIP all galleries (store mode, RFC 5987) |
| `DELETE` | `/api/collection/:id` | ✓ | Delete collection (galleries kept) |

### Settings

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/settings` | | Get site settings |
| `POST` | `/api/settings` | ✓ | Update theme, website, socials, languages, date format, slideshow |
| `PATCH` | `/api/settings/theme` | ✓ | Update theme only |

---

## Frontend Architecture

All HTML files are standalone — no bundler, no imports, all JS inline.

### `public/shared.js`

Loaded by all client pages via `<script src="/shared.js">` before their inline `<script>` block. Provides:
- `SOCIAL_ICONS` — SVG strings for website, instagram, facebook, pinterest, tiktok, linkedin, 500px, flickr, behance.
- `getSiteSettings()` — `GET /api/settings`, fetched **once per page load** and shared by every consumer (theme, social footer, slideshow) via a memoised promise. It resolves to `{}` on any failure, so callers only handle missing keys, never a rejection. `applyTheme()` and `renderSocialFooter()` used to fetch the same endpoint separately, which meant two identical round-trips on every client page. **Read settings through this, never with a fresh `fetch('/api/settings')`.**
- `applyTheme()` — toggles the `html.light` CSS class from the shared settings.
- `renderSocialFooter()` — renders icon links into `#socialFooter` from settings; hides the container entirely if no links are configured.

`admin.html` loads `shared.js` but defines its own `applyTheme()` that additionally updates the theme toggle button text — it overrides the shared version.

### `public/admin.html`

- **Split into three files, no build step.** The stylesheet lives in `public/admin.css` (`<link>`) and the five-locale `adminTranslations` object in `public/admin-i18n.js` (a classic script, so its top-level `const` is visible to the inline script that follows). `public/` is already served statically, so no server route was needed. Keeping them inline made `admin.html` unnavigable at ~5500 lines.
- **Sidebar shell + hash-routed views** replace the old header + two-column dashboard. `parseHash()` returns `{ route, params }`; `renderRoute()` toggles `.active` on the matching `.view`, highlights the nav item, closes the mobile drawer and resets scroll. On mobile the sidebar is a fixed drawer toggled by `toggleSidebar()`; the burger (`.sidebar-toggle`) carries `z-index: 8001` so it stays above the open drawer (`z-index: 8000`) and a second tap closes it — without that the drawer paints over the in-flow burger and the tap lands on the sidebar. Routes: `#/galleries`, `#/collections`, `#/new` (gallery **and** collection creation side by side — `#/new/gallery` and `#/new/collection` are kept as aliases), and the parameterised `#/gallery/:id/comments`. Unknown routes fall back to the galleries list. Parameterised routes are matched on **segments**, not by flattening the hash to a key — that's why `parseHash` splits on `/` before consulting `ROUTES`/`ROUTE_ALIASES`.
- Login via in-memory `adminPassword` variable only, not persisted to sessionStorage or localStorage.
- Password field has an eye toggle button (`.password-toggle`).
- `applyTheme()` called on load — it also reads `settings.adminLanguage` and calls `applyAdminTranslations(lang)` (see "Language settings"). `toggleTheme()` uses optimistic update.
- **The "Settings" modal** (`#profileModal`, formerly "Profile & Social Links") holds logo, website, socials, languages, date format and the slideshow settings. The element ids keep the `profile*` prefix — only the labels were renamed, via `t.profileTitle` *and* the separate `t.headerProfile` for the sidebar button. **Logo management lives in this modal**, not the sidebar: `#logoWrap`/`#adminLogo`/`#logoInput`/`#logoResetBtn` all moved into `.profile-modal-card`, which still sits **above** the inline `<script>` — that ordering is what keeps the top-level `document.getElementById('logoInput').addEventListener(...)` resolving at parse time, so do **not** park this block after the script (where the bulk-action bar lives). The sidebar keeps a display-only `#sidebarLogo`, and `refreshLogoImages()` cache-busts **both** `<img>` on upload/reset. `openProfileModal()` also re-runs `checkLogoState()` so the reset button is correct if the logo changed in another tab.
- **`applyStaticTranslations()`-style null-guard trap in `applyAdminTranslations()`**: the two slideshow `<select>`s share one section heading, so their purpose is carried by `title`. `byId()` writes `textContent`, which is meaningless on a `<select>` — set `.title` directly, null-guarded, the way the `#logoWrap` title already is.
- **Full i18n** (en/fr/es/pt/it): `adminTranslations` holds every locale; the module-scope `let t` is reassigned by `applyAdminTranslations(lang)` to the active locale and read by every render function and toast/error message. Static chrome (login, sidebar, every view and modal) carries `id`s set directly by `applyAdminTranslations`; dynamic templates (`renderGalleryItems`, `renderCollections`, the comments page, the photos/favorites/trash/picker modals, the bulk action bar) read `t.xxx` at render time.
- **`confirmDialog(message, okLabel)`** — page-level async confirmation modal (`#confirmDialogOverlay`/`.confirm-dialog-card`, styled like the other modals, `z-index: 8500` so it can be triggered from inside another open modal) replacing every native `confirm()` in the file. Returns a Promise resolved by `confirmDialogResolve(result)`; default `okLabel` is `t.delete`. All 10 call sites await it: `resetLogo`, `bulkDelete`, `deleteSelectedPhotos`, `deletePhoto`, `resetComments`, `resetViews`, `resetFavorites`, `deleteGallery`, `purgeGallery`, `emptyTrash`.
- Gallery list: `filterGalleries(query)` reads the current toolbar state, calls the pure `buildGalleryViewModel(galleries, collections, {query, sortBy, sortDir, filters})` to produce collection-grouped sections (an accordion, one `.gallery-group` per collection + a "No collection" group), and `renderGalleryItems(vm)` renders them from the `_galleriesData` cache. Every render path (load, search, sort, collection toggles) funnels through `filterGalleries`, so `_gallerySort` is always current at render time.
- **Sort + manual order:** the section header has a sort `<select>` (`#gallerySortField`: date/name/views/downloads/photos/comments/favorites/**manual**) and a direction toggle (`#gallerySortDirBtn`). `buildGalleryViewModel` sorts each group by the chosen comparator. **Manual order** sorts by each gallery's persisted `order` field (undefined last, tie-broken by newest) and is the only mode where reordering makes sense — so drag (`draggable`) and the ▲▼ arrows are rendered **only** in manual mode, the direction toggle is hidden, and a `.manual-order-hint` line is shown. `saveGalleryOrder()` (called by `moveGallery`/`handleGalleryItemDrop`) PATCHes `/api/galleries/reorder` **and** mirrors `order = index` into `_galleriesData` locally so a later re-render doesn't snap back (the server response isn't refetched). `/api/galleries` returns `order` so the client can sort by it. Reordering is within-group only (cross-group drag is blocked). Sort choice is session-only (not persisted); the manual *order* itself is persisted server-side.
- Gallery cards support: inline rename (double-click), cover image drag/drop, downloads toggle, comments toggle, **client-language `<select>`** (`setGalleryClientLanguage`), favorites view/reset, manage photos modal, critique link copy, OG regenerate, soft-delete, drag reorder (manual mode), bulk selection. Collection cards have the same downloads/comments toggles plus their own client-language `<select>` (`setCollectionClientLanguage`).
- **Filename-safe delete handlers:** the photo-delete button (photos modal), the comment-delete button and the comments-page rail do **not** embed the filename in an inline `onclick`. `escapeAttr` escapes `'`→`&#39;`, but the browser HTML-decodes that back to `'` before parsing the handler, so a filename with an apostrophe (common in French, e.g. `l'été.jpg`) would break the call. Instead: the photo button gets its handler via a `card.querySelector('.photo-delete-btn').onclick = …` closure capturing the raw filename; the comment button carries `data-filename`/`data-comment-id` and a delegated `list.onclick` reads `btn.dataset.*`. Both avoid the nested HTML-attribute → JS-string escaping trap.
- **Cover thumbnails use a stable `bgVersion`, never `Date.now()`.** `/api/galleries` and `/api/collections` return `bgVersion` — the cover file's `mtimeMs` — and the cards render `…/background?thumb=1&v=${bgVersion}` with `loading="lazy"`. The token is **stable across re-renders** so the browser cache (the routes already send `Cache-Control: public, max-age=86400`) actually works, and it changes by itself when a cover is replaced, so the card still updates immediately after an upload (both upload handlers call `loadGalleries()`/`loadCollections()`, which refetch the new mtime). **Do not reintroduce `?t=${Date.now()}` here:** it is re-evaluated on every render, and since `filterGalleries()` re-renders every card on each search keystroke, sort change and collection toggle, it refetched every thumbnail each time — with ~40 galleries an 8-character search fired ~320 image requests in seconds and tripped `publicReadLimiter`, producing a "Too many requests" error that blocked the dashboard.
- **Bulk selection mode:** toggled via "Select" button in gallery section header. `_selectionMode` + `_selectedGalleries` Set. `#bulkActionBar` slides up from bottom. Actions: enable/disable downloads, add to collection, delete. Escape exits.
- **Trash modal:** opened via trash icon button (with count badge) in gallery section header. Shows trashed galleries with daysLeft, Restore and "Delete now" buttons, Empty trash button.
- **Photo management modal:** `openPhotosModal(galleryId)` loads photos via `GET /api/gallery/:id/photos` and renders a justified row layout (`_buildPhotoRows`/`_renderPhotosRows`, recomputed via a `ResizeObserver`). Per-photo delete button visible on hover (desktop) or always (mobile). Selection mode allows multi-delete via `deleteSelectedPhotos()`, which deletes sequentially and drives a **progress toast** (reuses `#uploadToast`: `t.deletingPhotosProgress(i, n)` updates each iteration, then `t.photosDeletedDone(n)` / `t.photosCouldNotBeDeleted(errors)`) so bulk deletes of many photos give visible feedback instead of just dimming cards.
- **Gallery picker (for collections):** multi-select. Toggling a gallery adds/removes it from `_pickerSelected` Set. Confirm button shows count and adds all at once.
- Collection pills: drag to reorder (desktop) or ◀ ▶ buttons (visible on mobile via `@media (hover: none)`).
- `_galleriesData` cache populated in `loadGalleries()`, used by `renderCollections()` for pill labels and gallery picker.

### Gallery creation — multi-folder drop and collection assignment

`#dropZone`'s `handlePhotoDrop` inspects the dropped `DataTransferItemList` synchronously (entries must be captured via `webkitGetAsEntry()` before any `await`, since the list is cleared afterwards). If **2 or more top-level folders** are dropped, `handleMultiFolderDrop` traverses each folder separately with `traverseFileTree` and switches the UI into multi-gallery mode; loose files dropped alongside folders are ignored with an inline note. A single dropped folder (or loose files) keeps the existing single-gallery flow, auto-filling `#eventName` from the folder name.

- **Single-gallery mode** — `selectedFiles`/`selectedBgFile` state, `createGallery()`.
- **Multi-gallery mode** — `_multiGalleryGroups` array (`{ name, files, bgFile, bgPreviewUrl }`), one entry per dropped folder. `enterMultiGalleryMode()` hides the single-gallery inputs and shows `#multiGalleryPanel`, rendered by `renderMultiGalleryPanel()`: each row has an editable name, a photo count, a per-row `.drop-zone-mini` cover drop/browse zone (`handleMultiBgDrop`/`handleMultiBgSelect`/`setMultiGalleryBgFile`), and a remove button (`removeMultiGalleryGroup`). `cancelMultiGalleryMode()` discards the batch and restores the single-gallery form. `createMultipleGalleries()` creates the galleries sequentially — one `POST /api/gallery/create` plus paginated `/upload` calls per folder, then an optional per-gallery background upload — with one overall progress bar, then shows a success toast via `showMultiGallerySuccess(n)`.
- **Shared upload/collection helpers** (module scope, used by both flows): `uploadBatchXHR(url, method, batch, extraFields, uploadedSoFar, total, onProgress)` uploads one batch via `XMLHttpRequest` with progress reporting, **guarded by a stall watchdog** — XHR has no idle timeout, so a connection that goes quiet mid-transfer (dropped proxy, full disk, network hiccup) would otherwise leave `onload`/`onerror` silent forever and freeze the whole sequential upload with no error. If no `upload.onprogress` fires for `STALL_MS` (60s) the request is aborted and rejected; a separate `RESPONSE_MS` (180s) covers the post-body wait for the server's reply. The rejection carries `err.retryable`, set `true` **only when the body was not yet fully sent** (so the server cannot have processed the batch and a re-send can't duplicate photos/galleries); an HTTP-status failure or a stall while awaiting the response is `retryable: false`. `uploadBatchWithRetry(...)` wraps it with a bounded retry (3 attempts, linear backoff) that re-sends **only** on `retryable` failures — this is what both create flows actually call. `resolveCollectionTarget()` resolves `#galleryCollectionSelect` to an existing collection id, or — if `#includeInNewCollection` is checked — creates the new collection **once** (uploading its background if set) and returns its id; `assignGalleryToCollection(collectionId, galleryId)` calls `POST /api/collection/:id/galleries`.
- **`updateCollectionLink()`** keeps the collection UI in sync for both flows: shows/hides `#includeGalleryLabel`, sets `#includeGalleryLabelText` to "Include the gallery being created" (single) or "Include the galleries being created" (when `_multiGalleryGroups.length > 1`), and updates `#createBtn`/`#createMultiBtn` text to append "+ collection" whenever a collection (existing or new) will be assigned.
- **Upload-activity chrome (an upload is a background task).** The SPA keeps running when you leave the Create view mid-upload, so progress must be visible from anywhere and finishing while away must notify you. Module state `_uploadInProgress` (+ `_uploadResult` for the completion pop-up) is set by `setUploadActive(true/false)` at the start and in the `finally` of both create flows. **`_uploadInProgress`/`_uploadResult` (and the cancel state below) are declared near the top of the inline script, before the initial `renderRoute()` call** — `renderRoute()`→`syncUploadUI()` reads `_uploadInProgress`, and a `let` declared later would throw a temporal-dead-zone `ReferenceError` that aborts the whole script. Both flows' local `setProgress` delegates to `renderUploadProgress(pct, label)`, the single writer for **both** the inline Create bar and a **mini-panel docked in the sidebar footer, above Profile** (`#uploadMiniPanel`). `syncUploadUI()` (called by `setUploadActive` and on every `renderRoute`) shows, mutually exclusively: the sidebar panel when uploading **and not** on Create, and a light-red **"don't leave" warning banner** (`#uploadWarning`, width-capped to match `.new-grid`) when uploading **and** on Create — so progress is never shown twice. On completion, if `parseHash().route !== 'new'` a **done pop-up** (`#uploadDoneOverlay`, reusing `.confirm-dialog-*`) appears: single-gallery shows the share link (copyable) + "Go to the Create page", multi shows the gallery count + "View galleries"; on Create the existing inline `resultSection` / success toast is used instead. A **`beforeunload`** guard warns while `_uploadInProgress` (closing the tab kills the in-flight XHR → partial gallery).
  - **Cancel.** A **Cancel** button sits in both the sidebar panel and the Create banner (both call `cancelUpload()`), so it's reachable in either visibility state. `cancelUpload()` confirms via `confirmDialog`, then sets `_uploadCancelled` and aborts the in-flight XHR (`_activeUploadXHR`). `uploadBatchXHR` now settles once (a `done` guard) and its manual-abort path rejects with `{ cancelled: true }`; `uploadBatchWithRetry` never retries a cancel; the create loops call `throwIfCancelled()` between steps not guarded by an abort. On a cancelled error the flow runs `discardUploadArtifacts()` — **permanent** removal of everything created this run: each gallery in `_uploadCreatedGalleryIds` via `DELETE /api/gallery/:id/purge` (hard delete, no trash trace — the purge route works on any gallery, not only trashed ones) plus a collection created the same run (`_uploadCreatedCollectionId`) — then a neutral "cancelled" toast. Rare edge: a cancel landing exactly in the create-request's response window can orphan one gallery whose id never reached the client. New i18n keys (5 locales): `uploadInProgress`, `uploadDontLeave`, `uploadDoneTitle`, `uploadDoneGalleryReady`, `uploadDoneGoToCreate`, `uploadDoneViewGalleries`, `cancelUpload`, `cancelUploadConfirm`, `uploadCancelled`.

### `public/preview.html`

- **Full-screen hero**: `.hero` is `height: 100vh`/`100dvh` (fallback cascade) with the gallery's background photo as an undimmed, full-bleed cover (`object-fit: cover`, no darkening overlay) — the site logo sits top-left, the gallery name bottom-left, and a "Show Gallery" button + the "Download All" button bottom-right. "Show Gallery" (`scrollToGallery()`) smooth-scrolls down to `#galleryContainer`. The outline action-style buttons across the page (`.show-gallery-btn`, `.back-to-collection`, `.slideshow-btn`) share one CSS rule set — same size/border/radius, theme-aware via an `html.light` override — rather than each having its own styling; extend those selectors instead of adding a variant. (`.download-all-btn` is the filled-gold exception.)
- **Logo legibility over the hero**: the hero cover is undimmed and full-bleed, so `.hero-logo` carries a two-layer `filter: drop-shadow(0 2px 6px rgba(0,0,0,0.55)) drop-shadow(0 0 2px rgba(0,0,0,0.4))` — the first matches the house value on `.hero h1`, the second is a tight un-offset layer that separates thin SVG strokes, which a soft offset shadow alone leaves ambiguous. The collection index's `.logo` gets the same treatment (milder risk there: the cover runs at 30% opacity under `.bg-overlay`). `favorites.html`'s logo is on a plain page background and is deliberately left alone. **Limit:** `drop-shadow()` follows the alpha channel, so on an *opaque* JPEG logo it reads as a rectangular halo rather than hugging the glyph — `/api/logo` serves six formats and never tells the client which, so that cannot be detected client-side.
- Justified/row-based gallery: photos grouped into `.gallery-row` flex rows built in JS, recomputed on resize.
- Photos sorted server-side by filename stem (name without extension), extension as tiebreaker — see the preview.html layout section above.
- Lightbox preloads N-1 and N+1 previews via `new Image()` on each navigation.
- Fullscreen slideshow launched from `.actions-bar` — see "Gallery slideshow" above for the overlay, the transitions and the three integration points.
- Mobile lightbox: pinch-to-zoom (up to 5x), one-finger pan while zoomed, swipe navigation when not zoomed. `touch-action: none` disables native browser zoom.
- Animated images (GIF / animated WebP) show a static thumbnail + `GIF` badge in the grid and play in the lightbox — see "Animated images". The badge is driven by `photo.animated` from `/photos`; the lightbox `<img src=previewUrl>` resolves to the animated original with no extra code.
- **Critique mode:** `critiqueMode = URLSearchParams.get('critique') === '1'`. When true: photo number badges rendered on grid cards, `#lbCritiqueNum` shown in lightbox, `#critiqueIndicator` shown in actions bar.
- Favorites toast: `showFavToast(added)` shown on toggle, localized in all 5 languages, auto-dismisses after 2s.
- Social footer is hidden (`opacity: 0; pointer-events: none`) over the full-screen hero and only fades in once the page is scrolled past 100px (`updateFooterVisibility()`, on a `scroll` listener), so it never overlaps the hero's action buttons.
- `applyTheme()` and `renderSocialFooter()` called on load.
- Locale is finalized inside `loadGallery()`, not at page load: `let locale = 'en'; let t = translations.en;` defaults are replaced once `info.clientLanguage` comes back from `GET /api/gallery/:id/info`, via `resolveClientLocale()` (see "Language settings"). `applyStaticTranslations()` is called once with the defaults and again after resolution.

### One client document: `preview.html` serves both `/preview/:id` and `/collection/:id`

**`public/collection.html` no longer exists.** An `<audio>` element belongs to its
document, so any full navigation destroys it — and no API (Service Worker, bfcache,
Document Picture-in-Picture) can carry playback across one. Keeping the montage alive
while the couple moves between galleries therefore *requires* that no document
navigation happens, so both routes now serve **`preview.html`**, which holds both views.

The collection index was moved into `preview.html` (~400 lines) rather than moving the
gallery view into `collection.html` (~2700 lines of grid, lightbox, favorites, comments
and pinch-zoom) — same result, a fraction of the churn and the risk.

- `_isCollectionMode` is derived from `location.pathname` (`/collection/…` vs `/preview/…`);
  `collectionId` and the mutable `galleryId` follow from it. **`galleryId` is a `let`**,
  reassigned on each mount — its ~12 read sites pick up the current value unchanged.
- Routes: no hash → the collection index; `#/gallery/:uuid` → that gallery mounted **in
  place**. `renderRoute()` runs on `hashchange`; the index cards link to the hash, never to
  `../preview/:id`. Bootstrap is `loadCollectionIndex().then(renderRoute)` so the montage
  and index exist before a deep-linked gallery mounts on top.
- `resetGalleryViewState()` runs at the top of `loadGallery()`: it clears `photos`,
  favorites and drawer state, closes the lightbox, resets zoom and scroll, empties the
  grid, drops the hero image and **re-shows the download controls a previous gallery may
  have hidden**. It deliberately does **not** re-attach listeners — those are bound once to
  `window`/`document`/`#lightbox` and read module state, so re-attaching would stack one
  handler per gallery visited.
- `/preview/:id` still works standalone for a gallery link shared with family: no index, no
  montage (the audio belongs to a collection), `?from=` still renders a normal back link.
- Class collisions were avoided when porting: the index's download button is
  `.coll-download-btn` because `.download-all-btn` already exists for the hero; the index
  reuses the existing `#notFound` block with `collectionNotFoundTitle`/`Text` keys.
- `updateFooterVisibility()` is null-guarded: `#socialFooter` sits *after* the script, so
  the first synchronous call ran before it existed and threw on every page load.

The collection index itself keeps the behaviour it had as a standalone page: locale
resolved from `data.clientLanguage` via `resolveClientLocale()`, gallery covers at
`?card=1` (800px), and a download button showing `totalSizeBytes`.

---

## Conventions and Gotchas

- **No build step.** Do not introduce a bundler, TypeScript, or a frontend framework.
- **SQLite, not an external database server.** `data/delyvr.sqlite` via `better-sqlite3` — embedded, single file, no separate container/process. See "Data persistence". Never `require('../server.js')` from a test or script — it immediately calls `app.listen()`/`process.exit()`; multi-table logic worth testing belongs in `db/operations.js` instead.
- **`downloads_enabled`/`comments_enabled` default to `1` (`NOT NULL DEFAULT 1` in the schema).** Most route checks still read `!== false`/`=== 0` depending on which representation is in hand at that point (a JS boolean from a mapped row, or the raw SQLite integer) — both are correct, pick whichever the surrounding code already has rather than converting.
- **`safeResolvePath(base, ...segments)`** must be used for every path incorporating a user-controlled value.
- **`escape-html` package** used directly (not via alias) for OG tag injection — CodeQL recognises it.
- **`ADMIN_ALLOWED_IPS`** is checked inside `requireAuth` — applies to all admin routes automatically. No need to add middleware per route.
- **`[AUTH]` log prefix** — all auth failures and IP blocks are logged with this prefix for easy filtering: `docker logs delyvr | grep '\[AUTH\]'`.
- **Settings defaults** — enforced by the schema itself (`settings` row's column `DEFAULT`s), not by a JS merge step. `getSettings()`/`updateSettings()` just read/patch the singleton row.
- **Social footer** hidden entirely when no links are configured — `container.style.display = 'none'` if `links.length === 0`.
- **Justified gallery layout is JS-driven.** Rows in `.gallery-grid` are built in `buildJustifiedRows()` and recomputed on resize. Do not reintroduce CSS `columns` masonry here.
- **Mobile pinch-zoom uses `transform: translate(...) scale(...)`** on `.lightbox-img`, clamped to the real rendered image bounds (via `naturalWidth`/`naturalHeight` + `object-fit: contain` math). Always call `resetZoom()` from `openLightbox` / `closeLightbox` / `navigateLightbox`. See "Mobile lightbox" section for the zoom-toward-midpoint formula.
- **`express.json()` must be registered before all routes in `server.js`.** It is placed immediately after `app.set('trust proxy', ...)` at the top of the setup block. If you add routes above it, `req.body` will be `undefined` and any body destructuring will throw a TypeError → 500 response.
- **Theme toggle (`toggleTheme`) uses optimistic update.** It applies the CSS class change immediately on click, then reverts if the server returns non-ok. Do not make the UI update conditional on `res.ok` — the fetch to `PATCH /api/settings/theme` would need to fail silently for the user to see no response.
- **Preview generation is non-blocking on request** — if a preview is missing, the original is served immediately and generation runs in the background. Never `await generatePreview` on a request path.
- **Password never stored in sessionStorage.** Kept in `adminPassword` JS variable only.
- **`?password` query param removed.** `requireAuth` only checks `X-Admin-Password` header.
- **Visitor IDs are not authenticated.** Random client-generated strings, not security-sensitive.
- **Gallery links are public by UUID.** No per-gallery password system.
- **Soft-delete only.** `DELETE /api/gallery/:id` never removes files. `hardDeleteGallery(id)` does, via `ops.deleteGalleryRow()` — no separate "save" step needed, the `DELETE` statement (and its `ON DELETE CASCADE`s) commit on their own. Auto-purge runs on startup **and** hourly via `purgeExpiredTrash()` (a `setInterval` — not startup-only, or expired trash never clears on a long-running server).
- **`getActiveGallery(galleryId)`** returns the mapped gallery object only if it exists and `deleted = 0`. Use it in all public routes to return 404 for trashed galleries.
- **`db.transaction(fn)` for anything touching more than one table/statement**, even when a single statement would already be atomic on its own — see every multi-table write in `db/operations.js` and `server.js` for the pattern (`db.transaction(() => { ... })()` — called immediately).
- **PRAGMA `foreign_keys` is NOT persisted** — unlike `journal_mode`, it resets to OFF on every new connection and must be re-applied. If cascades ever seem to silently stop working, this is the first thing to check.
- **Migrating the schema itself** (adding a column/table later, e.g. for proofing/analytics): edit `db/schema.sql` as `CREATE ... IF NOT EXISTS` / rely on an explicit `ALTER TABLE` run once — this project has no formal migration-numbering system beyond the one JSON→SQLite migration script, by design (there's exactly one schema version in play at a time, the running one).
- **ZIP downloads use `store: true`** (no compression). Content-Length is intentionally omitted — archiver adds variable per-file data descriptors during streaming that make pre-calculation unreliable and cause "unexpected end of archive" errors.
- **Filename sanitisation allows Unicode.** Only truly dangerous filesystem characters are stripped (`<>:"/\|?*` and control chars). Accents, spaces, ampersands, and **apostrophes** are preserved. `SAFE_FILENAME_RE` reflects this.
- **Drop zones: the class is `drag-over`, hyphenated.** Every drop handler in `admin.html` adds `drag-over`; `admin.css` once styled `.drop-zone.dragover` instead, so the rule never matched and the main photo zone plus all three `.drop-zone-small` cover zones gave **no** visual feedback while a file hovered — they simply looked dead. If you add a drop zone, add the matching `.drag-over` rule and check the spelling on both sides.
- **A drop zone needs three things, not one:** the `ondragover`/`ondragleave`/`ondrop` handlers, a client-side size guard, *and* a checked response. The collection cover vignette had only `onclick` while its tooltip promised drop; `handleColBgFile`/`handleInlineColBgFile` skipped the `MAX_BG_MB` guard that `handleBgFile` applies; and the create-flow cover `POST` discarded its result, so a 413 produced a collection with no cover and no message. When a cover upload fails *after* its collection was created, report it **without throwing** — the enclosing `catch` would otherwise claim the collection itself failed.
- **Never embed a filename in an inline `onclick` string in admin.html.** Filenames can contain apostrophes (`l'été.jpg`). `escapeAttr` turns `'` into `&#39;`, which the browser HTML-decodes back to `'` *before* the JS in `onclick=` is parsed, breaking the handler. Attach handlers via a closure (`el.onclick = …`) or `data-*` attributes + a delegated listener reading `dataset` instead. The uuid `commentId` is safe, but the filename is not.
- **`?card=1` on background routes** generates an 800px JPEG (fit: inside, quality 82) for use in collection gallery cards. `?thumb=1` stays at 200x200 for admin thumbnails.
- **Critique mode** is entirely client-side. `?critique=1` in the URL enables photo numbering in `preview.html`. The admin copies the critique URL via `copyCritiqueLink()`. No server-side flag.
- **Gallery name editing** requires disabling `draggable` on the parent `.gallery-item` during edit (set in `startGalleryRename`, restored in `finishGalleryRename`) so that text selection works. Without this, the browser intercepts mousedown for drag, preventing text selection.
- **`squarePhotoGridCells()`** in the photos management modal measures `offsetWidth` of the first grid cell after `requestAnimationFrame` and sets explicit `style.height` on all cells. CSS `aspect-ratio` is unreliable in some mobile browsers when combined with grid and `position: absolute` content.
- **Never use `position: fixed` inside `.lightbox` or `.slideshow`.** Both are elements
  passed to `requestFullscreen()`, and a `fixed` descendant of a top-layer element does not
  resolve reliably across engines — that is what made the favorite/download bar disappear in
  mobile fullscreen. `.lb-mobile-overlay`, `#lightboxSocialWidget`, `#kbHintWidget` and
  every `.ss-*` child are therefore `position: absolute`: each overlay is itself
  `position: fixed; inset: 0`, so the geometry is identical in normal mode and correct in
  fullscreen. Anything else that must be usable in fullscreen has to live **inside** the
  fullscreened element (see `placeAudioButton()` / `audioHostFor()`).
- **`public/shared.js`** is loaded by all client pages via `<script src="/shared.js">`. It provides `SOCIAL_ICONS`, `getSiteSettings()`, `applyTheme()`, `renderSocialFooter()` and `resolveClientLocale()`. `admin.html` loads it but overrides `applyTheme()` locally to also update the theme toggle button text. Do not duplicate these functions into individual HTML files, and read settings through `getSiteSettings()` rather than adding another `fetch('/api/settings')`.