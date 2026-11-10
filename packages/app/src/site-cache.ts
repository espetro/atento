/**
 * Offline site cache on the filesystem: favicons per host and the last
 * rendered HTML per URL. Blobs live next to the DB (not in SQLite) so
 * links.db stays small and fast to back up; the DB keeps the metadata.
 *
 *   <dir>/favicons/<host>.bin + <host>.json   icon bytes + {contentType, fetchedAt}
 *   <dir>/favicons/<host>.none                negative cache (retry after a day)
 *   <dir>/pages/<sha1(url)>.html              last good render (scripts stripped)
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

const FAVICON_MAX_BYTES = 256 * 1024
const FAVICON_REFRESH_MS = 30 * 24 * 3600 * 1000
const FAVICON_RETRY_MS = 24 * 3600 * 1000
const FETCH_TIMEOUT_MS = 6000
const PAGE_MAX_BYTES = 3 * 1024 * 1024

export interface CachedFile {
  body: Buffer
  contentType: string
}

/** A public DNS name only: no IP literals, no localhost, no single labels. */
export function isCacheableHost(host: string): boolean {
  if (host.length > 253 || !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(host)) return false
  if (/^\d+(\.\d+)*$/.test(host)) return false
  return !/\.(local|localhost|internal|lan)$/i.test(host)
}

function urlKey(url: string): string {
  return createHash('sha1').update(url).digest('hex')
}

/** Strip active content and pin relative URLs to the page's origin. */
export function sanitizeRender(html: string, baseUrl: string): string {
  const stripped = html
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<noscript\b[\s\S]*?<\/noscript\s*>/gi, '')
    .replace(/<iframe\b[\s\S]*?<\/iframe\s*>/gi, '')
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
  const base = `<base href="${baseUrl.replace(/"/g, '&quot;')}"><meta name="referrer" content="no-referrer">`
  return /<head[^>]*>/i.test(stripped)
    ? stripped.replace(/<head[^>]*>/i, (m) => m + base)
    : base + stripped
}

async function timedFetch(url: string, init?: RequestInit): Promise<Response> {
  return fetch(url, { ...init, redirect: 'follow', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
}

async function fetchIcon(url: string): Promise<CachedFile | null> {
  const res = await timedFetch(url)
  if (!res.ok) return null
  const contentType = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase()
  const body = Buffer.from(await res.arrayBuffer())
  if (body.byteLength < 16 || body.byteLength > FAVICON_MAX_BYTES) return null
  if (contentType.startsWith('text/')) return null
  const type = contentType.startsWith('image/') ? contentType : url.endsWith('.ico') ? 'image/x-icon' : ''
  return type === '' ? null : { body, contentType: type }
}

async function discoverIconUrl(host: string): Promise<string | null> {
  const res = await timedFetch(`https://${host}/`)
  if (!res.ok) return null
  const html = (await res.text()).slice(0, 200_000)
  const tag = /<link\b[^>]*\brel=["'][^"']*\bicon\b[^"']*["'][^>]*>/i.exec(html)?.[0]
  const href = tag ? /\bhref=["']([^"']+)["']/i.exec(tag)?.[1] : undefined
  if (!href) return null
  try {
    return new URL(href, res.url || `https://${host}/`).toString()
  } catch {
    return null
  }
}

export interface SiteCache {
  favicon(host: string): Promise<CachedFile | null>
  saveRender(url: string, html: string, finalUrl?: string): Promise<void>
  readRender(url: string): Promise<CachedFile | null>
}

export function createSiteCache(dir: string): SiteCache {
  const faviconDir = join(dir, 'favicons')
  const pagesDir = join(dir, 'pages')

  async function readCachedIcon(host: string): Promise<{ file: CachedFile; fresh: boolean } | null> {
    try {
      const meta = JSON.parse(await readFile(join(faviconDir, `${host}.json`), 'utf8')) as {
        contentType: string
        fetchedAt: number
      }
      const body = await readFile(join(faviconDir, `${host}.bin`))
      return { file: { body, contentType: meta.contentType }, fresh: Date.now() - meta.fetchedAt < FAVICON_REFRESH_MS }
    } catch {
      return null
    }
  }

  return {
    async favicon(host) {
      host = host.toLowerCase()
      if (!isCacheableHost(host)) return null
      const cached = await readCachedIcon(host)
      if (cached?.fresh) return cached.file
      // Negative cache: skip the network for a day after a miss.
      if (!cached) {
        try {
          const s = await stat(join(faviconDir, `${host}.none`))
          if (Date.now() - s.mtimeMs < FAVICON_RETRY_MS) return null
        } catch { /* no negative entry */ }
      }
      let icon: CachedFile | null = null
      try {
        icon = await fetchIcon(`https://${host}/favicon.ico`)
        if (!icon) {
          const found = await discoverIconUrl(host)
          if (found) icon = await fetchIcon(found)
        }
      } catch {
        // Offline or host down: serve the stale copy when there is one.
        return cached?.file ?? null
      }
      await mkdir(faviconDir, { recursive: true })
      if (!icon) {
        if (cached) return cached.file
        await writeFile(join(faviconDir, `${host}.none`), '')
        return null
      }
      await writeFile(join(faviconDir, `${host}.bin`), icon.body)
      await writeFile(
        join(faviconDir, `${host}.json`),
        JSON.stringify({ contentType: icon.contentType, fetchedAt: Date.now() }),
      )
      return icon
    },

    async saveRender(url, html, finalUrl) {
      if (html.trim() === '' || html.length > PAGE_MAX_BYTES) return
      await mkdir(pagesDir, { recursive: true })
      await writeFile(join(pagesDir, `${urlKey(url)}.html`), sanitizeRender(html, finalUrl ?? url), 'utf8')
    },

    async readRender(url) {
      try {
        return {
          body: await readFile(join(pagesDir, `${urlKey(url)}.html`)),
          contentType: 'text/html; charset=utf-8',
        }
      } catch {
        return null
      }
    },
  }
}
