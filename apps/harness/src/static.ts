/**
 * Static serving for the built web UI, mounted by the harness AFTER the
 * api/mcp/openapi/capture routes so API paths always win. Implements the
 * contract apps/web must satisfy:
 *
 *  - GET/HEAD only; everything else falls through to the api 404.
 *  - Exact file → 200 with a content-type map; directory/miss → index.html
 *    (SPA fallback) for navigation requests.
 *  - Content-hashed assets (Vite/SvelteKit `name-<hash>.js`) get
 *    `cache-control: public, max-age=31536000, immutable`; everything else
 *    is `no-cache` so deploys are picked up immediately.
 *  - Path traversal is rejected by resolving under the web root.
 *  - When no build output exists (apps/web not built yet) a placeholder
 *    page is served instead of an error — the harness never blocks on M4b.
 */
import { existsSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'
import type { MiddlewareHandler } from 'hono'

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
}

/**
 * Paths owned by the api/mcp/capture surface — never served statically.
 * Segment-boundary matching: `/api` and `/api/...` are reserved but
 * `/apiary` is not; same for `/capture`, `/mcp`, `/openapi.json`.
 */
function isReserved(path: string): boolean {
  return (
    path === '/api' ||
    path.startsWith('/api/') ||
    path === '/capture' ||
    path.startsWith('/capture/') ||
    path === '/mcp' ||
    path.startsWith('/mcp/') ||
    path === '/openapi.json'
  )
}

/**
 * Hashed-asset heuristic: bundlers emit `name-<8+ char hash>.<ext>` (Vite)
 * or `name.<hash>.<ext>` (SvelteKit). Either way the basename carries a
 * long opaque segment, which is what makes immutable caching safe.
 */
const HASHED_RE = /[-.][A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$/

function cacheControlFor(relPath: string): string {
  const base = relPath.split('/').pop() ?? relPath
  if (HASHED_RE.test(base)) return 'public, max-age=31536000, immutable'
  return 'no-cache'
}

const PLACEHOLDER_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>linkinbox</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 4rem auto; max-width: 40rem;
         padding: 0 1rem; color: #1a1a1a; }
  code { background: #f0f0f0; padding: 0.1em 0.3em; border-radius: 4px; }
</style>
</head>
<body>
<h1>linkinbox</h1>
<p>The web UI has not been built yet. The API is live — use the CLI,
MCP endpoint (<code>/mcp</code>) or <a href="/openapi.json">OpenAPI doc</a>.</p>
<p>To build the UI: <code>pnpm --filter @linkinbox/web build</code>, or point
<code>web_dir</code> in <code>harness.toml</code> at an existing build.</p>
</body>
</html>
`

export interface StaticServerOptions {
  /**
   * Directory containing index.html, or null when no build output exists —
   * every non-reserved GET then serves the placeholder page.
   */
  webDir: string | null
}

interface Resolved {
  body: Uint8Array
  contentType: string
  cacheControl: string
}

async function readUnder(
  root: string,
  urlPath: string,
): Promise<{ abs: string; isDir: boolean } | null> {
  let rel: string
  try {
    rel = decodeURIComponent(urlPath)
  } catch {
    return null
  }
  rel = rel.replace(/^\/+/, '')
  const abs = resolve(root, rel)
  // Traversal guard: the resolved path must stay inside root.
  if (abs !== root && !abs.startsWith(root + sep)) return null
  try {
    const s = await stat(abs)
    return { abs, isDir: s.isDirectory() }
  } catch {
    return null
  }
}

async function readFileResolved(root: string, urlPath: string): Promise<Resolved | null> {
  const found = await readUnder(root, urlPath)
  if (found === null || found.isDir) return null
  try {
    const body = await readFile(found.abs)
    return {
      body: new Uint8Array(body.buffer, body.byteOffset, body.byteLength),
      contentType: CONTENT_TYPES[extname(found.abs).toLowerCase()] ?? 'application/octet-stream',
      cacheControl: cacheControlFor(found.abs.slice(root.length)),
    }
  } catch {
    return null
  }
}

function respond(resolved: Resolved, method: string): Response {
  const headers = new Headers({
    'content-type': resolved.contentType,
    'cache-control': resolved.cacheControl,
    'content-length': String(resolved.body.byteLength),
  })
  if (method === 'HEAD') return new Response(null, { headers })
  // Copy into a fresh ArrayBuffer-backed view for the Response body.
  const copy = resolved.body.slice().buffer as ArrayBuffer
  return new Response(copy, { headers })
}

function placeholder(): Response {
  const body = new TextEncoder().encode(PLACEHOLDER_HTML)
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-cache',
      'content-length': String(body.byteLength),
    },
  })
}

/**
 * The harness's static middleware. Mount AFTER createApp so api routes win;
 * it only sees requests no api route claimed.
 */
export function createStaticMiddleware(options: StaticServerOptions): MiddlewareHandler {
  const webDir = options.webDir !== null && existsSync(resolve(options.webDir, 'index.html'))
    ? resolve(options.webDir)
    : null

  return async (c, next) => {
    const path = c.req.path
    if (isReserved(path)) return next()
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') return next()

    // No build output: serve the placeholder for every page request.
    if (webDir === null) return placeholder()

    // Exact file hit (assets, favicon, deep links into real files).
    const file = await readFileResolved(webDir, path)
    if (file !== null) return respond(file, c.req.method)

    // SPA fallback: any other GET serves index.html so client-side routes
    // like /links/123 resolve. Only for paths that look like pages — asset
    // misses (paths with a file extension) get a real 404 via next().
    const last = path.split('/').pop() ?? ''
    if (!last.includes('.')) {
      const index = await readFileResolved(webDir, '/index.html')
      if (index !== null) return respond(index, c.req.method)
    }
    return next()
  }
}
