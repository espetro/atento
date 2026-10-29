import type { Store } from '../store.js'
import type { StageResult, StageOptions, LinkOutcome, ExtractFn } from './types.js'
import { STAGES, noopLogger } from './types.js'
import { recordRunMetrics } from './ingest.js'

export interface ExtractOptions extends StageOptions {
  /** Injected extraction function (the CLI adapts the extractors router). */
  extract: ExtractFn
  /** Cap the number of links processed in this run. */
  limit?: number
  /**
   * How long a lease may be held before another runner reclaims it. Leases
   * older than this are returned to the `created` queue before the batch is
   * selected. Default: 30 minutes.
   */
  leaseMs?: number
}

export interface ExtractResult extends StageResult {
  /** Number of links that ended up flagged needs_browser. */
  needsBrowserCount: number
}

/**
 * Extract stage: claim `created` links by atomically transitioning them to
 * `extracting` (the compare-and-set guarantees a link is never claimed by two
 * runners), run extraction, then record the outcome as one FSM event.
 *
 * A link whose extraction cannot run locally (walled garden, missing browser
 * profile, network failure) moves to `needs_browser` instead of crashing the
 * stage: the link is counted as ok-with-flag so the run stays green.
 */
export async function extract(store: Store, options: ExtractOptions): Promise<ExtractResult> {
  const logger = options.logger ?? noopLogger
  const now = options.now ?? (() => new Date())
  const startedAt = now()

  // Reclaim leases from a previous run that died, so a killed process never
  // strands a link.
  const leaseMs = options.leaseMs ?? 30 * 60 * 1000
  await store.reclaimExpiredLeases(new Date(startedAt.getTime() - leaseMs))

  const batch = await store.listByStates(['created'], options.limit)
  const run = await store.startRun(STAGES.extract, batch.length, startedAt)
  logger.info('extract run {runId} started with {inputCount} links', {
    runId: run.id,
    inputCount: batch.length,
  })

  const outcomes: LinkOutcome[] = []
  let okCount = 0
  let errorCount = 0
  let needsBrowserCount = 0
  const errorsByExtractor = new Map<string, number>()
  const needsBrowserByExtractor = new Map<string, number>()
  const extractionsByExtractor = new Map<string, number>()

  for (const link of batch) {
    let extractor = 'unknown'
    // Atomic claim: two concurrent runners race here, one wins, the loser
    // gets a typed STALE_STATE/ILLEGAL_TRANSITION and skips the link.
    const claim = await store.applyEvent(link.id, {
      type: 'EXTRACT_STARTED',
      at: now().toISOString(),
    })
    if (!claim.ok) {
      outcomes.push({
        linkId: link.id,
        url: link.url,
        ok: true,
        skipped: true,
        error: 'already claimed',
      })
      continue
    }

    try {
      const result = await options.extract(link.url)
      extractor = result.extractor ?? 'unknown'
      const markdown = result.markdown ?? ''
      const needsBrowser = result.needsBrowser === true || markdown.trim() === ''
      if (needsBrowser) {
        needsBrowserCount += 1
        bump(needsBrowserByExtractor, extractor)
        await store.setExtractedContent(link.id, markdown, true, now())
        await store.applyEvent(link.id, {
          type: 'NEEDS_BROWSER',
          host: hostOf(link.url),
          at: now().toISOString(),
        })
        logger.warn('extraction needs a browser for {url} (link {linkId}, extractor {extractor})', {
          url: link.url,
          linkId: link.id,
          extractor,
        })
        outcomes.push({
          linkId: link.id,
          url: link.url,
          ok: true,
          needsBrowser: true,
          chars: markdown.length,
        })
        okCount += 1
        continue
      }

      await store.setExtractedContent(link.id, markdown, false, now())
      bump(extractionsByExtractor, extractor)
      const done = await store.applyEvent(link.id, {
        type: 'EXTRACTED',
        chars: markdown.length,
        at: now().toISOString(),
      })
      if (!done.ok) {
        errorCount += 1
        bump(errorsByExtractor, extractor)
        outcomes.push({ linkId: link.id, url: link.url, ok: false, error: done.error.message })
        continue
      }
      okCount += 1
      logger.info('extracted {url} (link {linkId}, {chars} chars, extractor {extractor})', {
        url: link.url,
        linkId: link.id,
        chars: markdown.length,
        extractor,
      })
      outcomes.push({
        linkId: link.id,
        url: link.url,
        ok: true,
        needsBrowser: false,
        chars: markdown.length,
      })
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      errorCount += 1
      bump(errorsByExtractor, extractor)
      const failed = await store.applyEvent(link.id, {
        type: 'EXTRACT_FAILED',
        error,
        at: now().toISOString(),
      })
      logger.error('extraction failed for {url}: {error}', { url: link.url, error })
      outcomes.push({
        linkId: link.id,
        url: link.url,
        ok: false,
        error: failed.ok ? error : failed.error.message,
      })
    }
  }

  await recordRunMetrics(store, {
    stage: STAGES.extract,
    run,
    startedAt,
    okCount,
    errorCount,
    inputCount: batch.length,
    now,
  })
  await store.addMetric({
    timestamp: now(),
    stage: STAGES.extract,
    key: 'needs_browser',
    value: needsBrowserCount,
  })
  for (const [name, count] of needsBrowserByExtractor) {
    await store.addMetric({
      timestamp: now(),
      stage: STAGES.extract,
      key: 'needs_browser',
      value: count,
      tags: { extractor: name },
    })
  }
  for (const [name, count] of extractionsByExtractor) {
    await store.addMetric({
      timestamp: now(),
      stage: STAGES.extract,
      key: 'extractions',
      value: count,
      tags: { extractor: name },
    })
  }
  for (const [name, count] of errorsByExtractor) {
    await store.addMetric({
      timestamp: now(),
      stage: STAGES.extract,
      key: 'errors',
      value: count,
      tags: { extractor: name },
    })
  }

  const durationMs = now().getTime() - startedAt.getTime()
  await store.finishRun(run.id, {
    okCount,
    errorCount,
    durationMs,
  })
  logger.info('extract run {runId} finished: {okCount} ok, {errorCount} errors', {
    runId: run.id,
    okCount,
    errorCount,
  })

  return {
    stage: STAGES.extract,
    runId: run.id,
    inputCount: batch.length,
    okCount,
    errorCount,
    skippedCount: 0,
    durationMs,
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    outcomes,
    warnings: [],
    needsBrowserCount,
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}

function bump(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1)
}
