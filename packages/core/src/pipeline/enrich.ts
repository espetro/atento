import type { Store } from '../store.js'
import type { StageResult, StageOptions, LinkOutcome, EnrichFn } from './types.js'
import { STAGES, noopLogger } from './types.js'
import { recordRunMetrics } from './ingest.js'
import { ttlDaysForCategory, type TtlConfig } from '../ttl.js'

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
}

export interface EnrichResult extends StageResult {
  /** Ids of links that received enrichment. */
  linkIds: number[]
}

/**
 * Enrich stage: claim `extracted` links by atomically transitioning them to
 * `enriching`, call the injected structured-output function, then record the
 * outcome as one FSM event. Model identity comes from the injected function;
 * nothing here knows about providers.
 */
export async function enrich(store: Store, options: EnrichOptions): Promise<EnrichResult> {
  const logger = options.logger ?? noopLogger
  const now = options.now ?? (() => new Date())
  const startedAt = now()

  // `extracted` links are the normal queue. `created` links are eligible
  // only when extraction has not run (or was skipped): enrichment can still
  // read the url on its own.
  const extracted = await store.listByStates(['extracted'])
  const created = await store.listByStates(['created'])
  const batch = [...extracted, ...created].slice(0, options.limit ?? undefined)
  const pending = batch.filter((l) => l.extractedContent !== null || l.state === 'created')

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
  let tokensIn = 0
  let tokensOut = 0
  let costUsd = 0

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

    try {
      const result = await options.enrich(link)
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
  }
}

function bump(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1)
}
