import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openStore, type SqliteStore } from '@linkinbox/db'
import { createApp } from '../src/index.js'

let store: SqliteStore
let dir: string
let app: ReturnType<typeof createApp>

// Fresh store per test: SSE replay is journal-wide, so a shared db would
// leak earlier tests' link_events into later connections' backlogs.
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'linkinbox-events-'))
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

function parseFrames(text: string): Frame[] {
  const frames: Frame[] = []
  for (const block of text.split('\n\n')) {
    if (block.trim() === '' || block.startsWith(':')) continue
    const frame: Frame = { id: null, event: 'message', data: '' }
    for (const line of block.split('\n')) {
      if (line.startsWith('id: ')) frame.id = line.slice(4)
      else if (line.startsWith('event: ')) frame.event = line.slice(7)
      else if (line.startsWith('data: ')) frame.data += line.slice(6)
    }
    frames.push(frame)
  }
  return frames
}

/** Read SSE frames until `want` frames of `event` arrive or timeout. */
async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  event: string,
  count: number,
  timeoutMs = 4000,
): Promise<Frame[]> {
  const decoder = new TextDecoder()
  let buf = ''
  const deadline = Date.now() + timeoutMs
  const found: Frame[] = []
  while (Date.now() < deadline && found.length < count) {
    const remaining = deadline - Date.now()
    const read = await Promise.race([
      reader.read(),
      new Promise<never>((_, rej) =>
        setTimeout(() => rej(new Error('sse read timeout')), remaining),
      ),
    ])
    if (read.done) break
    buf += decoder.decode(read.value, { stream: true })
    const all = parseFrames(buf)
    const matching = all.filter((f) => f.event === event)
    if (matching.length > found.length) {
      found.push(...matching.slice(found.length))
    }
  }
  return found
}

async function connectEvents(
  headers: Record<string, string> = {},
): Promise<{ reader: ReadableStreamDefaultReader<Uint8Array>; res: Response }> {
  const res = await app.request('/api/events', { headers })
  expect(res.status).toBe(200)
  expect(res.headers.get('content-type')).toContain('text/event-stream')
  return { res, reader: res.body!.getReader() }
}

describe('GET /api/events (SSE)', () => {
  it('streams link state transitions with link_events.id as the event id', async () => {
    const { reader } = await connectEvents()
    try {
      const id = await seedLink()
      await triage(id)
      const frames = await readUntil(reader, 'link', 1)
      expect(frames.length).toBe(1)
      expect(frames[0]!.id).toMatch(/^\d+$/)
      const data = JSON.parse(frames[0]!.data) as { linkId: number; event: string }
      expect(data.linkId).toBe(id)
      expect(data.event).toBe('TRIAGE')
    } finally {
      await reader.cancel()
    }
  })

  it('resumes after Last-Event-ID without gaps or duplicates', async () => {
    const id = await seedLink()
    // First connection: consume two events.
    const first = await connectEvents()
    await triage(id)
    const e1 = await readUntil(first.reader, 'link', 1)
    expect(e1.length).toBe(1)
    // Second transition while still connected.
    const at = new Date().toISOString()
    await store.applyEvent(
      id,
      { type: 'RESTORE', at },
      'archived',
    )
    const e2 = await readUntil(first.reader, 'link', 1)
    expect(e2.length).toBe(1)
    expect(Number(e2[0]!.id)).toBeGreaterThan(Number(e1[0]!.id))
    const lastId = e2[0]!.id!
    await first.reader.cancel()

    // Third transition happens while disconnected. RESTORE landed the link
    // in `inbox`, where TRIAGE archive is legal.
    await store.applyEvent(
      id,
      { type: 'TRIAGE', at: new Date().toISOString(), action: 'archive' },
      'inbox',
    )

    // Reconnect with Last-Event-ID: only events with id > lastId arrive.
    const second = await connectEvents({ 'last-event-id': lastId })
    try {
      const frames = await readUntil(second.reader, 'link', 1)
      expect(frames.length).toBe(1)
      expect(Number(frames[0]!.id)).toBeGreaterThan(Number(lastId))
      const data = JSON.parse(frames[0]!.data) as { event: string }
      expect(data.event).toBe('TRIAGE')
    } finally {
      await second.reader.cancel()
    }
  })

  it('emits run start/finish events keyed by run:<id>', async () => {
    const { reader } = await connectEvents()
    try {
      const acquired = await store.acquireRun('extract', { pid: 12345 })
      expect(acquired.ok).toBe(true)
      if (!acquired.ok) return
      const runId = acquired.run.id
      const frames = await readUntil(reader, 'run', 1)
      expect(frames.length).toBe(1)
      expect(frames[0]!.id).toBe(`run:${runId}`)
      const started = JSON.parse(frames[0]!.data) as { status: string }
      expect(started.status).toBe('running')

      await store.finishRun(runId, { okCount: 1, errorCount: 0 })
      // Consume 'run' frames until the finished status arrives; each
      // readUntil call starts a fresh buffer, so earlier frames are not
      // re-counted.
      const deadline = Date.now() + 4000
      let finish: Frame | undefined
      while (Date.now() < deadline && finish === undefined) {
        let more: Frame[] = []
        try {
          more = await readUntil(reader, 'run', 1, deadline - Date.now())
        } catch {
          break
        }
        for (const f of more) {
          const d = JSON.parse(f.data) as { status: string }
          if (d.status === 'done' || d.status === 'failed') finish = f
        }
      }
      expect(finish).toBeTruthy()
      expect(finish!.id).toBe(`run:${runId}`)
    } finally {
      await reader.cancel()
    }
  })

  it('emits ingest job progress events', async () => {
    const { reader } = await connectEvents()
    try {
      await store.createIngestJob({ id: 'job-sse-1', source: 'test' })
      const frames = await readUntil(reader, 'ingest', 1)
      expect(frames.length).toBe(1)
      expect(frames[0]!.id).toBe('ingest:job-sse-1')
      const data = JSON.parse(frames[0]!.data) as { jobId: string; status: string }
      expect(data.jobId).toBe('job-sse-1')
    } finally {
      await reader.cancel()
    }
  })
})
