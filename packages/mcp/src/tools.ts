/**
 * Tool definitions for the linkinbox MCP server. Every handler calls the same
 * core functions as the CLI (packages/core ops and pipeline). Tool names use
 * underscores because the MCP SDK rejects dots; see TOOL_NAME_MAP for the
 * mapping back to the spec names.
 */
import { z } from 'zod'
import {
  listLinks,
  getLink,
  triage,
  sweep,
  applySweep,
  metricsSummary,
  ingest,
  extract,
  enrich,
  type LinkField,
  type SweepPlan,
  type TriageAction,
} from '@linkinbox/core'
import { importFile } from '@linkinbox/importers'
import type { McpDeps } from './deps.js'

const LINK_FIELDS: [LinkField, ...LinkField[]] = [
  'id',
  'url',
  'urlHash',
  'title',
  'source',
  'addedAt',
  'note',
  'tags',
  'extracted_content',
  'extractedAt',
  'enrichment',
  'expiresAt',
  'expiryReason',
  'status',
  'category',
  'priority',
  'action',
  'confidence',
  'readMinutes',
  'needsBrowser',
  'createdAt',
  'updatedAt',
]

const STATUSES = ['inbox', 'scheduled', 'archived', 'discarded'] as const
const ACTIONS = ['read_now', 'schedule', 'archive', 'discard'] as const

const optionalFields = z.array(z.enum(LINK_FIELDS)).optional()
const optionalLimit = z.number().int().positive().optional()

const listInput = {
  q: z.string().optional(),
  status: z.enum(STATUSES).optional(),
  category: z.string().optional(),
  stale: z.boolean().optional(),
  fields: optionalFields,
  filter: z.string().optional(),
  limit: optionalLimit,
}

function planToJson(plan: SweepPlan): Record<string, unknown> {
  return JSON.parse(JSON.stringify(plan)) as Record<string, unknown>
}

/** Serialize an MCP tool result: compact JSON as the text payload. */
function json(data: unknown): { content: { type: 'text'; text: string }[] } {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] }
}

export function registerTools(server: { registerTool: Function }, deps: McpDeps): void {
  server.registerTool(
    'links_list',
    {
      description:
        'List links (spec name links.list). Compact projection by default: ' +
        'extracted_content is included only when fields asks for it. ' +
        'filter uses the CLI batch syntax, e.g. "status:inbox category:job".',
      inputSchema: listInput,
    },
    async (args: {
      q?: string
      status?: (typeof STATUSES)[number]
      category?: string
      stale?: boolean
      fields?: LinkField[]
      filter?: string
      limit?: number
    }) => {
      const ctx = await deps.ctx()
      {
        let rows = await listLinks(ctx.store, {
          q: args.q,
          status: args.status,
          category: args.category,
          stale: args.stale === true,
          fields: args.fields,
          limit: args.limit,
        })
        rows = applyFilter(rows, args.filter)
        return json({ links: rows })
      }
    },
  )

  server.registerTool(
    'links_get',
    {
      description:
        'Get one link by id (spec name links.get). Extracted content only when fields includes it.',
      inputSchema: {
        id: z.number().int().positive(),
        fields: optionalFields,
      },
    },
    async (args: { id: number; fields?: LinkField[] }) => {
      const ctx = await deps.ctx()
      {
        const row = await getLink(ctx.store, args.id, args.fields)
        if (!row) return json({ link: null })
        return json({ link: row })
      }
    },
  )

  server.registerTool(
    'links_triage',
    {
      description:
        'Aggregate triage tool (spec name links.triage): apply one action to many ids. ' +
        'Actions: read_now, schedule, archive, discard.',
      inputSchema: {
        ids: z.array(z.number().int().positive()).min(1),
        action: z.enum(ACTIONS),
      },
    },
    async (args: { ids: number[]; action: TriageAction }) => {
      const ctx = await deps.ctx()
      {
        const result = await triage(ctx.store, args.ids, args.action)
        return json(result)
      }
    },
  )

  server.registerTool(
    'links_sweep',
    {
      description:
        'Sweep stale links (spec name links.sweep). Dry-run by default; apply archives. Never deletes.',
      inputSchema: {
        apply: z.boolean().optional(),
      },
    },
    async (args: { apply?: boolean }) => {
      const ctx = await deps.ctx()
      {
        const plan = await sweep(ctx.store, ctx.ttl)
        const archived = args.apply === true ? await applySweep(ctx.store, plan) : 0
        return json({ plan: planToJson(plan), archived })
      }
    },
  )

  server.registerTool(
    'ingest_run',
    {
      description:
        'Ingest links from files (spec name ingest.run). Same importers as the CLI import command.',
      inputSchema: {
        files: z.array(z.string().min(1)).min(1),
        limit: optionalLimit,
      },
    },
    async (args: { files: string[]; limit?: number }) => {
      const ctx = await deps.ctx()
      {
        const raws = []
        const warnings: string[] = []
        const importers: Record<string, number> = {}
        for (const file of args.files) {
          const result = await importFile(file)
          warnings.push(...result.warnings)
          raws.push(...result.links)
          importers[result.importer] = (importers[result.importer] ?? 0) + result.links.length
        }
        const outcome = await ingest(ctx.store, raws, { logger: ctx.logger, limit: args.limit })
        return json({
          importers,
          warnings,
          linkIds: outcome.linkIds,
          okCount: outcome.okCount,
          errorCount: outcome.errorCount,
          skippedCount: outcome.skippedCount,
          duplicates: outcome.duplicates,
        })
      }
    },
  )

  server.registerTool(
    'extract_run',
    {
      description: 'Run extraction on inbox links lacking content (spec name extract.run).',
      inputSchema: { limit: optionalLimit },
    },
    async (args: { limit?: number }) => {
      const ctx = await deps.ctx()
      {
        const outcome = await extract(ctx.store, {
          extract: await deps.extractFn(),
          limit: args.limit,
          logger: ctx.logger,
        })
        return json({
          okCount: outcome.okCount,
          errorCount: outcome.errorCount,
          needsBrowserCount: outcome.needsBrowserCount,
        })
      }
    },
  )

  server.registerTool(
    'enrich_run',
    {
      description:
        'Run enrichment (spec name enrich.run). Model identity comes from env config; nothing here names a provider.',
      inputSchema: { limit: optionalLimit },
    },
    async (args: { limit?: number }) => {
      const ctx = await deps.ctx()
      {
        const outcome = await enrich(ctx.store, {
          enrich: await deps.enrichFn(),
          limit: args.limit,
          ttl: ctx.ttl,
          logger: ctx.logger,
        })
        return json({
          linkIds: outcome.linkIds,
          okCount: outcome.okCount,
          errorCount: outcome.errorCount,
          tokensIn: outcome.tokensIn,
          tokensOut: outcome.tokensOut,
          costUsd: outcome.costUsd,
        })
      }
    },
  )

  server.registerTool(
    'metrics_get',
    {
      description: 'Per-stage metrics summary (spec name metrics.get), range like 24h, 7d, 2w.',
      inputSchema: { range: z.string().optional(), now: z.string().datetime().optional() },
    },
    async (args: { range?: string; now?: string }) => {
      const ctx = await deps.ctx()
      {
        const summary = await metricsSummary(
          ctx.store,
          args.range ?? '7d',
          args.now !== undefined ? new Date(args.now) : new Date(),
        )
        return json(summary)
      }
    },
  )
}

/** CLI batch filter syntax over projected rows: `status:archived category:job stale:1`. */
export function applyFilter(
  rows: Record<string, unknown>[],
  filter?: string,
): Record<string, unknown>[] {
  if (!filter) return rows
  const clauses = filter
    .split(/\s+/)
    .map((c) => c.trim())
    .filter(Boolean)
  return rows.filter((row) =>
    clauses.every((clause) => {
      const [key, raw] = clause.includes(':') ? clause.split(/:(.+)/) : [clause, '']
      const value = raw ?? ''
      switch (key) {
        case 'status':
          return row['status'] === value
        case 'category':
          return row['category'] === value
        case 'stale':
          return value === '' || value === '1' || value === 'true'
        default:
          return String(row['title'] ?? '').toLowerCase().includes(clause.toLowerCase())
      }
    }),
  )
}
