import { describe, expect, it } from 'vitest'
import { runVerdict } from '../src/lib/runVerdict'
import type { RunJournalRow, RunResult } from '../src/lib/types'

function result(overrides: {
  extract?: Record<string, unknown>
  enrich?: Record<string, unknown>
  needsAction?: boolean
}): RunResult {
  return {
    runId: 'r1',
    cursorBefore: 0,
    cursorAfter: 0,
    summary: {
      ingest: { jobs: [] },
      extract: { input: 10, ok: 10, errors: 0, ...overrides.extract },
      enrich: { input: 10, ok: 10, errors: 0, ...overrides.enrich },
      swept: 0,
      needsAction: overrides.needsAction ?? false,
      collections: {},
    },
  } as RunResult
}

const journal = (over: Partial<RunJournalRow>): RunJournalRow => ({
  id: 1,
  stage: 'run',
  status: 'done',
  pid: null,
  startedAt: '',
  heartbeatAt: null,
  finishedAt: null,
  inputCount: 0,
  okCount: 0,
  errorCount: 0,
  durationMs: null,
  tokensIn: null,
  tokensOut: null,
  costUsd: null,
  ...over,
})

const base = { runResult: null, latestRun: null, runError: '', busyInfo: null, liveRunning: false }

describe('runVerdict', () => {
  it('exit 0 when a run finishes clean', () => {
    expect(runVerdict({ ...base, runResult: result({}) })?.code).toBe(0)
  })

  it('exit 2 when needsAction is set', () => {
    expect(runVerdict({ ...base, runResult: result({ needsAction: true }) })?.code).toBe(2)
  })

  it('exit 3 when a stage summary carries busy', () => {
    const busy = { runId: 'other', pid: 42 }
    expect(runVerdict({ ...base, runResult: result({ enrich: { busy } }) })?.code).toBe(3)
    expect(runVerdict({ ...base, runResult: result({ extract: { busy } }) })?.code).toBe(3)
  })

  it('stage busy beats needsAction (exit 3 over 2)', () => {
    const v = runVerdict({
      ...base,
      runResult: result({ needsAction: true, extract: { busy: { runId: 'x' } } }),
    })
    expect(v?.code).toBe(3)
  })

  it('exit 1 on run error and on failed journal rows', () => {
    expect(runVerdict({ ...base, runError: 'boom' })?.code).toBe(1)
    expect(runVerdict({ ...base, latestRun: journal({ errorCount: 2 }) })?.code).toBe(1)
    expect(runVerdict({ ...base, latestRun: journal({ status: 'failed' }) })?.code).toBe(1)
  })

  it('busy POST response maps to exit 3', () => {
    expect(runVerdict({ ...base, busyInfo: { runId: 7 } })?.code).toBe(3)
  })

  it('returns null while a live run is in flight', () => {
    expect(runVerdict({ ...base, liveRunning: true })).toBeNull()
  })
})
