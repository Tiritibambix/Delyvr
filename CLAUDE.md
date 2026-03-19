# CLAUDE.md — Delyvr

This file describes the architecture, conventions, and key decisions in Delyvr so that AI assistants and contributors can work on the codebase effectively.

---

## What is Delyvr?

Delyvr is a **self-hosted photo delivery platform** for photographers. A photographer logs into a private dashboard, creates a named gallery by uploading photos (and optionally a hero background image), then shares the generated link with their client. The client visits a minimal, elegant page, browses photos in a lightbox, marks favorites, and downloads all photos as a single ZIP file.

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
├── Dockerfile          # Docker image definition
├── docker-compose.yml  # Docker Compose service definition (recommended deployment)
├── .env                # Secret config (gitignored) — copy from .env.example
├── .env.example        # Template showing required env vars
├── .dockerignore       # Excludes node_modules, .env, data/ from Docker build context
├── .gitignore          # Excludes .env, node_modules, data/, galleries.json
├── public/
│   ├── admin.html      # Photographer dashboard (login, upload, gallery management)
│   ├── customer.html   # Client download page (background image + download button)
│   └── preview.html    # Client photo browser (thumbnail grid + lightbox + favorites)
└── data/               # Runtime data root (Docker volume mount at /data)
    ├── uploads/        # Gallery photos, organised as uploads/{galleryId}/
    ├── backgrounds/    # Background images, named {galleryId}.jpg (normalised JPEG)
    ├── thumbnails/     # 400px JPEG thumbnails, generated on upload or first request
    ├── og-cache/       # 1200×630 OG images, generated on first share
    └── galleries.json  # Gallery metadata persisted to disk
```

`data/` and its contents are generated at runtime and gitignored. `server.js` creates all directories automatically on startup.

---

## Configuration

All secrets and tuneable values live in `.env` (bare-metal) or in the `environment` block of `docker-compose.yml` (Docker).

| Variable | Default | Notes |
|----------|---------|-------|
| `ADMIN_PASSWORD` | *(none — must be set)* | Password to access the admin dashboard |
| `PORT` | `3000` | TCP port the server listens on |
| `MAX_UPLOAD_MB` | `200` | Per-file size limit for photo uploads, in MB |
| `MAX_BACKGROUND_MB` | `20` | Size limit for background image uploads, in MB |
| `INSTALL_DIR` | *(project dir)* | Set to `/data` in Docker. Controls where galleries.json, uploads/, backgrounds/, thumbnails/ and og-cache/ are written. Do not change in Docker. |
| `TRUST_PROXY` | `0` | Set to `1` behind a reverse proxy (Nginx, Caddy, Traefik) for correct IP detection. |

`dotenv` is loaded as the very first line of `server.js` so env vars are available everywhere.

---

## Server Architecture (`server.js`)

### Data model

Galleries are stored in an in-memory `Map<galleryId, GalleryObject>` and flushed to `galleries.json` on every write. On startup the file is read back into memory. All gallery IDs are UUID v4 strings.

```js
{
  id: string,               // UUID v4
  eventName: string,        // Display name set by the photographer
  created: string,          // ISO 8601 timestamp
  files: string[],          // Array of filenames inside uploads/{id}/
  background: string|null,  // Filename inside backgrounds/ (or null)
  downloadsEnabled: boolean, // Whether clients can download photos (default true)
  favorites: {              // Per-photo vote map — filename → [visitorId, ...]
    [filename: string]: string[]
  }
}
```

### Authentication and security

A single `requireAuth` middleware checks the `X-Admin-Password` request header (or `?password` query param) against `process.env.ADMIN_PASSWORD`. Unauthenticated requests receive HTTP 401.

The `/api/auth/verify` endpoint is the only auth-related route that is itself unprotected — the browser uses it to validate the password on login. It is protected by `authLimiter` (10 attempts per IP per 15 minutes) to prevent brute-force attacks.

All routes that accept a `:galleryId` URL parameter pass through `validateGalleryId` before any filesystem operation. This middleware rejects values that do not match the UUID v4 regex, closing the path traversal attack vector.

Routes that accept a `:filename` parameter pass through `validateFilename`, which rejects any value not matching `/^[a-zA-Z0-9._\-]+$/`.

**Important:** The password travels in a plain HTTP header. In production, always serve behind HTTPS.

### File upload pipeline

Three separate `multer` instances handle different upload types:

- **`upload`** — photo uploads into `uploads/{galleryId}/`. Accepts JPEG, PNG, GIF, WebP, TIFF, BMP, raw formats (CR2, NEF, ARW), plus any `image/*` MIME type. Filenames are sanitised (non-alphanumeric except `.`, `-`, `_` replaced with underscores). Limit: `MAX_UPLOAD_MB`.
- **`uploadBackground`** — background images, stored in memory then processed by sharp into a normalised JPEG at `backgrounds/{galleryId}.jpg`. Max width 2400px. Limit: `MAX_BACKGROUND_MB`.
- **`uploadLogo`** — logo images, stored in memory then written to `DATA_DIR/logo.{ext}`. Accepts JPEG, PNG, GIF, WebP, SVG. Limit: 5 MB.

For new gallery creation, the gallery ID must be assigned **before** multer runs. A `generateGalleryId` middleware creates the UUID and inserts a skeleton gallery record into the Map before the upload middleware executes.

### Thumbnail generation

On gallery creation and photo upload, `generateGalleryThumbnails()` generates 400px-wide JPEG thumbnails via sharp (fire-and-forget). Missing thumbnails are generated on-the-fly when first requested via `GET /api/gallery/:id/photo/:filename?thumb=1`.

### OG image generation

`GET /api/gallery/:id/og-image` generates a 1200×630 JPEG cropped from the gallery background (or first photo if no background). Results are cached in `og-cache/`. The cache file is deleted whenever the background is replaced.

### ZIP streaming

`GET /api/gallery/:id/download` checks `downloadsEnabled` before proceeding. If disabled, returns 403. Otherwise creates an `archiver` zip stream piped directly to the response. Compression level is 5. The ZIP filename is derived from the event name (sanitised, max 50 chars).

### Download toggle

`PATCH /api/gallery/:id/downloads` accepts `{ enabled: boolean }` and sets `gallery.downloadsEnabled`. When false:
- `GET /api/gallery/:id/download` returns 403
- `GET /api/gallery/:id/download/:filename` returns 403
- Client pages hide all download buttons (checked via `downloadsEnabled` in `/info`)

### Favorites system

Each photo can be favorited by multiple anonymous visitors. Votes are stored as `favorites[filename] = [visitorId, ...]` in the gallery object.

- `POST /api/gallery/:id/favorites` — public, toggles a visitor's vote on a photo. Receives `{ filename, visitorId }`. Removes the photo key when vote count reaches 0.
- `GET /api/gallery/:id/favorites-public?visitorId=` — public, returns the list of photos this visitor has voted for. Used by `preview.html` on load to restore heart button state.
- `GET /api/gallery/:id/favorites` — admin only, returns photos sorted by vote count descending with `{ filename, votes }` objects.
- `DELETE /api/gallery/:id/favorites` — admin only, resets `favorites` to `{}`.

### Filesystem-first gallery listing

`GET /api/galleries` scans the `uploads/` directory rather than trusting only the in-memory Map. Any directory found on disk that has no corresponding metadata entry gets a synthetic record created automatically. This makes the system resilient to restarts or manual file operations.

---

## API Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/` | — | Serve admin dashboard |
| `GET` | `/download/:id` | — | Serve client download page (with OG meta tags) |
| `GET` | `/preview/:id` | — | Serve client photo browser (with OG meta tags) |
| `POST` | `/api/auth/verify` | — | Verify admin password |
| `POST` | `/api/gallery/create` | ✓ | Create gallery + upload photos |
| `POST` | `/api/gallery/:id/upload` | ✓ | Add more photos to existing gallery |
| `POST` | `/api/gallery/:id/background` | ✓ | Upload/replace background image |
| `POST` | `/api/gallery/:id/rename` | ✓ | Rename a gallery |
| `PATCH` | `/api/gallery/:id/downloads` | ✓ | Enable or disable downloads |
| `GET` | `/api/gallery/:id/info` | — | Gallery metadata (eventName, fileCount, background, downloadsEnabled) |
| `GET` | `/api/gallery/:id/photos` | — | List photos with URLs (used by preview page) |
| `GET` | `/api/gallery/:id/photo/:filename` | — | Serve photo; `?thumb=1` for 400px thumbnail |
| `GET` | `/api/gallery/:id/download` | — | Stream photos as ZIP (403 if downloads disabled) |
| `GET` | `/api/gallery/:id/download/:filename` | — | Download single photo (403 if downloads disabled) |
| `GET` | `/api/gallery/:id/background` | — | Serve background image |
| `GET` | `/api/gallery/:id/og-image` | — | Serve/generate 1200×630 OG image |
| `POST` | `/api/gallery/:id/favorites` | — | Toggle a photo favorite for a visitor |
| `GET` | `/api/gallery/:id/favorites-public` | — | Get this visitor's favorites (`?visitorId=`) |
| `GET` | `/api/gallery/:id/favorites` | ✓ | List all favorites sorted by vote count |
| `DELETE` | `/api/gallery/:id/favorites` | ✓ | Reset all favorites for a gallery |
| `GET` | `/api/galleries` | ✓ | List all galleries |
| `DELETE` | `/api/gallery/:id` | ✓ | Delete gallery + all associated files |
| `GET` | `/api/logo` | — | Serve logo (custom if present, default otherwise) |
| `POST` | `/api/logo` | ✓ | Upload custom logo |
| `DELETE` | `/api/logo` | ✓ | Reset logo to default |

---

## Frontend Architecture

All HTML files are standalone — no bundler, no imports, all JavaScript is inline in a `<script>` tag at the bottom of the file.

### `public/admin.html`

A single-page application with two states: **login screen** and **main dashboard**.

- On load, checks `sessionStorage` for a saved password and skips the login screen if found.
- Login calls `POST /api/auth/verify`; on success stores the password in `sessionStorage` and shows the dashboard.
- All subsequent API calls attach the password via `X-Admin-Password` header.
- Drag-and-drop zone supports individual files and recursive folder traversal via the `webkitGetAsEntry` / `FileSystemDirectoryReader` API.
- Gallery creation is a two-step fetch: `POST /api/gallery/create` (photos), then `POST /api/gallery/:id/background` (background, if any).
- Each gallery card shows: cover image (drag-to-replace), inline rename, download toggle, favorite count with View/Reset actions.
- The favorites modal displays thumbnails sorted by vote count descending, with a ♥ N badge on each.
- Event names are always HTML-escaped before DOM insertion via `escapeHtml()`.

### `public/customer.html`

Minimal download page. No authentication required.

- Extracts gallery ID from URL path.
- Calls `GET /api/gallery/:id/info` to get event name, photo count, background URL, and `downloadsEnabled`.
- Download button is hidden when `downloadsEnabled` is false.
- Background image fades in with a CSS transition once loaded.
- Right-click on images is disabled to prevent casual saving.

### `public/preview.html`

Full photo browser. No authentication required.

- Thumbnail grid with lazy loading via `IntersectionObserver`.
- Full-screen lightbox with keyboard navigation (←/→/Esc) and touch swipe support.
- Lightbox top-right corner: ✕ close, download button (round), heart button (round) — all three always visible.
- Download buttons (grid + lightbox) are hidden when `downloadsEnabled` is false.
- Right-click on images is disabled to prevent casual saving.
- Each visitor gets a stable anonymous ID stored in `localStorage` as `delyvr_visitor_id`.
- On load, fetches `GET /favorites-public?visitorId=` to restore heart button state.
- Favorites are toggled optimistically with server sync and automatic UI revert on network error.
- If `/favorites-public` returns 404 (gallery deleted), `delyvr_visitor_id` is cleaned from localStorage.

---

## Conventions and Gotchas

- **No build step.** Do not introduce a bundler, TypeScript, or a frontend framework without discussing it first. The simplicity is intentional.
- **No external database.** Gallery metadata lives in `galleries.json`. If you need a database, that is a significant architectural change.
- **`downloadsEnabled` defaults to `true`.** The check is `gallery.downloadsEnabled !== false` — missing field means enabled. Existing galleries without this field work correctly without migration.
- **`favorites` defaults to `{}`.** Similarly, `gallery.favorites || {}` is used everywhere. No migration needed for existing galleries.
- **Visitor IDs are not authenticated.** They are random strings generated client-side. They identify a browser session, not a real user. Do not use them for anything security-sensitive.
- **multer file size limits are configurable via env.** `MAX_UPLOAD_MB` applies to photos; `MAX_BACKGROUND_MB` applies to backgrounds. Nginx `client_max_body_size` must be set high enough to match.
- **INSTALL_DIR decouples code from data.** All filesystem paths in `server.js` use `process.env.INSTALL_DIR || __dirname`. Bare-metal installs work with no value set.
- **Backgrounds are normalised on upload.** sharp converts them to JPEG at max 2400px wide, quality 85. The original format is discarded.
- **Backgrounds replace on upload.** Uploading a new background deletes the old file from disk and invalidates the OG cache.
- **Galleries can be re-discovered from disk.** Do not assume the in-memory Map is the source of truth for what galleries exist; the filesystem is authoritative.
- **Password in sessionStorage.** The admin password is stored in `sessionStorage` (cleared when the tab closes), not `localStorage`. This is intentional — it limits exposure on shared computers.