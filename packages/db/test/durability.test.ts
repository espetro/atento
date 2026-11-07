import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openStore, type SqliteStore } from '../src/index.js'
import { extract, ingest, normalizeUrl } from '@linkinbox/core'

let dir: string
let store: SqliteStore

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'linkinbox-durability-'))
  store = await openStore({ path: join(dir, 'links.db') })
})

afterEach(async () => {
  await store.close()
  rmSync(dir, { recursive: true, force: true })
})

/** A pid that is certainly dead: spawn a process that already exited. */
function deadPid(): number {
  const r = spawnSync(process.execPath, ['-e', '0'])
  return r.pid && r.pid > 0 ? r.pid : 999_999
}

async function seedLeasedLink(runId: number, url: string) {
  const { url: normalized, hash } = normalizeUrl(url)
  return store.upsertLink({
    urlHash: hash,
    url: normalized,
    source: 'test',
    state: 'extracting',
    stateData: {
      startedAt: new Date().toISOString(),
      attempt: 1,
      runId,
    },
  })
}

describe('run journal', () => {
  it('acquireRun is single-writer per stage and reports the holder', async () => {
    const first = await store.acquireRun('extract', { pid: process.pid })
    expect(first.ok).toBe(true)
    const second = await store.acquireRun('extract', { pid: process.pid })
    expect(second.ok).toBe(false)
    if (!second.ok) {
      expect(second.busy.id).toBe(first.ok ? first.run.id : -1)
      expect(second.busy.stage).toBe('extract')
      expect(second.busy.pid).toBe(process.pid)
    }
    // A different stage is a different lock.
    const other = await store.acquireRun('enrich', { pid: process.pid })
    expect(other.ok).toBe(true)
    // Finishing releases the lock.
    if (first.ok) {
      await store.finishRun(first.run.id, { okCount: 0, errorCount: 0 })
    }
    const third = await store.acquireRun('extract', { pid: process.pid })
    expect(third.ok).toBe(true)
  })

  it('heartbeatRun refreshes heartbeat_at only while running', async () => {
    const acquired = await store.acquireRun('extract', { pid: process.pid })
    expect(acquired.ok).toBe(true)
    if (!acquired.ok) return
    const before = acquired.run.heartbeatAt!
    await new Promise((r) => setTimeout(r, 5))
    await store.heartbeatRun(acquired.run.id)
    const running = await store.listRunningRuns()
    const entry = running.find((r) => r.id === acquired.run.id)!
    expect(entry.heartbeatAt!.getTime()).toBeGreaterThanOrEqual(before.getTime())
    await store.finishRun(acquired.run.id, { okCount: 0, errorCount: 0 })
    await store.heartbeatRun(acquired.run.id)
    expect(await store.listRunningRuns()).toHaveLength(0)
  })

  it('reclaimDeadRuns marks a dead-pid run crashed and leaves live runs alone', async () => {
    const dead = await store.acquireRun('extract', { pid: deadPid() })
    const live = await store.acquireRun('enrich', { pid: process.pid })
    expect(dead.ok && live.ok).toBe(true)
    const crashed = await store.reclaimDeadRuns()
    expect(crashed).toHaveLength(1)
    expect(crashed[0]!.stage).toBe('extract')
    expect(crashed[0]!.status).toBe('crashed')
    const running = await store.listRunningRuns()
    expect(running.map((r) => r.stage)).toEqual(['enrich'])
  })

  it('reclaimDeadRuns marks a stale-heartbeat run crashed even when the pid is alive', async () => {
    const old = new Date(Date.now() - 60 * 60 * 1000)
    const acquired = await store.acquireRun('extract', { pid: process.pid, now: old })
    expect(acquired.ok).toBe(true)
    const crashed = await store.reclaimDeadRuns()
    expect(crashed).toHaveLength(1)
    expect(crashed[0]!.id).toBe(acquired.ok ? acquired.run.id : -1)
  })

  it('reclaimLeasesForRuns returns only the leases owned by the given runs', async () => {
    const runA = await store.acquireRun('extract', { pid: process.pid })
    const runB = await store.acquireRun('enrich', { pid: process.pid })
    expect(runA.ok && runB.ok).toBe(true)
    const aId = runA.ok ? runA.run.id : -1
    const bId = runB.ok ? runB.run.id : -1
    const linkA = await seedLeasedLink(aId, 'https://a.example.com/x')
    const linkB = await seedLeasedLink(bId, 'https://b.example.com/y')
    // Only run A's lease comes back.
    const n = await store.reclaimLeasesForRuns([aId])
    expect(n).toBe(1)
    expect((await store.getState(linkA.id))!.state).toBe('created')
    expect((await store.getState(linkB.id))!.state).toBe('extracting')
  })
})

describe('extract crash recovery', () => {
  it('reclaims a dead run’s lease and resumes the link without waiting 30 minutes', async () => {
    const dead = await store.acquireRun('extract', { pid: deadPid() })
    expect(dead.ok).toBe(true)
    const crashedRunId = dead.ok ? dead.run.id : -1
    const link = await seedLeasedLink(crashedRunId, 'https://example.com/leased')

    const result = await extract(store, {
      extract: async () => ({ markdown: '# recovered', title: 'Recovered' }),
    })
    expect(result.busy).toBeUndefined()
    expect(result.okCount).toBe(1)
    const after = await store.getLink(link.id)
    expect(after?.state).toBe('extracted')
    // The dead run is journaled crashed; the new run finished done.
    const runs = store.allRuns()
    expect(runs.find((r) => r.id === crashedRunId)?.status).toBe('crashed')
    const mine = runs.find((r) => r.id === result.runId)
    expect(mine?.status).toBe('done')
    expect(mine?.stage).toBe('extract')
  })

  it('reclaims a stale-heartbeat run’s lease even though its pid is alive', async () => {
    const old = new Date(Date.now() - 60 * 60 * 1000)
    const stale = await store.acquireRun('extract', {
      pid: process.pid,
      now: old,
    })
    expect(stale.ok).toBe(true)
    const staleRunId = stale.ok ? stale.run.id : -1
    const link = await seedLeasedLink(staleRunId, 'https://example.com/stale')

    const result = await extract(store, {
      extract: async () => ({ markdown: '# back', title: 'Back' }),
    })
    expect(result.busy).toBeUndefined()
    expect(result.okCount).toBe(1)
    expect((await store.getLink(link.id))?.state).toBe('extracted')
    expect(store.allRuns().find((r) => r.id === staleRunId)?.status).toBe('crashed')
  })

  it('a second concurrent extract returns busy with the current run id', async () => {
    // Hold the extract lock with a live run.
    const holder = await store.acquireRun('extract', { pid: process.pid })
    expect(holder.ok).toBe(true)
    const holderId = holder.ok ? holder.run.id : -1

    const result = await extract(store, {
      extract: async () => ({ markdown: 'never', title: 'Never' }),
    })
    expect(result.busy).toBeDefined()
    expect(result.busy!.runId).toBe(holderId)
    expect(result.busy!.stage).toBe('extract')
    expect(result.okCount).toBe(0)
    expect(result.inputCount).toBe(0)
    // No new runs row was created for the loser.
    expect(store.allRuns().filter((r) => r.stage === 'extract')).toHaveLength(1)
  })

  it('ingest also honours the single-writer lock', async () => {
    const holder = await store.acquireRun('ingest', { pid: process.pid })
    expect(holder.ok).toBe(true)
    const holderId = holder.ok ? holder.run.id : -1
    const result = await ingest(store, [
      { url: 'https://example.com/ing', source: 'test' },
    ])
    expect(result.busy?.runId).toBe(holderId)
    expect(result.linkIds).toHaveLength(0)
  })
})
