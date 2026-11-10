/**
 * Durable ingest jobs.
 *
 * Bulk input is spooled to `<spoolDir>/<jobId>/input.jsonl` — one RawLink
 * JSON per line — and an `ingest_jobs` row tracks progress. The job's
 * `cursor` counts the spooled lines already committed; every chunk commit
 * (`Store.commitIngestChunk`) writes the links AND advances the cursor in
 * one transaction, so a crash can never leave links past the cursor.
 *
 * Resume: `runIngestJob` on a 'pending' or 'running' job re-acquires the
 * 'ingest' journal lock (crash recovery marks the dead run first) and
 * continues from `cursor`. url_hash dedupe makes replay of the committed
 * prefix a no-op, so even a cursor that somehow lagged would stay correct.
 *
 * Spool layout:
 *   <spoolDir>/<jobId>/input.jsonl   the bulk input, one RawLink per line
 *   <spoolDir>/<jobId>/meta.json     { source, createdAt }
 *
 * The spool root is caller-provided: the CLI passes `<config dir>/spool`
 * (i.e. ~/.atento/spool, honouring ATENTO_HOME / ATENTO_CONFIG_DIR).
 */
import { randomBytes } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Store, IngestChunkCommit } from '../store.js'
import type { IngestJob, RawLink } from '../types.js'
import {
  STAGES,
  noopLogger,
  type BusyRun,
  type LinkOutcome,
  type PipelineLogger,
} from './types.js'
import {
  busyRunOf,
  reclaimCrashedRuns,
  startRunHeartbeat,
  type RunJournalEntry,
} from '../run-journal.js'
import { writeFileAtomic } from '../fs-atomic.js'

/** Spool file names inside a job directory. */
export const INGEST_JOB_INPUT = 'input.jsonl'
export const INGEST_JOB_META = 'meta.json'

/** Default chunk size: links committed per transaction. */
export const INGEST_CHUNK_SIZE = 100

/** Job id: sortable-ish, filesystem-safe, unique. */
export function newIngestJobId(): string {
  return `job-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`
}

/** Serialize a RawLink to its spool line. Dates become ISO strings. */
export function serializeRawLink(raw: RawLink): string {
  return JSON.stringify({
    url: raw.url,
    ...(raw.title !== undefined ? { title: raw.title } : {}),
    ...(raw.addedAt !== undefined ? { addedAt: raw.addedAt.toISOString() } : {}),
    ...(raw.tags !== undefined ? { tags: raw.tags } : {}),
    ...(raw.note !== undefined ? { note: raw.note } : {}),
    source: raw.source,
  })
}

/** Parse one spool line back into a RawLink. Throws on malformed JSON. */
export function parseRawLinkLine(line: string): RawLink {
  const obj = JSON.parse(line) as Record<string, unknown>
  const out: RawLink = {
    url: String(obj['url'] ?? ''),
    source: typeof obj['source'] === 'string' ? obj['source'] : 'import',
  }
  if (typeof obj['title'] === 'string') out.title = obj['title']
  if (typeof obj['addedAt'] === 'string') out.addedAt = new Date(obj['addedAt'])
  if (Array.isArray(obj['tags'])) out.tags = obj['tags'] as string[]
  if (typeof obj['note'] === 'string') out.note = obj['note']
  return out
}

export interface CreateSpooledJobOptions {
  /** Importer/pipeline identity recorded on the job row. */
  source: string
  /** Spool root (e.g. <config dir>/spool). The job dir is <root>/<jobId>. */
  spoolDir: string
  /** Pre-parsed payload, written to input.jsonl before the job row exists. */
  links?: RawLink[]
  jobId?: string
  now?: () => Date
}

/**
 * Write the bulk input to the spool and insert the job row. Order matters:
 * the spooled payload exists on disk first, then the row — a crash between
 * the two leaves an orphaned spool dir (harmless) rather than a job
 * pointing at nothing.
 */
export async function createSpooledIngestJob(
  store: Store,
  options: CreateSpooledJobOptions,
): Promise<IngestJob> {
  const jobId = options.jobId ?? newIngestJobId()
  const dir = join(options.spoolDir, jobId)
  await mkdir(dir, { recursive: true })
  const now = options.now?.() ?? new Date()
  let total = 0
  if (options.links !== undefined) {
    const body =
      options.links.length > 0
        ? options.links.map(serializeRawLink).join('\n') + '\n'
        : ''
    await writeFileAtomic(join(dir, INGEST_JOB_INPUT), body)
    total = options.links.length
  }
  await writeFileAtomic(
    join(dir, INGEST_JOB_META),
    JSON.stringify({ source: options.source, createdAt: now.toISOString() }, null, 2),
  )
  return store.createIngestJob({
    id: jobId,
    source: options.source,
    spoolPath: dir,
    total,
  })
}

/** Read every spool line as RawLinks. Malformed lines become failing items. */
async function readSpoolLinks(path: string, source: string): Promise<RawLink[]> {
  const text = await readFile(path, 'utf8')
  const out: RawLink[] = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      out.push(parseRawLinkLine(line))
    } catch {
      // A torn/corrupt line still consumes a cursor slot: feed a raw that
      // fails normalization so the item is counted as an error, not dropped.
      out.push({ url: '', source })
    }
  }
  return out
}

export interface IngestJobRunOptions {
  /** Links committed per transaction. Default INGEST_CHUNK_SIZE (100). */
  chunkSize?: number
  now?: () => Date
  logger?: PipelineLogger
  /** Called after each committed chunk (cursor already advanced). */
  onChunk?: (commit: IngestChunkCommit) => void | Promise<void>
}

export interface IngestJobRunResult {
  job: IngestJob
  /** The journal run that processed (or holds) this invocation. */
  runId: number | null
  /** Set when another run holds the ingest lock: nothing was committed. */
  busy?: BusyRun
  /** Items committed during THIS invocation. */
  inputCount: number
  okCount: number
  errorCount: number
  duplicates: number
  inserted: number
  updated: number
  linkIds: number[]
  outcomes: LinkOutcome[]
  durationMs: number
}

function emptyJobResult(
  job: IngestJob,
  runId: number | null,
  startedAt: Date,
  now: () => Date,
): IngestJobRunResult {
  return {
    job,
    runId,
    inputCount: 0,
    okCount: 0,
    errorCount: 0,
    duplicates: 0,
    inserted: 0,
    updated: 0,
    linkIds: [],
    outcomes: [],
    durationMs: now().getTime() - startedAt.getTime(),
  }
}

/**
 * Run (or resume) one ingest job to completion. Holds the 'ingest'
 * single-writer lock for the whole pass; a second runner gets `busy`.
 * Safe to call on a 'done' job (no-op) and on 'pending'/'running'/'failed'
 * jobs (resumes from the cursor).
 */
export async function runIngestJob(
  store: Store,
  jobId: string,
  options: IngestJobRunOptions = {},
): Promise<IngestJobRunResult> {
  const logger = options.logger ?? noopLogger
  const now = options.now ?? (() => new Date())
  const startedAt = now()
  const chunkSize = options.chunkSize ?? INGEST_CHUNK_SIZE

  const initial = await store.getIngestJob(jobId)
  if (!initial) throw new Error(`ingest job ${jobId} does not exist`)
  // Idempotent: a finished job is a no-op and never takes the lock.
  if (initial.status === 'done') {
    return emptyJobResult(initial, initial.runId, startedAt, now)
  }

  // Crash recovery first: a dead ingest run must not hold the lock, and its
  // job row is still resumable from the cursor.
  await reclaimCrashedRuns(store, { now: startedAt })

  const acquired = await store.acquireRun(STAGES.ingest, {
    pid: process.pid,
    now: startedAt,
  })
  if (!acquired.ok) {
    return {
      ...emptyJobResult(initial, null, startedAt, now),
      busy: busyRunOf(acquired.busy),
    }
  }
  const journal: RunJournalEntry = acquired.run
  const stopHeartbeat = startRunHeartbeat(store, journal.id, now)
  try {
    return await ingestJobPass(store, jobId, journal, options, startedAt, now, logger, chunkSize)
  } catch (err) {
    await store
      .finishRun(journal.id, { finishedAt: now(), status: 'failed', errorCount: 1 })
      .catch(() => {})
    const message = err instanceof Error ? err.message : String(err)
    await store
      .updateIngestJob(jobId, { status: 'failed', error: message, updatedAt: now() })
      .catch(() => {})
    throw err
  } finally {
    stopHeartbeat()
  }
}

/** The job body, run while holding the ingest journal lock. */
async function ingestJobPass(
  store: Store,
  jobId: string,
  journal: RunJournalEntry,
  options: IngestJobRunOptions,
  startedAt: Date,
  now: () => Date,
  logger: PipelineLogger,
  chunkSize: number,
): Promise<IngestJobRunResult> {
  const job = await store.getIngestJob(jobId)
  if (!job) throw new Error(`ingest job ${jobId} does not exist`)

  // Safety: finished between the pre-check and the lock — close the run.
  if (job.status === 'done') {
    const finishedAt = now()
    await store.finishRun(journal.id, { finishedAt, okCount: 0, errorCount: 0 })
    return emptyJobResult(job, journal.id, startedAt, now)
  }

  if (job.spoolPath === null) {
    throw new Error(`ingest job ${jobId} has no spool payload`)
  }
  const links = await readSpoolLinks(join(job.spoolPath, INGEST_JOB_INPUT), job.source)
  if (job.total !== links.length) {
    await store.updateIngestJob(jobId, { total: links.length, updatedAt: now() })
    job.total = links.length
  }

  await store.updateIngestJob(jobId, {
    status: 'running',
    runId: journal.id,
    error: null,
    updatedAt: now(),
  })
  logger.info('ingest job {jobId} running: {done}/{total} committed', {
    jobId,
    done: job.done,
    total: job.total,
  })

  const linkIds: number[] = []
  const outcomes: LinkOutcome[] = []
  const errorsBySource = new Map<string, number>()
  let okCount = 0
  let errorCount = 0
  let duplicates = 0
  let inserted = 0
  let updated = 0
  let processed = 0

  // Resume exactly at the cursor: lines [0, cursor) are already committed.
  for (let offset = job.cursor; offset < links.length; offset += chunkSize) {
    const chunk = links.slice(offset, Math.min(offset + chunkSize, links.length))
    const commit = await store.commitIngestChunk(jobId, chunk, { now: now() })
    processed += commit.items.length
    inserted += commit.inserted
    updated += commit.updated
    for (const [i, item] of commit.items.entries()) {
      if (!item.ok) {
        errorCount += 1
        const source = chunk[i]?.source ?? job.source
        errorsBySource.set(source, (errorsBySource.get(source) ?? 0) + 1)
        outcomes.push({ linkId: -1, url: item.url, ok: false, error: item.error })
        logger.error('ingest failed for {url}: {error}', { url: item.url, error: item.error })
        continue
      }
      okCount += 1
      linkIds.push(item.linkId)
      if (item.duplicate) duplicates += 1
      logger.info('ingested {url} as link {linkId} (duplicate {duplicate})', {
        url: item.url,
        linkId: item.linkId,
        duplicate: item.duplicate,
      })
      outcomes.push({ linkId: item.linkId, url: item.url, ok: true })
    }
    await options.onChunk?.(commit)
  }

  const finishedAt = now()
  await store.updateIngestJob(jobId, {
    status: 'done',
    done: job.cursor + processed,
    finishedAt,
    updatedAt: finishedAt,
  })
  const durationMs = finishedAt.getTime() - startedAt.getTime()
  await store.finishRun(journal.id, {
    finishedAt,
    okCount,
    errorCount,
    durationMs,
    inputCount: processed,
  })
  // Same metrics rows the single-shot ingest writes (input/ok/errors/duration).
  await store.addMetric({
    timestamp: finishedAt,
    stage: STAGES.ingest,
    key: 'input',
    value: processed,
  })
  await store.addMetric({
    timestamp: finishedAt,
    stage: STAGES.ingest,
    key: 'ok',
    value: okCount,
  })
  await store.addMetric({
    timestamp: finishedAt,
    stage: STAGES.ingest,
    key: 'errors',
    value: errorCount,
  })
  await store.addMetric({
    timestamp: finishedAt,
    stage: STAGES.ingest,
    key: 'duration_ms',
    value: durationMs,
  })
  for (const [source, count] of errorsBySource) {
    await store.addMetric({
      timestamp: finishedAt,
      stage: STAGES.ingest,
      key: 'errors',
      value: count,
      tags: { importer: source },
    })
  }
  logger.info('ingest job {jobId} done: {okCount} ok, {errorCount} errors', {
    jobId,
    okCount,
    errorCount,
  })

  const finalJob = (await store.getIngestJob(jobId)) ?? job
  return {
    job: finalJob,
    runId: journal.id,
    inputCount: processed,
    okCount,
    errorCount,
    duplicates,
    inserted,
    updated,
    linkIds,
    outcomes,
    durationMs,
  }
}

/**
 * Resume every unfinished job ('pending' or 'running' — 'failed' jobs are
 * left for an explicit retry). Runs them one at a time under the ingest
 * lock; stops early when the lock is held elsewhere.
 */
export async function resumeIngestJobs(
  store: Store,
  options: IngestJobRunOptions & { limit?: number } = {},
): Promise<IngestJobRunResult[]> {
  const due = await store.listIngestJobs({
    status: ['pending', 'running'],
    limit: options.limit,
  })
  const results: IngestJobRunResult[] = []
  for (const job of due) {
    const result = await runIngestJob(store, job.id, options)
    results.push(result)
    if (result.busy) break
  }
  return results
}
