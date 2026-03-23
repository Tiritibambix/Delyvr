# CLAUDE.md — Delyvr

This file describes the architecture, conventions, and key decisions in Delyvr so that AI assistants and contributors can work on the codebase effectively.

---

## What is Delyvr?

Delyvr is a **self-hosted photo delivery platform** for photographers. A photographer logs into a private dashboard, creates named galleries by uploading photos, groups them into collections, then shares links with clients. Clients browse photos in a masonry lightbox, mark favorites, and download photos or full collections as ZIP files.

There is no public registration. The entire admin side is protected by a single shared password.

> Based on the original work of [Andre Padua (apadua)](https://github.com/apadua/MeTransfer).

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js 20+ |
| Server framework | Express 4 |
| File uploads | multer (disk storage) |
| Image processing | sharp (thumbnails, OG images, background normalisation) |
| ZIP creation | archiver |
| Unique IDs | uuid v4 |
| Environment config | dotenv |
| Rate limiting | express-rate-limit |
| HTML escaping | escape-html (used server-side for OG tag injection) |
| Frontend | Vanilla HTML/CSS/JS — no framework, no build step |
| Fonts | Google Fonts (Instrument Sans, Fraunces) |

---

## File Structure

```
delyvr/
├── server.js           # All server logic — Express app, routes, middleware
├── package.json        # Dependencies and npm scripts
├── Dockerfile
├── docker-compose.yml
├── .env                # Secret config (gitignored) — copy from .env.example
├── .env.example        # Template showing required env vars
├── .dockerignore
├── .gitignore
├── public/
│   ├── admin.html      # Photographer dashboard
│   ├── customer.html   # Client download page (single gallery)
│   ├── preview.html    # Client photo browser (masonry grid + lightbox + favorites)
│   └── collection.html # Client collection page (multiple galleries)
└── data/               # Runtime data root (Docker volume mount at /data)
    ├── uploads/        # Gallery photos, organised as uploads/{galleryId}/
    ├── backgrounds/    # Background images — {galleryId}.jpg for galleries,
    │                   # collection-{collectionId}.jpg for collections (normalised JPEG)
    ├── thumbnails/     # 400px JPEG thumbnails, generated on upload or first request
    ├── previews/       # 1920px JPEG previews for lightbox, generated on upload or first request
    ├── og-cache/       # 1200×630 OG images, generated on first share
    ├── galleries.json  # Gallery metadata
    ├── collections.json # Collection metadata
    └── settings.json   # Site-wide settings (theme) — created automatically on first change
```

---

## Configuration

| Variable | Default | Notes |
|----------|---------|-------|
| `ADMIN_PASSWORD` | *(none — must be set)* | Password to access the admin dashboard |
| `PORT` | `3000` | TCP port the server listens on |
| `MAX_UPLOAD_MB` | `200` | Per-file size limit for photo uploads, in MB |
| `MAX_BACKGROUND_MB` | `20` | Size limit for background image uploads, in MB |
| `INSTALL_DIR` | *(project dir)* | Set to `/data` in Docker. Controls where all data files are written. Do not change in Docker. |
| `TRUST_PROXY` | `0` | Set to `1` behind a reverse proxy for correct IP detection. |

---

## Server Architecture (`server.js`)

### Data models

**Gallery** — stored in `galleries.json`, keyed by UUID v4:

```js
{
  id: string,
  eventName: string,
  created: string,          // ISO 8601
  files: string[],          // filenames inside uploads/{id}/
  background: string|null,  // filename inside backgrounds/
  downloadsEnabled: boolean, // default true (missing = true)
  favorites: {              // filename → [visitorId, ...]
    [filename: string]: string[]
  }
}
```

**Collection** — stored in `collections.json`, keyed by UUID v4:

```js
{
  id: string,
  name: string,
  created: string,          // ISO 8601
  galleryIds: string[],     // ordered list — order is the client display order
  background: string|null   // filename inside backgrounds/ (collection-{id}.jpg)
}
```

**Settings** — stored in `settings.json`:

```js
{
  theme: 'dark' | 'light'   // default 'dark' — applies site-wide to all pages
}
```

`settings.json` is created automatically the first time the theme is changed via the admin. If it does not exist, `siteSettings` defaults to `{ theme: 'dark' }`.

One gallery belongs to at most one collection. The server enforces this on `POST /api/collection/:id/galleries`. Deleting a gallery removes it from any collection automatically.

### Authentication

`requireAuth` middleware checks the `X-Admin-Password` header only — the `?password` query param has been removed to prevent credentials leaking into server logs and browser history. Login is rate-limited at 10 attempts per IP per 15 minutes via `authLimiter`.

`validateGalleryId` and `validateCollectionId` both enforce UUID v4 format before any filesystem operation, closing path traversal vectors. `validateFilename` enforces `/^[a-zA-Z0-9._\-]+$/`.

### Path safety

All filesystem paths that incorporate user-controlled values (`galleryId`, `collectionId`, `filename`) go through `safeResolvePath(base, ...segments)`. This function resolves the final path and throws if it would escape the base directory, defending against path traversal even when input passes UUID/filename validation.

### Rate limiting

| Limiter | Limit | Applied to |
|---------|-------|-----------|
| `authLimiter` | 10/15 min | `POST /api/auth/verify` |
| `imageLimiter` | 600/min | Photo and OG image serving |
| `publicReadLimiter` | 300/min | All public GET routes |
| `publicWriteLimiter` | 120/min | `POST /favorites` |
| `downloadLimiter` | 10/min | Gallery and collection ZIP downloads |
| `adminLimiter` | 60/min | Admin routes with filesystem access |

### File upload pipeline

- **`upload`** — photos into `uploads/{galleryId}/`. Accepts JPEG, PNG, GIF, WebP, TIFF, BMP, raw (CR2, NEF, ARW). Filenames sanitised. Limit: `MAX_UPLOAD_MB`.
- **`uploadBackground`** — background normalised to JPEG via sharp (max 2400px wide, quality 85). Used for both gallery and collection backgrounds.
- **`uploadLogo`** — stored in memory, written to `DATA_DIR/logo.{ext}`. Accepts JPEG, PNG, GIF, WebP, SVG. Limit: 5 MB.

### Photo sort order

`GET /api/gallery/:id/photos` sorts files using `localeCompare` with `{ numeric: true, sensitivity: 'base' }`. This gives natural sort order: `DSC_9` before `DSC_10`.

### Thumbnail generation

400px-wide JPEG thumbnails are generated via sharp on upload (fire-and-forget) and on-the-fly if missing when `?thumb=1` is requested.

### Preview generation

1920px JPEG previews (longest side, `fit: inside`, quality 85) are generated via sharp on upload alongside thumbnails. Served by `GET /api/gallery/:id/preview/:filename`. Generated on-the-fly if missing (covers galleries uploaded before the feature). Falls back to the original if generation fails. The lightbox uses `previewUrl` instead of `url` — originals are only served on download. Previews are deleted with the gallery.

### OG image generation

1200×630 JPEG, cached in `og-cache/`. Source: background image if present, else first photo. Cache invalidated when background is replaced. Event/collection names injected into OG meta tags via `escapeHtml()` from the `escape-html` package (CodeQL-recognised sanitiser).

### ZIP streaming

Gallery ZIP: `archiver` pipes directly to response, compression level 5. Filename derived from `eventName`.

Collection ZIP: iterates over `galleryIds`, creates one sub-folder per gallery named after `eventName`, pipes all photos into a single archive.

### Download toggle

`PATCH /api/gallery/:id/downloads` sets `gallery.downloadsEnabled`. When false, both ZIP and per-photo download routes return 403. Client pages check `downloadsEnabled` from `/info` and hide buttons accordingly.

### Favorites

Per-photo, per-visitor voting. Structure: `favorites[filename] = [visitorId, ...]`. Key deleted when vote count reaches 0.

- `POST /favorites` — public, toggles visitor's vote, requires `{ filename, visitorId }`
- `GET /favorites-public?visitorId=` — public, returns photos this visitor voted for
- `GET /favorites` — admin only, sorted by vote count desc, returns `{ filename, votes }[]`
- `DELETE /favorites` — admin only, resets to `{}`

### Collections

- `POST /api/collection/create` — creates collection, returns `collectionUrl`
- `GET /api/collections` — admin list, includes `hasBackground` per collection
- `GET /api/collection/:id` — public, returns collection with gallery details and `background` URL
- `POST /api/collection/:id/rename`
- `POST /api/collection/:id/background` — upload/replace cover (same sharp pipeline as gallery backgrounds, stored as `backgrounds/collection-{id}.jpg`)
- `GET /api/collection/:id/background` — serve cover image
- `POST /api/collection/:id/galleries` — add gallery (enforces one-collection-per-gallery)
- `PATCH /api/collection/:id/galleries/reorder` — accepts full ordered `galleryIds` array, validates all IDs belong to collection
- `DELETE /api/collection/:id/galleries/:galleryId` — remove from collection
- `GET /api/collection/:id/download` — ZIP with sub-folders
- `DELETE /api/collection/:id` — delete collection only, galleries untouched
- `GET /collection/:id` — serves `collection.html` with OG meta tags

### Settings

- `GET /api/settings` — public, returns `siteSettings` (currently `{ theme }`)
- `PATCH /api/settings/theme` — admin only, accepts `{ theme: 'dark' | 'light' }`, persists to `settings.json`

---

## API Endpoints

### Gallery

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/` | — | Admin dashboard |
| `GET` | `/download/:id` | — | Customer download page |
| `GET` | `/preview/:id` | — | Photo browser |
| `POST` | `/api/auth/verify` | — | Verify password |
| `POST` | `/api/gallery/create` | ✓ | Create gallery + upload |
| `POST` | `/api/gallery/:id/upload` | ✓ | Add photos |
| `POST` | `/api/gallery/:id/background` | ✓ | Upload/replace background |
| `POST` | `/api/gallery/:id/rename` | ✓ | Rename |
| `PATCH` | `/api/gallery/:id/downloads` | ✓ | Toggle downloads |
| `GET` | `/api/gallery/:id/info` | — | Metadata |
| `GET` | `/api/gallery/:id/photos` | — | Photo list (sorted) |
| `GET` | `/api/gallery/:id/photo/:filename` | — | Serve photo or thumbnail |
| `GET` | `/api/gallery/:id/preview/:filename` | — | Serve 1920px lightbox preview (fallback to original) |
| `GET` | `/api/gallery/:id/download` | — | ZIP download |
| `GET` | `/api/gallery/:id/download/:filename` | — | Single photo download |
| `GET` | `/api/gallery/:id/background` | — | Serve background |
| `GET` | `/api/gallery/:id/og-image` | — | OG image |
| `POST` | `/api/gallery/:id/favorites` | — | Toggle favorite |
| `GET` | `/api/gallery/:id/favorites-public` | — | Visitor's favorites |
| `GET` | `/api/gallery/:id/favorites` | ✓ | All favorites (admin) |
| `DELETE` | `/api/gallery/:id/favorites` | ✓ | Reset favorites |
| `GET` | `/api/galleries` | ✓ | List all galleries |
| `DELETE` | `/api/gallery/:id` | ✓ | Delete gallery |

### Collection

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/collection/:id` | — | Collection page |
| `POST` | `/api/collection/create` | ✓ | Create collection |
| `GET` | `/api/collections` | ✓ | List collections (includes `hasBackground`) |
| `GET` | `/api/collection/:id` | — | Collection info (includes `background` URL) |
| `POST` | `/api/collection/:id/rename` | ✓ | Rename |
| `POST` | `/api/collection/:id/background` | ✓ | Upload/replace cover image |
| `GET` | `/api/collection/:id/background` | — | Serve cover image |
| `POST` | `/api/collection/:id/galleries` | ✓ | Add gallery |
| `PATCH` | `/api/collection/:id/galleries/reorder` | ✓ | Reorder galleries |
| `DELETE` | `/api/collection/:id/galleries/:galleryId` | ✓ | Remove gallery |
| `GET` | `/api/collection/:id/download` | — | ZIP all galleries |
| `DELETE` | `/api/collection/:id` | ✓ | Delete collection |

### Settings

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/settings` | — | Get site settings |
| `PATCH` | `/api/settings/theme` | ✓ | Set theme (`{ theme: 'dark'\|'light' }`) |

---

## Frontend Architecture

All HTML files are standalone — no bundler, no imports, all JS inline.

### `public/admin.html`

- Login via in-memory `adminPassword` variable only — not persisted to `sessionStorage` or `localStorage`. Requires re-login on page reload.
- `applyTheme()` called on load — fetches `/api/settings` and adds `class="light"` on `<html>` if needed.
- Theme toggle button in the header — calls `toggleTheme()` which PATCHes `/api/settings/theme` and updates the class immediately.
- **Galleries section** — displayed as a responsive card grid (`auto-fill, minmax(280px, 1fr)`). Each card shows a 16/9 cover, inline rename, downloads toggle, favorites count/view/reset, copy link, delete, drag-and-drop.
- Gallery cards are `draggable="true"` — can be dragged into collection drop zones. Cursor is `grab` / `grabbing`.
- **Collections section** (above galleries) — create, rename inline, copy link, delete. Each collection has a cover zone (click or drag to upload). Gallery pills inside each collection are draggable for reordering (`cursor: grab`).
- `_galleriesData` cache populated inside `loadGalleries()` and used by `renderCollections()` to show gallery names in pills.
- `html.light {}` CSS vars defined for full light mode support.
- **Mobile layout** — collection create row stacks vertically (≤600px), button full-width. After gallery creation, the link row hides the URL input on mobile and shows a full-width Copy Link button. Theme toggle gets `padding-top: 44px` on the header to avoid overlapping the logo.

### `public/customer.html`

Single-gallery download page. Hides download button when `downloadsEnabled` is false. Right-click on images disabled. `applyTheme()` called on load. `html.light .bg-overlay` uses a pale gradient so text remains readable in light mode.

### `public/preview.html`

Full photo browser for a single gallery.

- `applyTheme()` called on load. `html.light .hero-overlay` uses a pale gradient variant.
- **`?from=` param** — if present, a back button appears in the actions bar linking to `/collection/{from}`. The button is hidden when the param is absent, so clients with a direct gallery link never see it. `collection.html` appends `?from={collectionId}` to all gallery links.
- **Masonry layout** — JS-based, round-robin column distribution (left-to-right chronological order). `getColCount()` returns 4/3/2/1 based on viewport width. Re-renders on resize (debounced).
- No `aspect-ratio` constraint — photos display at natural ratio.
- Lazy loading via `IntersectionObserver`.
- Full-screen lightbox: ✕, download (round), heart (round) in top-right corner.
- Download controls hidden when `downloadsEnabled` is false.
- Right-click on images disabled.
- **Visitor ID** — `delyvr_visitor_id` in `localStorage`, shared across all galleries on the device.
- Favorites fetched from `/favorites-public?visitorId=` on load. Toggled optimistically with server sync and revert on error.
- Favorite button uses `data-filename` + `addEventListener` instead of inline `onclick` — avoids incomplete sanitisation of filenames with special characters.
- **Mobile lightbox** — on screens ≤768px, the close button and nav arrows are hidden. A fixed bottom action bar (`.lightbox-mobile-bar`) replaces them with five buttons: Prev / Fav / Close / Save / Next. The bar uses `safe-area-inset-bottom` for notched phones.
- **Swipe navigation** — `touchstart`/`touchend` on the lightbox element detect horizontal swipes (min 50px, must exceed vertical delta). The old tap-zone buttons that were blocking touch events have been removed.
- **Lightbox image padding** — on mobile, `padding-bottom: 72px` on `.lightbox-content` prevents the image from being hidden behind the bottom bar.

### `public/collection.html`

Client-facing collection page.

- `applyTheme()` called on load.
- Full i18n: EN, FR, ES, PT, IT (same language detection as other client pages).
- **Hero background** — if the collection has a cover, it is displayed as a subtle full-bleed image (opacity 18%) behind the header.
- Gallery cards with clickable 16/9 cover navigating to `/preview/:id?from={collectionId}`.
- **Copy Link** button (outlined style) copies gallery preview URL with translated feedback.
- **Download** button (accent style, if enabled) downloads gallery ZIP.
- **Download All Galleries** button (visible if any gallery is downloadable) downloads collection ZIP.
- No placeholder icon on covers — missing cover = clean dark surface.
- Right-click on images disabled.

---

## Conventions and Gotchas

- **No build step.** Do not introduce a bundler, TypeScript, or a frontend framework without discussing it first.
- **No external database.** Metadata lives in `galleries.json`, `collections.json`, and `settings.json`.
- **`downloadsEnabled` defaults to `true`.** Check is `gallery.downloadsEnabled !== false` — missing field means enabled.
- **`favorites` defaults to `{}`.** `gallery.favorites || {}` used everywhere.
- **`galleryIds` order is authoritative** for collection display order. The reorder endpoint validates the full array before saving.
- **One gallery = one collection max.** Enforced server-side on add. The `collectionId` field returned by `/api/galleries` reflects this.
- **Collection background naming** — stored as `backgrounds/collection-{id}.jpg` to avoid collisions with gallery backgrounds which use `{galleryId}.jpg`.
- **`settings.json` is optional.** If absent, the server defaults to `{ theme: 'dark' }`. It is created on first `PATCH /api/settings/theme`.
- **Theme is server-side.** All pages call `GET /api/settings` on load and apply `class="light"` on `<html>`. Changing the theme in the admin affects every visitor immediately.
- **`safeResolvePath(base, ...segments)`** must be used for every path that incorporates a user-controlled value. It resolves the path and throws if it escapes the base directory.
- **`escape-html` package** is used directly (not via an alias) for OG tag injection so CodeQL recognises it as a trusted sanitiser.
- **Visitor IDs are not authenticated.** Random client-generated strings — not security-sensitive.
- **Lightbox uses `previewUrl`, not `url`.** The `/api/gallery/:id/photos` response includes both. `url` is the full original (used nowhere in the UI — only available server-side). `previewUrl` points to the 1920px preview. Download links always use `downloadUrl` which serves the original.
- **Photo sort is natural locale sort** (`numeric: true, sensitivity: base`). Rename files on camera before uploading to control display order.
- **Backgrounds replace on upload.** Old file deleted, OG cache invalidated.
- **Galleries can be re-discovered from disk.** The filesystem is authoritative.
- **Password never stored in sessionStorage.** Kept in the `adminPassword` JS variable only — cleared when the tab closes.
- **`?password` query param removed.** `requireAuth` only checks the `X-Admin-Password` header to prevent credentials leaking into logs.
- **INSTALL_DIR decouples code from data.** All paths use `process.env.INSTALL_DIR || __dirname`.
- **Right-click disabled on all client pages** (`customer.html`, `preview.html`, `collection.html`) — only images are targeted, not the full page.