import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openStore, type SqliteStore } from '@atento/db'
import { createApp } from '../src/index.js'

let store: SqliteStore
let dir: string
let app: ReturnType<typeof createApp>

// Fresh store per test: SSE replay is journal-wide, so a shared db would
// leak earlier tests' link_events into later connections' backlogs.
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'atento-events-'))
  store = await openStore({ path: join(dir, 'test.db') })
  app = createApp(store, { env: {}, eventsPollMs: 40 })
})

afterEach(async () => {
  await store.close()
  rmSync(dir, { recursive: true, force: true })
})

async function seedLink(): Promise<number> {
  const suffix = Math.floor(Math.random() * 1e9)
  const link = await store.upsertLink({
    urlHash: `hash-${suffix}`,
    url: `https://example.com/ev-${suffix}`,
    title: 'event link',
    source: 'test',
    status: 'inbox',
    needsBrowser: false,
  })
  return link.id
}

async function triage(id: number): Promise<void> {
  const at = new Date().toISOString()
  await store.applyEvent(id, { type: 'TRIAGE', at, action: 'archive' }, 'created')
}

interface Frame {
  id: string | null
  event: string
  data: string
}

/** The composite resume cursor every frame id encodes. */
interface EventCursor {
  l: number
  r: number
  i: number
}

function parseEvtId(id: string): EventCursor {
  expect(id.startsWith('evt:')).toBe(true)
  return JSON.parse(id.slice(4)) as EventCursor
}

function parseFrame(block: string): Frame | null {
  if (block.trim() === '' || block.startsWith(':')) return null
  const frame: Frame = { id: null, event: 'message', data: '' }
  for (const line of block.split('\n')) {
    if (line.startsWith('id: ')) frame.id = line.slice(4)
    else if (line.startsWith('event: ')) frame.event = line.slice(7)
    else if (line.startsWith('data: ')) frame.data += line.slice(6)
  }
  return frame
}

interface SseClient {
  /**
   * Wait until at least `count` (default 1) frames of `event` have arrived.
   * Returns every matched frame seen, in order. Frames of other event
   * families stay queued for their own waitFor calls — the three families
   * share one stream, so per-family readers would eat each other's frames.
   */
  waitFor(event: string, count?: number, timeoutMs?: number): Promise<Frame[]>
  cancel(): Promise<void>
}

async function connectEvents(headers: Record<string, string> = {}): Promise<SseClient> {
  const res = await app.request('/api/events', { headers })
  expect(res.status).toBe(200)
  expect(res.headers.get('content-type')).toContain('text/event-stream')
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  const queue: Frame[] = []
  let buf = ''
  let ended = false
  // Single pump: every frame of every family lands in `queue`, so no
  // waitFor can starve or swallow another family's frames.
  void (async () => {
    try {
      for (;;) {
        const r = await reader.read()
        if (r.done) {
          ended = true
          return
        }
        buf += decoder.decode(r.value, { stream: true })
        let idx = buf.indexOf('\n\n')
        while (idx >= 0) {
          const frame = parseFrame(buf.slice(0, idx))
          if (frame !== null) queue.push(frame)
          buf = buf.slice(idx + 2)
          idx = buf.indexOf('\n\n')
        }
      }
    } catch {
      ended = true
    }
  })()

  const drain = (event: string, matched: Frame[]) => {
    for (let i = queue.length - 1; i >= 0; i--) {
      if (queue[i]!.event === event) matched.unshift(queue.splice(i, 1)[0]!)
    }
  }

  return {
    async waitFor(event, count = 1, timeoutMs = 4000) {
      const deadline = Date.now() + timeoutMs
      const matched: Frame[] = []
      for (;;) {
        drain(event, matched)
        if (matched.length >= count || ended) return matched
        if (Date.now() >= deadline) return matched
        await new Promise((r) => setTimeout(r, 5))
      }
    },
    async cancel() {
      await reader.cancel()
    },
  }
}

describe('GET /api/events (SSE)', () => {
  it('streams link state transitions with the composite cursor as the event id', async () => {
    const sse = await connectEvents()
    try {
      const id = await seedLink()
      await triage(id)
      const frames = await sse.waitFor('link', 1)
      expect(frames.length).toBe(1)
      const cursor = parseEvtId(frames[0]!.id!)
      const data = JSON.parse(frames[0]!.data) as { id: number; linkId: number; event: string }
      expect(cursor.l).toBe(data.id)
      expect(data.linkId).toBe(id)
      expect(data.event).toBe('TRIAGE')
    } finally {
      await sse.cancel()
    }
  })

  it('resumes after Last-Event-ID without gaps or duplicates', async () => {
    const id = await seedLink()
    // First connection: consume two events.
    const first = await connectEvents()
    await triage(id)
    const e1 = await first.waitFor('link', 1)
    expect(e1.length).toBe(1)
    // Second transition while still connected.
    const at = new Date().toISOString()
    await store.applyEvent(
      id,
      { type: 'RESTORE', at },
      'archived',
    )
    const e2 = await first.waitFor('link', 1)
    expect(e2.length).toBe(1)
    expect(parseEvtId(e2[0]!.id!).l).toBeGreaterThan(parseEvtId(e1[0]!.id!).l)
    const lastId = e2[0]!.id!
    await first.cancel()

    // Third transition happens while disconnected. RESTORE landed the link
    // in `inbox`, where TRIAGE archive is legal.
    await store.applyEvent(
      id,
      { type: 'TRIAGE', at: new Date().toISOString(), action: 'archive' },
      'inbox',
    )

    // Reconnect with Last-Event-ID: only link events with id > cursor.l arrive.
    const second = await connectEvents({ 'last-event-id': lastId })
    try {
      const frames = await second.waitFor('link', 1)
      expect(frames.length).toBe(1)
      expect(parseEvtId(frames[0]!.id!).l).toBeGreaterThan(parseEvtId(lastId).l)
      const data = JSON.parse(frames[0]!.data) as { event: string }
      expect(data.event).toBe('TRIAGE')
    } finally {
      await second.cancel()
    }
  })

  it('does not skip link/run/ingest events across a heartbeat gap on resume', async () => {
    // Regression: the old resume anchored the link cursor at the run's
    // CURRENT activity timestamp, so a heartbeat during the disconnect
    // pushed linkSince to ~now and silently skipped link events.
    const first = await connectEvents()
    const acquired = await store.acquireRun('extract', { pid: 4321 })
    expect(acquired.ok).toBe(true)
    if (!acquired.ok) return
    const runId = acquired.run.id
    const started = await first.waitFor('run', 1)
    expect(started.length).toBe(1)
    const lastId = started[0]!.id!
    await first.cancel()

    // While disconnected: heartbeat the run forward, then make one change
    // per family.
    await store.heartbeatRun(runId)
    const linkId = await seedLink()
    await triage(linkId)
    await store.createIngestJob({ id: 'job-gap-1', source: 'test' })

    const second = await connectEvents({ 'last-event-id': lastId })
    try {
      const linkFrames = await second.waitFor('link', 1)
      expect(linkFrames.length).toBe(1)
      const data = JSON.parse(linkFrames[0]!.data) as { linkId: number; event: string }
      expect(data.linkId).toBe(linkId)
      expect(data.event).toBe('TRIAGE')

      // The run's finish must also be announced after the gap. Resume
      // re-announces current state first (the still-running row), so scan
      // run frames until the finished status arrives.
      await store.finishRun(runId, { okCount: 1, errorCount: 0 })
      const deadline = Date.now() + 4000
      let finished: Frame | undefined
      while (finished === undefined && Date.now() < deadline) {
        let more: Frame[] = []
        try {
          more = await second.waitFor('run', 1, deadline - Date.now())
        } catch {
          break
        }
        finished = more.find((f) => {
          const d = JSON.parse(f.data) as { id: number; status: string | null }
          return d.id === runId && (d.status === 'done' || d.status === 'failed')
        })
      }
      expect(finished).toBeTruthy()

      const ingestFrames = await second.waitFor('ingest', 1)
      const job = ingestFrames.find((f) => f.data.includes('job-gap-1'))
      expect(job).toBeTruthy()
    } finally {
      await second.cancel()
    }
  })

  it('emits every pending run once when a low-id run finishes last (>500 candidates)', { timeout: 30_000 }, async () => {
    // Regression: drainRuns used to scan only the first 500 candidates by
    // run id while emitRun advanced the composite runMs floor to the max
    // announced activity. A low-id run finishing last pushed the floor
    // past higher-id pending runs, which were then skipped forever.
    const now = Date.now()
    const startedAt = new Date(now - 9_000)
    const midFinish = new Date(now - 8_000)
    const lastFinish = new Date(now)

    // 502 candidates: the FIRST seeded row has the lowest id and the
    // newest finishedAt — it "finishes last" inside the replay window.
    const ids: number[] = []
    const long = await store.startRun('enrich', 1, startedAt)
    ids.push(long.id)
    for (let i = 0; i < 501; i++) {
      const r = await store.startRun('enrich', 1, startedAt)
      ids.push(r.id)
      await store.finishRun(r.id, { finishedAt: midFinish, okCount: 1, errorCount: 0 })
    }
    await store.finishRun(long.id, { finishedAt: lastFinish, okCount: 1, errorCount: 0 })

    // Resume from an old cursor so the whole backlog is one candidate set.
    const lastEventId = `evt:${JSON.stringify({ l: 0, r: now - 10_000, i: 0 })}`
    const sse = await connectEvents({ 'last-event-id': lastEventId })
    try {
      const frames = await sse.waitFor('run', 502, 15_000)
      expect(frames.length).toBe(502)
      const emitted = frames.map((f) => (JSON.parse(f.data) as { id: number }).id)
      // Exactly once each: no skips, no duplicates.
      expect(new Set(emitted).size).toBe(502)
      for (const id of ids) expect(emitted).toContain(id)
    } finally {
      await sse.cancel()
    }
  })

  it('emits run start/finish events', async () => {
    const sse = await connectEvents()
    try {
      const acquired = await store.acquireRun('extract', { pid: 12345 })
      expect(acquired.ok).toBe(true)
      if (!acquired.ok) return
      const runId = acquired.run.id
      const frames = await sse.waitFor('run', 1)
      expect(frames.length).toBe(1)
      parseEvtId(frames[0]!.id!)
      const started = JSON.parse(frames[0]!.data) as { id: number; status: string | null }
      expect(started.id).toBe(runId)
      expect(started.status).toBe('running')

      await store.finishRun(runId, { okCount: 1, errorCount: 0 })
      // Consume 'run' frames until the finished status arrives.
      const deadline = Date.now() + 4000
      let finish: Frame | undefined
      while (Date.now() < deadline && finish === undefined) {
        let more: Frame[] = []
        try {
          more = await sse.waitFor('run', 1, deadline - Date.now())
        } catch {
          break
        }
        for (const f of more) {
          const d = JSON.parse(f.data) as { id: number; status: string | null }
          if (d.id === runId && (d.status === 'done' || d.status === 'failed')) finish = f
        }
      }
      expect(finish).toBeTruthy()
      parseEvtId(finish!.id!)
    } finally {
      await sse.cancel()
    }
  })

  it('emits ingest job progress events', async () => {
    const sse = await connectEvents()
    try {
      await store.createIngestJob({ id: 'job-sse-1', source: 'test' })
      const frames = await sse.waitFor('ingest', 1)
      expect(frames.length).toBe(1)
      parseEvtId(frames[0]!.id!)
      const data = JSON.parse(frames[0]!.data) as { jobId: string; status: string }
      expect(data.jobId).toBe('job-sse-1')
    } finally {
      await sse.cancel()
    }
  })

  it('fresh connect does not replay journal history', async () => {
    // Seed history BEFORE connecting: link events, a finished run and a
    // done ingest job.
    const id = await seedLink()
    await triage(id)
    const acquired = await store.acquireRun('extract', { pid: 1 })
    if (acquired.ok) await store.finishRun(acquired.run.id, { okCount: 0, errorCount: 0 })
    const job = await store.createIngestJob({ id: 'job-old', source: 'test' })
    await store.updateIngestJob(job.id, { status: 'done', finishedAt: new Date() })

    const sse = await connectEvents()
    try {
      // No history may be replayed: the FIRST frame of each family must be
      // the new work created after connect, never the seeded rows.
      const id2 = await seedLink()
      await triage(id2)
      const linkFrames = await sse.waitFor('link', 1)
      expect(linkFrames.length).toBe(1)
      const linkData = JSON.parse(linkFrames[0]!.data) as { linkId: number }
      expect(linkData.linkId).toBe(id2)

      const job2 = await store.createIngestJob({ id: 'job-new', source: 'test' })
      const ingestFrames = await sse.waitFor('ingest', 1)
      expect(ingestFrames.length).toBe(1)
      const ingestData = JSON.parse(ingestFrames[0]!.data) as { jobId: string }
      expect(ingestData.jobId).toBe(job2.id)

      const acquired2 = await store.acquireRun('extract', { pid: 2 })
      expect(acquired2.ok).toBe(true)
      if (acquired2.ok) {
        const runFrames = await sse.waitFor('run', 1)
        expect(runFrames.length).toBe(1)
        const runData = JSON.parse(runFrames[0]!.data) as { id: number }
        expect(runData.id).toBe(acquired2.run.id)
      }
    } finally {
      await sse.cancel()
    }
  })

  it('fresh connect announces in-flight runs and ingest jobs once', async () => {
    const acquired = await store.acquireRun('extract', { pid: 7 })
    expect(acquired.ok).toBe(true)
    if (!acquired.ok) return
    const runId = acquired.run.id
    await store.createIngestJob({ id: 'job-live', source: 'test' })

    const sse = await connectEvents()
    try {
      const runFrames = await sse.waitFor('run', 1)
      const runData = JSON.parse(runFrames[0]!.data) as { id: number; status: string | null }
      expect(runData.id).toBe(runId)
      expect(runData.status).toBe('running')

      const ingestFrames = await sse.waitFor('ingest', 1)
      expect(ingestFrames[0]!.data).toContain('job-live')
    } finally {
      await sse.cancel()
    }
  })
})
