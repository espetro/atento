# Offline cache: favicons and last render

Goal: favicons and the last render of every link keep showing with no network.

## Decision: filesystem blobs, metadata stays in SQLite

Stored under the config dir (`~/.linkinbox`), next to `links.db`:

- `favicons/<host>.bin` + `<host>.json` (content type, fetchedAt), `<host>.none` negative cache.
- `pages/<sha1(url)>.html`: last good render, scripts/handlers/iframes stripped, `<base>` pinned to the final URL.

Served by `GET /api/favicon/:host` and `GET /api/links/:id/render` (CSP `default-src 'none'; sandbox`; the UI frame is also `sandbox=""`).

## Why not SQLite

- Size: a rendered page is 50 KB to 3 MB. Thousands of links means hundreds of MB; `links.db` is 8 MB today and is copied for backups, snapshotted for migrations and held in WAL.
- Churn: every re-extract rewrites a blob, inflating WAL and needing `VACUUM` to reclaim space.
- Access pattern: blobs are written once and read whole, never queried. FS gives sendfile, gzip-at-rest, per-file TTL prune and trivial `rm` eviction.
- Keying by URL hash dedupes links that share a URL and survives link-id changes.

## Why not S3-style

An object store only pays off with multi-device sync or a remote/headless deployment. Today the server is a local sidecar, so it adds credentials, a network dependency and failure modes with no gain. The cache sits behind `createSiteCache(dir)` (`packages/app/src/site-cache.ts`); swapping the backend for S3/R2 later means reimplementing three methods.

## Limits and follow-ups

- Renders are captured during extraction (the pipeline's raw HTML). Links extracted before this change have no render until re-extracted; a backfill command is not built yet.
- It is the server-fetched HTML, not a browser screenshot: styles/images load from the origin when online and degrade offline. A true offline-faithful capture (single-file inlining or a headless screenshot) is a follow-up.
- Favicons are fetched directly from the site (`/favicon.ico`, then `<link rel=icon>`), no third-party lookup. Hosts must be public DNS names (no IPs, localhost, `.local`).
- No size cap or LRU on `pages/` yet; prune by mtime when needed.

## Page snapshots (on open)

Opening a link while online calls `POST /api/links/:id/snapshot`. The server queues one capture at a time and skips links with a snapshot younger than 7 days.

Order: single-file-cli driving the installed Chrome (`LINKINBOX_CHROME` overrides the path), then monolith (`LINKINBOX_MONOLITH`, or next to the node binary), then the sanitized extract HTML saved at extract time.

The result is `pages/<sha1(url)>.snap.html`, one file with CSS, images and fonts inlined. Scripts are removed, so animations that need JS and interactivity are not preserved. Pages that need a login are captured as logged out. The render route serves it under a strict CSP with `sandbox`.

Favicons use http-cache-semantics for freshness (ttl clamped to 1 to 30 days) and conditional GETs (ETag, Last-Modified) when stale.

Deferred: replayweb.page/WACZ for true interactive replay.
