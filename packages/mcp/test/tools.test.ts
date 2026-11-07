/**
 * Every MCP tool is callable over an in-memory client transport, and the
 * responses are the compact projections the spec asks for.
 */
import { mkdtempSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { callJson, createHarness, insertLink } from './helpers.js'
import { TOOL_NAME_MAP } from '../src/index.js'

describe('mcp tools', () => {
  it('exposes every spec tool', async () => {
    const h = await createHarness()
    try {
      const { tools } = await h.client.listTools()
      const names = tools.map((t) => t.name).sort()
      expect(names).toEqual(Object.keys(TOOL_NAME_MAP).sort())
      // every tool has an object input schema
      for (const tool of tools) {
        expect(tool.inputSchema.type).toBe('object')
      }
    } finally {
      await h.cleanup()
    }
  })

  it('emits the expected JSON Schema for a representative tool', async () => {
    const h = await createHarness()
    try {
      const { tools } = await h.client.listTools()
      const linksGet = tools.find((t) => t.name === 'links_get')
      // The SDK converts the zod/mini input shape through zod v4's
      // toJSONSchema; this pins the contract clients see.
      expect(linksGet?.inputSchema).toMatchObject({
        type: 'object',
        properties: {
          id: { type: 'integer', exclusiveMinimum: 0 },
          fields: {
            type: 'array',
            items: { type: 'string', enum: expect.any(Array) },
          },
        },
        required: ['id'],
      })
    } finally {
      await h.cleanup()
    }
  })

  it('links_list returns the default projection without extracted_content', async () => {
    const h = await createHarness()
    try {
      await insertLink(h.store, 'https://example.com/a', {
        title: 'A',
        extractedContent: '# hello world',
      })
      const res = await h.client.callTool({ name: 'links_list', arguments: {} })
      const { isError, data } = callJson(res)
      expect(isError).toBe(false)
      expect(data.links).toHaveLength(1)
      expect(data.links[0]).not.toHaveProperty('extracted_content')
      expect(data.links[0]).toHaveProperty('url', 'https://example.com/a')
    } finally {
      await h.cleanup()
    }
  })

  it('links_list includes extracted_content only when fields asks for it', async () => {
    const h = await createHarness()
    try {
      await insertLink(h.store, 'https://example.com/a', {
        title: 'A',
        extractedContent: '# hello world',
      })
      const res = await h.client.callTool({
        name: 'links_list',
        arguments: { fields: ['id', 'extracted_content'] },
      })
      const { data } = callJson(res)
      expect(data.links[0].extracted_content).toBe('# hello world')
      expect(data.links[0]).not.toHaveProperty('title')
    } finally {
      await h.cleanup()
    }
  })

  it('links_list applies status, q, filter and limit', async () => {
    const h = await createHarness()
    try {
      const a = await insertLink(h.store, 'https://example.com/alpha', { title: 'Alpha' })
      await insertLink(h.store, 'https://example.com/beta', { title: 'Beta', status: 'archived' })
      await insertLink(h.store, 'https://other.com/gamma', { title: 'Gamma' })

      const byStatus = callJson(
        await h.client.callTool({ name: 'links_list', arguments: { status: 'archived' } }),
      )
      expect(byStatus.data.links).toHaveLength(1)

      const byQ = callJson(await h.client.callTool({ name: 'links_list', arguments: { q: 'gamma' } }))
      expect(byQ.data.links).toHaveLength(1)

      const byFilter = callJson(
        await h.client.callTool({ name: 'links_list', arguments: { filter: 'status:inbox' } }),
      )
      expect(byFilter.data.links).toHaveLength(2)

      const limited = callJson(
        await h.client.callTool({ name: 'links_list', arguments: { limit: 1 } }),
      )
      expect(limited.data.links).toHaveLength(1)
      expect(a.id).toBeGreaterThan(0)
    } finally {
      await h.cleanup()
    }
  })

  it('links_get returns one link and null for a missing id', async () => {
    const h = await createHarness()
    try {
      const link = await insertLink(h.store, 'https://example.com/a', {
        title: 'A',
        extractedContent: 'body',
      })
      const found = callJson(
        await h.client.callTool({ name: 'links_get', arguments: { id: link.id } }),
      )
      expect(found.data.link.id).toBe(link.id)
      expect(found.data.link).not.toHaveProperty('extracted_content')

      const missing = callJson(
        await h.client.callTool({ name: 'links_get', arguments: { id: 9999 } }),
      )
      expect(missing.data.link).toBeNull()
    } finally {
      await h.cleanup()
    }
  })

  it('links_triage applies one action to many ids', async () => {
    const h = await createHarness()
    try {
      const a = await insertLink(h.store, 'https://example.com/a')
      const b = await insertLink(h.store, 'https://example.com/b')
      const res = callJson(
        await h.client.callTool({
          name: 'links_triage',
          arguments: { ids: [a.id, b.id], action: 'archive' },
        }),
      )
      expect(res.data.updated).toBe(2)
      expect(res.data.status).toBe('archived')
      expect((await h.store.getLink(a.id))?.status).toBe('archived')
    } finally {
      await h.cleanup()
    }
  })

  it('links_sweep is a dry run by default and archives on apply', async () => {
    const h = await createHarness()
    try {
      const link = await insertLink(h.store, 'https://example.com/a', {
        status: 'inbox',
        category: 'job',
        expiresAt: new Date(Date.now() - 1000),
        expiryReason: 'test',
      })
      const dry = callJson(await h.client.callTool({ name: 'links_sweep', arguments: {} }))
      expect(dry.data.plan.totals.archive).toBe(1)
      expect(dry.data.archived).toBe(0)
      expect((await h.store.getLink(link.id))?.status).toBe('inbox')

      const applied = callJson(
        await h.client.callTool({ name: 'links_sweep', arguments: { apply: true } }),
      )
      expect(applied.data.archived).toBe(1)
      expect((await h.store.getLink(link.id))?.status).toBe('archived')
    } finally {
      await h.cleanup()
    }
  })

  it('ingest_run imports a file through the same importer as the CLI', async () => {
    const h = await createHarness()
    try {
      const { writeFileSync } = await import('node:fs')
      const { tmpdir } = await import('node:os')
      const { join } = await import('node:path')
      const dir = mkdtempSync(join(tmpdir(), 'linkinbox-mcp-import-'))
      const file = join(dir, 'links.md')
      writeFileSync(file, '- [Example](https://example.com/imported)\n')

      const res = callJson(
        await h.client.callTool({ name: 'ingest_run', arguments: { files: [file] } }),
      )
      expect(res.data.okCount).toBe(1)
      expect(res.data.linkIds).toHaveLength(1)

      const listed = callJson(await h.client.callTool({ name: 'links_list', arguments: {} }))
      expect(listed.data.links[0].url).toBe('https://example.com/imported')
    } finally {
      await h.cleanup()
    }
  })

  it('extract_run uses the injected extract function', async () => {
    const h = await createHarness({
      extractFn: async () => ({ markdown: '# extracted', extractor: 'fake' }),
    })
    try {
      await insertLink(h.store, 'https://example.com/a')
      const res = callJson(await h.client.callTool({ name: 'extract_run', arguments: {} }))
      expect(res.data.okCount).toBe(1)
      expect(res.data.errorCount).toBe(0)
      const link = await h.store.getLink(1)
      expect(link?.extractedContent).toBe('# extracted')
    } finally {
      await h.cleanup()
    }
  })

  it('enrich_run uses the injected enrich function', async () => {
    const h = await createHarness({
      enrichFn: async () => ({
        ok: true,
        enrichment: {
          category: 'job',
          priority: 'high',
          action: 'read_now',
          confidence: 0.9,
          why_it_matters: 'because',
          read_minutes: 5,
          expires_at: null,
          expiry_reason: null,
        },
        tokensIn: 10,
        tokensOut: 5,
        modelId: 'test-model',
      }),
    })
    try {
      await insertLink(h.store, 'https://example.com/a', { extractedContent: 'body' })
      const res = callJson(await h.client.callTool({ name: 'enrich_run', arguments: {} }))
      expect(res.data.okCount).toBe(1)
      expect(res.data.tokensIn).toBe(10)
      const link = await h.store.getLink(1)
      expect(link?.category).toBe('job')
    } finally {
      await h.cleanup()
    }
  })

  it('metrics_get returns the per-stage summary', async () => {
    const h = await createHarness({
      extractFn: async () => ({ markdown: 'x', extractor: 'fake' }),
    })
    try {
      await insertLink(h.store, 'https://example.com/a')
      await h.client.callTool({ name: 'extract_run', arguments: {} })
      const res = callJson(await h.client.callTool({ name: 'metrics_get', arguments: {} }))
      expect(Array.isArray(res.data.stages)).toBe(true)
      const extractStage = res.data.stages.find((s: { stage: string }) => s.stage === 'extract')
      expect(extractStage).toBeDefined()
      expect(extractStage.ok).toBe(1)
    } finally {
      await h.cleanup()
    }
  })

  it('rejects invalid input', async () => {
    const h = await createHarness()
    try {
      const res = await h.client.callTool({
        name: 'links_triage',
        arguments: { ids: [1], action: 'nope' },
      })
      expect(res.isError).toBe(true)
    } finally {
      await h.cleanup()
    }
  })
})

describe('mcp limits_status', () => {
  it('reports per-host budget and breaker state without mutating anything', async () => {
    const h = await createHarness()
    try {
      await h.store.saveHostState({
        key: 'x.com',
        lastRequestAt: Date.now() - 1000,
        windowStart: Date.now() - 1000,
        windowCount: 40,
        consecutiveFailures: 2,
        breakerState: 'open',
        openedUntil: Date.now() + 3600_000,
        cooldownLevel: 1,
        lastError: 'http_429',
        trialState: 'flagged',
        trialReason: 'http_429',
        trialAt: Date.now(),
        loginGated: false,
        rateLimitedUntil: null,
      })
      const res = await h.client.callTool({ name: 'limits_status', arguments: {} })
      const { isError, data } = callJson(res)
      expect(isError).toBe(false)
      const x = data.hosts.find((h: { key: string }) => h.key === 'x.com')
      expect(x.breakerState).toBe('open')
      expect(x.dailyCap).toBe(40)
      expect(x.remainingToday).toBe(0)
      expect(x.reopensAt).toBeTruthy()
      expect(data.hosts.some((h: { key: string }) => h.key === 'llm')).toBe(true)
      // read-only: the state is unchanged
      const after = await h.store.getHostState('x.com')
      expect(after?.breakerState).toBe('open')
    } finally {
      await h.cleanup()
    }
  })

  it('extract_run returns deferred info instead of throwing', async () => {
    const h = await createHarness({
      extractFn: async () => {
        throw Object.assign(new Error('forbidden'), { status: 403 })
      },
    })
    try {
      await insertLink(h.store, 'https://x.com/a')
      const res = await h.client.callTool({ name: 'extract_run', arguments: {} })
      const { isError, data } = callJson(res)
      expect(isError).toBe(false)
      expect(data.deferredCount).toBe(1)
      expect(typeof data.retryAfter).toBe('number')
    } finally {
      await h.cleanup()
    }
  })

  it('login_pending lists pending hosts and saved profiles', async () => {
    const h = await createHarness()
    try {
      const parked = await insertLink(h.store, 'https://x.com/a')
      await h.store.applyEvent(parked.id, {
        type: 'EXTRACT_STARTED',
        at: new Date().toISOString(),
      })
      await h.store.applyEvent(parked.id, {
        type: 'NEEDS_BROWSER',
        host: 'x.com',
        at: new Date().toISOString(),
      })
      await h.store.upsertProfile({
        host: 'news.ycombinator.com',
        path: '/tmp/profiles/news.ycombinator.com',
        updatedAt: new Date(Date.now() - 2 * 86_400_000),
      })

      const res = await h.client.callTool({ name: 'login_pending', arguments: {} })
      const { isError, data } = callJson(res)
      expect(isError).toBe(false)
      expect(data.pending).toEqual([{ host: 'x.com', links: 1, reason: 'login_wall' }])
      expect(data.done).toEqual([{ host: 'news.ycombinator.com', profileAgeDays: 2 }])
    } finally {
      await h.cleanup()
    }
  })
})
