/**
 * Bulk capture: turn a set of URLs (all tabs, a window, highlighted tabs,
 * a bookmarks tree) into /api/ingest batches.
 *
 * The wire contract is the existing one: POST /api/ingest with
 * `{ kind: "urls", urls: [...] }`, capped at 500 URLs per call server-side
 * (INGEST_URLS_MAX in packages/app). Larger selections are chunked into
 * ≤500-url batches, each its own queued item and its own ingest job.
 *
 * Every batch gets a deterministic idempotency key, so re-running the same
 * bulk capture (a retried context-menu click, a worker restart replay)
 * dedupes in the outbox instead of double-ingesting. The server's url_hash
 * dedupe is the second layer.
 *
 * Pure functions over plain shapes — the chrome.* calls live in
 * background.ts.
 */
import { decideCapture, DEFAULT_DENY_LIST, type DenyPattern } from './guard.js'

/** The server-side cap on urls per /api/ingest call. */
export const INGEST_BATCH_MAX = 500

/** The JSON body of one /api/ingest urls call. */
export interface IngestUrlsPayload {
  kind: 'urls'
  urls: string[]
  note?: string
  tags?: string[]
}

/** A queued ingest batch plus its dedupe key. */
export interface IngestBatch {
  idempotencyKey: string
  payload: IngestUrlsPayload
}

/** A minimal tab shape (chrome.tabs.Tab satisfies it). */
export interface BulkTab {
  url?: string | undefined
  incognito?: boolean | undefined
}

/** A minimal bookmark node shape (chrome.bookmarks.BookmarkTreeNode). */
export interface BookmarkNode {
  url?: string | undefined
  title?: string | undefined
  children?: BookmarkNode[] | undefined
}

/**
 * Deterministic 32-bit FNV-1a hash, hex-encoded. Enough for dedupe keys:
 * collisions only merge two identical-looking batches, which the server's
 * url_hash dedupe would collapse anyway.
 */
export function shortHash(input: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16)
}

/** The idempotency key for one capture payload. */
export function captureKey(url: string, capturedAt: string): string {
  return `capture:${url}:${capturedAt}`
}

/** The idempotency key for one ingest batch: stable for the same url set. */
export function ingestKey(urls: readonly string[]): string {
  return `ingest:${shortHash([...urls].sort().join('\n'))}`
}

/** Only real web URLs are ingestible; ftp:, chrome:, etc. are skipped. */
export function isHttpUrl(url: string): boolean {
  try {
    const protocol = new URL(url).protocol
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * URLs worth sending from a tab list: http(s) only, allowed by the deny
 * rules, deduped, order preserved. Private-window tabs are skipped — the
 * same rule as single capture.
 */
export function collectTabUrls(
  tabs: readonly BulkTab[],
  denyList: DenyPattern[] = DEFAULT_DENY_LIST,
): string[] {
  const seen = new Set<string>()
  const urls: string[] = []
  for (const tab of tabs) {
    const url = tab.url
    if (url === undefined || tab.incognito === true) continue
    if (seen.has(url)) continue
    if (!isHttpUrl(url)) continue
    if (!decideCapture(url, denyList).allowed) continue
    seen.add(url)
    urls.push(url)
  }
  return urls
}

/** Every http(s) URL in a bookmarks tree, deduped, depth-first. */
export function collectBookmarkUrls(nodes: readonly BookmarkNode[]): string[] {
  const seen = new Set<string>()
  const urls: string[] = []
  const walk = (node: BookmarkNode) => {
    if (
      node.url !== undefined &&
      node.url !== '' &&
      isHttpUrl(node.url) &&
      !seen.has(node.url)
    ) {
      seen.add(node.url)
      urls.push(node.url)
    }
    for (const child of node.children ?? []) walk(child)
  }
  for (const node of nodes) walk(node)
  return urls
}

/** Split a list into chunks of at most `size`. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size))
  }
  return out
}

/**
 * Build the ingest batches for a URL list: guard-filtered, deduped,
 * chunked at INGEST_BATCH_MAX, each with a stable idempotency key.
 */
export function buildIngestBatches(
  urls: readonly string[],
  options: {
    denyList?: DenyPattern[]
    note?: string
    tags?: string[]
    batchSize?: number
  } = {},
): IngestBatch[] {
  const denyList = options.denyList ?? DEFAULT_DENY_LIST
  const seen = new Set<string>()
  const clean: string[] = []
  for (const raw of urls) {
    const url = raw.trim()
    if (url === '' || seen.has(url)) continue
    if (!isHttpUrl(url)) continue
    if (!decideCapture(url, denyList).allowed) continue
    seen.add(url)
    clean.push(url)
  }
  const size = options.batchSize ?? INGEST_BATCH_MAX
  return chunk(clean, size).map((batch) => ({
    idempotencyKey: ingestKey(batch),
    payload: {
      kind: 'urls',
      urls: batch,
      ...(options.note !== undefined ? { note: options.note } : {}),
      ...(options.tags !== undefined ? { tags: options.tags } : {}),
    },
  }))
}
