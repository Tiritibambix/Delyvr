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
    ├── backgrounds/    # Background images, named {galleryId}.jpg (normalised JPEG)
    ├── thumbnails/     # 400px JPEG thumbnails, generated on upload or first request
    ├── og-cache/       # 1200×630 OG images, generated on first share
    ├── galleries.json  # Gallery metadata
    └── collections.json # Collection metadata
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
  galleryIds: string[]      // ordered list — order is the client display order
}
```

One gallery belongs to at most one collection. The server enforces this on `POST /api/collection/:id/galleries`. Deleting a gallery removes it from any collection automatically.

### Authentication

`requireAuth` middleware checks `X-Admin-Password` header (or `?password` query param). Login is rate-limited at 10 attempts per IP per 15 minutes via `authLimiter`.

`validateGalleryId` and `validateCollectionId` both enforce UUID v4 format before any filesystem operation, closing path traversal vectors. `validateFilename` enforces `/^[a-zA-Z0-9._\-]+$/`.

### File upload pipeline

- **`upload`** — photos into `uploads/{galleryId}/`. Accepts JPEG, PNG, GIF, WebP, TIFF, BMP, raw (CR2, NEF, ARW). Filenames sanitised. Limit: `MAX_UPLOAD_MB`.
- **`uploadBackground`** — background normalised to JPEG via sharp (max 2400px wide, quality 85). Stored as `backgrounds/{galleryId}.jpg`.
- **`uploadLogo`** — stored in memory, written to `DATA_DIR/logo.{ext}`. Accepts JPEG, PNG, GIF, WebP, SVG. Limit: 5 MB.

### Photo sort order

`GET /api/gallery/:id/photos` sorts files using `localeCompare` with `{ numeric: true, sensitivity: 'base' }`. This gives natural sort order: `DSC_9` before `DSC_10`.

### Thumbnail generation

400px-wide JPEG thumbnails are generated via sharp on upload (fire-and-forget) and on-the-fly if missing when `?thumb=1` is requested.

### OG image generation

1200×630 JPEG, cached in `og-cache/`. Source: background image if present, else first photo. Cache invalidated when background is replaced.

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
- `GET /api/collections` — admin list
- `GET /api/collection/:id` — public, returns collection with gallery details
- `POST /api/collection/:id/rename`
- `POST /api/collection/:id/galleries` — add gallery (enforces one-collection-per-gallery)
- `PATCH /api/collection/:id/galleries/reorder` — accepts full ordered `galleryIds` array, validates all IDs belong to collection
- `DELETE /api/collection/:id/galleries/:galleryId` — remove from collection
- `GET /api/collection/:id/download` — ZIP with sub-folders
- `DELETE /api/collection/:id` — delete collection only, galleries untouched
- `GET /collection/:id` — serves `collection.html` with OG meta tags

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
| `GET` | `/api/collections` | ✓ | List collections |
| `GET` | `/api/collection/:id` | — | Collection info |
| `POST` | `/api/collection/:id/rename` | ✓ | Rename |
| `POST` | `/api/collection/:id/galleries` | ✓ | Add gallery |
| `PATCH` | `/api/collection/:id/galleries/reorder` | ✓ | Reorder galleries |
| `DELETE` | `/api/collection/:id/galleries/:galleryId` | ✓ | Remove gallery |
| `GET` | `/api/collection/:id/download` | — | ZIP all galleries |
| `DELETE` | `/api/collection/:id` | ✓ | Delete collection |

---

## Frontend Architecture

All HTML files are standalone — no bundler, no imports, all JS inline.

### `public/admin.html`

- Login via `sessionStorage` (cleared on tab close)
- **Galleries section** — drag-and-drop upload, inline rename, cover upload, download toggle, favorites count/view/reset, delete
- Gallery items are `draggable="true"` — can be dragged into collection drop zones
- **Collections section** (above galleries) — create, rename inline, copy link, delete. Each collection shows gallery pills that are draggable for reordering within the collection.
- `_galleriesData` cache populated inside `loadGalleries()` and used by `renderCollections()` to show gallery names in pills

### `public/customer.html`

Single-gallery download page. Hides download button when `downloadsEnabled` is false. Right-click on images disabled.

### `public/preview.html`

Full photo browser for a single gallery.

- **Masonry layout** — JS-based, round-robin column distribution (left-to-right chronological order). `getColCount()` returns 4/3/2/1 based on viewport width. Re-renders on resize (debounced).
- No `aspect-ratio` constraint — photos display at natural ratio.
- Lazy loading via `IntersectionObserver`.
- Full-screen lightbox: ✕, download (round), heart (round) in top-right corner.
- Download controls hidden when `downloadsEnabled` is false.
- Right-click on images disabled.
- **Visitor ID** — `delyvr_visitor_id` in `localStorage`, shared across all galleries on the device.
- Favorites fetched from `/favorites-public?visitorId=` on load. Toggled optimistically with server sync and revert on error.

### `public/collection.html`

Client-facing collection page.

- Full i18n: EN, FR, ES, PT, IT (same language detection as other client pages).
- Gallery cards with clickable 16/9 cover (navigates to `/preview/:id`).
- **Copy Link** button (outlined style) copies gallery preview URL with translated feedback.
- **Download** button (accent style, if enabled) downloads gallery ZIP.
- **Download All Galleries** button (visible if any gallery is downloadable) downloads collection ZIP.
- No placeholder icon on covers — missing cover = clean dark surface.
- Right-click on images disabled.

---

## Conventions and Gotchas

- **No build step.** Do not introduce a bundler, TypeScript, or a frontend framework without discussing it first.
- **No external database.** Metadata lives in `galleries.json` and `collections.json`.
- **`downloadsEnabled` defaults to `true`.** Check is `gallery.downloadsEnabled !== false` — missing field means enabled.
- **`favorites` defaults to `{}`.** `gallery.favorites || {}` used everywhere.
- **`galleryIds` order is authoritative** for collection display order. The reorder endpoint validates the full array before saving.
- **One gallery = one collection max.** Enforced server-side on add. The `collectionId` field returned by `/api/galleries` reflects this.
- **Visitor IDs are not authenticated.** Random client-generated strings — not security-sensitive.
- **Photo sort is natural locale sort** (`numeric: true, sensitivity: base`). Rename files on camera before uploading to control display order.
- **Backgrounds replace on upload.** Old file deleted, OG cache invalidated.
- **Galleries can be re-discovered from disk.** The filesystem is authoritative.
- **Password in sessionStorage.** Cleared on tab close — intentional.
- **INSTALL_DIR decouples code from data.** All paths use `process.env.INSTALL_DIR || __dirname`.
- **Right-click disabled on all client pages** (`customer.html`, `preview.html`, `collection.html`) — only images are targeted, not the full page.