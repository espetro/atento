/**
 * Test set E, parity layer: same input into the core function and into the
 * MCP tool gives the same output. The MCP handlers call the core ops and
 * pipeline functions directly, so this snapshots the two surfaces against
 * each other.
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  applySweep,
  getLink,
  listLinks,
  listPipelineLinks,
  metricsSummary,
  pipelineOverview,
  sweep,
  triage,
  DEFAULT_TTL_CONFIG,
  type ExtractFn,
  type TriageAction,
} from '@linkinbox/core'
import { callJson, createHarness, insertLink } from './helpers.js'

const extractFn: ExtractFn = async () => ({ markdown: '# extracted parity', extractor: 'fake' })

async function seed(h: Awaited<ReturnType<typeof createHarness>>): Promise<{
  a: number
  b: number
}> {
  const a = await insertLink(h.store, 'https://example.com/one', {
    title: 'One',
    extractedContent: 'hidden body',
  })
  const b = await insertLink(h.store, 'https://example.com/two', {
    title: 'Two',
    status: 'archived',
  })
  return { a: a.id, b: b.id }
}

describe('mcp/core parity', () => {
  it('links_list output matches listLinks for the same options', async () => {
    const h = await createHarness()
    try {
      await seed(h)
      const viaCore = await listLinks(h.store, { q: 'one', limit: 5 })
      const viaMcp = callJson(
        await h.client.callTool({ name: 'links_list', arguments: { q: 'one', limit: 5 } }),
      )
      expect(viaMcp.data.links).toEqual(viaCore)
      expect(viaMcp.data.links).toMatchSnapshot()
    } finally {
      await h.cleanup()
    }
  })

  it('links_get output matches getLink for the same id and fields', async () => {
    const h = await createHarness()
    try {
      const { a } = await seed(h)
      const viaCore = await getLink(h.store, a, ['id', 'url', 'extracted_content'])
      const viaMcp = callJson(
        await h.client.callTool({
          name: 'links_get',
          arguments: { id: a, fields: ['id', 'url', 'extracted_content'] },
        }),
      )
      expect(viaMcp.data.link).toEqual(viaCore)
      expect(viaMcp.data.link.extracted_content).toBe('hidden body')
    } finally {
      await h.cleanup()
    }
  })

  it('links_triage output matches triage for the same ids and action', async () => {
    // Two identically seeded harnesses: triage moves links through the FSM, so
    // a second call on the same store would not start from the same state.
    const h = await createHarness()
    const hCore = await createHarness()
    try {
      const { a, b } = await seed(h)
      await seed(hCore)
      const action: TriageAction = 'schedule'
      const viaCore = await triage(hCore.store, [a, b], action)
      const viaMcp = callJson(
        await h.client.callTool({
          name: 'links_triage',
          arguments: { ids: [a, b], action },
        }),
      )
      expect(viaMcp.data).toEqual(viaCore)
      expect(viaMcp.data).toMatchSnapshot()
    } finally {
      await h.cleanup()
      await hCore.cleanup()
    }
  })

  it('links_sweep plan matches sweep and apply matches applySweep', async () => {
    const h = await createHarness()
    try {
      await insertLink(h.store, 'https://example.com/stale', {
        status: 'inbox',
        category: 'job',
        expiresAt: new Date(Date.now() - 1000),
        expiryReason: 'parity',
      })
      const viaCore = await sweep(h.store, DEFAULT_TTL_CONFIG)
      const archivedCore = await applySweep(h.store, viaCore)

      await h.store.updateStatus(
        viaCore.groups.flatMap((g) => g.items.map((i) => i.linkId)),
        'inbox',
      )
      const viaMcp = callJson(
        await h.client.callTool({ name: 'links_sweep', arguments: { apply: true } }),
      )
      expect(viaMcp.data.plan.totals).toEqual(
        JSON.parse(JSON.stringify(viaCore.totals)),
      )
      expect(viaMcp.data.archived).toBe(archivedCore)
    } finally {
      await h.cleanup()
    }
  })

  it('ingest_run ingests through the same core ingest stage', async () => {
    const h = await createHarness()
    try {
      const dir = mkdtempSync(join(tmpdir(), 'linkinbox-mcp-parity-'))
      const file = join(dir, 'links.md')
      writeFileSync(file, '- [Example](https://example.com/parity)\n')

      const res = callJson(
        await h.client.callTool({ name: 'ingest_run', arguments: { files: [file] } }),
      )
      expect(res.data.linkIds).toHaveLength(1)
      const viaCore = await getLink(h.store, res.data.linkIds[0])
      expect(viaCore?.url).toBe('https://example.com/parity')
    } finally {
      await h.cleanup()
    }
  })

  it('extract_run drives the same core extract stage', async () => {
    const h = await createHarness({ extractFn })
    try {
      await insertLink(h.store, 'https://example.com/a')
      const res = callJson(await h.client.callTool({ name: 'extract_run', arguments: {} }))
      expect(res.data.okCount).toBe(1)
      const link = await h.store.getLink(1)
      expect(link?.extractedContent).toBe('# extracted parity')
    } finally {
      await h.cleanup()
    }
  })

  it('enrich_run drives the same core enrich stage with the injected fn', async () => {
    const h = await createHarness({
      enrichFn: async () => ({
        ok: true,
        enrichment: {
          category: 'job',
          priority: 'medium',
          action: 'read_now',
          confidence: 0.8,
          why_it_matters: 'parity',
          read_minutes: 3,
          expires_at: null,
          expiry_reason: null,
        },
        tokensIn: 7,
        tokensOut: 3,
        modelId: 'test-model',
      }),
    })
    try {
      await insertLink(h.store, 'https://example.com/a', { extractedContent: 'body' })
      const res = callJson(await h.client.callTool({ name: 'enrich_run', arguments: {} }))
      expect(res.data.okCount).toBe(1)
      const link = await h.store.getLink(1)
      expect(link?.action).toBe('read_now')
    } finally {
      await h.cleanup()
    }
  })

  it('links_overview matches pipelineOverview for the same store', async () => {
    const h = await createHarness()
    try {
      await insertLink(h.store, 'https://example.com/one')
      await insertLink(h.store, 'https://example.com/two')
      await insertLink(h.store, 'https://gated.example/one', {
        state: 'needs_browser',
        stateData: { host: 'gated.example', reason: 'login_wall' },
      })
      const viaCore = await pipelineOverview(h.store)
      const viaMcp = callJson(await h.client.callTool({ name: 'links_overview', arguments: {} }))
      expect(viaMcp.data.total).toBe(viaCore.total)
      expect(viaMcp.data.byState).toEqual(viaCore.byState)
      expect(viaMcp.data.byParkReason).toEqual(viaCore.byParkReason)
      expect(viaMcp.data.byHost).toEqual(viaCore.byHost)
      expect(viaMcp.data.byState.created).toBe(2)
      expect(viaMcp.data.byState.needs_browser).toBe(1)
      expect(viaMcp.data.byParkReason.login_wall).toBe(1)
      expect(viaMcp.data.byParkReason.unknown).toBe(0)
    } finally {
      await h.cleanup()
    }
  })

  it('links_pipeline rows carry the state and reason', async () => {
    const h = await createHarness()
    try {
      await insertLink(h.store, 'https://gated.example/one', {
        state: 'needs_browser',
        stateData: { host: 'gated.example', reason: 'login_wall' },
      })
      const viaCore = await listPipelineLinks(h.store, { state: 'needs_browser' })
      const viaMcp = callJson(
        await h.client.callTool({
          name: 'links_pipeline',
          arguments: { state: 'needs_browser' },
        }),
      )
      expect(viaMcp.data.links).toEqual(viaCore)
      expect(viaMcp.data.links[0]).toMatchObject({
        host: 'gated.example',
        state: 'needs_browser',
        reason: 'login_wall',
      })
    } finally {
      await h.cleanup()
    }
  })

  it('metrics_get matches metricsSummary for the same range', async () => {
    const h = await createHarness({ extractFn })
    try {
      await insertLink(h.store, 'https://example.com/a')
      await h.client.callTool({ name: 'extract_run', arguments: {} })
      const now = new Date('2026-10-29T12:00:00Z')
      const viaCore = await metricsSummary(h.store, '7d', now)
      const viaMcp = callJson(
        await h.client.callTool({
          name: 'metrics_get',
          arguments: { range: '7d', now: now.toISOString() },
        }),
      )
      expect(viaMcp.data).toEqual(viaCore)
    } finally {
      await h.cleanup()
    }
  })

  it('default responses exclude extracted_content unless fields asks for it', async () => {
    const h = await createHarness()
    try {
      await insertLink(h.store, 'https://example.com/a', {
        extractedContent: 'should not leak',
      })
      const listed = callJson(await h.client.callTool({ name: 'links_list', arguments: {} }))
      for (const row of listed.data.links) {
        expect(row).not.toHaveProperty('extracted_content')
      }
      const got = callJson(await h.client.callTool({ name: 'links_get', arguments: { id: 1 } }))
      expect(got.data.link).not.toHaveProperty('extracted_content')
    } finally {
      await h.cleanup()
    }
  })
})
