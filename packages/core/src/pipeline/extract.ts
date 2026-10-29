import type { Store } from '../store.js'
import type { StageResult, StageOptions, LinkOutcome, ExtractFn } from './types.js'
import { STAGES, noopLogger } from './types.js'
import { recordRunMetrics } from './ingest.js'
import {
  DEFAULT_MAX_BATCH,
  breakerReport,
  type GuardDeps,
  guardRun,
} from '../resilience/index.js'
import {
  attemptsOf,
  deferOrError,
  guardDepsFromStore,
  releaseDueDeferred,
} from './resilience.js'
import { DEFAULT_MAX_ATTEMPTS } from './resilience-options.js'

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
  /**
   * Resilience wiring: limiter + breaker + retry per host. When absent the
   * stage runs unguarded exactly as before (backward compatible).
   */
  guard?: GuardDeps
  /** Max DEFER rounds before a link moves to errored. Default 5. */
  maxAttempts?: number
  /** Hard cap on links per call when invoked remotely. Default 20. */
  maxBatch?: number
}

export interface ExtractResult extends StageResult {
  /** Number of links that ended up flagged needs_browser. */
  needsBrowserCount: number
  /** Number of links deferred by the limiter or breaker (additive). */
  deferredCount: number
  /** Suggested wait in ms before the next batch should run (additive). */
  retryAfter: number
}

/**
 * Extract stage: claim `created` links by atomically transitioning them to
 * `extracting` (the compare-and-set guarantees a link is never claimed by two
 * runners), run extraction, then record the outcome as one FSM event.
 *
 * A link whose extraction cannot run locally (walled garden, missing browser
 * profile, network failure) moves to `needs_browser` instead of crashing the
 * stage: the link is counted as ok-with-flag so the run stays green.
 *
 * With a guard, every fetch is rate limited per host and protected by the
 * host's circuit breaker. A throttled or blocked link gets a DEFER event
 * (never an error), and the rest of that host's batch is deferred too.
 */
export async function extract(store: Store, options: ExtractOptions): Promise<ExtractResult> {
  const logger = options.logger ?? noopLogger
  const now = options.now ?? (() => new Date())
  const startedAt = now()
  const guard: GuardDeps | undefined = options.guard
  const guardActive = guard !== undefined
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
  const maxBatch = options.maxBatch ?? DEFAULT_MAX_BATCH

  // Reclaim leases from a previous run that died, so a killed process never
  // strands a link.
  const leaseMs = options.leaseMs ?? 30 * 60 * 1000
  await store.reclaimExpiredLeases(new Date(startedAt.getTime() - leaseMs))

  // Due deferred links come back to the created queue before selection.
  await releaseDueDeferred(store, 'extract', startedAt)

  const batch = (await store.listByStates(['created'], options.limit)).slice(0, maxBatch)
  const run = await store.startRun(STAGES.extract, batch.length, startedAt)
  logger.info('extract run {runId} started with {inputCount} links', {
    runId: run.id,
    inputCount: batch.length,
  })

  const outcomes: LinkOutcome[] = []
  let okCount = 0
  let errorCount = 0
  let needsBrowserCount = 0
  let deferredCount = 0
  let retryAfter = 0
  const errorsByExtractor = new Map<string, number>()
  const needsBrowserByExtractor = new Map<string, number>()
  const extractionsByExtractor = new Map<string, number>()
  /** Set when a host's breaker opens: the rest of its links are deferred. */
  const blockedHosts = new Set<string>()

  for (const link of batch) {
    let extractor = 'unknown'
    const host = hostOf(link.url)
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

    // A host whose breaker opened mid-batch is skipped without a fetch: the
    // link is deferred with the breaker's reopen time.
    if (blockedHosts.has(host)) {
      deferredCount += 1
      await store.applyEvent(link.id, {
        type: 'DEFER',
        stage: 'extract',
        nextAttemptAt: new Date(startedAt.getTime() + 60 * 60 * 1000).toISOString(),
        attempts: (await preAttempts(store, link.id)) + 1,
        reason: 'breaker_open',
        at: now().toISOString(),
      })
      outcomes.push({
        linkId: link.id,
        url: link.url,
        ok: true,
        skipped: true,
        error: 'deferred: breaker_open',
      })
      continue
    }

    try {
      const result = guardActive
        ? await guardRun(guard as GuardDeps, host, () => options.extract(link.url))
        : { kind: 'ok' as const, value: await options.extract(link.url), attempts: 1 }
      if (result.kind === 'defer') {
        deferredCount += 1
        retryAfter = Math.max(retryAfter, result.retryAfterMs)
        if (result.breakerOpen) blockedHosts.add(host)
        const decision = await deferOrError(
          store, link, 'extract', result.reason, result.retryAfterMs, maxAttempts, now(),
        )
        if (decision.errored) {
          errorCount += 1
          bump(errorsByExtractor, extractor)
          outcomes.push({ linkId: link.id, url: link.url, ok: false, error: result.reason })
        } else {
          outcomes.push({
            linkId: link.id,
            url: link.url,
            ok: true,
            skipped: true,
            error: `deferred: ${result.reason}`,
          })
        }
        continue
      }
      if (result.kind === 'error') {
        throw new Error(result.reason)
      }

      extractor = String(
        (result.value as { extractor?: string; route?: string }).extractor ??
          (result.value as { route?: string }).route ??
          'unknown',
      )
      const raw = result.value as {
        markdown?: string
        needsBrowser?: boolean
        blocked?: boolean
        blockReason?: string
      }
      // A login wall or captcha: the host refused the session. Open its
      // breaker so the rest of the batch stops hammering it, and defer.
      if (raw.blocked === true) {
        deferredCount += 1
        blockedHosts.add(host)
        const reason = `blocked:${raw.blockReason ?? 'login_wall'}`
        const waitMs = await openBreakerForHost(guard, host, now().getTime())
        retryAfter = Math.max(retryAfter, waitMs)
        const decision = await deferOrError(store, link, 'extract', reason, waitMs, maxAttempts, now())
        logger.warn('extraction blocked on {host} (link {linkId}): run `linkinbox login {host}`', {
          host,
          linkId: link.id,
        })
        if (decision.errored) {
          errorCount += 1
          bump(errorsByExtractor, extractor)
          outcomes.push({ linkId: link.id, url: link.url, ok: false, error: reason })
        } else {
          outcomes.push({
            linkId: link.id,
            url: link.url,
            ok: true,
            skipped: true,
            error: `deferred: ${reason}`,
          })
        }
        continue
      }
      const markdown = raw.markdown ?? ''
      const needsBrowser = raw.needsBrowser === true || markdown.trim() === ''
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
  if (deferredCount > 0) {
    await store.addMetric({
      timestamp: now(),
      stage: STAGES.extract,
      key: 'deferred',
      value: deferredCount,
    })
    await store.addMetric({
      timestamp: now(),
      stage: STAGES.extract,
      key: 'throttled',
      value: deferredCount,
    })
  }
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
    deferredCount,
    retryAfter,
  }
}

/**
 * Open the host's circuit breaker after a hard block and return how long the
 * caller must wait before probing again.
 */
async function openBreakerForHost(
  guard: GuardDeps | undefined,
  host: string,
  now: number,
): Promise<number> {
  if (!guard) return 0
  const report = await breakerReport(
    {
      load: (key) => guard.getHostState(key),
      save: (state) => guard.saveHostState(state),
      clock: guard.clock,
      profile: guard.config.breaker,
    },
    host,
    'failure',
    { retryable: false, block: true, reason: 'login_wall' },
  )
  return report.state.openedUntil !== null ? Math.max(0, report.state.openedUntil - now) : 0
}

/** Attempts burned so far, read from the link's FSM history. */
async function preAttempts(store: Store, linkId: number): Promise<number> {
  return attemptsOf(store, linkId)
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
