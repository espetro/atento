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
 * `store.listIngestJobs` for terminal (done/failed) jobs. Tracking is
 * watermark-based, NOT a seen-set: each poll asks only for jobs whose
 * effective finish stamp (`finished_at`, falling back to `updated_at` —
 * failed jobs never set `finished_at`) is >= the watermark, so the scan
 * stays bounded no matter how much terminal-job history accumulates.
 * `boundaryIds` dedupes the jobs sitting exactly on the watermark stamp
 * (millisecond ties); it only ever holds ids at the current max stamp, so
 * it cannot grow unboundedly.
 *
 * Baseline: `start()` sets the watermark to now — jobs already terminal at
 * startup are history, not triggers, with no enumeration needed.
 *
 * Self-ingest absorption: after each tick the scheduler re-scans and advances
 * the watermark past the ingest jobs that run created (their ids come back
 * in `summary.ingest.jobs`). External jobs that completed *during* the run
 * are NOT absorbed — they arm the debounce and get their own follow-up run
 * (strictly better than dropping them). After a FAILED run we cannot know
 * which jobs were ours, so everything fresh is absorbed to avoid a
 * retry-forever loop.
 *
 * Known drop: `stop()` clears an armed debounce timer, so completions seen
 * just before shutdown never trigger a run. Their links are still picked up
 * by the next scheduled tick or external ingest — acceptable for a service
 * that is going away anyway.
 */
import { Cron } from 'croner'
import type { IngestJob, RunResult, Store } from '@linkinbox/app'
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
  /** Called for non-fatal scheduler warnings (e.g. stop timeout). */
  warn?: (message: string) => void
  /** How long stop() waits for an in-flight tick. Default 30s. */
  stopTimeoutMs?: number
}

const TERMINAL: IngestJobStatus[] = ['done', 'failed']
/** Poll page size; the watermark makes truncation self-healing. */
const POLL_LIMIT = 500
/** stop() default bound on waiting for an in-flight tick. */
const DEFAULT_STOP_TIMEOUT_MS = 30_000

export class HarnessScheduler {
  private readonly deps: SchedulerDeps
  private cron: Cron | undefined
  private pollTimer: unknown
  private debounceTimer: unknown
  private tickInFlight = false
  private stopped = false
  /**
   * Effective finish stamp below which jobs are history. Set to `now` at
   * start() (baseline) and advanced after every scan. null before start().
   */
  private watermark: Date | null = null
  /**
   * Ids of jobs sitting exactly on the watermark stamp — already accounted
   * for, so `>=` queries don't retrigger them. Cleared whenever the
   * watermark advances; bounded by jobs-per-millisecond.
   */
  private readonly boundaryIds = new Set<string>()

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
      // Baseline: jobs finished before the scheduler started are history.
      // No enumeration needed — the watermark alone excludes them, however
      // much terminal-job history has accumulated.
      this.watermark = this.now
      this.pollTimer = this.setIntervalFn(() => {
        void this.pollIngestJobs()
      }, this.deps.config.ingestPollMs)
    }
  }

  /** Stop timers and wait (bounded) for any in-flight tick. Idempotent. */
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
    // Wait out an in-flight run so shutdown does not orphan app.run — but
    // bounded: a wedged run must not hang the service stop forever.
    const timeoutMs = this.deps.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS
    const deadline = Date.now() + timeoutMs
    while (this.tickInFlight && Date.now() < deadline) {
      await new Promise((res) => setTimeout(res, 50))
    }
    if (this.tickInFlight) {
      this.deps.warn?.(
        `linkinbox-harness: stop timed out after ${timeoutMs}ms with a run still in flight`,
      )
    }
  }

  /**
   * One run tick: app.run → journal record → notification. Overlapping
   * triggers return null immediately. Errors are journaled and notified,
   * never thrown into the timer callback; notifier/onTick failures are
   * swallowed so tick's contract (record or null, never a rejection from
   * post-run steps) holds.
   */
  async tick(trigger: RunTrigger): Promise<HarnessRunRecord | null> {
    if (this.tickInFlight || this.stopped) return null
    this.tickInFlight = true
    const started = Date.now()
    try {
      let record: HarnessRunRecord
      let selfJobIds: Set<string> | null = null
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
        selfJobIds = new Set(result.summary.ingest.jobs.map((j) => j.jobId))
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
        try {
          await this.deps.notifier.notify(runNotification(record, this.deps.uiUrl))
        } catch {
          // notification failure must not escape tick
        }
      }
      try {
        this.deps.onTick?.(record)
      } catch {
        // observer failure must not escape tick
      }
      // Absorb the ingest jobs this run just finished so on_ingest cannot
      // retrigger on its own output — while tickInFlight is still set, so
      // the poller cannot interleave. External completions during the run
      // are left fresh and arm the debounce for a follow-up run.
      if (this.deps.config.onIngest) {
        await this.reconcileAfterTick(selfJobIds)
      }
      return record
    } finally {
      this.tickInFlight = false
    }
  }

  /** Effective finish stamp of a terminal job (finished_at ?? updated_at). */
  private jobStamp(job: IngestJob): number {
    return (job.finishedAt ?? job.updatedAt).getTime()
  }

  /** Terminal jobs at or after the watermark (bounded by POLL_LIMIT). */
  private async scanTerminalJobs(): Promise<IngestJob[]> {
    try {
      return await this.deps.store.listIngestJobs({
        status: TERMINAL,
        finishedAfter: this.watermark ?? new Date(0),
        limit: POLL_LIMIT,
      })
    } catch {
      return []
    }
  }

  /** Jobs in the batch not yet accounted for by the watermark/boundary. */
  private freshJobs(jobs: IngestJob[]): IngestJob[] {
    const wm = this.watermark?.getTime()
    return jobs.filter((job) => {
      const stamp = this.jobStamp(job)
      if (wm === undefined) return true
      if (stamp > wm) return true
      if (stamp === wm) return !this.boundaryIds.has(job.id)
      return false
    })
  }

  /**
   * Advance the watermark over a scanned batch. Ids sitting exactly on the
   * new max stamp go into boundaryIds so the `>=` query doesn't refire them;
   * jobs beyond POLL_LIMIT truncation keep stamp > watermark and are picked
   * up by the next scan.
   */
  private advanceWatermark(jobs: IngestJob[]): void {
    let max = this.watermark?.getTime() ?? Number.NEGATIVE_INFINITY
    for (const job of jobs) max = Math.max(max, this.jobStamp(job))
    if (max === Number.NEGATIVE_INFINITY) return
    if (this.watermark === null || max > this.watermark.getTime()) {
      this.watermark = new Date(max)
      this.boundaryIds.clear()
    }
    for (const job of jobs) {
      if (this.jobStamp(job) === max) this.boundaryIds.add(job.id)
    }
  }

  /** Arm (or re-arm) the debounced ingest-triggered run. */
  private armIngestDebounce(): void {
    // Each detection resets the timer so a burst of completions produces a
    // single run. If stop() clears this timer the trigger is dropped — see
    // the module docstring; the links are still picked up by the next tick.
    if (this.debounceTimer !== undefined) this.clearTimeoutFn(this.debounceTimer)
    this.debounceTimer = this.setTimeoutFn(() => {
      this.debounceTimer = undefined
      void this.tick('ingest')
    }, this.deps.config.ingestDebounceMs)
  }

  private async pollIngestJobs(): Promise<void> {
    if (this.stopped || this.tickInFlight) return
    const jobs = await this.scanTerminalJobs()
    if (jobs.length === 0) return
    const fresh = this.freshJobs(jobs)
    this.advanceWatermark(jobs)
    if (fresh.length === 0) return
    this.armIngestDebounce()
  }

  /**
   * Post-tick reconciliation: advance the watermark past everything the
   * scan sees, but only trigger on jobs this run did NOT ingest itself.
   * `selfJobIds === null` means the run failed — absorb everything to avoid
   * a retry-forever loop on a persistently failing pipeline.
   */
  private async reconcileAfterTick(selfJobIds: Set<string> | null): Promise<void> {
    const jobs = await this.scanTerminalJobs()
    if (jobs.length === 0) return
    const fresh = this.freshJobs(jobs)
    this.advanceWatermark(jobs)
    if (selfJobIds === null) return
    if (fresh.some((job) => !selfJobIds.has(job.id))) {
      this.armIngestDebounce()
    }
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
