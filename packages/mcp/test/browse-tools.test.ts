/**
 * The browse tools over the in-memory MCP transport: the allowlist gate,
 * the profile gate, the read-only promise and the hosts listing. The read
 * primitive is a fake: nothing opens a browser and nothing touches the
 * network.
 */
import { describe, expect, it } from 'vitest'
import { callJson, createHarness } from './helpers.js'
import type { BrowseFn } from '@linkinbox/core'

const fakeRead = (calls: string[] = []): BrowseFn =>
  async (url) => {
    calls.push(url)
    return { ok: true, markdown: `# page\n\ncontent of ${url}`, engine: 'fake' }
  }

describe('browse_read', () => {
  it('refuses every host when the allowlist is empty', async () => {
    const calls: string[] = []
    const h = await createHarness({ browseFn: fakeRead(calls) })
    try {
      const res = await h.client.callTool({
        name: 'browse_read',
        arguments: { url: 'https://shared.example/a' },
      })
      const { data } = callJson(res)
      expect(data.ok).toBe(false)
      expect(data.reason).toBe('not_shared')
      expect(calls).toHaveLength(0)
    } finally {
      await h.cleanup()
    }
  })

  it('reads a shared host with a profile', async () => {
    const calls: string[] = []
    const h = await createHarness({
      share: { hosts: ['shared.example'] },
      browseFn: fakeRead(calls),
    })
    try {
      await h.store.upsertProfile({ host: 'shared.example', path: '/tmp/p' })
      const res = await h.client.callTool({
        name: 'browse_read',
        arguments: { url: 'https://shared.example/a' },
      })
      const { isError, data } = callJson(res)
      expect(isError).toBe(false)
      expect(data.ok).toBe(true)
      expect(data.markdown).toContain('content of https://shared.example/a')
      expect(calls).toEqual(['https://shared.example/a'])
    } finally {
      await h.cleanup()
    }
  })

  it('refuses a shared host without a saved profile', async () => {
    const calls: string[] = []
    const h = await createHarness({
      share: { hosts: ['shared.example'] },
      browseFn: fakeRead(calls),
    })
    try {
      const res = await h.client.callTool({
        name: 'browse_read',
        arguments: { url: 'https://shared.example/a' },
      })
      const { data } = callJson(res)
      expect(data.ok).toBe(false)
      expect(data.reason).toBe('no_profile')
      expect(calls).toHaveLength(0)
    } finally {
      await h.cleanup()
    }
  })

  it('writes nothing to the link store', async () => {
    const h = await createHarness({
      share: { hosts: ['shared.example'] },
      browseFn: fakeRead(),
    })
    try {
      await h.store.upsertProfile({ host: 'shared.example', path: '/tmp/p' })
      await h.client.callTool({
        name: 'browse_read',
        arguments: { url: 'https://shared.example/a' },
      })
      const links = await h.store.listLinks({ limit: 100 })
      expect(links).toHaveLength(0)
    } finally {
      await h.cleanup()
    }
  })

  it('reports that browsing is not configured when no reader is injected', async () => {
    const h = await createHarness({ share: { hosts: ['shared.example'] } })
    try {
      const res = await h.client.callTool({
        name: 'browse_read',
        arguments: { url: 'https://shared.example/a' },
      })
      const { data } = callJson(res)
      expect(data.ok).toBe(false)
      expect(data.reason).toBe('not_configured')
    } finally {
      await h.cleanup()
    }
  })
})

describe('browse_hosts', () => {
  it('lists the saved profiles with their share verdict', async () => {
    const h = await createHarness({ share: { hosts: ['shared.example'] } })
    try {
      await h.store.upsertProfile({ host: 'shared.example', path: '/tmp/p' })
      await h.store.upsertProfile({ host: 'private.example', path: '/tmp/q' })
      const res = await h.client.callTool({ name: 'browse_hosts', arguments: {} })
      const { data } = callJson(res)
      const byHost = new Map(
        (data.hosts as { host: string; shared: boolean }[]).map((r) => [r.host, r]),
      )
      expect(byHost.get('shared.example')?.shared).toBe(true)
      expect(byHost.get('private.example')?.shared).toBe(false)
    } finally {
      await h.cleanup()
    }
  })

  it('says so when the allowlist is empty', async () => {
    const h = await createHarness()
    try {
      const res = await h.client.callTool({ name: 'browse_hosts', arguments: {} })
      const { data } = callJson(res)
      expect(data.hosts).toEqual([])
      expect(String(data.note)).toContain('[share] hosts list is empty')
    } finally {
      await h.cleanup()
    }
  })
})
