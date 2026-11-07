/**
 * Tool definitions for the linkinbox MCP server. Every handler calls the same
 * core functions as the CLI (packages/core ops and pipeline). Tool names use
 * underscores because the MCP SDK rejects dots; see TOOL_NAME_MAP for the
 * mapping back to the spec names.
 */
import { z } from 'zod/mini'
import {
  createLinkinboxOps,
  COLLECTION_NAMES,
  hostOf,
  LINK_STATES,
  LLM_KEY,
  DEFAULT_LIMITS,
  type CollectionName,
  type LinkField,
  type LinkStateName,
  type LinkinboxOps,
  type ShareConfig,
  type SweepPlan,
  type TriageAction,
} from '@linkinbox/app'
import type { McpDeps } from './deps.js'

/**
 * The use cases for one MCP context: the same app layer the CLI and the
 * HTTP server drive, bound to the context's store and config fields. Built
 * per call — it is a plain object over the store, no I/O happens until a
 * use case runs.
 */
function opsFor(ctx: import('./deps.js').McpContext): LinkinboxOps {
  return createLinkinboxOps(
    {
      ttl: ctx.ttl,
      ...(ctx.limits ? { limits: ctx.limits } : {}),
      ...(ctx.login ? { login: ctx.login } : {}),
      ...(ctx.share ? { share: ctx.share } : {}),
    },
    {
      store: ctx.store,
      logger: ctx.logger,
      ...(ctx.spoolDir !== undefined ? { spoolDir: ctx.spoolDir } : {}),
    },
  )
}

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
const STATES = LINK_STATES as readonly LinkStateName[]

const optionalFields = z.optional(z.array(z.enum(LINK_FIELDS)))
const optionalLimit = z.optional(z.number().check(z.int(), z.positive()))

const listInput = {
  q: z.optional(z.string()),
  status: z.optional(z.enum(STATUSES)),
  category: z.optional(z.string()),
  stale: z.optional(z.boolean()),
  fields: optionalFields,
  filter: z.optional(z.string()),
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
        let rows = await opsFor(ctx).list({
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
    'links_overview',
    {
      description:
        'Pipeline overview (spec name links.overview): how many links sit in ' +
        'each pipeline state, how many parked links carry each park reason ' +
        '(login_wall, bot_block, js_shell, http_error, timeout, review_only, ' +
        'unknown), plus the busiest hosts with their per-state and per-reason ' +
        'breakdown. Read-only: it never mutates state. Use it to see where ' +
        'the whole corpus stands without listing every link.',
      inputSchema: {
        topHosts: z.optional(z.number().check(z.int(), z.positive())),
      },
    },
    async (args: { topHosts?: number }) => {
      const ctx = await deps.ctx()
      {
        const overview = await opsFor(ctx).overview({ topHosts: args.topHosts })
        return json({
          total: overview.total,
          byState: overview.byState,
          byParkReason: overview.byParkReason,
          byHost: overview.byHost,
        })
      }
    },
  )

  server.registerTool(
    'links_pipeline',
    {
      description:
        'Pipeline rows (spec name links.pipeline): every link with its FSM ' +
        'state, the reason it carries and its next retry time. Filters: ' +
        'state, host, q. Unlike links_list this spans all states, not just ' +
        'the inbox projection.',
      inputSchema: {
        state: z.optional(z.enum(STATES as [LinkStateName, ...LinkStateName[]])),
        host: z.optional(z.string()),
        q: z.optional(z.string()),
        limit: optionalLimit,
        offset: z.optional(z.number().check(z.int(), z.minimum(0))),
      },
    },
    async (args: {
      state?: LinkStateName
      host?: string
      q?: string
      limit?: number
      offset?: number
    }) => {
      const ctx = await deps.ctx()
      {
        const rows = await opsFor(ctx).pipelineLinks({
          state: args.state,
          host: args.host,
          q: args.q,
          limit: args.limit,
          offset: args.offset,
        })
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
        id: z.number().check(z.int(), z.positive()),
        fields: optionalFields,
      },
    },
    async (args: { id: number; fields?: LinkField[] }) => {
      const ctx = await deps.ctx()
      {
        const row = await opsFor(ctx).get(args.id, args.fields)
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
        ids: z.array(z.number().check(z.int(), z.positive())).check(z.minLength(1)),
        action: z.enum(ACTIONS),
      },
    },
    async (args: { ids: number[]; action: TriageAction }) => {
      const ctx = await deps.ctx()
      {
        const result = await opsFor(ctx).triage(args.ids, args.action)
        return json(result)
      }
    },
  )

  server.registerTool(
    'links_restore',
    {
      description:
        'Restore parked links (archived, discarded, errored) back to the inbox. ' +
        'Deleted links are tombstones and are reported as blocked, never resurrected.',
      inputSchema: {
        ids: z.array(z.number().check(z.int(), z.positive())).check(z.minLength(1)),
      },
    },
    async (args: { ids: number[] }) => {
      const ctx = await deps.ctx()
      return json(await opsFor(ctx).restore(args.ids))
    },
  )

  server.registerTool(
    'links_sweep',
    {
      description:
        'Sweep stale links (spec name links.sweep). Dry-run by default; apply archives. Never deletes.',
      inputSchema: {
        apply: z.optional(z.boolean()),
      },
    },
    async (args: { apply?: boolean }) => {
      const ctx = await deps.ctx()
      {
        const ops = opsFor(ctx)
        const plan = await ops.sweepPlan(ctx.ttl)
        const archived = args.apply === true ? await ops.applySweepPlan(plan) : 0
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
        files: z.array(z.string().check(z.minLength(1))).check(z.minLength(1)),
        limit: optionalLimit,
      },
    },
    async (args: { files: string[]; limit?: number }) => {
      const ctx = await deps.ctx()
      {
        const ops = opsFor(ctx)
        // Crash resume first: a killed ingest job finishes before new work.
        if (ops.spoolDir !== undefined) {
          await ops.resumeIngest({ logger: ctx.logger })
        }
        const { outcome, warnings, importers } = await ops.ingestFiles(args.files, {
          limit: args.limit,
          logger: ctx.logger,
        })
        return json({
          importers,
          warnings,
          linkIds: outcome.linkIds,
          okCount: outcome.okCount,
          errorCount: outcome.errorCount,
          skippedCount: outcome.skippedCount,
          duplicates: outcome.duplicates,
          ...(outcome.busy ? { busy: outcome.busy } : {}),
        })
      }
    },
  )

  server.registerTool(
    'ingest_file',
    {
      description:
        'Bulk-ingest links from a local file (spec name ingest.file): markdown, ' +
        'json, url list (.txt), Safari reading list (.plist) or html bookmarks. ' +
        'Costs zero tokens for the payload — the preferred ingest when the ' +
        'agent runs on the same machine as the linkinbox store. Returns only ' +
        'the job summary { jobId, accepted, duplicates, rejected, status }, ' +
        'never the links themselves.',
      inputSchema: {
        path: z.string().check(z.minLength(1)),
      },
    },
    async (args: { path: string }) => {
      const ctx = await deps.ctx()
      return json(await opsFor(ctx).ingest({ kind: 'file', path: args.path }, { logger: ctx.logger }))
    },
  )

  server.registerTool(
    'ingest_text',
    {
      description:
        'Bulk-ingest links found in long-form text (spec name ingest.text): ' +
        'notes, chat dumps, pasted pages. URLs are pulled out with the ' +
        'markdown and url-list importers. Returns only the job summary.',
      inputSchema: {
        text: z.string().check(z.minLength(1)),
      },
    },
    async (args: { text: string }) => {
      const ctx = await deps.ctx()
      return json(await opsFor(ctx).ingest({ kind: 'text', text: args.text }, { logger: ctx.logger }))
    },
  )

  server.registerTool(
    'ingest_urls',
    {
      description:
        'Bulk-ingest an explicit URL array (spec name ingest.urls), capped at ' +
        '500 urls per call — larger lists belong in a file via ingest_file. ' +
        'Optional note and tags are attached to every link. Returns only the ' +
        'job summary.',
      inputSchema: {
        urls: z.array(z.string().check(z.minLength(1))).check(z.minLength(1), z.maxLength(500)),
        note: z.optional(z.string()),
        tags: z.optional(z.array(z.string())),
      },
    },
    async (args: { urls: string[]; note?: string; tags?: string[] }) => {
      const ctx = await deps.ctx()
      return json(
        await opsFor(ctx).ingest(
          {
            kind: 'urls',
            urls: args.urls,
            ...(args.note !== undefined ? { note: args.note } : {}),
            ...(args.tags !== undefined ? { tags: args.tags } : {}),
          },
          { logger: ctx.logger },
        ),
      )
    },
  )

  server.registerTool(
    'ingest_remote',
    {
      description:
        'Bulk-ingest links from a remote file (spec name ingest.remote): a ' +
        'gist or raw URL is fetched, then parsed with the importer its ' +
        'extension selects (json, markdown, url list, plist). Returns only ' +
        'the job summary.',
      inputSchema: {
        url: z.url(),
      },
    },
    async (args: { url: string }) => {
      const ctx = await deps.ctx()
      return json(await opsFor(ctx).ingest({ kind: 'remote', url: args.url }, { logger: ctx.logger }))
    },
  )

  server.registerTool(
    'ingest_status',
    {
      description:
        'Progress of one ingest job (spec name ingest.status): status, ' +
        'total/done/cursor and the last error. Use it for large jobs; small ' +
        'jobs are already done when ingest_* returns.',
      inputSchema: {
        jobId: z.string().check(z.minLength(1)),
      },
    },
    async (args: { jobId: string }) => {
      const ctx = await deps.ctx()
      {
        const status = await opsFor(ctx).ingestStatus(args.jobId)
        return json({ job: status })
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
        const ops = opsFor(ctx)
        // Same guard shape as before: limits + [login], no pacing.
        const guard = ops.guardDeps({
          ...(ctx.limits ? { limits: ctx.limits } : {}),
          ...(ctx.login ? { login: ctx.login } : {}),
        })
        const outcome = await ops.extract({
          extract: await deps.extractFn(ctx),
          limit: args.limit,
          guard,
          maxBatch: ctx.limits?.maxBatch ?? DEFAULT_LIMITS.maxBatch,
          logger: ctx.logger,
        })
        return json({
          okCount: outcome.okCount,
          errorCount: outcome.errorCount,
          needsBrowserCount: outcome.needsBrowserCount,
          reviewOnlyCount: outcome.reviewOnlyCount,
          deferredCount: outcome.deferredCount,
          retryAfter: outcome.retryAfter,
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
        const ops = opsFor(ctx)
        const outcome = await ops.enrich({
          enrich: await deps.enrichFn(),
          limit: args.limit,
          guard: ops.guardDeps(),
          maxBatch: DEFAULT_LIMITS.maxBatch,
          ttl: ctx.ttl,
          logger: ctx.logger,
        })
        return json({
          linkIds: outcome.linkIds,
          okCount: outcome.okCount,
          errorCount: outcome.errorCount,
          deferredCount: outcome.deferredCount,
          retryAfter: outcome.retryAfter,
          tokensIn: outcome.tokensIn,
          tokensOut: outcome.tokensOut,
          costUsd: outcome.costUsd,
        })
      }
    },
  )

const COLLECTION_FIELD_NAMES = [
  'id', 'url', 'url_hash', 'title', 'source', 'added_at', 'note', 'tags',
  'category', 'priority', 'action', 'confidence', 'read_minutes', 'status',
  'state', 'reason', 'needs_browser', 'expires_at', 'expiry_reason',
  'why_it_matters', 'summary', 'created_at', 'updated_at',
] as const

const collectionNameSchema = z.enum(COLLECTION_NAMES as unknown as [CollectionName, ...CollectionName[]])
const collectionFieldsSchema = z.optional(z.array(z.enum(COLLECTION_FIELD_NAMES)))
const sinceSchema = z.optional(z.number().check(z.int(), z.minimum(0)))

  server.registerTool(
    'collections_summary',
    {
      description:
        'Counts per pipeline collection plus the per-host breakdown of ' +
        'needs_login (spec name collections.summary). This is the tool a ' +
        'harness calls after a run: one line per host that still needs a ' +
        'login. Read-only.',
      inputSchema: {},
    },
    async () => {
      const ctx = await deps.ctx()
      return json(await opsFor(ctx).collectionsSummary())
    },
  )

  server.registerTool(
    'collection_read',
    {
      description:
        'Read one collection inline (spec name collections.read): paginated ' +
        '(<=50 rows by default), fields projection, format=json|tsv. Pass ' +
        'since=<cursor> from a previous read or export to get only the ' +
        'delta; the response carries the next cursor. Collections: ' +
        COLLECTION_NAMES.join(', ') + '.',
      inputSchema: {
        name: collectionNameSchema,
        since: sinceSchema,
        fields: collectionFieldsSchema,
        format: z.optional(z.enum(['json', 'tsv'])),
        limit: z.optional(z.number().check(z.int(), z.positive())),
        offset: z.optional(z.number().check(z.int(), z.minimum(0))),
      },
    },
    async (args: {
      name: CollectionName
      since?: number
      fields?: string[]
      format?: 'json' | 'tsv'
      limit?: number
      offset?: number
    }) => {
      const ctx = await deps.ctx()
      {
        const result = await opsFor(ctx).collectionRead(args.name, {
          ...(args.since !== undefined ? { since: args.since } : {}),
          ...(args.fields !== undefined ? { fields: args.fields } : {}),
          ...(args.limit !== undefined ? { limit: args.limit } : {}),
          ...(args.offset !== undefined ? { offset: args.offset } : {}),
        })
        if (args.format === 'tsv') {
          // TSV is the token-cheap form: emit it as the raw text payload.
          const { serializeCollection } = await import('@linkinbox/app')
          const fields = args.fields ?? ['id', 'url', 'title', 'category', 'priority', 'summary']
          return {
            content: [
              {
                type: 'text' as const,
                text: serializeCollection(result.rows, fields, 'tsv'),
              },
            ],
          }
        }
        return json(result)
      }
    },
  )

  server.registerTool(
    'collection_export',
    {
      description:
        'Export one collection to a file (spec name collections.export): ' +
        'writes ~/.linkinbox/exports/<name>-<cursor>.<ext> and returns ' +
        '{ path, uri, count, bytes } where uri is a linkinbox:// resource ' +
        'link to read lazily. Use it instead of collection_read for large ' +
        'result sets.',
      inputSchema: {
        name: collectionNameSchema,
        since: sinceSchema,
        fields: collectionFieldsSchema,
        format: z.optional(z.enum(['jsonl', 'md', 'tsv'])),
      },
    },
    async (args: {
      name: CollectionName
      since?: number
      fields?: string[]
      format?: 'jsonl' | 'md' | 'tsv'
    }) => {
      const ctx = await deps.ctx()
      {
        const result = await opsFor(ctx).collectionExport(args.name, {
          ...(args.since !== undefined ? { since: args.since } : {}),
          ...(args.fields !== undefined ? { fields: args.fields } : {}),
          ...(args.format !== undefined ? { format: args.format } : {}),
        })
        return json(result)
      }
    },
  )

  server.registerTool(
    'limits_status',
    {
      description:
        'Rate limit budget and circuit breaker state per host (spec name limits.status). ' +
        'Read-only: it never mutates state. Breaker reset stays CLI-only.',
      inputSchema: {},
    },
    async () => {
      const ctx = await deps.ctx()
      {
        const ops = opsFor(ctx)
        // Report the hosts that have state; there is no hardcoded default
        // list, so an untouched install reports only the llm key.
        const states = await ctx.store.listHostStates()
        const keys = new Set<string>(states.map((s) => s.key))
        keys.add(LLM_KEY)
        const rows = await ops.guardStatusesFor([...keys].sort())
        return json({
          hosts: rows.map((row) => ({
            key: row.key,
            breakerState: row.breakerState,
            reopensAt: row.reopensAt,
            dailyCap: row.dailyCap === Number.POSITIVE_INFINITY ? 'unlimited' : row.dailyCap,
            remainingToday:
              row.remainingToday === Number.POSITIVE_INFINITY
                ? 'unlimited'
                : row.remainingToday,
            lastRequestAt: row.lastRequestAt,
            consecutiveFailures: row.consecutiveFailures,
            lastError: row.lastError,
            trialState: row.trialState,
            trialReason: row.trialReason,
            rateLimitedUntil: row.rateLimitedUntil,
            policy: row.policy,
          })),
        })
      }
    },
  )

  server.registerTool(
    'metrics_get',
    {
      description: 'Per-stage metrics summary (spec name metrics.get), range like 24h, 7d, 2w.',
      inputSchema: { range: z.optional(z.string()), now: z.optional(z.iso.datetime()) },
    },
    async (args: { range?: string; now?: string }) => {
      const ctx = await deps.ctx()
      {
        const summary = await opsFor(ctx).metrics(
          args.range ?? '7d',
          args.now !== undefined ? new Date(args.now) : new Date(),
        )
        return json(summary)
      }
    },
  )

  server.registerTool(
    'login_pending',
    {
      description:
        'Hosts that still need a browser login (spec name login.pending). ' +
        'Read-only: pending hosts with their waiting link counts, and the ' +
        'hosts that already have a saved profile with its age. The browser ' +
        'login itself is a CLI step (linkinbox login): it needs a terminal.',
      inputSchema: {},
    },
    async () => {
      const ctx = await deps.ctx()
      {
        return json(
          await opsFor(ctx).loginPending({
            limits: ctx.limits,
            loginAllow: ctx.login?.allow,
          }),
        )
      }
    },
  )

  server.registerTool(
    'browse_read',
    {
      description:
        'Read one page through the saved browser profile of its host and ' +
        'return markdown (spec name browse.read). READ-ONLY: no clicks, no ' +
        'typing, no forms. Only the hosts the owner listed in the [share] ' +
        'hosts config may be read (the list ships empty, so by default every ' +
        'call is refused), and only through a profile saved by `linkinbox ' +
        'login`. The read spends the same per-host budget as the pipeline: ' +
        'human pacing, a daily cap, working hours and the circuit breaker. ' +
        'Nothing is written to the link store.',
      inputSchema: {
        url: z.url(),
      },
    },
    async (args: { url: string }) => {
      const ctx = await deps.ctx()
      {
        const share: ShareConfig = ctx.share ?? { hosts: [] }
        const host = hostOf(args.url)
        if (!deps.browseFn) {
          return json({
            ok: false,
            markdown: '',
            host,
            reason: 'not_configured',
            detail:
              'browsing is not configured in this MCP server; run `linkinbox browse <url>` in the terminal instead',
          })
        }
        const read = await deps.browseFn(ctx)
        const guard = deps.browseGuard ? await deps.browseGuard(ctx) : undefined
        const result = await opsFor(ctx).browseRead(args.url, {
          share,
          read,
          hasProfile: deps.hasProfile
            ? deps.hasProfile
            : async (h) => (await ctx.store.getProfile(h)) !== null,
          guard,
        })
        return json(result)
      }
    },
  )

  server.registerTool(
    'browse_hosts',
    {
      description:
        'Which hosts may be read through a saved browser profile (spec name ' +
        'browse.hosts). Read-only: the saved profiles with their verdict ' +
        'from the [share] hosts allowlist. A host that is not shared can be ' +
        'made shareable by the owner in the config; nothing is shared by ' +
        'default.',
      inputSchema: {},
    },
    async () => {
      const ctx = await deps.ctx()
      {
        const profiles = await ctx.store.listProfiles()
        const rows = await opsFor(ctx).browseHosts(profiles, ctx.share ?? { hosts: [] })
        return json({
          hosts: rows,
          note: ctx.share === undefined || ctx.share.hosts.length === 0
            ? 'the [share] hosts list is empty: nothing is shared until the owner opts in'
            : undefined,
        })
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
