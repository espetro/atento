import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openStore, type SqliteStore } from '../src/index.js'
import {
  createSpooledIngestJob,
  runIngestJob,
  resumeIngestJobs,
  ingest,
  INGEST_JOB_INPUT,
  type RawLink,
} from '@linkinbox/core'

let dir: string
let store: SqliteStore
let spool: string

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'linkinbox-ingest-jobs-'))
  spool = join(dir, 'spool')
  store = await openStore({ path: join(dir, 'links.db') })
})

afterEach(async () => {
  await store.close()
  rmSync(dir, { recursive: true, force: true })
})

function deadPid(): number {
  const r = spawnSync(process.execPath, ['-e', '0'])
  return r.pid && r.pid > 0 ? r.pid : 999_999
}

function raws(n: number, prefix = 'https://example.com'): RawLink[] {
  return Array.from({ length: n }, (_, i) => ({
    url: `${prefix}/${i}`,
    title: `Link ${i}`,
    source: 'test',
  }))
}

describe('ingest jobs on sqlite', () => {
  it('spools bulk input, commits in chunks, resumes from cursor after a crash', async () => {
    const input = raws(5)
    const job = await createSpooledIngestJob(store, {
      source: 'test',
      spoolDir: spool,
      links: input,
    })
    expect(existsSync(join(job.spoolPath!, INGEST_JOB_INPUT))).toBe(true)

    // Simulate the crash state exactly: a dead ingest run owns the job, the
    // first chunk is committed (links + cursor advanced in one tx).
    const dead = await store.acquireRun('ingest', { pid: deadPid() })
    expect(dead.ok).toBe(true)
    const deadRunId = dead.ok ? dead.run.id : -1
    await store.updateIngestJob(job.id, { status: 'running', runId: deadRunId })
    const chunk1 = await store.commitIngestChunk(job.id, input.slice(0, 2))
    expect(chunk1.cursor).toBe(2)
    expect(chunk1.done).toBe(2)
    expect(await store.countLinks()).toBe(2)

    // Resume through the public path: the dead run is reclaimed, the job
    // continues from cursor=2 — no re-commit of the first two links.
    const result = await runIngestJob(store, job.id, { chunkSize: 2 })
    expect(result.busy).toBeUndefined()
    expect(result.inputCount).toBe(3)
    expect(result.okCount).toBe(3)
    expect(await store.countLinks()).toBe(5)
    const after = await store.getIngestJob(job.id)
    expect(after?.status).toBe('done')
    expect(after?.done).toBe(5)
    expect(after?.cursor).toBe(5)
    // The dead run is journaled crashed.
    expect(store.allRuns().find((r) => r.id === deadRunId)?.status).toBe('crashed')
  })

  it('resumeIngestJobs finishes pending and crashed-running jobs', async () => {
    const job = await createSpooledIngestJob(store, {
      source: 'test',
      spoolDir: spool,
      links: raws(4, 'https://resume.example.com'),
    })
    await store.updateIngestJob(job.id, { status: 'running' })
    const results = await resumeIngestJobs(store, { chunkSize: 3 })
    expect(results).toHaveLength(1)
    expect(results[0]!.job.status).toBe('done')
    expect(await store.countLinks()).toBe(4)
  })

  it('ingest() with spoolDir goes through the durable job path', async () => {
    const result = await ingest(store, raws(7), { spoolDir: spool })
    expect(result.busy).toBeUndefined()
    expect(result.okCount).toBe(7)
    expect(result.linkIds).toHaveLength(7)
    expect(await store.countLinks()).toBe(7)
    const jobs = await store.listIngestJobs()
    expect(jobs).toHaveLength(1)
    expect(jobs[0]!.status).toBe('done')
    expect(jobs[0]!.total).toBe(7)
    // The journal run for the job finished done.
    const run = store.allRuns().find((r) => r.id === result.runId)
    expect(run?.stage).toBe('ingest')
    expect(run?.status).toBe('done')
  })

  it('ingest() without spoolDir keeps the single-shot path', async () => {
    const result = await ingest(store, raws(3, 'https://plain.example.com'))
    expect(result.okCount).toBe(3)
    expect(await store.listIngestJobs()).toHaveLength(0)
  })

  it('duplicate urls across jobs never create a second link', async () => {
    const input = raws(4, 'https://dup.example.com')
    const j1 = await createSpooledIngestJob(store, { source: 'test', spoolDir: spool, links: input })
    await runIngestJob(store, j1.id)
    // Replay the same input as a brand-new job (e.g. re-import after crash).
    const j2 = await createSpooledIngestJob(store, { source: 'test', spoolDir: spool, links: input })
    const r2 = await runIngestJob(store, j2.id)
    expect(r2.duplicates).toBe(4)
    expect(r2.inserted).toBe(0)
    expect(await store.countLinks()).toBe(4)
  })

  it('a second concurrent ingest job run returns busy with the run id', async () => {
    const holder = await store.acquireRun('ingest', { pid: process.pid })
    expect(holder.ok).toBe(true)
    const job = await createSpooledIngestJob(store, {
      source: 'test',
      spoolDir: spool,
      links: raws(2),
    })
    const result = await runIngestJob(store, job.id)
    expect(result.busy?.runId).toBe(holder.ok ? holder.run.id : -1)
    expect(await store.countLinks()).toBe(0)
  })
})
