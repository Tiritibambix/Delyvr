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
    └── settings.json   # Site-wide settings (theme + social links) — created automatically
```

---

## Configuration

| Variable | Default | Notes |
|----------|---------|-------|
| `ADMIN_PASSWORD` | *(none — must be set)* | Password for the admin dashboard |
| `PORT` | `3000` | TCP port the server listens on |
| `MAX_UPLOAD_MB` | `200` | Per-file size limit for photo uploads, in MB |
| `MAX_BACKGROUND_MB` | `20` | Size limit for background image uploads, in MB |
| `INSTALL_DIR` | *(project dir)* | Set to `/data` in Docker. Controls where all data files are written. |
| `TRUST_PROXY` | `0` | Set to `1` behind a reverse proxy for correct IP detection. |
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
  files: string[],          // filenames inside uploads/{id}/
  background: string|null,
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
  created: string,
  galleryIds: string[],     // ordered — order is the client display order
  background: string|null
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
  }
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
| `publicWriteLimiter` | 120 / min | `POST /favorites` |
| `downloadLimiter` | 10 / min | ZIP downloads |
| `adminLimiter` | 60 / min | Admin routes with filesystem access |

### Settings persistence

`loadSettings()` reads `settings.json` and merges with `SETTINGS_DEFAULTS`. `saveSettings(data)` writes the full object. Both are synchronous.

`GET /api/settings` is public — all client pages call it on load to apply the theme and render the social footer.

`POST /api/settings` is admin-only — accepts `{ theme, website, socials }` and saves the merged result.

`PATCH /api/settings/theme` and `POST /api/settings/theme` are both supported for backward compatibility with the existing admin toggle.

### Preview generation

1920px JPEG previews (`fit: inside`, quality 85) are generated via sharp:
- **On upload** — fire-and-forget via `generateGalleryPreviews`
- **On startup** — `setImmediate` scans all galleries for missing previews and generates them in the background after directory creation
- **On first request** — if still missing, the original is served immediately and generation is triggered in the background (non-blocking)

The lightbox uses `previewUrl`. Originals are only served on explicit download via `downloadUrl`.

### Masonry layout

`preview.html` uses native CSS `columns` for the photo grid — no JS column distribution. `break-inside: avoid` on `.photo-card` prevents images from being split across columns. Column count is controlled by CSS media queries (4/3/2/1). No resize re-render needed.

### Social footer

All client pages (`customer.html`, `preview.html`, `collection.html`) call `GET /api/settings` on load and render inline SVG icons for each non-empty social/website URL. The footer is hidden entirely if no links are configured.

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
| `GET` | `/api/gallery/:id/preview/:filename` | — | Serve 1920px preview (fallback to original) |
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
| `POST` | `/api/collection/:id/background` | ✓ | Upload/replace cover |
| `GET` | `/api/collection/:id/background` | — | Serve cover |
| `POST` | `/api/collection/:id/galleries` | ✓ | Add gallery |
| `PATCH` | `/api/collection/:id/galleries/reorder` | ✓ | Reorder galleries |
| `DELETE` | `/api/collection/:id/galleries/:galleryId` | ✓ | Remove gallery |
| `GET` | `/api/collection/:id/download` | — | ZIP all galleries |
| `DELETE` | `/api/collection/:id` | ✓ | Delete collection |

### Settings

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/settings` | — | Get site settings |
| `POST` | `/api/settings` | ✓ | Update theme, website, socials |
| `POST` | `/api/settings/theme` | ✓ | Update theme only (legacy) |
| `PATCH` | `/api/settings/theme` | ✓ | Update theme only (legacy) |

---

## Frontend Architecture

All HTML files are standalone — no bundler, no imports, all JS inline.

### `public/admin.html`

- Login via in-memory `adminPassword` variable only — not persisted to sessionStorage or localStorage.
- Password field has an eye toggle button (`.password-toggle`) to show/hide the password. The button is excluded from `.login-card button` styles via `:not(.password-toggle)`.
- `applyTheme()` called on load — fetches `/api/settings` and adds `class="light"` on `<html>` if needed.
- **Profile modal** — triggered by the "Profile" button (top-left of header). Loads current settings on open, saves via `POST /api/settings`. Contains website URL + 8 social network URL fields with inline SVG icons.
- Gallery grid uses `auto-fill, minmax(280px, 1fr)`. All gallery controls preserved: toggle, favorites, copy, delete, drag.
- `_galleriesData` cache populated in `loadGalleries()`, used by `renderCollections()` to show gallery names in pills.

### `public/customer.html`

- `html, body { height: 100%; overflow: hidden }` — page is fully fixed, no scroll possible on any screen size.
- Social footer is `position: fixed; bottom: 0` on mobile (≤600px) so it stays visible without scrolling.
- In light mode: background image opacity reduced to 0.60, white overlay at rgba(250,250,250,0.35), all text forced to `#000000`.
- `applyTheme()` and `renderSocialFooter()` called on load.

### `public/preview.html`

- Masonry uses CSS `columns` (4/3/2/1 via media queries). `break-inside: avoid` on `.photo-card`. No JS column distribution, no resize re-render.
- Lightbox preloads N-1 and N+1 previews via `new Image()` on each navigation step (`preloadAdjacentPreviews`).
- `applyTheme()` and `renderSocialFooter()` called on load.

### `public/collection.html`

- `applyTheme()` and `renderSocialFooter()` called on load.
- Full i18n: EN, FR, ES, PT, IT.

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
- **CSS columns masonry** — no JS needed for layout. Do not reintroduce JS column distribution.
- **Preview generation is non-blocking on request** — if a preview is missing, the original is served immediately and generation runs in the background. Never `await generatePreview` on a request path.
- **Password never stored in sessionStorage.** Kept in `adminPassword` JS variable only.
- **`?password` query param removed.** `requireAuth` only checks `X-Admin-Password` header.
- **Visitor IDs are not authenticated.** Random client-generated strings — not security-sensitive.
- **Gallery links are public by UUID.** No per-gallery password system. Document this to users.