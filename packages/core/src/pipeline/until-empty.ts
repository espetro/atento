/**
 * The `--until-empty` driver, generalized as `drainStage`: repeat a pipeline
 * stage until its eligibility probe reports no work or an iteration makes no
 * progress. Stops after at most `maxIterations` batches (default 100), and
 * never sleeps more than the shortest retry-after reported by any batch.
 *
 * Both `extractUntilEmpty` and `enrichUntilEmpty` are thin wrappers: they
 * supply the stage call and the "is there still work" probe. The drain loop
 * itself is stage-agnostic — no recurrence logic lives here; the caller
 * (CLI `run`, harness tick) decides when to invoke it.
 *
 * Fakes only in tests: the sleep is injected, so the loop is fully offline.
 */
import type { Store } from '../store.js'
import { extract, type ExtractOptions, type ExtractResult } from './extract.js'
import { enrich, type EnrichOptions, type EnrichResult } from './enrich.js'
import { noopLogger, type BusyRun, type PipelineLogger } from './types.js'

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
  /**
   * Set when a batch found the stage lock held by another run: the loop
   * stopped without doing more work. Not an error — the holder is running.
   */
  busy?: BusyRun
}

/** The fields of a stage result the drain loop reads. Both ExtractResult
 * and EnrichResult satisfy this shape. */
export interface DrainBatchResult {
  inputCount: number
  okCount: number
  errorCount: number
  deferredCount: number
  /** Extract-only: links parked for a browser. Absent on enrich. */
  needsBrowserCount?: number
  retryAfter: number
  busy?: BusyRun
}

export interface DrainStageOptions<R extends DrainBatchResult> {
  /** One stage invocation (a single batch). */
  run: () => Promise<R>
  /** True while the stage still has eligible work. */
  hasWork: () => Promise<boolean>
  /** Cap on iterations. Default 100. */
  maxIterations?: number
  /** Injected sleep (tests). Default: a real sleep, capped at the retry-after. */
  sleep?: (ms: number) => Promise<void>
  /** Called after each batch with its one-line summary. */
  onBatch?: (summary: UntilEmptyBatchSummary) => void
  logger?: PipelineLogger
}

/**
 * Repeat `run` until `hasWork` is false or a batch makes no progress.
 * Stage-agnostic: the caller wires the stage call and the eligibility probe.
 */
export async function drainStage<R extends DrainBatchResult>(
  store: Store,
  options: DrainStageOptions<R>,
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
    // No eligible work left: done.
    if (!(await options.hasWork())) break

    const result = await options.run()
    if (result.busy) {
      const byState = await store.countByState()
      return { batches, totals, hitCap: false, retryAfter, byState, busy: result.busy }
    }
    const summary: UntilEmptyBatchSummary = {
      iteration,
      inputCount: result.inputCount,
      okCount: result.okCount,
      errorCount: result.errorCount,
      deferredCount: result.deferredCount,
      needsBrowserCount: result.needsBrowserCount ?? 0,
      retryAfterMs: result.retryAfter,
    }
    batches.push(summary)
    totals.ok += result.okCount
    totals.errors += result.errorCount
    totals.deferred += result.deferredCount
    totals.needsBrowser += result.needsBrowserCount ?? 0
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
    hitCap = await options.hasWork()
  }

  const byState = await store.countByState()
  return { batches, totals, hitCap, retryAfter, byState }
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

/** Extract-until-empty: drain the `created` queue through the extract stage. */
export async function extractUntilEmpty(
  store: Store,
  options: UntilEmptyOptions,
): Promise<UntilEmptyResult> {
  return drainStage<ExtractResult>(store, {
    run: () =>
      extract(store, {
        ...options,
        extract: options.extract,
      } as ExtractOptions),
    hasWork: async () => (await store.listByStates(['created'])).length > 0,
    ...(options.maxIterations !== undefined ? { maxIterations: options.maxIterations } : {}),
    ...(options.sleep ? { sleep: options.sleep } : {}),
    ...(options.onBatch ? { onBatch: options.onBatch } : {}),
    ...(options.logger ? { logger: options.logger } : {}),
  })
}

export interface EnrichUntilEmptyOptions extends Omit<EnrichOptions, 'enrich'> {
  enrich: EnrichOptions['enrich']
  /** Cap on iterations. Default 100. */
  maxIterations?: number
  /** Injected sleep (tests). Default: a real sleep, capped at the retry-after. */
  sleep?: (ms: number) => Promise<void>
  /** Called after each batch with its one-line summary. */
  onBatch?: (summary: UntilEmptyBatchSummary) => void
}

/**
 * True while the enrich stage has eligible work: a link in `extracted`,
 * `created` or `inbox` that still lacks enrichment and has extracted
 * content — the same filter `enrich` applies to its batch.
 */
async function enrichHasWork(store: Store): Promise<boolean> {
  const candidates = await store.listByStates(['extracted', 'created', 'inbox'])
  return candidates.some(
    (l) => l.enrichment === null && l.extractedContent !== null && !l.needsBrowser,
  )
}

/** Enrich-until-empty: drain enrichable links through the enrich stage. */
export async function enrichUntilEmpty(
  store: Store,
  options: EnrichUntilEmptyOptions,
): Promise<UntilEmptyResult> {
  return drainStage<EnrichResult>(store, {
    run: () => enrich(store, { ...options, enrich: options.enrich } as EnrichOptions),
    hasWork: () => enrichHasWork(store),
    ...(options.maxIterations !== undefined ? { maxIterations: options.maxIterations } : {}),
    ...(options.sleep ? { sleep: options.sleep } : {}),
    ...(options.onBatch ? { onBatch: options.onBatch } : {}),
    ...(options.logger ? { logger: options.logger } : {}),
  })
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
