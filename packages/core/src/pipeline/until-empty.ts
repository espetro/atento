/**
 * The `--until-empty` driver: repeat the extract stage until no `created`
 * link is eligible or an iteration makes no progress. Stops after at most
 * `maxIterations` batches (default 100), and never sleeps more than the
 * shortest retry-after reported by any batch.
 *
 * Fakes only in tests: the sleep is injected, so the loop is fully offline.
 */
import type { Store } from '../store.js'
import { extract, type ExtractOptions, type ExtractResult } from './extract.js'
import { noopLogger } from './types.js'

/** Upper bound on iterations: a runaway loop can never hang the CLI. */
export const MAX_UNTIL_EMPTY_ITERATIONS = 100

export interface UntilEmptyBatchSummary {
  iteration: number
  inputCount: number
  okCount: number
  errorCount: number
  deferredCount: number
  needsBrowserCount: number
  retryAfterMs: number
}

export interface UntilEmptyResult {
  batches: UntilEmptyBatchSummary[]
  /** Cumulative final counts per state over the whole loop. */
  totals: {
    ok: number
    errors: number
    deferred: number
    needsBrowser: number
  }
  /** Final link count per state (the FSM histogram). */
  byState: Record<string, number>
  /** True when the loop hit the iteration cap with work still queued. */
  hitCap: boolean
  /** Shortest retry-after across batches (ms), 0 when nothing was deferred. */
  retryAfter: number
}

export interface UntilEmptyOptions extends Omit<ExtractOptions, 'extract'> {
  extract: ExtractOptions['extract']
  /** Cap on iterations. Default 100. */
  maxIterations?: number
  /** Injected sleep (tests). Default: a real sleep, capped at the retry-after. */
  sleep?: (ms: number) => Promise<void>
  /** Called after each batch with its one-line summary. */
  onBatch?: (summary: UntilEmptyBatchSummary) => void
}

export async function extractUntilEmpty(
  store: Store,
  options: UntilEmptyOptions,
): Promise<UntilEmptyResult> {
  const logger = options.logger ?? noopLogger
  const maxIterations = options.maxIterations ?? MAX_UNTIL_EMPTY_ITERATIONS
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))
  const onBatch = options.onBatch

  const batches: UntilEmptyBatchSummary[] = []
  const totals = { ok: 0, errors: 0, deferred: 0, needsBrowser: 0 }
  let retryAfter = 0
  let hitCap = false

  for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
    // No eligible created link left: done.
    const created = await store.listByStates(['created'])
    if (created.length === 0) break

    const result: ExtractResult = await extract(store, {
      ...options,
      extract: options.extract,
    } as ExtractOptions)
    const summary: UntilEmptyBatchSummary = {
      iteration,
      inputCount: result.inputCount,
      okCount: result.okCount,
      errorCount: result.errorCount,
      deferredCount: result.deferredCount,
      needsBrowserCount: result.needsBrowserCount,
      retryAfterMs: result.retryAfter,
    }
    batches.push(summary)
    totals.ok += result.okCount
    totals.errors += result.errorCount
    totals.deferred += result.deferredCount
    totals.needsBrowser += result.needsBrowserCount
    if (result.retryAfter > 0 && (retryAfter === 0 || result.retryAfter < retryAfter)) {
      retryAfter = result.retryAfter
    }
    onBatch?.(summary)
    logger.info('until-empty batch {iteration}: {inputCount} links, {okCount} ok', {
      iteration,
      inputCount: result.inputCount,
      okCount: result.okCount,
    })

    // No progress: the batch only deferred or skipped, waiting cannot help
    // within this process (spacing waits can exceed any sane runtime).
    const progressed = result.okCount > 0 || result.errorCount > 0
    if (!progressed) break

    // Never sleep more than the shortest retry-after seen so far.
    if (retryAfter > 0) await sleep(retryAfter)
  }

  if (batches.length >= maxIterations) {
    const created = await store.listByStates(['created'])
    hitCap = created.length > 0
  }

  const byState = await store.countByState()
  return { batches, totals, hitCap, retryAfter, byState }
}

/** One-line summary for a batch, as printed by the CLI. */
export function formatBatchSummary(summary: UntilEmptyBatchSummary): string {
  return (
    `batch ${summary.iteration}: ${summary.okCount}/${summary.inputCount} ok` +
    (summary.deferredCount > 0 ? `, ${summary.deferredCount} deferred` : '') +
    (summary.needsBrowserCount > 0 ? `, ${summary.needsBrowserCount} need browser` : '') +
    (summary.errorCount > 0 ? `, ${summary.errorCount} errors` : '')
  )
}

/** Final per-state summary line: the FSM histogram plus the loop totals. */
export function formatTotals(result: UntilEmptyResult): string {
  const histogram = Object.entries(result.byState)
    .filter(([, count]) => count > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([state, count]) => `${state}: ${count}`)
  const totals = [
    `ok: ${result.totals.ok}`,
    `deferred: ${result.totals.deferred}`,
    `needs_browser: ${result.totals.needsBrowser}`,
    `errored: ${result.totals.errors}`,
  ].join(', ')
  return `${totals} | ${histogram.join(', ') || 'no links'}`
}
