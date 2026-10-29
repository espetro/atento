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
      await insertLink(h.store, 'https://example.com/a')
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
