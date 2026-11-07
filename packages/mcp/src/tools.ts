/**
 * Tool definitions for the linkinbox MCP server. Every handler calls the same
 * core functions as the CLI (packages/core ops and pipeline). Tool names use
 * underscores because the MCP SDK rejects dots; see TOOL_NAME_MAP for the
 * mapping back to the spec names.
 */
import { z } from 'zod/mini'
import {
  listLinks,
  getLink,
  triage,
  restore,
  sweep,
  applySweep,
  metricsSummary,
  pipelineOverview,
  listPipelineLinks,
  ingest,
  extract,
  enrich,
  guardDepsFromStore,
  guardStatuses,
  DEFAULT_LIMITS,
  LLM_KEY,
  LINK_STATES,
  type LinkField,
  type LinkStateName,
  type SweepPlan,
  type TriageAction,
  type GuardDeps,
} from '@linkinbox/core'
import { importFile } from '@linkinbox/importers'
import { loadLoginReport } from '@linkinbox/cli'
import {
  browseRead,
  hostOf,
  listShareHosts,
  type BrowseFn,
  type BrowseOptions,
  type ShareConfig,
  type ShareHostEntry,
} from '@linkinbox/core'
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
        const overview = await pipelineOverview(ctx.store, { topHosts: args.topHosts })
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
        const rows = await listPipelineLinks(ctx.store, {
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
        ids: z.array(z.number().check(z.int(), z.positive())).check(z.minLength(1)),
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
      return json(await restore(ctx.store, args.ids))
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
        files: z.array(z.string().check(z.minLength(1))).check(z.minLength(1)),
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
        const guard: GuardDeps = guardDepsFromStore(ctx.store, {
          // Only the keys that are set: an undefined value would replace the
          // default limits with nothing.
          config: {
            ...(ctx.limits ? { limits: ctx.limits } : {}),
            ...(ctx.login ? { login: ctx.login } : {}),
          },
        })
        const outcome = await extract(ctx.store, {
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
        const guard: GuardDeps = guardDepsFromStore(ctx.store)
        const outcome = await enrich(ctx.store, {
          enrich: await deps.enrichFn(),
          limit: args.limit,
          guard,
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
        const guard: GuardDeps = guardDepsFromStore(ctx.store)
        // Report the hosts that have state; there is no hardcoded default
        // list, so an untouched install reports only the llm key.
        const states = await ctx.store.listHostStates()
        const keys = new Set<string>(states.map((s) => s.key))
        keys.add(LLM_KEY)
        const rows = await guardStatuses(guard, [...keys].sort())
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
        const summary = await metricsSummary(
          ctx.store,
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
          await loadLoginReport(ctx.store, {
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
        const result = await browseRead(args.url, {
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
        const rows: ShareHostEntry[] = await listShareHosts(
          profiles,
          ctx.share ?? { hosts: [] },
        )
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
