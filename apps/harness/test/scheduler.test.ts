import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RunResult, Store } from '@linkinbox/app'
import type { IngestJob, IngestJobStatus } from '@linkinbox/core'
import { DEFAULT_HARNESS_CONFIG, type HarnessConfig } from '../src/config.js'
import { createRecordingNotifier } from '../src/notify.js'
import { createMemoryRunStore, createJsonlRunStore, type HarnessRunRecord } from '../src/runs.js'
import { HarnessScheduler } from '../src/scheduler.js'

const dirs: string[] = []
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
})

function makeRunResult(runId = 'run-test'): RunResult {
  return {
    runId,
    cursorBefore: 10,
    cursorAfter: 25,
    summary: {
      ingest: { jobs: [] },
      extract: { batches: 1, input: 5, ok: 5, errors: 0, deferred: 0, needsBrowser: 0, hitCap: false },
      enrich: { batches: 1, input: 5, ok: 4, errors: 1, deferred: 0, needsBrowser: 0, hitCap: false },
      swept: 2,
      needsAction: true,
      collections: {
        total: 8,
        collections: { needs_login: 3 } as RunResult['summary']['collections']['collections'],
        needsLoginHosts: [{ host: 'x.com', count: 3 }],
      },
    },
  }
}

function makeJob(id: string, status: IngestJobStatus): IngestJob {
  const now = new Date('2026-01-01T00:00:00Z')
  return {
    id,
    source: 'test',
    status,
    total: 1,
    done: status === 'done' ? 1 : 0,
    cursor: status === 'done' ? 1 : 0,
    spoolPath: null,
    runId: null,
    error: status === 'failed' ? 'nope' : null,
    createdAt: now,
    updatedAt: now,
    finishedAt: status === 'done' || status === 'failed' ? now : null,
  }
}

/** Minimal Store: only listIngestJobs is exercised by the scheduler. */
function fakeStore(jobs: IngestJob[]): Store {
  return {
    listIngestJobs: async (filter?: { status?: IngestJobStatus | IngestJobStatus[] }) => {
      if (filter?.status === undefined) return jobs
      const wanted = Array.isArray(filter.status) ? filter.status : [filter.status]
      return jobs.filter((j) => wanted.includes(j.status))
    },
  } as unknown as Store
}

function cfg(overrides: Partial<HarnessConfig> = {}): HarnessConfig {
  return { ...DEFAULT_HARNESS_CONFIG, ...overrides }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('HarnessScheduler.tick', () => {
  it('calls run once and persists the record with cursors', async () => {
    const runs = createMemoryRunStore()
    const notifier = createRecordingNotifier()
    let calls = 0
    const scheduler = new HarnessScheduler({
      run: async () => {
        calls++
        return makeRunResult()
      },
      store: fakeStore([]),
      config: cfg(),
      runs,
      notifier,
      uiUrl: 'http://127.0.0.1:4173',
    })
    const record = await scheduler.tick('manual')
    expect(calls).toBe(1)
    expect(record?.runId).toBe('run-test')
    expect(record?.cursorBefore).toBe(10)
    expect(record?.cursorAfter).toBe(25)
    expect(record?.trigger).toBe('manual')
    expect(runs.records).toHaveLength(1)
    expect(runs.records[0]).toEqual(record)
    expect(notifier.requests).toHaveLength(1)
    expect(notifier.requests[0]!.body).toContain('4 enriched, 3 need login')
  })

  it('drops overlapping ticks', async () => {
    const runs = createMemoryRunStore()
    let release!: () => void
    const gate = new Promise<void>((res) => (release = res))
    let calls = 0
    const scheduler = new HarnessScheduler({
      run: async () => {
        calls++
        await gate
        return makeRunResult()
      },
      store: fakeStore([]),
      config: cfg(),
      runs,
    })
    const first = scheduler.tick('cron')
    const second = await scheduler.tick('ingest')
    expect(second).toBeNull()
    release()
    await first
    expect(calls).toBe(1)
  })

  it('journals run failures instead of throwing', async () => {
    const runs = createMemoryRunStore()
    const scheduler = new HarnessScheduler({
      run: async () => {
        throw new Error('pipeline exploded')
      },
      store: fakeStore([]),
      config: cfg(),
      runs,
    })
    const record = await scheduler.tick('cron')
    expect(record?.error).toBe('pipeline exploded')
    expect(runs.records[0]?.error).toBe('pipeline exploded')
  })
})

describe('HarnessScheduler on_ingest', () => {
  it('ignores jobs already terminal at startup (baseline)', async () => {
    const jobs = [makeJob('old-1', 'done')]
    const runs = createMemoryRunStore()
    let calls = 0
    const scheduler = new HarnessScheduler({
      run: async () => {
        calls++
        return makeRunResult()
      },
      store: fakeStore(jobs),
      config: cfg({ onIngest: true, ingestPollMs: 10, ingestDebounceMs: 15 }),
      runs,
    })
    scheduler.start()
    await sleep(80)
    await scheduler.stop()
    expect(calls).toBe(0)
    expect(runs.records).toHaveLength(0)
  })

  it('debounces completions into a single ingest-triggered run', async () => {
    const jobs: IngestJob[] = []
    const store = fakeStore(jobs)
    const runs = createMemoryRunStore()
    let calls = 0
    const scheduler = new HarnessScheduler({
      run: async () => {
        calls++
        return makeRunResult()
      },
      store,
      config: cfg({ onIngest: true, ingestPollMs: 10, ingestDebounceMs: 30 }),
      runs,
    })
    scheduler.start()
    await sleep(30) // let the baseline absorb settle
    // Two jobs complete inside the debounce window → one run.
    jobs.push(makeJob('j1', 'done'), makeJob('j2', 'done'))
    await sleep(150)
    expect(calls).toBe(1)
    expect(runs.records[0]?.trigger).toBe('ingest')
    // A later completion triggers another run.
    jobs.push(makeJob('j3', 'failed'))
    await sleep(150)
    expect(calls).toBe(2)
    await scheduler.stop()
  })

  it('does not retrigger on ingest jobs completed by its own run', async () => {
    const jobs: IngestJob[] = []
    const store = fakeStore(jobs)
    const runs = createMemoryRunStore()
    let calls = 0
    const scheduler = new HarnessScheduler({
      run: async () => {
        calls++
        // Simulate the run's own ingest job completing mid-run.
        jobs.push(makeJob(`self-${calls}`, 'done'))
        return makeRunResult()
      },
      store,
      config: cfg({ onIngest: true, ingestPollMs: 10, ingestDebounceMs: 20 }),
      runs,
    })
    scheduler.start()
    // Manual tick first so a run happens while on_ingest is armed.
    await scheduler.tick('manual')
    expect(calls).toBe(1)
    // Wait well past poll + debounce: the self-ingested job must not fire.
    await sleep(150)
    expect(calls).toBe(1)
    await scheduler.stop()
  })
})

describe('HarnessScheduler schedule', () => {
  it('throws on an invalid cron expression at start', () => {
    const scheduler = new HarnessScheduler({
      run: async () => makeRunResult(),
      store: fakeStore([]),
      config: cfg({ schedule: 'not a cron' }),
      runs: createMemoryRunStore(),
    })
    expect(() => scheduler.start()).toThrow()
  })

  it('accepts a valid cron expression', () => {
    const scheduler = new HarnessScheduler({
      run: async () => makeRunResult(),
      store: fakeStore([]),
      config: cfg({ schedule: '0 6 * * *' }),
      runs: createMemoryRunStore(),
    })
    expect(() => scheduler.start()).not.toThrow()
    return scheduler.stop()
  })
})

describe('jsonl run store', () => {
  it('appends and lists records newest-first', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'linkinbox-harness-runs-'))
    dirs.push(dir)
    const path = join(dir, 'harness_runs.jsonl')
    const store = createJsonlRunStore(path)
    const base: HarnessRunRecord = {
      runId: 'r1',
      trigger: 'cron',
      cursorBefore: 0,
      cursorAfter: 1,
      summary: makeRunResult().summary,
      finishedAt: '2026-01-01T00:00:00Z',
      durationMs: 1,
    }
    await store.append(base)
    await store.append({ ...base, runId: 'r2' })
    const all = await store.list()
    expect(all.map((r) => r.runId)).toEqual(['r2', 'r1'])
    expect(await store.list(1)).toHaveLength(1)
    // Corrupt lines are skipped.
    const { appendFileSync } = await import('node:fs')
    appendFileSync(path, 'not json\n')
    expect((await store.list()).length).toBe(2)
  })
})
