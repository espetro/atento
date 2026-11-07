/**
 * The bulk-ingest input contract (M2).
 *
 * One use case — `ingestInput` — sits behind the CLI, the MCP tools and the
 * HTTP API. Every kind resolves to RawLinks, which are spooled through the
 * durable `ingest_jobs` mechanism (`createSpooledIngestJob` +
 * `runIngestJob`), so a crash resumes from the cursor and url_hash dedupe
 * makes replays safe.
 *
 * The result is a job summary only: `{ jobId, accepted, duplicates,
 * rejected, status }`. Link payloads are never echoed back — that is the
 * token-efficiency contract for agents.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, join } from 'node:path'
import {
  createSpooledIngestJob,
  runIngestJob,
  type BusyRun,
  type IngestJob,
  type IngestJobStatus,
  type PipelineLogger,
  type RawLink,
  type Store,
} from '@linkinbox/core'
import {
  importFile,
  parseJsonLinks,
  parseMarkdown,
  parseUrlList,
  URL_LIST_SOURCE,
  MARKDOWN_SOURCE,
  JSON_SOURCE,
} from '@linkinbox/importers'

/** The ingest input kinds, shared by CLI, MCP and HTTP. */
export type IngestInput =
  | { kind: 'file'; path: string }
  | { kind: 'text'; text: string }
  | { kind: 'urls'; urls: string[]; note?: string; tags?: string[] }
  | { kind: 'remote'; url: string }

/** Hard cap on urls per `ingest_urls` call; larger lists go through a file. */
export const INGEST_URLS_MAX = 500

/** Remote fetch limits: a gist/raw file is small; anything bigger is a mistake. */
export const INGEST_REMOTE_MAX_BYTES = 10 * 1024 * 1024
export const INGEST_REMOTE_TIMEOUT_MS = 30_000

/** What every adapter gets back: progress, never payloads. */
export interface IngestJobSummary {
  jobId: string
  /** Items committed successfully (includes duplicates). */
  accepted: number
  /** Items that collapsed onto an already-known url_hash. */
  duplicates: number
  /** Items that failed normalization or the store write. */
  rejected: number
  /** Final job status; 'busy' when another run holds the ingest lock. */
  status: IngestJobStatus | 'busy'
  /** Non-fatal parser/importer warnings. */
  warnings: string[]
  /** Set when status is 'busy': the run holding the ingest lock. */
  busy?: BusyRun
}

/** The `ingest_status` view of one job row. */
export interface IngestStatus {
  jobId: string
  source: string
  status: IngestJobStatus
  total: number
  done: number
  cursor: number
  runId: number | null
  error: string | null
  createdAt: Date
  updatedAt: Date
  finishedAt: Date | null
}

export function ingestStatusOf(job: IngestJob): IngestStatus {
  return {
    jobId: job.id,
    source: job.source,
    status: job.status,
    total: job.total,
    done: job.done,
    cursor: job.cursor,
    runId: job.runId,
    error: job.error,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    finishedAt: job.finishedAt,
  }
}

interface ParsedInput {
  raws: RawLink[]
  warnings: string[]
  /** ingest_jobs.source identity for this input kind. */
  source: string
}

/** Parse `ingest_text`: markdown links plus bare url-list lines, deduped. */
export function parseIngestText(text: string): ParsedInput {
  const warnings: string[] = []
  const seen = new Set<string>()
  const raws: RawLink[] = []
  const push = (link: RawLink) => {
    const key = link.url.trim()
    if (key === '' || seen.has(key)) return
    seen.add(key)
    raws.push(link)
  }
  const md = parseMarkdown(text)
  warnings.push(...md.warnings)
  for (const link of md.links) push(link)
  const ul = parseUrlList(text)
  warnings.push(...ul.warnings)
  for (const link of ul.links) push({ ...link, source: 'ingest-text' })
  if (raws.length === 0) warnings.push('No links found in text.')
  return { raws, warnings, source: 'ingest:text' }
}

/** Parse `ingest_urls`: a plain array, capped at INGEST_URLS_MAX. */
export function parseIngestUrls(
  urls: string[],
  extras: { note?: string; tags?: string[] } = {},
): ParsedInput {
  if (urls.length > INGEST_URLS_MAX) {
    throw new Error(
      `ingest_urls accepts at most ${INGEST_URLS_MAX} urls per call; ` +
        'put larger lists in a file and use ingest_file',
    )
  }
  const raws: RawLink[] = urls.map((url) => ({
    url: url.trim(),
    source: 'ingest:urls',
    ...(extras.note !== undefined ? { note: extras.note } : {}),
    ...(extras.tags !== undefined ? { tags: extras.tags } : {}),
  }))
  return { raws, warnings: [], source: 'ingest:urls' }
}

/** Extension hint for a remote URL, used to pick the importer. */
function remoteHint(url: string): string {
  try {
    return new URL(url).pathname
  } catch {
    return url
  }
}

/**
 * Parse `ingest_remote`: fetch the URL, then run the same importer a local
 * file of that name would get. The payload lands in a temp file so every
 * importer (including the Safari plist reader) works unchanged.
 */
export async function parseIngestRemote(url: string): Promise<ParsedInput> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), INGEST_REMOTE_TIMEOUT_MS)
  let response: Response
  try {
    response = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'user-agent': 'linkinbox-ingest/1.0' },
    })
  } catch (err) {
    throw new Error(
      `ingest_remote could not fetch ${url}: ${err instanceof Error ? err.message : String(err)}`,
    )
  } finally {
    clearTimeout(timer)
  }
  if (!response.ok) {
    throw new Error(`ingest_remote fetch of ${url} failed: HTTP ${response.status}`)
  }
  const buf = Buffer.from(await response.arrayBuffer())
  if (buf.byteLength > INGEST_REMOTE_MAX_BYTES) {
    throw new Error(
      `ingest_remote payload exceeds ${INGEST_REMOTE_MAX_BYTES} bytes; use ingest_file instead`,
    )
  }
  const dir = await mkdtemp(join(tmpdir(), 'linkinbox-ingest-'))
  try {
    const hint = remoteHint(url)
    const ext = extname(hint)
    const file = join(dir, `remote${ext === '' ? '.txt' : ext}`)
    await writeFile(file, buf)
    const result = await importFile(file)
    return {
      raws: result.links,
      warnings: result.warnings,
      source: `ingest:remote:${result.importer}`,
    }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

/** Resolve one IngestInput to RawLinks. Never echoes links back. */
export async function parseIngestInput(input: IngestInput): Promise<ParsedInput> {
  switch (input.kind) {
    case 'file': {
      const result = await importFile(input.path)
      return {
        raws: result.links,
        warnings: result.warnings,
        source: `ingest:file:${result.importer}`,
      }
    }
    case 'text':
      return parseIngestText(input.text)
    case 'urls':
      return parseIngestUrls(input.urls, {
        ...(input.note !== undefined ? { note: input.note } : {}),
        ...(input.tags !== undefined ? { tags: input.tags } : {}),
      })
    case 'remote':
      return parseIngestRemote(input.url)
  }
}

export interface RunIngestInputOptions {
  spoolDir: string
  logger?: PipelineLogger
  now?: () => Date
}

/**
 * The `app.ingest` use case: parse the input, spool it as an ingest job and
 * run the job to completion (or report busy). Always durable — the spool is
 * what makes bulk ingest crash-safe.
 */
export async function runIngestInput(
  store: Store,
  input: IngestInput,
  options: RunIngestInputOptions,
): Promise<IngestJobSummary> {
  const parsed = await parseIngestInput(input)
  const job = await createSpooledIngestJob(store, {
    source: parsed.source,
    spoolDir: options.spoolDir,
    links: parsed.raws,
    ...(options.now ? { now: options.now } : {}),
  })
  const result = await runIngestJob(store, job.id, {
    ...(options.logger ? { logger: options.logger } : {}),
    ...(options.now ? { now: options.now } : {}),
  })
  if (result.busy) {
    return {
      jobId: job.id,
      accepted: 0,
      duplicates: 0,
      rejected: 0,
      status: 'busy',
      warnings: parsed.warnings,
      busy: result.busy,
    }
  }
  return {
    jobId: job.id,
    accepted: result.okCount,
    duplicates: result.duplicates,
    rejected: result.errorCount,
    status: result.job.status,
    warnings: parsed.warnings,
  }
}

// Re-exported so adapters can name the importer sources without importing
// @linkinbox/importers themselves.
export { MARKDOWN_SOURCE, URL_LIST_SOURCE, JSON_SOURCE }
