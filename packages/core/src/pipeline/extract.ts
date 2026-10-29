import type { Store } from '../store.js'
import type { Link } from '../types.js'
import type { StageResult, StageOptions, LinkOutcome, ExtractFn } from './types.js'
import { STAGES, noopLogger } from './types.js'
import { recordRunMetrics } from './ingest.js'

export interface ExtractOptions extends StageOptions {
  /** Injected extraction function (the CLI adapts the extractors router). */
  extract: ExtractFn
  /** Cap the number of links processed in this run. */
  limit?: number
  /** Only extract links in these statuses. Default: inbox. */
  statuses?: Link['status'][]
}

export interface ExtractResult extends StageResult {
  /** Number of links that ended up flagged needs_browser. */
  needsBrowserCount: number
}

/**
 * Extract stage: run extraction on inbox links lacking content.
 *
 * A link whose extraction cannot run locally (walled garden, missing browser
 * profile, network failure) is flagged `needs_browser` instead of crashing the
 * stage: the link is counted as ok-with-flag so the run stays green and the
 * user can fix the profile and re-run.
 */
export async function extract(
  store: Store,
  options: ExtractOptions,
): Promise<ExtractResult> {
  const logger = options.logger ?? noopLogger
  const now = options.now ?? (() => new Date())
  const startedAt = now()

  const statuses = options.statuses ?? (['inbox'] as Link['status'][])
  const candidates = await store.listLinks({ status: statuses[0] })
  const pending = candidates
    .filter((l) => l.extractedContent === null || l.extractedContent.trim() === '')
    .filter((l) => statuses.includes(l.status))
    .slice(0, options.limit ?? Number.POSITIVE_INFINITY)

  const run = await store.startRun(STAGES.extract, pending.length, startedAt)
  logger.info('extract run {runId} started with {inputCount} links', {
    runId: run.id,
    inputCount: pending.length,
  })

  const outcomes: LinkOutcome[] = []
  let okCount = 0
  let errorCount = 0
  let needsBrowserCount = 0
  const errorsByExtractor = new Map<string, number>()

  for (const link of pending) {
    let extractor = 'unknown'
    try {
      const result = await options.extract(link.url)
      extractor = result.extractor ?? 'unknown'
      const markdown = result.markdown ?? ''
      const needsBrowser = result.needsBrowser === true || markdown.trim() === ''
      if (needsBrowser) {
        needsBrowserCount += 1
        await store.setExtractedContent(link.id, markdown, true, now())
        logger.warn('extraction needs a browser for {url} (link {linkId})', {
          url: link.url,
          linkId: link.id,
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
      okCount += 1
      logger.info('extracted {url} (link {linkId}, {chars} chars)', {
        url: link.url,
        linkId: link.id,
        chars: markdown.length,
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
      logger.error('extraction failed for {url}: {error}', { url: link.url, error })
      outcomes.push({ linkId: link.id, url: link.url, ok: false, error })
    }
  }

  await recordRunMetrics(store, {
    stage: STAGES.extract,
    run,
    startedAt,
    okCount,
    errorCount,
    inputCount: pending.length,
    now,
  })
  await store.addMetric({
    timestamp: now(),
    stage: STAGES.extract,
    key: 'needs_browser',
    value: needsBrowserCount,
  })

  for (const [extractor, count] of errorsByExtractor) {
    await store.addMetric({
      timestamp: now(),
      stage: STAGES.extract,
      key: 'errors',
      value: count,
      tags: { extractor },
    })
  }

  const durationMs = now().getTime() - startedAt.getTime()
  await store.finishRun(run.id, { okCount, errorCount, durationMs })
  logger.info(
    'extract run {runId} finished: {okCount} ok, {errorCount} errors, {needsBrowserCount} need a browser',
    { runId: run.id, okCount, errorCount, needsBrowserCount },
  )

  return {
    stage: STAGES.extract,
    runId: run.id,
    inputCount: pending.length,
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

function bump(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1)
}
