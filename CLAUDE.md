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
| Runtime | Node.js 20+ |
| Server framework | Express 4 |
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
├── package.json
├── Dockerfile
├── docker-compose.yml
├── .env                # Secret config (gitignored) — copy from .env.example
├── .env.example        # Template showing required env vars
├── .dockerignore
├── .gitignore
├── public/
│   ├── admin.html      # Photographer dashboard
│   ├── preview.html    # Client photo browser (justified grid + lightbox + favorites + pinch zoom)
│   ├── collection.html # Client collection page (multiple galleries)
│   ├── favorites.html  # Public favorites ranking page (/favorites/:id)
│   └── shared.js       # Shared client JS — SOCIAL_ICONS, applyTheme(), renderSocialFooter()
└── data/               # Runtime data root (Docker volume mount at /data)
    ├── uploads/        # Gallery photos, organised as uploads/{galleryId}/
    ├── backgrounds/    # Background images — {galleryId}.jpg for galleries,
    │                   # collection-{collectionId}.jpg for collections (normalised JPEG)
    ├── thumbnails/     # 400px JPEG thumbnails, generated on upload or first request
    ├── previews/       # 1920px JPEG previews for lightbox, generated on upload or first request
    ├── og-cache/       # 1200×630 OG images, generated on first share
    ├── galleries.json  # Gallery metadata
    ├── collections.json # Collection metadata
    └── settings.json   # Site-wide settings (theme + social links) — created automatically
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
| `INSTALL_DIR` | *(project dir)* | Set to `/data` in Docker. Controls where all data files are written. |
| `TRUST_PROXY` | `0` | Set to `1` behind a single reverse proxy. Also accepts: integer hop count, IP, CIDR, comma-separated IPs/CIDRs, or `loopback`/`uniquelocal`. |
| `ADMIN_ALLOWED_IPS` | *(unset — all IPs allowed)* | Comma-separated IPs or CIDR ranges. When set, all admin routes (including login) reject requests from unlisted IPs with 403. |

---

## Server Architecture (`server.js`)

### Data models

**Gallery** — stored in `galleries.json`, keyed by UUID v4:

```js
{
  id: string,
  eventName: string,
  created: string,          // ISO 8601
  files: string[],          // filenames inside uploads/{id}/ — photos and videos
  background: string|null,
  downloadsEnabled: boolean, // default true (missing = true)
  downloadCount: number,    // incremented on every ZIP download (default 0)
  viewCount: number,        // unique view count (default 0)
  viewerHashes: string[],   // SHA-256(ip+ua) per unique visitor — not security-sensitive
  favorites: {              // filename → [visitorId, ...]
    [filename: string]: string[]
  },
  dimensions: {             // filename → cached dimensions (duration for videos, animated for GIF/WebP)
    [filename: string]: { w: number, h: number, duration?: number, animated?: boolean }
  },
  commentsEnabled: boolean, // default true (missing = true) — per-gallery toggle
  comments: {               // filename → comments, oldest first
    [filename: string]: { id: string, visitorId: string, name: string|null, text: string, createdAt: string }[]
  },
  clientLanguage: string|null // optional override: 'en'|'fr'|'es'|'pt'|'it', null/absent = inherit (see "Language settings")
}
```

**Collection** — stored in `collections.json`, keyed by UUID v4:

```js
{
  id: string,
  name: string,
  created: string,
  galleryIds: string[],     // ordered — order is the client display order
  background: string|null,
  downloadsEnabled: boolean, // default true (missing = true)
  clientLanguage: string|null // optional override: 'en'|'fr'|'es'|'pt'|'it', null/absent = inherit
}
```

**Settings** — stored in `settings.json`:

```js
{
  theme: 'dark' | 'light',  // default 'dark'
  website: string,          // optional website URL
  socials: {
    instagram: string,
    facebook: string,
    pinterest: string,
    tiktok: string,
    linkedin: string,
    '500px': string,
    flickr: string,
    behance: string
  },
  adminLanguage: 'en'|'fr'|'es'|'pt'|'it', // default 'en' — admin dashboard UI language
  clientLanguage: 'auto'|'en'|'fr'|'es'|'pt'|'it' // default 'auto' — global fallback for client pages/OG tags
}
```

`settings.json` is created automatically on first write. If absent, the server defaults to `{ theme: 'dark' }`.

### Authentication & IP allowlist

`requireAuth` middleware:
1. If `ADMIN_ALLOWED_IPS` is non-empty, resolves the request IP (stripping `::ffff:` prefix for IPv4-mapped IPv6) and checks it against every entry using `ipMatchesCIDR`. Blocks with 403 and logs `[AUTH] IP blocked` if not matched.
2. Checks the `X-Admin-Password` header against `ADMIN_PASSWORD`. Blocks with 401 and logs `[AUTH] Failed auth attempt` on mismatch.

`requireAllowedIP` is also applied independently on `POST /api/auth/verify` so IP blocking happens before the password is even evaluated.

All `[AUTH]` log lines go to stdout and are visible via `docker logs`.

CIDR matching is implemented with BigInt bitwise arithmetic using the Node built-in `net` module — no extra dependency.

`validateGalleryId` and `validateCollectionId` enforce UUID v4 format before any filesystem operation. `validateFilename` enforces `/^[a-zA-Z0-9._\-]+$/`.

### Path safety

All filesystem paths incorporating user-controlled values go through `safeResolvePath(base, ...segments)`. This resolves the final path and throws if it would escape the base directory.

### Rate limiting

| Limiter | Limit | Applied to |
|---------|-------|-----------|
| `authLimiter` | 10 / 15 min | `POST /api/auth/verify` |
| `imageLimiter` | 600 / min | Photo and OG image serving |
| `publicReadLimiter` | 300 / min | All public GET routes |
| `publicWriteLimiter` | 120 / min | `POST /favorites`, `POST /comments` |
| `downloadLimiter` | 10 / min | ZIP downloads |
| `adminLimiter` | 300 / min | Admin routes with filesystem access |

`adminLimiter` also covers the list routes (`/api/galleries`, `/api/collections`) that the dashboard re-fetches after every action, so its cap is deliberately high (300/min): bulk admin work — e.g. resetting favorites/views/comments across many galleries in a row, each reset followed by a `loadGalleries()` refetch — must not trip `Too many requests, please slow down`. The routes are already behind `requireAuth` (+ optional IP allowlist), so the abuse surface is low.

### Settings persistence

`loadSettings()` reads `settings.json` and merges with `SETTINGS_DEFAULTS`. `saveSettings(data)` writes the full object. Both are synchronous.

`GET /api/settings` is public — all client pages call it on load to apply the theme and render the social footer.

`POST /api/settings` is admin-only — accepts `{ theme, website, socials, adminLanguage, clientLanguage }` and saves the merged result.

`PATCH /api/settings/theme` is used by the admin theme toggle.

### Language settings

Two independent language concerns, with different scopes:

- **Admin dashboard language** (`settings.adminLanguage`) — a single global preference, one of `en`/`fr`/`es`/`pt`/`it`. Set via the "Dashboard language" `<select>` in `admin.html`'s Profile modal (`POST /api/settings`). `admin.html` holds a full `adminTranslations` object (5 locales) and a global `t` reference reassigned by `applyAdminTranslations(lang)`, which also re-runs `loadGalleries()`/`loadCollections()`/`loadTrash()` so dynamically-rendered card templates pick up the new language. **Saving a language change triggers `location.reload()`** rather than attempting to live-retranslate every render call site — simpler and more robust given the size of the file.
- **Client-facing language** (for `preview.html`, `collection.html`, and the OG share-preview text) — resolved per gallery/collection through a 3-tier cascade, **most specific wins**: the gallery's own `clientLanguage` override, else the first collection containing it that has a `clientLanguage` override, else the global default `settings.clientLanguage` (`'auto'` = browser-detected, like before this feature existed). Implemented by two resolver functions reused everywhere a language decision is needed (OG tags, `/info`, `/api/collection/:id`):
  ```js
  function resolveGalleryClientLanguage(galleryId) { /* gallery.clientLanguage → containing collection's → settings.clientLanguage */ }
  function resolveCollectionClientLanguage(collectionId) { /* collection.clientLanguage → settings.clientLanguage */ }
  ```
  Set via `PATCH /api/gallery/:id/client-language` / `PATCH /api/collection/:id/client-language` (body `{ language }`, `'auto'` stored as `null`). The admin UI exposes this as a compact `<select>` on each gallery/collection card's `.gallery-bottom` row, plus a "Default client language" `<select>` (global) in the Profile modal.

  Client pages no longer detect the browser language themselves. `GET /api/gallery/:id/info` and `GET /api/collection/:id` both include the resolved `clientLanguage` (`'auto'` or a specific code) in their response; each page reads `locale = resolveClientLocale(info.clientLanguage)` (defined in `shared.js`) only after that fetch resolves, then re-applies its static translations via an `applyStaticTranslations()` helper. `resolveClientLocale()` only handles the final `'auto'` → browser-detection step — the gallery/collection/global precedence itself lives server-side as the single source of truth, shared with the OG-tag generation below. `favorites.html` has no client-side i18n today and was left untouched.
- **OG share-preview localization**: `OG_DESCRIPTIONS` (server.js) is a 3-key × 5-language map (`preview`, `collection`, `favorites`) read via `ogDescription(key, language)`, applied at all OG injection sites using the resolver functions above (gallery routes use `resolveGalleryClientLanguage`, the collection route uses `resolveCollectionClientLanguage`). `'auto'` falls back to English since OG crawlers have no browser to detect from.

### Preview generation

1920px JPEG previews (`fit: inside`, quality 85) are generated via sharp:
- **On upload** — fire-and-forget via `generateGalleryPreviews`
- **On startup** — `setImmediate` scans all galleries for missing previews and generates them in the background after directory creation
- **On first request** — if still missing, the original is served immediately and generation is triggered in the background (non-blocking)

The lightbox uses `previewUrl`. Originals are only served on explicit download via `downloadUrl`.

**ICC color profile preservation:** All Sharp pipelines that write to disk (thumbnails, previews, OG images) use `.withMetadata()` so the original embedded ICC profile (Adobe RGB, Display P3, etc.) is carried through to the derived image. Without this, browsers assume sRGB and colors diverge from Lightroom or the OS file viewer. If existing thumbnails/previews were generated before this was added, delete `data/thumbnails/` and `data/previews/` to force regeneration.

### Video support

Galleries can contain video clips (`.mp4`, `.mov`, `.webm`, `.m4v`) alongside photos. There is no persisted "type" field — videos are detected purely by file extension via `isVideoFile()` (server), `isVideoFilename()`/`isMediaFile()` (admin.html), and `isVideoPhoto()` (preview.html).

- `gallery.dimensions[filename]` gains an optional `duration` (seconds) for videos, captured via `ffprobe`.
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

- **Detection**: `readDimensions()` reads `meta.pages` from sharp; `animated = pages > 1`. For animated images it uses `meta.pageHeight` (a single frame's height) rather than `meta.height`, which is the full vertical filmstrip height (`pageHeight × pages`) — without this the justified grid computes absurdly tall cells. The flag is cached in `gallery.dimensions[filename].animated` (stored explicitly as `true`/`false` once probed, so animatable formats aren't re-probed every request; absent = legacy record, never checked). `isAnimatableFile()` (ext ∈ `gif`/`webp`) gates whether probing is even worthwhile.
- **Thumbnail (`?thumb=1`)**: unchanged — `generateThumbnail()` writes a static first-frame JPEG (sharp reads only frame 1 without `{ animated: true }`), keeping the grid light.
- **Preview (`?preview=1`)**: for animated images the route serves the **original file** (`res.sendFile`, correct `image/gif`/`image/webp` Content-Type → the `<img>` animates natively). This branch runs **before** the `existsSync(previewPath)` check so a stale/legacy flattened JPEG is never served, and probes once (self-healing) for animatable files whose flag isn't recorded yet. `generatePreview()` early-returns for animated images so no JPEG preview is ever generated for them.
- **`/photos` response**: each photo gains `animated: boolean`. `previewUrl`/`thumbnailUrl` are unchanged — the server decides per-file what those URLs return.
- **preview.html**: a `GIF` pill badge (`.gif-badge`) is shown on grid cards where `photo.animated` (and not a video). The lightbox needs no change: `imgEl.src = photo.previewUrl` already resolves to the animated original, and mobile pinch-zoom (CSS transform on the `<img>`) stays compatible.
- **Deliberately unchanged**: OG images (sharp flattens to a static first-frame JPEG — correct, crawlers require static); gallery/collection backgrounds (GIF normalized to static JPEG); `favorites.html` (shows the static thumbnail).

### Justified gallery layout

`preview.html` uses a JS-built justified/row-based layout: photos are grouped into `.gallery-row` flex rows whose children preserve the photo's aspect ratio and together fill the row width. Each row is recomputed on resize. This replaces the previous CSS `columns` masonry so photos are never split and rows always justify edge-to-edge. Photos in the preview page are sorted alphabetically by filename.

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

All client pages (`preview.html`, `collection.html`) call `GET /api/settings` on load and render inline SVG icons for each non-empty social/website URL. The footer is `position: fixed; bottom: 0` on all screen sizes, with a semi-transparent blurred background. Hidden entirely if no links are configured. (`preview.html` additionally fades it in/out based on scroll position — see its section below — so it never overlaps the full-screen hero.)

### Soft-delete and trash

`DELETE /api/gallery/:id` soft-deletes only: sets `gallery.deleted = true` and `gallery.deletedAt = ISO date`, leaves files on disk. `hardDeleteGallery(id)` removes all files (uploads, thumbnails, previews, background, OG cache) and removes the gallery from any collections. `purgeExpiredTrash()` auto-purges galleries where `deletedAt` is older than `TRASH_RETENTION_MS` (3 days). It runs at startup **and** on an hourly `setInterval` (`.unref()`ed) — the startup-only call never fired on a long-running server, so expired trash sat forever until the next restart. Each `hardDeleteGallery` inside the loop is wrapped in `try/catch` so an fs failure can't abort the sweep or crash the timer. All public routes check `getActiveGallery(galleryId)` and return 404 for deleted galleries.

### OG images

Gallery OG images are generated at `GET /api/gallery/:id/og-image`, cached in `og-cache/{galleryId}.jpg`. Collection OG images are at `GET /api/collection/:id/og-image`, cached as `og-cache/collection-{collectionId}.jpg`. Both use the background image if set, then fall back to the first photo. The cache is invalidated on background upload, on photo deletion, and via `DELETE /api/gallery/:id/og-image` / `DELETE /api/collection/:id/og-image` (admin). The admin "regenerate" button uses the rotate-ccw Lucide icon with a hover tooltip explaining what share previews are — present on both gallery cards (`regenerateOG()`) and collection cards (`regenerateCollectionOG()`).

### Critique mode

`preview.html` reads `?critique=1` from the URL at load. When set: each photo card shows a numbered badge (bottom-left), the lightbox shows `# N` in the top-left, and a "Critique" indicator appears in the actions bar. The admin copies the critique link (`/preview/:id?critique=1`) using the ordered-list icon button on each gallery card. Regular clients use the plain preview URL and never see numbers.

### Comments

Clients can leave a text comment on individual photos/videos from the lightbox. Comments are **public** — every visitor of the gallery sees every comment under a given photo (guestbook model, not private feedback-to-photographer), confirmed as the intended behavior. `gallery.commentsEnabled` (default `true`, same `!== false` convention as `downloadsEnabled`) lets the photographer turn this off per gallery via the "Comments" toggle next to "Downloads" on each admin gallery card (`PATCH /api/gallery/:id/comments-enabled`).

**Collection-level toggle**: mirrors the existing `downloadsEnabled`/`isGalleryBlockedByCollection()` pattern exactly. `collection.commentsEnabled` (default `true`) is toggled via `PATCH /api/collection/:id/comments-enabled` and a "Comments" switch next to "Downloads" on each admin collection card (`toggleCollectionComments()`). `isGalleryBlockedByCollectionForComments(galleryId)` checks whether any collection containing the gallery has `commentsEnabled === false`; it's combined with the gallery's own `commentsEnabled` in `GET /api/gallery/:id/info`, `GET /api/gallery/:id/photos` (both consumed by `preview.html` to show/hide the comment button), and enforced server-side as a 403 in `POST /api/gallery/:id/comments`. A gallery's comments can therefore be turned off either directly or by being in a collection with comments disabled — same precedence as downloads.

**Collection toggle = global, gallery toggle = case-by-case override**: the collection's downloads/comments toggle is the master switch for every gallery inside it; the gallery's own toggle keeps its stored value underneath but only takes effect once the collection allows it again. To avoid the admin UI looking misleading (a gallery's toggle showing "on" while actually blocked by its collection), `renderGalleryItems()` (admin.html) looks up each gallery's containing collection in `_collectionsData` and adds a `.blocked-by-collection` class (dims the switch via opacity) plus a tooltip naming the blocking collection, while leaving the checkbox's `checked` state — and the ability to keep clicking it — tied to the gallery's own stored value. `toggleCollectionDownloads()`/`toggleCollectionComments()` update `_collectionsData` in place and re-render the gallery list (respecting the active search filter) so the dimmed state appears immediately; `loadCollections()` does the same on initial load in case it resolves after `loadGalleries()`.

- **Identification**: reuses the same anonymous `visitorId` (localStorage) already used for favorites — no accounts. Additionally, a self-declared display **name is optional**: the first time a visitor opens the comment drawer, an editable "Your name" field is shown; once they post, the name is saved to `localStorage` (`delyvr_commenter_name`, separate from `visitorId`) and reused for later comments (with a "change name" link to edit it). Empty name → displayed as "Guest". No verification of any kind.
- **Storage**: `gallery.comments[filename]` is an array of `{ id (uuidv4), visitorId, name, text, createdAt }`, oldest first. `POST /api/gallery/:id/comments` validates and trims `text` (required, max 500 chars) and `name` (optional, max 60 chars), strips control characters, and 403s if `commentsEnabled === false`.
- **Routes**: `POST .../comments` (public, `publicWriteLimiter`) to add; `GET .../comments-public?filename=X` (public, `publicReadLimiter`) to fetch one photo's thread — fetched lazily only when its drawer is opened, never preloaded for the whole gallery; `GET .../comments` (admin) flattened across all photos; `DELETE .../comments/:filename/:commentId` (admin) removes a single spam comment; `DELETE .../comments` (admin) clears all, mirroring `resetFavorites()`. `GET .../photos` also returns `commentCount` per photo so the grid badge doesn't need an extra request.
- **Admin moderation modal**: `_renderCommentGroups()` (admin.html) re-groups the flattened `GET .../comments` response client-side by `filename` — one section per commented photo (thumbnail + filename + count header, most recently active photo first) with its comments listed underneath, each with a per-row delete button. This is a recap "by photo", not a flat chronological list, since the photographer wants to see all feedback on a given shot together.
- **UI**: a speech-bubble button (with an unread-style count badge) sits next to the favorite/download buttons in both the desktop cluster and the mobile bottom bar, opening a drawer — a fixed side panel on desktop, a bottom sheet on mobile — with the thread, an optional name field, and a textarea (Enter to send, Shift+Enter for newline). Posting is optimistic, matching `toggleFavorite()`'s update/revert-on-error shape, with a toast reusing the `#favToast` element (`showToast()` was generalized from `showFavToast()`).
- **XSS safety**: `preview.html` has no `escapeHtml()` helper and intentionally doesn't need one for this feature — comment rows are built via `document.createElement` + `textContent` only, never `innerHTML`, since comment text is long-form and free-form. `admin.html` already has `escapeHtml()` (used for `eventName`/filenames elsewhere) and reuses it for the moderation modal's `innerHTML` rows.
- The comment drawer is a child of `.lightbox`, so its own touch/click/keydown handling must opt out of the lightbox's swipe-to-navigate, pinch-zoom, and tap-to-toggle-bars listeners (guarded via `e.target.closest('#commentDrawer')`) and the capture-phase arrow-key navigation listener, otherwise scrolling the comment list or typing would trigger photo navigation.

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
| `GET` | `/api/collection/:id/download` | | ZIP all galleries (store mode, RFC 5987) |
| `DELETE` | `/api/collection/:id` | ✓ | Delete collection (galleries kept) |

### Settings

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/settings` | | Get site settings |
| `POST` | `/api/settings` | ✓ | Update theme, website, socials |
| `PATCH` | `/api/settings/theme` | ✓ | Update theme only |

---

## Frontend Architecture

All HTML files are standalone — no bundler, no imports, all JS inline.

### `public/shared.js`

Loaded by all client pages via `<script src="/shared.js">` before their inline `<script>` block. Provides:
- `SOCIAL_ICONS` — SVG strings for website, instagram, facebook, pinterest, tiktok, linkedin, 500px, flickr, behance.
- `applyTheme()` — fetches `GET /api/settings` and toggles `html.light` CSS class.
- `renderSocialFooter()` — renders icon links into `#socialFooter` from settings; hides the container entirely if no links are configured.

`admin.html` loads `shared.js` but defines its own `applyTheme()` that additionally updates the theme toggle button text — it overrides the shared version.

### `public/admin.html`

- Login via in-memory `adminPassword` variable only, not persisted to sessionStorage or localStorage.
- Password field has an eye toggle button (`.password-toggle`).
- `applyTheme()` called on load — it also reads `settings.adminLanguage` and calls `applyAdminTranslations(lang)` (see "Language settings"). `toggleTheme()` uses optimistic update.
- **Full i18n** (en/fr/es/pt/it): `adminTranslations` holds every locale; the module-scope `let t` is reassigned by `applyAdminTranslations(lang)` to the active locale and read by every render function and toast/error message. Static chrome (login, header, both columns, every modal) carries `id`s set directly by `applyAdminTranslations`; dynamic templates (`renderGalleryItems`, `renderCollections`, the photos/favorites/comments/trash/picker modals, the bulk action bar) read `t.xxx` at render time.
- **`confirmDialog(message, okLabel)`** — page-level async confirmation modal (`#confirmDialogOverlay`/`.confirm-dialog-card`, styled like the other modals, `z-index: 8500` so it can be triggered from inside another open modal) replacing every native `confirm()` in the file. Returns a Promise resolved by `confirmDialogResolve(result)`; default `okLabel` is `t.delete`. All 10 call sites await it: `resetLogo`, `bulkDelete`, `deleteSelectedPhotos`, `deletePhoto`, `resetComments`, `resetViews`, `resetFavorites`, `deleteGallery`, `purgeGallery`, `emptyTrash`.
- Gallery list: `filterGalleries(query)` reads the current toolbar state, calls the pure `buildGalleryViewModel(galleries, collections, {query, sortBy, sortDir, filters})` to produce collection-grouped sections (an accordion, one `.gallery-group` per collection + a "No collection" group), and `renderGalleryItems(vm)` renders them from the `_galleriesData` cache. Every render path (load, search, sort, collection toggles) funnels through `filterGalleries`, so `_gallerySort` is always current at render time.
- **Sort + manual order:** the section header has a sort `<select>` (`#gallerySortField`: date/name/views/downloads/photos/comments/favorites/**manual**) and a direction toggle (`#gallerySortDirBtn`). `buildGalleryViewModel` sorts each group by the chosen comparator. **Manual order** sorts by each gallery's persisted `order` field (undefined last, tie-broken by newest) and is the only mode where reordering makes sense — so drag (`draggable`) and the ▲▼ arrows are rendered **only** in manual mode, the direction toggle is hidden, and a `.manual-order-hint` line is shown. `saveGalleryOrder()` (called by `moveGallery`/`handleGalleryItemDrop`) PATCHes `/api/galleries/reorder` **and** mirrors `order = index` into `_galleriesData` locally so a later re-render doesn't snap back (the server response isn't refetched). `/api/galleries` returns `order` so the client can sort by it. Reordering is within-group only (cross-group drag is blocked). Sort choice is session-only (not persisted); the manual *order* itself is persisted server-side.
- Gallery cards support: inline rename (double-click), cover image drag/drop, downloads toggle, comments toggle, **client-language `<select>`** (`setGalleryClientLanguage`), favorites view/reset, manage photos modal, critique link copy, OG regenerate, soft-delete, drag reorder (manual mode), bulk selection. Collection cards have the same downloads/comments toggles plus their own client-language `<select>` (`setCollectionClientLanguage`).
- **Filename-safe delete handlers:** the photo-delete button (photos modal) and comment-delete button (comments modal) do **not** embed the filename in an inline `onclick`. `escapeAttr` escapes `'`→`&#39;`, but the browser HTML-decodes that back to `'` before parsing the handler, so a filename with an apostrophe (common in French, e.g. `l'été.jpg`) would break the call. Instead: the photo button gets its handler via a `card.querySelector('.photo-delete-btn').onclick = …` closure capturing the raw filename; the comment button carries `data-filename`/`data-comment-id` and a delegated `list.onclick` reads `btn.dataset.*`. Both avoid the nested HTML-attribute → JS-string escaping trap.
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
- **Shared upload/collection helpers** (module scope, used by both flows): `uploadBatchXHR(url, method, batch, extraFields, uploadedSoFar, total, onProgress)` uploads one batch via `XMLHttpRequest` with progress reporting; `resolveCollectionTarget()` resolves `#galleryCollectionSelect` to an existing collection id, or — if `#includeInNewCollection` is checked — creates the new collection **once** (uploading its background if set) and returns its id; `assignGalleryToCollection(collectionId, galleryId)` calls `POST /api/collection/:id/galleries`.
- **`updateCollectionLink()`** keeps the collection UI in sync for both flows: shows/hides `#includeGalleryLabel`, sets `#includeGalleryLabelText` to "Include the gallery being created" (single) or "Include the galleries being created" (when `_multiGalleryGroups.length > 1`), and updates `#createBtn`/`#createMultiBtn` text to append "+ collection" whenever a collection (existing or new) will be assigned.

### `public/preview.html`

- **Full-screen hero**: `.hero` is `height: 100vh`/`100dvh` (fallback cascade) with the gallery's background photo as an undimmed, full-bleed cover (`object-fit: cover`, no darkening overlay) — the site logo sits top-left, the gallery name bottom-left, and a "Show Gallery" button + the "Download All" button bottom-right. "Show Gallery" (`scrollToGallery()`) smooth-scrolls down to `#galleryContainer`. The three action-style buttons across the page (`.show-gallery-btn`, `.download-all-btn`, `.back-to-collection`) share one CSS rule set — same size/border/radius, theme-aware via an `html.light` override — rather than each having its own styling.
- Justified/row-based gallery: photos grouped into `.gallery-row` flex rows built in JS, recomputed on resize.
- Photos sorted alphabetically by filename (server-side).
- Lightbox preloads N-1 and N+1 previews via `new Image()` on each navigation.
- Mobile lightbox: pinch-to-zoom (up to 5x), one-finger pan while zoomed, swipe navigation when not zoomed. `touch-action: none` disables native browser zoom.
- Animated images (GIF / animated WebP) show a static thumbnail + `GIF` badge in the grid and play in the lightbox — see "Animated images". The badge is driven by `photo.animated` from `/photos`; the lightbox `<img src=previewUrl>` resolves to the animated original with no extra code.
- **Critique mode:** `critiqueMode = URLSearchParams.get('critique') === '1'`. When true: photo number badges rendered on grid cards, `#lbCritiqueNum` shown in lightbox, `#critiqueIndicator` shown in actions bar.
- Favorites toast: `showFavToast(added)` shown on toggle, localized in all 5 languages, auto-dismisses after 2s.
- Social footer is hidden (`opacity: 0; pointer-events: none`) over the full-screen hero and only fades in once the page is scrolled past 100px (`updateFooterVisibility()`, on a `scroll` listener), so it never overlaps the hero's action buttons.
- `applyTheme()` and `renderSocialFooter()` called on load.
- Locale is finalized inside `loadGallery()`, not at page load: `let locale = 'en'; let t = translations.en;` defaults are replaced once `info.clientLanguage` comes back from `GET /api/gallery/:id/info`, via `resolveClientLocale()` (see "Language settings"). `applyStaticTranslations()` is called once with the defaults and again after resolution.

### `public/collection.html`

- `applyTheme()` and `renderSocialFooter()` called on load.
- Full i18n: EN, FR, ES, PT, IT — including `gallery`/`galleries` keys (no hardcoded French strings).
- Locale resolved from `data.clientLanguage` (the collection's own resolved value, server-side precedence already applied) via `resolveClientLocale()` inside `loadCollection()`, same deferred pattern as the other client pages.
- Gallery covers use `?card=1` (800px) instead of full resolution.
- Download button shows total size (`totalSizeBytes` from `/api/collection/:id`).
- Browse and customer-link URLs are page-relative (`../preview/...`, `../download/...`) for subpath deployment compatibility.

---

## Conventions and Gotchas

- **No build step.** Do not introduce a bundler, TypeScript, or a frontend framework.
- **No external database.** Metadata lives in `galleries.json`, `collections.json`, `settings.json`.
- **`downloadsEnabled` defaults to `true`.** Check is `gallery.downloadsEnabled !== false`.
- **`safeResolvePath(base, ...segments)`** must be used for every path incorporating a user-controlled value.
- **`escape-html` package** used directly (not via alias) for OG tag injection — CodeQL recognises it.
- **`ADMIN_ALLOWED_IPS`** is checked inside `requireAuth` — applies to all admin routes automatically. No need to add middleware per route.
- **`[AUTH]` log prefix** — all auth failures and IP blocks are logged with this prefix for easy filtering: `docker logs delyvr | grep '\[AUTH\]'`.
- **Settings defaults** — `loadSettings()` merges file content with `SETTINGS_DEFAULTS`. Missing keys are filled in without overwriting existing values.
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
- **Soft-delete only.** `DELETE /api/gallery/:id` never removes files. `hardDeleteGallery(id)` does. Always call `saveGalleries()` after `hardDeleteGallery`. Auto-purge runs on startup **and** hourly via `purgeExpiredTrash()` (a `setInterval` — not startup-only, or expired trash never clears on a long-running server).
- **`getActiveGallery(galleryId)`** returns the gallery only if it exists and `!gallery.deleted`. Use it in all public routes to return 404 for trashed galleries.
- **ZIP downloads use `store: true`** (no compression). Content-Length is intentionally omitted — archiver adds variable per-file data descriptors during streaming that make pre-calculation unreliable and cause "unexpected end of archive" errors.
- **Filename sanitisation allows Unicode.** Only truly dangerous filesystem characters are stripped (`<>:"/\|?*` and control chars). Accents, spaces, ampersands, and **apostrophes** are preserved. `SAFE_FILENAME_RE` reflects this.
- **Never embed a filename in an inline `onclick` string in admin.html.** Filenames can contain apostrophes (`l'été.jpg`). `escapeAttr` turns `'` into `&#39;`, which the browser HTML-decodes back to `'` *before* the JS in `onclick=` is parsed, breaking the handler. Attach handlers via a closure (`el.onclick = …`) or `data-*` attributes + a delegated listener reading `dataset` instead. The uuid `commentId` is safe, but the filename is not.
- **`?card=1` on background routes** generates an 800px JPEG (fit: inside, quality 82) for use in collection gallery cards. `?thumb=1` stays at 200x200 for admin thumbnails.
- **Critique mode** is entirely client-side. `?critique=1` in the URL enables photo numbering in `preview.html`. The admin copies the critique URL via `copyCritiqueLink()`. No server-side flag.
- **Gallery name editing** requires disabling `draggable` on the parent `.gallery-item` during edit (set in `startGalleryRename`, restored in `finishGalleryRename`) so that text selection works. Without this, the browser intercepts mousedown for drag, preventing text selection.
- **`squarePhotoGridCells()`** in the photos management modal measures `offsetWidth` of the first grid cell after `requestAnimationFrame` and sets explicit `style.height` on all cells. CSS `aspect-ratio` is unreliable in some mobile browsers when combined with grid and `position: absolute` content.
- **`public/shared.js`** is loaded by all client pages via `<script src="/shared.js">`. It provides `SOCIAL_ICONS`, `applyTheme()`, and `renderSocialFooter()`. `admin.html` loads it but overrides `applyTheme()` locally to also update the theme toggle button text. Do not duplicate these functions into individual HTML files.