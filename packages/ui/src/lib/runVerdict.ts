import type { RunJournalRow, RunResult } from './types'

export type RunVerdict = {
  code: number
  tone: 'ok' | 'warn' | 'bad' | 'neutral'
  text: string
}

/**
 * Maps a run outcome onto the CLI exit-code legend:
 *   0 done / all clear · 2 finished, needs human action ·
 *   1 failure · 3 busy (a stage skipped because another run held its lock).
 *
 * Priority: explicit error > in-flight busy response > stage-level busy
 * (exit 3) > needsAction (exit 2) > clean (exit 0). When only the journal
 * is known (no RunResult), a failed/erroring row means exit 1.
 */
export function runVerdict(input: {
  runResult: RunResult | null
  latestRun: RunJournalRow | null
  runError: string
  busyInfo: unknown
  liveRunning: boolean
}): RunVerdict | null {
  const { runResult, latestRun, runError, busyInfo, liveRunning } = input
  if (runError) return { code: 1, tone: 'bad', text: `Run failed — ${runError}` }
  if (busyInfo) return { code: 3, tone: 'neutral', text: 'Another run is in progress' }
  if (liveRunning && !runResult) return null // live panel covers it
  if (runResult) {
    const sum = runResult.summary
    if (sum.extract?.busy || sum.enrich?.busy) {
      return {
        code: 3,
        tone: 'neutral',
        text: 'A stage was skipped — another run held the lock',
      }
    }
    return sum.needsAction
      ? { code: 2, tone: 'warn', text: 'Last run finished — needs you' }
      : { code: 0, tone: 'ok', text: 'Last run finished — all clear' }
  }
  if (latestRun) {
    if (latestRun.errorCount > 0 || latestRun.status === 'failed') {
      return { code: 1, tone: 'bad', text: `Last run had errors (#${latestRun.id})` }
    }
    return { code: 0, tone: 'ok', text: 'Last run finished' }
  }
  return null
}
