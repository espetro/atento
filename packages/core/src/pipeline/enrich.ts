import type { Store } from '../store.js'
import type { StageResult, StageOptions, LinkOutcome, EnrichFn } from './types.js'
import { STAGES, noopLogger } from './types.js'
import { recordRunMetrics } from './ingest.js'
import { ttlDaysForCategory, type TtlConfig } from '../ttl.js'
import { DEFAULT_MAX_BATCH, LLM_KEY, type GuardDeps, guardRun } from '../resilience/index.js'
import { deferOrError, releaseDueDeferred } from './resilience.js'
import { DEFAULT_MAX_ATTEMPTS } from './resilience-options.js'

export interface EnrichOptions extends StageOptions {
  /** Injected enrichment function (implemented by @linkinbox/enrich). */
  enrich: EnrichFn
  /** Cap the number of links processed in this run. */
  limit?: number
  /**
   * TTL config used when the enrichment carries no expires_at: the link then
   * expires ttl_days_for_category(category) days from now.
   */
  ttl?: TtlConfig
  /**
   * How long a lease may be held before another runner reclaims it. Default:
   * 30 minutes.
   */
  leaseMs?: number
  /**
   * Resilience wiring: the llm breaker, retry and bounded concurrency. When
   * absent the stage runs unguarded exactly as before.
   */
  guard?: GuardDeps
  /** Max DEFER rounds before a link moves to errored. Default 5. */
  maxAttempts?: number
  /** Hard cap on links per call when invoked remotely. Default 20. */
  maxBatch?: number
}

export interface EnrichResult extends StageResult {
  /** Ids of links that received enrichment. */
  linkIds: number[]
  /** Number of links deferred by the limiter or breaker (additive). */
  deferredCount: number
  /** Suggested wait in ms before the next batch should run (additive). */
  retryAfter: number
}

/**
 * Enrich stage: claim `extracted` links by atomically transitioning them to
 * `enriching`, call the injected structured-output function, then record the
 * outcome as one FSM event. Model identity comes from the injected function;
 * nothing here knows about providers.
 *
 * With a guard, the llm key has its own breaker: a 429 or 5xx storm retries
 * with backoff and then defers the remaining links instead of failing them.
 */
export async function enrich(store: Store, options: EnrichOptions): Promise<EnrichResult> {
  const logger = options.logger ?? noopLogger
  const now = options.now ?? (() => new Date())
  const startedAt = now()
  const guard = options.guard
  const guardActive = guard !== undefined
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
  const maxBatch = options.maxBatch ?? DEFAULT_MAX_BATCH

  // Candidates: links that still need enrichment. `extracted` has content and
  // waits for the model, `created` was never extracted, `inbox` was enriched
  // before but lost its enrichment (or was seeded without one).
  // Reclaim leases from a previous run that died.
  const leaseMs = options.leaseMs ?? 30 * 60 * 1000
  await store.reclaimExpiredLeases(new Date(startedAt.getTime() - leaseMs))

  // Due deferred links come back to their queue before selection.
  await releaseDueDeferred(store, 'enrich', startedAt)

  const extracted = await store.listByStates(['extracted'])
  const created = await store.listByStates(['created'])
  const inbox = await store.listByStates(['inbox'])
  const batch = [...extracted, ...created, ...inbox]
    // Enrich reads extracted content; a link that was never extracted waits
    // for the extract stage instead of being guessed at from its URL.
    .filter((l) => l.enrichment === null && l.extractedContent !== null && !l.needsBrowser)
    .slice(0, options.limit ?? undefined)
  const pending = batch.slice(0, maxBatch)

  const run = await store.startRun(STAGES.enrich, pending.length, startedAt)
  logger.info('enrich run {runId} started with {inputCount} links', {
    runId: run.id,
    inputCount: pending.length,
  })

  const outcomes: LinkOutcome[] = []
  const linkIds: number[] = []
  const errorsByModel = new Map<string, number>()
  let okCount = 0
  let errorCount = 0
  let deferredCount = 0
  let retryAfter = 0
  let tokensIn = 0
  let tokensOut = 0
  let costUsd = 0
  /** Set when the llm breaker opens: the rest of the batch is deferred. */
  let breakerOpen = false

  for (const link of pending) {
    let modelId = 'unknown'
    const claim = await store.applyEvent(link.id, {
      type: 'ENRICH_STARTED',
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

    // The llm breaker opened mid-batch: defer the rest without calling out.
    if (breakerOpen) {
      deferredCount += 1
      await deferOrError(store, link, 'enrich', 'breaker_open', 30_000, maxAttempts, now())
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
      let retriesThisLink = 0
      const raw = guardActive
        ? await guardRun(guard as GuardDeps, LLM_KEY, () => options.enrich(link), {
            onRetry: () => {
              retriesThisLink += 1
            },
          })
        : { kind: 'ok' as const, value: await options.enrich(link), attempts: 1 }
      if (retriesThisLink > 0) {
        await store.addMetric({
          timestamp: now(),
          stage: STAGES.enrich,
          key: 'retries',
          value: retriesThisLink,
          tags: { host: LLM_KEY },
        })
      }

      if (raw.kind === 'defer') {
        deferredCount += 1
        retryAfter = Math.max(retryAfter, raw.retryAfterMs)
        if (raw.breakerOpen) breakerOpen = true
        const decision = await deferOrError(
          store, link, 'enrich', raw.reason, raw.retryAfterMs, maxAttempts, now(),
        )
        if (decision.errored) {
          errorCount += 1
          bump(errorsByModel, 'error')
          outcomes.push({ linkId: link.id, url: link.url, ok: false, error: raw.reason })
        } else {
          outcomes.push({
            linkId: link.id,
            url: link.url,
            ok: true,
            skipped: true,
            error: `deferred: ${raw.reason}`,
          })
        }
        continue
      }
      if (raw.kind === 'error') {
        throw new Error(raw.reason)
      }

      const result = raw.value
      if (result.ok) {
        modelId = result.modelId
        const enrichment = result.enrichment
        await store.setEnrichment(link.id, enrichment, now())
        // When the enrichment carries no expiry, derive one from the ttl
        // config (by_category first, then default_days).
        if (!enrichment.expires_at && options.ttl) {
          const days = ttlDaysForCategory(options.ttl, enrichment.category)
          const expiresAt = new Date(now().getTime() + days * 24 * 60 * 60 * 1000)
          await store.setExpiry(link.id, expiresAt, enrichment.expiry_reason, now())
        }
        const done = await store.applyEvent(link.id, {
          type: 'ENRICHED',
          at: now().toISOString(),
        })
        if (!done.ok) {
          errorCount += 1
          bump(errorsByModel, 'error')
          outcomes.push({ linkId: link.id, url: link.url, ok: false, error: done.error.message })
          continue
        }
        okCount += 1
        tokensIn += result.tokensIn
        tokensOut += result.tokensOut
        costUsd += result.costUsd ?? 0
        linkIds.push(link.id)
        logger.info(
          'enriched {url} (link {linkId}, category {category}, action {action}, model {modelId})',
          {
            url: link.url,
            linkId: link.id,
            category: result.enrichment.category,
            action: result.enrichment.action,
            modelId: result.modelId,
            tokensIn: result.tokensIn,
            tokensOut: result.tokensOut,
            costUsd: result.costUsd ?? 0,
          },
        )
        outcomes.push({
          linkId: link.id,
          url: link.url,
          ok: true,
          modelId: result.modelId,
          tokensIn: result.tokensIn,
          tokensOut: result.tokensOut,
          costUsd: result.costUsd ?? 0,
        })
      } else {
        modelId = 'error'
        errorCount += 1
        bump(errorsByModel, 'error')
        await store.applyEvent(link.id, {
          type: 'ENRICH_FAILED',
          error: result.error,
          at: now().toISOString(),
        })
        logger.error('enrichment failed for {url}: {error}', { url: link.url, error: result.error })
        outcomes.push({ linkId: link.id, url: link.url, ok: false, error: result.error })
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      errorCount += 1
      bump(errorsByModel, modelId)
      await store.applyEvent(link.id, {
        type: 'ENRICH_FAILED',
        error,
        at: now().toISOString(),
      })
      logger.error('enrichment threw for {url}: {error}', { url: link.url, error })
      outcomes.push({ linkId: link.id, url: link.url, ok: false, error })
    }
  }

  await recordRunMetrics(store, {
    stage: STAGES.enrich,
    run,
    startedAt,
    okCount,
    errorCount,
    inputCount: pending.length,
    now,
  })
  await store.addMetric({ timestamp: now(), stage: STAGES.enrich, key: 'tokens_in', value: tokensIn })
  await store.addMetric({ timestamp: now(), stage: STAGES.enrich, key: 'tokens_out', value: tokensOut })
  await store.addMetric({ timestamp: now(), stage: STAGES.enrich, key: 'cost_usd', value: costUsd })
  if (deferredCount > 0) {
    await store.addMetric({
      timestamp: now(),
      stage: STAGES.enrich,
      key: 'deferred',
      value: deferredCount,
    })
    await store.addMetric({
      timestamp: now(),
      stage: STAGES.enrich,
      key: 'throttled',
      value: deferredCount,
    })
  }
  // Per-host resilience metrics: the llm gateway is the only key here.
  if (deferredCount > 0) {
    await store.addMetric({
      timestamp: now(),
      stage: STAGES.enrich,
      key: 'deferred',
      value: deferredCount,
      tags: { host: LLM_KEY },
    })
  }
  if (breakerOpen) {
    await store.addMetric({
      timestamp: now(),
      stage: STAGES.enrich,
      key: 'breaker_open',
      value: 1,
      tags: { host: LLM_KEY },
    })
  }

  for (const [model, count] of errorsByModel) {
    await store.addMetric({
      timestamp: now(),
      stage: STAGES.enrich,
      key: 'errors',
      value: count,
      tags: { model },
    })
  }

  const durationMs = now().getTime() - startedAt.getTime()
  await store.finishRun(run.id, {
    okCount,
    errorCount,
    durationMs,
    tokensIn: tokensIn || null,
    tokensOut: tokensOut || null,
    costUsd: costUsd || null,
  })
  logger.info('enrich run {runId} finished: {okCount} ok, {errorCount} errors', {
    runId: run.id,
    okCount,
    errorCount,
  })

  return {
    stage: STAGES.enrich,
    runId: run.id,
    inputCount: pending.length,
    okCount,
    errorCount,
    skippedCount: batch.length - pending.length,
    durationMs,
    tokensIn,
    tokensOut,
    costUsd,
    outcomes,
    warnings: [],
    linkIds,
    deferredCount,
    retryAfter,
  }
}

function bump(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1)
}
