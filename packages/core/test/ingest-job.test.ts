import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FakeStore } from './fake-store.js'
import {
  createSpooledIngestJob,
  runIngestJob,
  resumeIngestJobs,
  newIngestJobId,
  INGEST_JOB_INPUT,
  type RawLink,
} from '../src/index.js'

let dir: string
let store: FakeStore

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'atento-ingest-job-'))
  store = new FakeStore()
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function raws(n: number, prefix = 'https://example.com'): RawLink[] {
  return Array.from({ length: n }, (_, i) => ({
    url: `${prefix}/${i}`,
    title: `Link ${i}`,
    source: 'test',
  }))
}

describe('spooled ingest jobs', () => {
  it('writes the bulk input to the spool before the job row exists', async () => {
    const job = await createSpooledIngestJob(store, {
      source: 'test',
      spoolDir: dir,
      links: raws(3),
    })
    expect(job.id).toMatch(/^job-/)
    expect(job.status).toBe('pending')
    expect(job.total).toBe(3)
    expect(job.cursor).toBe(0)
    expect(job.spoolPath).toBe(join(dir, job.id))
    expect(existsSync(join(job.spoolPath!, INGEST_JOB_INPUT))).toBe(true)
    expect(existsSync(join(job.spoolPath!, 'meta.json'))).toBe(true)
  })

  it('runIngestJob commits in chunks and marks the job done', async () => {
    const chunks: number[] = []
    const job = await createSpooledIngestJob(store, {
      source: 'test',
      spoolDir: dir,
      links: raws(5),
    })
    const result = await runIngestJob(store, job.id, {
      chunkSize: 2,
      onChunk: (c) => chunks.push(c.cursor),
    })
    expect(result.busy).toBeUndefined()
    expect(result.okCount).toBe(5)
    expect(result.linkIds).toHaveLength(5)
    expect(chunks).toEqual([2, 4, 5])
    const after = await store.getIngestJob(job.id)
    expect(after?.status).toBe('done')
    expect(after?.done).toBe(5)
    expect(after?.cursor).toBe(5)
    expect(store.links).toHaveLength(5)
    expect(store.links.every((l) => l.state === 'created')).toBe(true)
  })

  it('resumes exactly from the cursor after a simulated crash', async () => {
    const input = raws(5)
    const job = await createSpooledIngestJob(store, {
      source: 'test',
      spoolDir: dir,
      links: input,
    })
    // Simulate a crash mid-job: the first chunk committed (links + cursor
    // advanced atomically), the job row still says running.
    await store.updateIngestJob(job.id, { status: 'running', runId: 999 })
    const first = await store.commitIngestChunk(job.id, input.slice(0, 2))
    expect(first.cursor).toBe(2)
    expect(store.links).toHaveLength(2)

    // Resume: only lines [2, 5) are committed now.
    const result = await runIngestJob(store, job.id, { chunkSize: 2 })
    expect(result.okCount).toBe(3)
    expect(result.inputCount).toBe(3)
    expect(store.links).toHaveLength(5)
    // No duplicates: every url_hash exists exactly once.
    expect(new Set(store.links.map((l) => l.urlHash)).size).toBe(5)
    const after = await store.getIngestJob(job.id)
    expect(after?.status).toBe('done')
    expect(after?.done).toBe(5)
  })

  it('replaying committed input is deduped by url_hash', async () => {
    const input = raws(3)
    const job = await createSpooledIngestJob(store, {
      source: 'test',
      spoolDir: dir,
      links: input,
    })
    await runIngestJob(store, job.id)
    // A second job over the same urls: all duplicates, no new links.
    const job2 = await createSpooledIngestJob(store, {
      source: 'test',
      spoolDir: dir,
      links: input,
    })
    const result = await runIngestJob(store, job2.id)
    expect(result.okCount).toBe(3)
    expect(result.duplicates).toBe(3)
    expect(result.inserted).toBe(0)
    expect(store.links).toHaveLength(3)
  })

  it('returns busy when the ingest lock is held', async () => {
    const holder = await store.acquireRun('ingest', { pid: process.pid })
    expect(holder.ok).toBe(true)
    const job = await createSpooledIngestJob(store, {
      source: 'test',
      spoolDir: dir,
      links: raws(2),
    })
    const result = await runIngestJob(store, job.id)
    expect(result.busy).toBeDefined()
    expect(result.busy!.runId).toBe(holder.ok ? holder.run.id : -1)
    expect(store.links).toHaveLength(0)
    // The job stays pending for a later resume.
    expect((await store.getIngestJob(job.id))?.status).toBe('pending')
  })

  it('a done job is a no-op and never takes the lock', async () => {
    const job = await createSpooledIngestJob(store, {
      source: 'test',
      spoolDir: dir,
      links: raws(1),
    })
    await runIngestJob(store, job.id)
    const runsBefore = store.runs.length
    const again = await runIngestJob(store, job.id)
    expect(again.inputCount).toBe(0)
    expect(again.busy).toBeUndefined()
    expect(store.runs.length).toBe(runsBefore)
  })

  it('resumeIngestJobs picks up pending and running jobs, skips done and failed', async () => {
    const pending = await createSpooledIngestJob(store, {
      source: 'test',
      spoolDir: dir,
      links: raws(2, 'https://a.example.com'),
    })
    const running = await createSpooledIngestJob(store, {
      source: 'test',
      spoolDir: dir,
      links: raws(2, 'https://b.example.com'),
    })
    await store.updateIngestJob(running.id, { status: 'running' })
    const done = await createSpooledIngestJob(store, {
      source: 'test',
      spoolDir: dir,
      links: raws(1, 'https://c.example.com'),
    })
    await runIngestJob(store, done.id)
    const failed = await createSpooledIngestJob(store, {
      source: 'test',
      spoolDir: dir,
      links: raws(1, 'https://d.example.com'),
    })
    await store.updateIngestJob(failed.id, { status: 'failed', error: 'boom' })

    const results = await resumeIngestJobs(store)
    expect(results).toHaveLength(2)
    const statuses = await store.listIngestJobs()
    const byId = new Map(statuses.map((j) => [j.id, j.status]))
    expect(byId.get(pending.id)).toBe('done')
    expect(byId.get(running.id)).toBe('done')
    expect(byId.get(done.id)).toBe('done')
    expect(byId.get(failed.id)).toBe('failed')
    expect(store.links).toHaveLength(5)
  })

  it('newIngestJobId produces unique filesystem-safe ids', () => {
    const a = newIngestJobId()
    const b = newIngestJobId()
    expect(a).not.toBe(b)
    expect(a).toMatch(/^[a-z0-9-]+$/)
  })
})
