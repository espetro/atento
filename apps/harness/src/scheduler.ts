/**
 * Recurrence — owned entirely by the harness; nothing in core/app knows a
 * schedule exists. Two triggers from harness.toml:
 *
 *  - `schedule = "<cron>"`      periodic `app.run` ticks (croner)
 *  - `on_ingest = true`         a debounced run after ingest jobs complete
 *
 * Every tick calls `app.run`, persists the result (runId + cursors + summary)
 * to the run journal and fires the notifier. Ticks never overlap: a cron or
 * ingest trigger arriving mid-run is dropped, not queued.
 *
 * on_ingest mechanics: ingest_jobs are durable rows, so the scheduler polls
 * `store.listIngestJobs` for terminal (done/failed) jobs it has not seen.
 * Completions inside the debounce window batch into ONE run. Jobs that a
 * harness run ingests itself are absorbed by a baseline refresh after every
 * tick, so scheduled runs cannot retrigger themselves; an external ingest
 * that completes *during* a run is absorbed too (documented trade-off — its
 * links are still picked up by the next tick).
 */
import { Cron } from 'croner'
import type { RunResult, Store } from '@linkinbox/app'
import type { IngestJobStatus } from '@linkinbox/core'
import type { HarnessConfig } from './config.js'
import { runNotification, type Notifier } from './notify.js'
import type { HarnessRunRecord, RunStore, RunTrigger } from './runs.js'

export interface SchedulerDeps {
  /** One full pipeline pass — `app.run` bound by the composition root. */
  run: () => Promise<RunResult>
  /** Store used only to poll ingest_jobs for on_ingest. */
  store: Store
  config: HarnessConfig
  runs: RunStore
  notifier?: Notifier
  /** Base URL linked from notifications. */
  uiUrl?: string
  /** Clock injection for tests. */
  now?: () => Date
  /** Timer injection for tests (defaults to globals). */
  setTimeoutFn?: (fn: () => void, ms: number) => unknown
  clearTimeoutFn?: (handle: unknown) => void
  setIntervalFn?: (fn: () => void, ms: number) => unknown
  clearIntervalFn?: (handle: unknown) => void
  /** Called after each finished tick (success or failure), for logging. */
  onTick?: (record: HarnessRunRecord) => void
}

const TERMINAL: IngestJobStatus[] = ['done', 'failed']

export class HarnessScheduler {
  private readonly deps: SchedulerDeps
  private cron: Cron | undefined
  private pollTimer: unknown
  private debounceTimer: unknown
  private tickInFlight = false
  private stopped = false
  /** Ingest job ids already accounted for (baseline + seen completions). */
  private readonly seenJobs = new Set<string>()

  constructor(deps: SchedulerDeps) {
    this.deps = deps
  }

  private get now(): Date {
    return this.deps.now?.() ?? new Date()
  }

  private get setTimeoutFn() {
    return this.deps.setTimeoutFn ?? ((fn: () => void, ms: number) => setTimeout(fn, ms))
  }
  private get clearTimeoutFn() {
    return this.deps.clearTimeoutFn ?? ((h: unknown) => clearTimeout(h as NodeJS.Timeout))
  }
  private get setIntervalFn() {
    return this.deps.setIntervalFn ?? ((fn: () => void, ms: number) => setInterval(fn, ms))
  }
  private get clearIntervalFn() {
    return this.deps.clearIntervalFn ?? ((h: unknown) => clearInterval(h as NodeJS.Timeout))
  }

  /**
   * Arm the configured triggers. An invalid cron expression throws — the
   * caller (`start`) surfaces it as a config error.
   */
  start(): void {
    if (this.stopped) return
    if (this.deps.config.schedule !== undefined) {
      // Croner validates the pattern in the constructor.
      this.cron = new Cron(this.deps.config.schedule, { protect: true }, () => {
        void this.tick('cron')
      })
    }
    if (this.deps.config.onIngest) {
      // Baseline: jobs already terminal at startup are history, not triggers.
      void this.absorbTerminalJobs()
      this.pollTimer = this.setIntervalFn(() => {
        void this.pollIngestJobs()
      }, this.deps.config.ingestPollMs)
    }
  }

  /** Stop timers and wait for any in-flight tick. Idempotent. */
  async stop(): Promise<void> {
    this.stopped = true
    this.cron?.stop()
    this.cron = undefined
    if (this.pollTimer !== undefined) {
      this.clearIntervalFn(this.pollTimer)
      this.pollTimer = undefined
    }
    if (this.debounceTimer !== undefined) {
      this.clearTimeoutFn(this.debounceTimer)
      this.debounceTimer = undefined
    }
    // Wait out an in-flight run so shutdown does not orphan app.run.
    while (this.tickInFlight) {
      await new Promise((res) => setTimeout(res, 50))
    }
  }

  /**
   * One run tick: app.run → journal record → notification. Overlapping
   * triggers return null immediately. Errors are journaled and notified,
   * never thrown into the timer callback.
   */
  async tick(trigger: RunTrigger): Promise<HarnessRunRecord | null> {
    if (this.tickInFlight || this.stopped) return null
    this.tickInFlight = true
    const started = Date.now()
    try {
      let record: HarnessRunRecord
      try {
        const result = await this.deps.run()
        record = {
          runId: result.runId,
          trigger,
          cursorBefore: result.cursorBefore,
          cursorAfter: result.cursorAfter,
          summary: result.summary,
          finishedAt: this.now.toISOString(),
          durationMs: Date.now() - started,
        }
      } catch (err) {
        record = {
          runId: `run-error-${this.now.getTime()}`,
          trigger,
          cursorBefore: 0,
          cursorAfter: 0,
          summary: emptySummary(),
          finishedAt: this.now.toISOString(),
          durationMs: Date.now() - started,
          error: err instanceof Error ? err.message : String(err),
        }
      }
      try {
        await this.deps.runs.append(record)
      } catch {
        // journal failure must not kill the scheduler
      }
      if (this.deps.notifier !== undefined) {
        await this.deps.notifier.notify(runNotification(record, this.deps.uiUrl))
      }
      this.deps.onTick?.(record)
      // Absorb the ingest jobs this run just completed so on_ingest cannot
      // retrigger on its own output. Runs while tickInFlight is still set,
      // so the poller cannot mark them as new triggers in the gap.
      if (this.deps.config.onIngest) await this.absorbTerminalJobs()
      return record
    } finally {
      this.tickInFlight = false
    }
  }

  /** Mark every currently-terminal ingest job as seen (no trigger). */
  private async absorbTerminalJobs(): Promise<void> {
    try {
      const jobs = await this.deps.store.listIngestJobs({
        status: TERMINAL,
        limit: 500,
      })
      for (const job of jobs) this.seenJobs.add(job.id)
    } catch {
      // store not ready / closed: skip this round
    }
  }

  private async pollIngestJobs(): Promise<void> {
    if (this.stopped || this.tickInFlight) return
    let jobs
    try {
      jobs = await this.deps.store.listIngestJobs({ status: TERMINAL, limit: 500 })
    } catch {
      return
    }
    let found = false
    for (const job of jobs) {
      if (!this.seenJobs.has(job.id)) {
        this.seenJobs.add(job.id)
        found = true
      }
    }
    if (!found) return
    // Debounce: each detection resets the timer so a burst of completions
    // produces a single run.
    if (this.debounceTimer !== undefined) this.clearTimeoutFn(this.debounceTimer)
    this.debounceTimer = this.setTimeoutFn(() => {
      this.debounceTimer = undefined
      void this.tick('ingest')
    }, this.deps.config.ingestDebounceMs)
  }
}

function emptySummary(): RunResult['summary'] {
  return {
    ingest: { jobs: [] },
    extract: { batches: 0, input: 0, ok: 0, errors: 0, deferred: 0, needsBrowser: 0, hitCap: false },
    enrich: { batches: 0, input: 0, ok: 0, errors: 0, deferred: 0, needsBrowser: 0, hitCap: false },
    swept: 0,
    needsAction: false,
    collections: { total: 0, collections: {} as RunResult['summary']['collections']['collections'], needsLoginHosts: [] },
  }
}
