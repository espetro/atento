/**
 * Run journal: the durable-execution primitives shared by the pipeline
 * stages and the store implementations.
 *
 * A "run" is one stage pass (ingest, extract, enrich) or one ingest job.
 * Its journal row lives in the `runs` table with `status='running'`, the OS
 * pid and a heartbeat. While the run works the heartbeat is refreshed on an
 * interval; when the process dies the row stays `running` until the next
 * start marks it `crashed` — either because the pid is gone
 * (`process.kill(pid, 0)`) or because the heartbeat went stale.
 *
 * Heartbeat policy (documented choice): the heartbeat is refreshed on a
 * timer, not per link, so a single slow link (a browser dwell, a long LLM
 * call) can never make a live run look dead. `RUN_HEARTBEAT_MS` is the
 * interval; `RUN_STALE_MS` is the staleness threshold — two missed beats,
 * per the phase-2 plan. The pid check is the primary crash detector and
 * needs no waiting at all; the heartbeat covers pid reuse and platforms
 * where `kill(pid, 0)` cannot prove death.
 */
import type { Store, RunJournalEntry } from './store.js'
import type { BusyRun } from './pipeline/types.js'

export type { RunJournalEntry }

/** How often a live run refreshes its journal heartbeat. */
export const RUN_HEARTBEAT_MS = 15_000

/** A heartbeat older than this marks the run crashed. 2 × RUN_HEARTBEAT_MS. */
export const RUN_STALE_MS = 2 * RUN_HEARTBEAT_MS

/**
 * Is `pid` a live process? `process.kill(pid, 0)` sends no signal: it only
 * checks existence. ESRCH means dead, EPERM means alive-but-not-ours.
 * Non-POSIX platforms and unexpected errors answer "alive" — the heartbeat
 * check is the fallback that still catches the crash.
 */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'EPERM') return true
    if (code === 'ESRCH') return false
    // Unknown platform behaviour: assume alive, heartbeat decides.
    return true
  }
}

/**
 * True when the run's last sign of life (`heartbeatAt`, falling back to
 * `startedAt`) is older than `staleMs` relative to `now`.
 */
export function heartbeatStale(
  entry: { heartbeatAt: Date | null; startedAt: Date },
  now: Date,
  staleMs: number,
): boolean {
  const lastSeen = entry.heartbeatAt ?? entry.startedAt
  return now.getTime() - lastSeen.getTime() > staleMs
}

/**
 * Refresh a run's heartbeat on an interval until the returned stop function
 * is called. The timer is unref'd so it never holds the process open, and
 * heartbeat failures are swallowed: a closed store must not crash the run.
 * `at` is the clock the caller uses for journal time (usually the stage's
 * injected `now`), so fake clocks in tests stay consistent.
 */
export function startRunHeartbeat(
  store: Store,
  runId: number,
  at: () => Date = () => new Date(),
  intervalMs: number = RUN_HEARTBEAT_MS,
): () => void {
  const timer = setInterval(() => {
    void store.heartbeatRun(runId, at()).catch(() => {})
  }, intervalMs)
  timer.unref?.()
  return () => clearInterval(timer)
}

/** The `busy` payload a stage result carries when the lock is held. */
export function busyRunOf(entry: RunJournalEntry): BusyRun {
  return {
    runId: entry.id,
    stage: entry.stage,
    pid: entry.pid,
    startedAt: entry.startedAt,
    heartbeatAt: entry.heartbeatAt,
  }
}

/**
 * Crash recovery for pipeline start: mark every dead/stale `running` journal
 * row `crashed`, then return their leases to the queues. This is what makes
 * a `run` after a crash resume where the FSM left off — the FSM state is
 * the checkpoint, the journal only says who died.
 *
 * Returns the number of leases reclaimed.
 */
export async function reclaimCrashedRuns(
  store: Store,
  opts: { now?: Date; heartbeatStaleMs?: number; pidAlive?: (pid: number) => boolean } = {},
): Promise<number> {
  const crashed = await store.reclaimDeadRuns(opts)
  return store.reclaimLeasesForRuns(
    crashed.map((r) => r.id),
    opts.now,
  )
}
