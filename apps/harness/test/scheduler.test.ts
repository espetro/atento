import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RunResult, Store } from '@atento/app'
import type { IngestJob, IngestJobStatus } from '@atento/core'
import { DEFAULT_HARNESS_CONFIG, type HarnessConfig } from '../src/config.js'
import { createRecordingNotifier } from '../src/notify.js'
import { createMemoryRunStore, createJsonlRunStore, type HarnessRunRecord } from '../src/runs.js'
import { HarnessScheduler } from '../src/scheduler.js'

const dirs: string[] = []
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
})

function makeRunResult(runId = 'run-test', ingestJobIds: string[] = []): RunResult {
  return {
    runId,
    cursorBefore: 10,
    cursorAfter: 25,
    summary: {
      ingest: {
        jobs: ingestJobIds.map((jobId) => ({
          jobId,
          accepted: 1,
          duplicates: 0,
          rejected: 0,
          status: 'done' as const,
          warnings: [],
        })),
      },
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

/**
 * Ingest job with a controllable finish stamp. `stamp` defaults to now —
 * the scheduler's watermark is "now" at start(), so tests that want a job
 * to count as new must stamp it at/after start; tests for baseline history
 * stamp it in the past.
 */
function makeJob(
  id: string,
  status: IngestJobStatus,
  stamp: Date = new Date(),
): IngestJob {
  const done = status === 'done'
  return {
    id,
    source: 'test',
    status,
    total: 1,
    done: done ? 1 : 0,
    cursor: done ? 1 : 0,
    spoolPath: null,
    runId: null,
    error: status === 'failed' ? 'nope' : null,
    createdAt: stamp,
    updatedAt: stamp,
    finishedAt: done ? stamp : null,
  }
}

/** Minimal Store honouring the same filters the scheduler uses. */
function fakeStore(jobs: IngestJob[]): Store {
  return {
    listIngestJobs: async (filter?: {
      status?: IngestJobStatus | IngestJobStatus[]
      limit?: number
      finishedAfter?: Date
    }) => {
      let out = jobs
      if (filter?.status !== undefined) {
        const wanted = Array.isArray(filter.status) ? filter.status : [filter.status]
        out = out.filter((j) => wanted.includes(j.status))
      }
      if (filter?.finishedAfter !== undefined) {
        const after = filter.finishedAfter.getTime()
        out = out.filter((j) => (j.finishedAt ?? j.updatedAt).getTime() >= after)
      }
      out = [...out].sort(
        (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id),
      )
      if (filter?.limit !== undefined) out = out.slice(0, filter.limit)
      return out
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

  it('swallows notifier and onTick failures', async () => {
    const runs = createMemoryRunStore()
    const scheduler = new HarnessScheduler({
      run: async () => makeRunResult(),
      store: fakeStore([]),
      config: cfg(),
      runs,
      notifier: {
        notify: async () => {
          throw new Error('notify broke')
        },
      },
      onTick: () => {
        throw new Error('observer broke')
      },
    })
    const record = await scheduler.tick('manual')
    expect(record?.runId).toBe('run-test')
  })
})

describe('HarnessScheduler on_ingest', () => {
  it('ignores jobs already terminal at startup (baseline)', async () => {
    // Stamps in the past — before the scheduler's start() watermark.
    const past = new Date(Date.now() - 60_000)
    const jobs = [makeJob('old-1', 'done', past)]
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
    await sleep(30) // let the baseline settle
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
        // Simulate the run's own ingest job completing mid-run; the run
        // result reports it so reconcile can tell it apart from external work.
        const id = `self-${calls}`
        jobs.push(makeJob(id, 'done'))
        return makeRunResult(`run-${calls}`, [id])
      },
      store,
      config: cfg({ onIngest: true, ingestPollMs: 10, ingestDebounceMs: 20 }),
      runs,
    })
    scheduler.start()
    await scheduler.tick('manual')
    expect(calls).toBe(1)
    // Wait well past poll + debounce: the self-ingested job must not fire.
    await sleep(150)
    expect(calls).toBe(1)
    await scheduler.stop()
  })

  it('triggers a follow-up run for external ingests that finish during a run', async () => {
    const jobs: IngestJob[] = []
    const store = fakeStore(jobs)
    const runs = createMemoryRunStore()
    let calls = 0
    const scheduler = new HarnessScheduler({
      run: async () => {
        calls++
        if (calls === 1) {
          // An external ingest completes while our run is in flight.
          jobs.push(makeJob('external-1', 'done'))
        }
        return makeRunResult(`run-${calls}`)
      },
      store,
      config: cfg({ onIngest: true, ingestPollMs: 10, ingestDebounceMs: 20 }),
      runs,
    })
    scheduler.start()
    await scheduler.tick('manual')
    expect(calls).toBe(1)
    // The external job was NOT absorbed — it arms the debounce.
    await sleep(150)
    expect(calls).toBe(2)
    await scheduler.stop()
  })

  it('absorbs everything after a failed run (no retry-forever loop)', async () => {
    const jobs: IngestJob[] = []
    const store = fakeStore(jobs)
    const runs = createMemoryRunStore()
    let calls = 0
    const scheduler = new HarnessScheduler({
      run: async () => {
        calls++
        jobs.push(makeJob(`j-${calls}`, 'done'))
        throw new Error('always fails')
      },
      store,
      config: cfg({ onIngest: true, ingestPollMs: 10, ingestDebounceMs: 20 }),
      runs,
    })
    scheduler.start()
    await scheduler.tick('manual')
    expect(calls).toBe(1)
    await sleep(150)
    expect(calls).toBe(1)
    await scheduler.stop()
  })

  it('still fires on_ingest after >500 lifetime terminal jobs (regression)', async () => {
    // 600 old terminal jobs — the pre-fix poll (ASC + LIMIT 500) would only
    // ever see the oldest 500 and miss every new completion forever.
    const past = new Date(Date.now() - 3_600_000)
    const jobs: IngestJob[] = []
    for (let i = 0; i < 600; i++) jobs.push(makeJob(`old-${i}`, 'done', past))
    const store = fakeStore(jobs)
    const runs = createMemoryRunStore()
    let calls = 0
    const scheduler = new HarnessScheduler({
      run: async () => {
        calls++
        return makeRunResult()
      },
      store,
      config: cfg({ onIngest: true, ingestPollMs: 10, ingestDebounceMs: 20 }),
      runs,
    })
    scheduler.start()
    await sleep(30)
    jobs.push(makeJob('new-1', 'done'))
    await sleep(150)
    expect(calls).toBe(1)
    expect(runs.records[0]?.trigger).toBe('ingest')
    await scheduler.stop()
  })

  it('dedupes jobs sharing the watermark millisecond', async () => {
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
      config: cfg({ onIngest: true, ingestPollMs: 10, ingestDebounceMs: 20 }),
      runs,
    })
    scheduler.start()
    await sleep(30)
    // Same finish stamp for both — must trigger exactly once, not twice.
    const stamp = new Date()
    jobs.push(makeJob('tie-1', 'done', stamp), makeJob('tie-2', 'done', stamp))
    await sleep(150)
    expect(calls).toBe(1)
    await sleep(120)
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

describe('HarnessScheduler.stop', () => {
  it('warns and returns when an in-flight tick outlives the timeout', async () => {
    let release!: () => void
    const gate = new Promise<void>((res) => (release = res))
    const warnings: string[] = []
    const scheduler = new HarnessScheduler({
      run: async () => {
        await gate
        return makeRunResult()
      },
      store: fakeStore([]),
      config: cfg(),
      runs: createMemoryRunStore(),
      warn: (m) => warnings.push(m),
      stopTimeoutMs: 60,
    })
    const tick = scheduler.tick('cron')
    const stop = scheduler.stop()
    await stop
    expect(warnings.some((w) => w.includes('timed out'))).toBe(true)
    release()
    await tick
  })
})

describe('jsonl run store', () => {
  it('appends and lists records newest-first', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'atento-harness-runs-'))
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
