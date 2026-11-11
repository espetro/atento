import { describe, expect, it, vi } from 'vitest'
import {
  EnrichmentSchema,
  RUN_STALE_MS,
  heartbeatStale,
  pidAlive,
  type RunJournalEntry,
  type RunJournalStatus,
} from '@atento/core'
import { enrichLink, enrichPending, createModelFromEnv, type EnrichModel } from '../src/run.js'
import { buildPrompt } from '../src/prompt.js'
import { ENRICHMENT_JSON_SCHEMA, parseEnrichment } from '../src/chat.js'
import type { Link, Store, Enrichment } from '@atento/core'

const modelId = 'mock-enricher'

function mockModel(rawOutput: unknown, modelIdOverride = modelId): EnrichModel {
  return {
    modelId: modelIdOverride,
    generate: async () => ({ text: JSON.stringify(rawOutput), tokensIn: 100, tokensOut: 40 }),
  }
}

/** A model whose generate blocks on `gate`, for concurrency tests. */
function gatedModel(gate: Promise<void>, onCall?: () => void): EnrichModel {
  return {
    modelId,
    generate: async () => {
      onCall?.()
      await gate
      return { text: JSON.stringify(validEnrichment), tokensIn: 100, tokensOut: 40 }
    },
  }
}

function throwingModel(message: string): EnrichModel {
  return {
    modelId,
    generate: async () => {
      throw new Error(message)
    },
  }
}

const validEnrichment = {
  category: 'job',
  priority: 'high',
  why_it_matters: 'Role matches your saved search.',
  read_minutes: 4,
  action: 'read_now',
  expires_at: '2026-12-01T00:00:00.000Z',
  expiry_reason: 'job posting',
  confidence: 0.9,
}

const now = () => new Date('2026-10-29T12:00:00Z')

const baseLink: Link = {
  id: 1,
  urlHash: 'hash-1',
  url: 'https://example.com/job',
  title: 'Senior Engineer at Example',
  source: 'markdown',
  addedAt: new Date('2026-10-28T00:00:00Z'),
  note: null,
  tags: null,
  extractedContent: 'We are hiring a senior engineer...',
  extractedAt: new Date('2026-10-28T00:00:00Z'),
  enrichment: null,
  expiresAt: null,
  expiryReason: null,
  status: 'inbox',
  category: null,
  priority: null,
  action: null,
  confidence: null,
  readMinutes: null,
  needsBrowser: false,
  createdAt: new Date('2026-10-28T00:00:00Z'),
  updatedAt: new Date('2026-10-28T00:00:00Z'),
}

function makeLink(overrides: Partial<Link> = {}): Link {
  return { ...baseLink, ...overrides }
}

interface JournalRow {
  stage: string
  status: RunJournalStatus
  pid: number | null
  startedAt: Date
  heartbeatAt: Date | null
}

function makeStore(links: Link[] = [makeLink()]) {
  const state = { links: structuredClone(links) as Link[] }
  const calls = { setEnrichment: 0, setExpiry: 0, heartbeat: 0 }
  // Minimal run journal: acquireRun is the only writer of 'running' rows,
  // heartbeatRun refreshes them, reclaimDeadRuns mirrors the store rule
  // (dead pid OR stale heartbeat => crashed).
  const journal = new Map<number, JournalRow>()
  let nextRunId = 0
  const journalEntry = (id: number): RunJournalEntry => {
    const j = journal.get(id)!
    return {
      id,
      stage: j.stage,
      status: j.status,
      pid: j.pid,
      startedAt: j.startedAt,
      heartbeatAt: j.heartbeatAt,
      finishedAt: null,
    }
  }
  const store: Store = {
    upsertLink: async () => {
      throw new Error('not implemented')
    },
    getLink: async (id) => state.links.find((l) => l.id === id) ?? null,
    getLinkByUrlHash: async () => null,
    listLinks: async () => state.links,
    countLinks: async () => state.links.length,
    updateStatus: async () => 0,
    deleteLinks: async () => 0,
    setEnrichment: async (id, enrichment: Enrichment) => {
      calls.setEnrichment += 1
      const link = state.links.find((l) => l.id === id)
      if (link) {
        link.enrichment = enrichment
        link.category = enrichment.category
        link.action = enrichment.action
        if (enrichment.expires_at) link.expiresAt = new Date(enrichment.expires_at)
      }
      return 1
    },
    setExpiry: async (id, expiresAt, expiryReason) => {
      calls.setExpiry += 1
      const link = state.links.find((l) => l.id === id)
      if (link) {
        link.expiresAt = expiresAt
        link.expiryReason = expiryReason
      }
      return 1
    },
    setExtractedContent: async () => 1,
    reclaimLeasesForRuns: async () => 0,
    acquireRun: async (stage, opts = {}) => {
      const at = opts.now ?? new Date()
      const pid = opts.pid ?? process.pid
      const holderId = [...journal.entries()].find(
        ([, j]) => j.stage === stage && j.status === 'running',
      )?.[0]
      if (holderId !== undefined) {
        return { ok: false as const, busy: journalEntry(holderId) }
      }
      nextRunId += 1
      journal.set(nextRunId, { stage, status: 'running', pid, startedAt: at, heartbeatAt: at })
      return { ok: true as const, run: journalEntry(nextRunId) }
    },
    heartbeatRun: async (id) => {
      calls.heartbeat += 1
      const j = journal.get(id)
      if (j?.status === 'running') j.heartbeatAt = new Date()
    },
    listRunningRuns: async () =>
      [...journal.entries()]
        .filter(([, j]) => j.status === 'running')
        .map(([id]) => journalEntry(id)),
    reclaimDeadRuns: async (opts = {}) => {
      const at = opts.now ?? new Date()
      const staleMs = opts.heartbeatStaleMs ?? RUN_STALE_MS
      const alive = opts.pidAlive ?? pidAlive
      const crashed: RunJournalEntry[] = []
      for (const [id, j] of journal) {
        if (j.status !== 'running') continue
        const entry = journalEntry(id)
        const pidDead = entry.pid !== null && !alive(entry.pid)
        const stale = heartbeatStale(entry, at, staleMs)
        if (!pidDead && !stale) continue
        j.status = 'crashed'
        crashed.push({ ...entry, status: 'crashed' })
      }
      return crashed
    },
    createIngestJob: async () => { throw new Error('not implemented') },
    getIngestJob: async () => null,
    updateIngestJob: async () => {},
    listIngestJobs: async () => [],
    commitIngestChunk: async () => { throw new Error('not implemented') },
    startRun: async (stage, inputCount, startedAt) => {
      nextRunId += 1
      // Legacy metrics row: non-'running', never a journal lock.
      journal.set(nextRunId, {
        stage,
        status: 'done',
        pid: process.pid,
        startedAt: startedAt ?? new Date(),
        heartbeatAt: startedAt ?? new Date(),
      })
      return {
        id: nextRunId,
        stage,
        startedAt: startedAt ?? new Date(),
        finishedAt: null,
        inputCount,
        okCount: 0,
        errorCount: 0,
        durationMs: null,
        tokensIn: null,
        tokensOut: null,
        costUsd: null,
      }
    },
    finishRun: async (id, result) => {
      const j = journal.get(id)
      if (j) j.status = result.status ?? 'done'
    },
    addMetric: async () => {},
    listMetrics: async () => [],
    listProfiles: async () => [],
    getProfile: async () => null,
    upsertProfile: async () => {
      throw new Error('not implemented')
    },
    deleteProfile: async () => 0,
    getMeta: async () => null,
    setMeta: async () => {},
    schemaVersion: async () => '0',
    migrate: async () => {},
    close: async () => {},
  }
  return { store, state, calls }
}

describe('schema', () => {
  it('re-exports EnrichmentSchema from core', () => {
    expect(EnrichmentSchema.safeParse(validEnrichment).success).toBe(true)
    expect(EnrichmentSchema.safeParse({ ...validEnrichment, priority: 'urgent' }).success).toBe(false)
  })
})

describe('prompt', () => {
  it('includes today as an input', () => {
    const { system, user } = buildPrompt({ link: makeLink(), now: new Date('2026-10-29T12:00:00Z') })
    expect(system).toContain('2026-10-29')
    expect(user).toContain('Today: 2026-10-29')
    expect(user).toContain('https://example.com/job')
    expect(user).toContain('We are hiring')
  })

  it('truncates extracted content', () => {
    const link = makeLink({ extractedContent: 'x'.repeat(20000) })
    const { user } = buildPrompt({ link, contentMaxChars: 100 })
    expect(user).toContain('x'.repeat(100))
    expect(user.length).toBeLessThan(1000)
  })
})

describe('enrichLink', () => {
  it('returns enrichment, usage and modelId on valid output', async () => {
    const result = await enrichLink(makeLink(), { model: mockModel(validEnrichment), now })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.enrichment.category).toBe('job')
    expect(result.usage).toEqual({ tokensIn: 100, tokensOut: 40 })
    expect(result.modelId).toBe('mock-enricher')
  })

  it('returns an error result on invalid output', async () => {
    const result = await enrichLink(makeLink(), {
      model: mockModel({ ...validEnrichment, priority: 'urgent', confidence: 5 }),
      now,
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.stage).toBe('parse')
    expect(typeof result.error).toBe('string')
  })

  it('returns an error result on model failure', async () => {
    const failing = throwingModel('gateway timeout')
    const result = await enrichLink(makeLink(), { model: failing, now })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.stage).toBe('model')
    expect(result.error).toContain('gateway timeout')
  })

  it('re-repairs via EnrichmentSchema so extra fields are stripped', async () => {
    const result = await enrichLink(makeLink(), {
      model: mockModel({ ...validEnrichment, extra: 'noise' }),
      now,
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.enrichment).not.toHaveProperty('extra')
  })
})

describe('enrichPending', () => {
  it('enriches pending inbox links and records usage', async () => {
    const { store, state, calls } = makeStore([makeLink({ id: 1 }), makeLink({ id: 2, enrichment: validEnrichment })])
    const summary = await enrichPending(store, { model: mockModel(validEnrichment), now })
    expect(summary.processed).toBe(1)
    expect(summary.okCount).toBe(1)
    expect(summary.tokensIn).toBe(100)
    expect(calls.setEnrichment).toBe(1)
    const enriched = state.links.find((l) => l.id === 1)
    expect(enriched?.enrichment?.category).toBe('job')
    expect(enriched?.expiresAt?.toISOString()).toBe('2026-12-01T00:00:00.000Z')
  })

  it('skips links without extracted content', async () => {
    const { store } = makeStore([makeLink({ extractedContent: null })])
    const summary = await enrichPending(store, { model: mockModel(validEnrichment), now })
    expect(summary.processed).toBe(0)
  })

  it('counts errors without throwing', async () => {
    const failing = throwingModel('boom')
    const { store, calls } = makeStore([makeLink({ id: 1 })])
    const summary = await enrichPending(store, { model: failing, now })
    expect(summary.processed).toBe(1)
    expect(summary.okCount).toBe(0)
    expect(summary.errorCount).toBe(1)
    expect(calls.setEnrichment).toBe(0)
  })

  it('respects limit', async () => {
    const { store, calls } = makeStore([makeLink({ id: 1 }), makeLink({ id: 2 })])
    const summary = await enrichPending(store, { model: mockModel(validEnrichment), now }, { limit: 1 })
    expect(summary.processed).toBe(1)
    expect(calls.setEnrichment).toBe(1)
  })

  it('holds the enrich journal lock: a concurrent acquireRun reports busy', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let modelCalled = false
    const { store } = makeStore([makeLink({ id: 1 })])
    const pending = enrichPending(store, {
      model: gatedModel(gate, () => {
        modelCalled = true
      }),
      now,
    })
    await vi.waitFor(() => expect(modelCalled).toBe(true))

    // While enrichPending works, the stage lock is held.
    const concurrent = await store.acquireRun('enrich', { pid: process.pid })
    expect(concurrent.ok).toBe(false)
    if (!concurrent.ok) expect(concurrent.busy.stage).toBe('enrich')

    // A second enrichPending reports busy instead of overlapping writes.
    const second = await enrichPending(store, { model: mockModel(validEnrichment), now })
    expect(second.processed).toBe(0)
    expect(second.busy?.stage).toBe('enrich')

    release()
    const summary = await pending
    expect(summary.processed).toBe(1)
    expect(summary.busy).toBeUndefined()

    // The lock is released once the run finishes.
    const after = await store.acquireRun('enrich', { pid: process.pid })
    expect(after.ok).toBe(true)
  })

  it('heartbeats the journal row while running so a live run is not reclaimed', async () => {
    vi.useFakeTimers()
    try {
      let release!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      let modelCalled = false
      const { store, calls } = makeStore([makeLink({ id: 1 })])
      const pending = enrichPending(store, {
        model: gatedModel(gate, () => {
          modelCalled = true
        }),
        now,
      })
      // Flush microtasks until the gated model call is in flight.
      for (let i = 0; i < 50 && !modelCalled; i++) {
        await vi.advanceTimersByTimeAsync(0)
      }
      expect(modelCalled).toBe(true)

      // Well past RUN_STALE_MS: without heartbeat refresh this row would
      // already be reclaimable as crashed while the run is still alive.
      await vi.advanceTimersByTimeAsync(RUN_STALE_MS + 1_000)
      expect(calls.heartbeat).toBeGreaterThan(0)
      const crashed = await store.reclaimDeadRuns()
      expect(crashed).toHaveLength(0)
      const concurrent = await store.acquireRun('enrich', { pid: process.pid })
      expect(concurrent.ok).toBe(false)

      release()
      const summary = await pending
      expect(summary.processed).toBe(1)
      expect((await store.acquireRun('enrich', { pid: process.pid })).ok).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('createModelFromEnv', () => {
  it('builds a model from env config', () => {
    const model = createModelFromEnv({
      OPENAI_COMPAT_BASE_URL: 'https://gw.example.com/v1',
      OPENAI_COMPAT_API_KEY: 'sk-test',
      ATENTO_MODEL: 'some-model',
    })
    expect(model.modelId).toBe('some-model')
  })

  it('throws when env is missing', () => {
    expect(() => createModelFromEnv({})).toThrow(/OPENAI_COMPAT_BASE_URL/)
  })
})

describe('chat model over fetch', () => {
  const env = { OPENAI_COMPAT_BASE_URL: 'http://gw.test/v1/', OPENAI_COMPAT_API_KEY: 'k', ATENTO_MODEL: 'm-1' }

  it('posts a json_schema chat completion and parses usage', async () => {
    const seen: { url: string; init: RequestInit }[] = []
    const real = globalThis.fetch
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      seen.push({ url, init })
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify(validEnrichment) } }],
          usage: { prompt_tokens: 11, completion_tokens: 7 },
        }),
        { status: 200 },
      )
    }) as typeof fetch
    try {
      const result = await enrichLink(makeLink(), { model: createModelFromEnv(env), now })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.usage).toEqual({ tokensIn: 11, tokensOut: 7 })
      expect(result.modelId).toBe('m-1')
      expect(seen[0]!.url).toBe('http://gw.test/v1/chat/completions')
      const body = JSON.parse(String(seen[0]!.init.body))
      expect(body.model).toBe('m-1')
      expect(body.response_format.type).toBe('json_schema')
      expect((seen[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer k')
    } finally {
      globalThis.fetch = real
    }
  })

  it('reports an HTTP error as a model-stage failure', async () => {
    const real = globalThis.fetch
    globalThis.fetch = (async () => new Response('nope', { status: 500 })) as typeof fetch
    try {
      const result = await enrichLink(makeLink(), { model: createModelFromEnv(env), now })
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.stage).toBe('model')
        expect(result.error).toContain('HTTP 500')
      }
    } finally {
      globalThis.fetch = real
    }
  })

  it('hand validator agrees with EnrichmentSchema', () => {
    const cases: unknown[] = [
      validEnrichment,
      { ...validEnrichment, priority: 'urgent' },
      { ...validEnrichment, confidence: 1.5 },
      { ...validEnrichment, read_minutes: 2.5 },
      { ...validEnrichment, read_minutes: -1 },
      { ...validEnrichment, category: '' },
      { ...validEnrichment, expires_at: null, expiry_reason: null },
      { ...validEnrichment, expires_at: 5 },
      { ...validEnrichment, action: 'later' },
      { ...validEnrichment, why_it_matters: undefined },
    ]
    for (const c of cases) {
      expect(parseEnrichment(JSON.stringify(c)).ok).toBe(EnrichmentSchema.safeParse(c).success)
    }
  })

  it('accepts fenced JSON and rejects garbage', () => {
    expect(parseEnrichment('```json\n' + JSON.stringify(validEnrichment) + '\n```').ok).toBe(true)
    expect(parseEnrichment('not json').ok).toBe(false)
  })

  it('keeps ENRICHMENT_JSON_SCHEMA in step with the schema keys', () => {
    const schema = JSON.parse(ENRICHMENT_JSON_SCHEMA)
    expect(Object.keys(schema.properties).sort()).toEqual(Object.keys(validEnrichment).sort())
    expect([...schema.required].sort()).toEqual(Object.keys(validEnrichment).sort())
  })
})
