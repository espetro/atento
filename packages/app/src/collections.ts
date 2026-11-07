/**
 * Collections use cases (M2): token-efficient output for agents.
 *
 * Three mechanisms, all backed by the `link_events` cursor:
 *   1. `collectionsSummary` — counts per collection plus the per-host
 *      breakdown of `needs_login` (one line per host to log into).
 *   2. `collectionRead` — inline paginated reads (<= 50 rows by default)
 *      with a `fields` projection and `format=tsv` (~40% fewer tokens).
 *      `since=<cursor>` returns only links changed after it.
 *   3. `collectionExport` — the same data written to
 *      `<exportsDir>/<name>-<cursor>.<ext>`; returns a path plus a
 *      `linkinbox://exports/...` resource_link uri clients read lazily.
 *
 * The cursor is the `link_events.id` high-water mark: monotonic, already
 * written by every FSM transition (and by the INGESTED marker rows the
 * durable ingest commits). Delta reads therefore see ingests, transitions
 * and triage actions; a link that never changed simply is not "new".
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  COLLECTION_NAMES,
  collectionOfLink,
  isCollectionName,
  LINK_STATES,
  hostOfUrl,
  type CollectionName,
  type Link,
  type Store,
} from '@linkinbox/core'

/** Fields a collection row can project. `summary` is derived: the
 * enrichment's why_it_matters truncated to 200 chars. */
export const COLLECTION_FIELDS = [
  'id',
  'url',
  'url_hash',
  'title',
  'source',
  'added_at',
  'note',
  'tags',
  'category',
  'priority',
  'action',
  'confidence',
  'read_minutes',
  'status',
  'state',
  'reason',
  'needs_browser',
  'expires_at',
  'expiry_reason',
  'why_it_matters',
  'summary',
  'created_at',
  'updated_at',
] as const

export type CollectionField = (typeof COLLECTION_FIELDS)[number]

/** The default projection: identity + triage fields + a 200-char summary. */
export const DEFAULT_COLLECTION_FIELDS: CollectionField[] = [
  'id',
  'url',
  'title',
  'category',
  'priority',
  'summary',
]

/** Inline reads are paginated: 50 rows by default, 200 hard cap. */
export const COLLECTION_READ_DEFAULT_LIMIT = 50
export const COLLECTION_READ_MAX_LIMIT = 200

export type CollectionReadFormat = 'json' | 'tsv'
export type CollectionExportFormat = 'jsonl' | 'md' | 'tsv'

export interface CollectionsSummary {
  total: number
  collections: Record<CollectionName, number>
  /** One entry per host parked on a login wall, for `linkinbox login`. */
  needsLoginHosts: { host: string; count: number }[]
}

export interface CollectionReadResult {
  collection: CollectionName
  /** The cursor to store for the next delta read. */
  cursor: number
  /** Rows in this page. */
  count: number
  /** Rows matching the collection (before pagination). */
  total: number
  hasMore: boolean
  rows: Record<string, unknown>[]
}

export interface CollectionExportResult {
  collection: CollectionName
  path: string
  /** MCP resource_link uri: linkinbox://exports/<file>. */
  uri: string
  count: number
  bytes: number
  cursor: number
  format: CollectionExportFormat
}

function iso(d: Date | null): string | null {
  return d === null ? null : d.toISOString()
}

function stateReason(link: Link): string | null {
  const data = link.stateData
  if (!data) return null
  const reason = data['reason']
  return typeof reason === 'string' ? reason : null
}

function whyItMatters(link: Link): string | null {
  const enrichment = link.enrichment as Record<string, unknown> | null
  const value = enrichment?.['why_it_matters']
  return typeof value === 'string' ? value : null
}

/** Project one link onto the requested collection fields. */
export function projectCollectionRow(
  link: Link,
  fields: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const field of fields) {
    switch (field) {
      case 'id': out.id = link.id; break
      case 'url': out.url = link.url; break
      case 'url_hash': out.url_hash = link.urlHash; break
      case 'title': out.title = link.title; break
      case 'source': out.source = link.source; break
      case 'added_at': out.added_at = iso(link.addedAt); break
      case 'note': out.note = link.note; break
      case 'tags': out.tags = link.tags; break
      case 'category': out.category = link.category; break
      case 'priority': out.priority = link.priority; break
      case 'action': out.action = link.action; break
      case 'confidence': out.confidence = link.confidence; break
      case 'read_minutes': out.read_minutes = link.readMinutes; break
      case 'status': out.status = link.status; break
      case 'state': out.state = link.state; break
      case 'reason': out.reason = stateReason(link); break
      case 'needs_browser': out.needs_browser = link.needsBrowser; break
      case 'expires_at': out.expires_at = iso(link.expiresAt); break
      case 'expiry_reason': out.expiry_reason = link.expiryReason; break
      case 'why_it_matters': out.why_it_matters = whyItMatters(link); break
      case 'summary': {
        const summary = whyItMatters(link)
        out.summary = summary === null ? null : summary.slice(0, 200)
        break
      }
      case 'created_at': out.created_at = iso(link.createdAt); break
      case 'updated_at': out.updated_at = iso(link.updatedAt); break
      default: break // unknown field names are dropped, never fabricated
    }
  }
  return out
}

/** Every link that is not deleted, for full-collection scans. */
async function allLiveLinks(store: Store): Promise<Link[]> {
  return store.listByStates(LINK_STATES.filter((s) => s !== 'deleted'))
}

/** Links currently belonging to one collection, ordered by id. */
async function collectionLinks(store: Store, name: CollectionName): Promise<Link[]> {
  const links = await allLiveLinks(store)
  return links.filter((l) => collectionOfLink(l) === name).sort((a, b) => a.id - b.id)
}

/** Counts per collection plus the needs_login per-host breakdown. */
export async function collectionsSummary(store: Store): Promise<CollectionsSummary> {
  const collections = Object.fromEntries(COLLECTION_NAMES.map((n) => [n, 0])) as Record<
    CollectionName,
    number
  >
  const loginHosts = new Map<string, number>()
  let total = 0
  for (const link of await allLiveLinks(store)) {
    const name = collectionOfLink(link)
    if (name === null) continue
    total += 1
    collections[name] += 1
    if (name === 'needs_login') {
      const host = hostOfUrl(link.url)
      loginHosts.set(host, (loginHosts.get(host) ?? 0) + 1)
    }
  }
  const needsLoginHosts = [...loginHosts.entries()]
    .map(([host, count]) => ({ host, count }))
    .sort((a, b) => b.count - a.count || a.host.localeCompare(b.host))
  return { total, collections, needsLoginHosts }
}

export interface CollectionReadOptions {
  /** Delta cursor: only links with link_events.id > since. */
  since?: number
  limit?: number
  offset?: number
  fields?: readonly string[]
}

/** Inline paginated read of one collection. */
export async function collectionRead(
  store: Store,
  name: CollectionName,
  options: CollectionReadOptions = {},
): Promise<CollectionReadResult> {
  const limit = Math.min(
    Math.max(1, options.limit ?? COLLECTION_READ_DEFAULT_LIMIT),
    COLLECTION_READ_MAX_LIMIT,
  )
  const offset = Math.max(0, options.offset ?? 0)
  const fields = options.fields ?? DEFAULT_COLLECTION_FIELDS

  let matched: Link[]
  if (options.since !== undefined) {
    const changed = await store.listChangedLinks(options.since)
    matched = changed.filter((l) => collectionOfLink(l) === name)
  } else {
    matched = await collectionLinks(store, name)
  }
  matched.sort((a, b) => a.id - b.id)

  const page = matched.slice(offset, offset + limit)
  const hasMore = offset + limit < matched.length
  // The cursor only advances once the caller has consumed the whole delta;
  // a truncated page hands back the same `since` so nothing is skipped.
  const cursor =
    options.since !== undefined && hasMore ? options.since : await store.linkEventCursor()
  return {
    collection: name,
    cursor,
    count: page.length,
    total: matched.length,
    hasMore,
    rows: page.map((l) => projectCollectionRow(l, fields)),
  }
}

/** Serialize projected rows to one of the export formats. */
export function serializeCollection(
  rows: Record<string, unknown>[],
  fields: readonly string[],
  format: CollectionExportFormat,
): string {
  // Rows arrive already projected, but enforce the field list anyway so a
  // caller passing raw rows cannot leak unrequested columns.
  const projected = rows.map((r) => {
    const out: Record<string, unknown> = {}
    for (const f of fields) out[f] = r[f]
    return out
  })
  if (format === 'jsonl') {
    return projected.map((r) => JSON.stringify(r)).join('\n') + (projected.length > 0 ? '\n' : '')
  }
  if (format === 'tsv') {
    const esc = (v: unknown): string =>
      v === null || v === undefined
        ? ''
        : String(Array.isArray(v) ? v.join(',') : v).replace(/[\t\n\r]/g, ' ')
    const lines = [fields.join('\t')]
    for (const row of projected) lines.push(fields.map((f) => esc(row[f])).join('\t'))
    return lines.join('\n') + '\n'
  }
  // markdown: a pipe table, one row per link.
  const escMd = (v: unknown): string =>
    v === null || v === undefined
      ? ''
      : String(Array.isArray(v) ? v.join(', ') : v).replace(/\|/g, '\\|').replace(/\n/g, ' ')
  const header = `| ${fields.join(' | ')} |`
  const sep = `| ${fields.map(() => '---').join(' | ')} |`
  const body = projected.map((r) => `| ${fields.map((f) => escMd(r[f])).join(' | ')} |`)
  return [header, sep, ...body].join('\n') + '\n'
}

export interface CollectionExportOptions {
  since?: number
  fields?: readonly string[]
  format?: CollectionExportFormat
  /** Export root; default <config dir>/exports resolved by the caller. */
  exportsDir: string
}

const EXPORT_EXT: Record<CollectionExportFormat, string> = {
  jsonl: 'jsonl',
  md: 'md',
  tsv: 'tsv',
}

/**
 * Write one collection (optionally a delta) to
 * `<exportsDir>/<name>-<cursor>.<ext>` and return the handle. The `uri` is
 * the MCP resource_link a client reads lazily instead of pulling rows.
 */
export async function collectionExport(
  store: Store,
  name: CollectionName,
  options: CollectionExportOptions,
): Promise<CollectionExportResult> {
  const format = options.format ?? 'jsonl'
  const fields = options.fields ?? DEFAULT_COLLECTION_FIELDS
  let matched: Link[]
  if (options.since !== undefined) {
    const changed = await store.listChangedLinks(options.since)
    matched = changed.filter((l) => collectionOfLink(l) === name)
  } else {
    matched = await collectionLinks(store, name)
  }
  matched.sort((a, b) => a.id - b.id)
  const rows = matched.map((l) => projectCollectionRow(l, fields))
  const body = serializeCollection(rows, fields, format)
  const bytes = Buffer.byteLength(body, 'utf8')

  const cursor = await store.linkEventCursor()
  const file = `${name}-${cursor}.${EXPORT_EXT[format]}`
  await mkdir(options.exportsDir, { recursive: true })
  const path = join(options.exportsDir, file)
  await writeFile(path, body, 'utf8')
  return {
    collection: name,
    path,
    uri: `linkinbox://exports/${file}`,
    count: rows.length,
    bytes,
    cursor,
    format,
  }
}

export { isCollectionName, COLLECTION_NAMES }
export type { CollectionName }
