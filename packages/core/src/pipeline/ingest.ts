import type { Store } from '../store.js'
import { normalizeUrl } from '../url.js'
import type { RawLink, Link } from '../types.js'
import type {
  StageResult,
  StageOptions,
  LinkOutcome,
  PipelineLogger,
} from './types.js'
import { STAGES, noopLogger } from './types.js'
import {
  busyRunOf,
  reclaimCrashedRuns,
  startRunHeartbeat,
  type RunJournalEntry,
} from '../run-journal.js'

export interface IngestOptions extends StageOptions {
  /** Cap the number of links processed in this run. */
  limit?: number
}

export interface IngestResult extends StageResult {
  /** Ids of links inserted or updated by this run. */
  linkIds: number[]
  /** How many raw inputs collapsed onto already-known urls (no-op). */
  duplicates: number
}

/**
 * Ingest stage: RawLink[] -> store, dedupe by normalized url hash, idempotent.
 * Re-importing the same source changes nothing for known urls (upsert is
 * non-destructive downstream). Records one `runs` row, count metrics, and one
 * log line per link.
 */
export async function ingest(
  store: Store,
  rawLinks: RawLink[],
  options: IngestOptions = {},
): Promise<IngestResult> {
  const logger = options.logger ?? noopLogger
  const now = options.now ?? (() => new Date())
  const startedAt = now()

  // Crash recovery first: a dead run's journal row must not hold the lock,
  // and its leases must come back before this run selects work.
  await reclaimCrashedRuns(store, { now: startedAt })

  // Single-writer lock for the ingest stage. A second concurrent ingest —
  // in this process or another — gets a busy result with the holder's id.
  const acquired = await store.acquireRun(STAGES.ingest, {
    pid: process.pid,
    now: startedAt,
  })
  if (!acquired.ok) {
    const holder = acquired.busy
    logger.warn('ingest is busy: run {runId} holds the lock (pid {pid})', {
      runId: holder.id,
      pid: holder.pid,
    })
    return {
      stage: STAGES.ingest,
      runId: holder.id,
      busy: busyRunOf(holder),
      inputCount: rawLinks.length,
      okCount: 0,
      errorCount: 0,
      skippedCount: rawLinks.length,
      durationMs: 0,
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
      outcomes: [],
      warnings: [],
      linkIds: [],
      duplicates: 0,
    }
  }
  const journal = acquired.run
  logger.info('ingest run {runId} started with {inputCount} raw links', {
    runId: journal.id,
    inputCount: rawLinks.length,
  })
  const stopHeartbeat = startRunHeartbeat(store, journal.id, now)
  try {
    return await ingestPass(store, rawLinks, options, journal, startedAt)
  } catch (err) {
    await store
      .finishRun(journal.id, { finishedAt: now(), status: 'failed', errorCount: 1 })
      .catch(() => {})
    throw err
  } finally {
    stopHeartbeat()
  }
}

/** The ingest body, run while holding the stage's journal lock. */
async function ingestPass(
  store: Store,
  rawLinks: RawLink[],
  options: IngestOptions,
  journal: RunJournalEntry,
  startedAt: Date,
): Promise<IngestResult> {
  const logger = options.logger ?? noopLogger
  const now = options.now ?? (() => new Date())
  const run = journal

  const linkIds: number[] = []
  const outcomes: LinkOutcome[] = []
  const warnings: string[] = []
  const errorsByKey = new Map<string, number>()
  let okCount = 0
  let errorCount = 0
  let duplicates = 0

  const limit = options.limit ?? rawLinks.length
  let processed = 0

  for (const raw of rawLinks) {
    if (processed >= limit) break
    processed += 1
    try {
      const { url, hash } = normalizeUrl(raw.url)
      const existing = await store.getLinkByUrlHash(hash)
      const link = await store.upsertLink({
        urlHash: hash,
        url,
        title: raw.title ?? null,
        source: raw.source,
        addedAt: raw.addedAt ?? null,
        note: raw.note ?? null,
        tags: raw.tags ?? null,
        status: 'inbox',
        needsBrowser: false,
        captured: false,
        capturedAt: null,
        // FSM: a freshly ingested link starts in the `created` state, the
        // head of the extraction queue.
        state: 'created',
        stateData: {},
      })
      if (existing) duplicates += 1
      linkIds.push(link.id)
      okCount += 1
      logger.info('ingested {url} as link {linkId} (source {source}, duplicate {duplicate})', {
        url,
        linkId: link.id,
        source: raw.source,
        duplicate: existing,
      })
      outcomes.push({ linkId: link.id, url, ok: true })
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      errorCount += 1
      bump(errorsByKey, raw.source)
      logger.error('ingest failed for {url}: {error}', { url: raw.url, error })
      outcomes.push({ linkId: -1, url: raw.url, ok: false, error })
    }
  }

  await recordRunMetrics(store, {
    stage: STAGES.ingest,
    run,
    startedAt,
    okCount,
    errorCount,
    inputCount: rawLinks.length,
    now,
  })

  for (const [source, count] of errorsByKey) {
    await store.addMetric({
      timestamp: now(),
      stage: STAGES.ingest,
      key: 'errors',
      value: count,
      tags: { importer: source },
    })
  }

  const durationMs = now().getTime() - startedAt.getTime()
  await store.finishRun(run.id, {
    okCount,
    errorCount,
    durationMs,
    inputCount: rawLinks.length,
  })
  logger.info('ingest run {runId} finished: {okCount} ok, {errorCount} errors, {duplicates} duplicates', {
    runId: run.id,
    okCount,
    errorCount,
    duplicates,
  })

  return {
    stage: STAGES.ingest,
    runId: run.id,
    inputCount: rawLinks.length,
    okCount,
    errorCount,
    skippedCount: rawLinks.length - processed,
    durationMs,
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    outcomes,
    warnings,
    linkIds,
    duplicates,
  }
}

/** Shared run/metrics bookkeeping. Not exported from the package root. */
export async function recordRunMetrics(
  store: Store,
  input: {
    stage: string
    run: { id: number }
    startedAt: Date
    okCount: number
    errorCount: number
    inputCount: number
    now: () => Date
  },
): Promise<void> {
  const t = input.now()
  await store.addMetric({ timestamp: t, stage: input.stage, key: 'input', value: input.inputCount })
  await store.addMetric({ timestamp: t, stage: input.stage, key: 'ok', value: input.okCount })
  await store.addMetric({ timestamp: t, stage: input.stage, key: 'errors', value: input.errorCount })
  await store.addMetric({
    timestamp: t,
    stage: input.stage,
    key: 'duration_ms',
    value: t.getTime() - input.startedAt.getTime(),
  })
}

export function bump(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1)
}

export type { PipelineLogger }
