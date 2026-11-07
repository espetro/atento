/**
 * Link tools: list, overview, pipeline rows, get, triage, restore, sweep.
 * Schemas are zod/mini object schemas; descriptions are unchanged from the
 * pre-M3 registerTool definitions.
 */
import { z } from 'zod/mini'
import {
  LINK_STATES,
  type LinkField,
  type LinkStateName,
  type SweepPlan,
  type TriageAction,
} from '@linkinbox/app'
import { applyFilter } from './filter.js'
import { json, type ToolDef } from './types.js'

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

export const linkTools: ToolDef[] = [
  {
    name: 'links_list',
    description:
      'List links (spec name links.list). Compact projection by default: ' +
      'extracted_content is included only when fields asks for it. ' +
      'filter uses the CLI batch syntax, e.g. "status:inbox category:job".',
    inputSchema: z.object(listInput),
    handler: async (env, args: {
      q?: string
      status?: (typeof STATUSES)[number]
      category?: string
      stale?: boolean
      fields?: LinkField[]
      filter?: string
      limit?: number
    }) => {
      const { ctx, ops } = env
      void ctx
      let rows = await ops.list({
        q: args.q,
        status: args.status,
        category: args.category,
        stale: args.stale === true,
        fields: args.fields,
        limit: args.limit,
      })
      rows = applyFilter(rows, args.filter)
      return json({ links: rows })
    },
  },

  {
    name: 'links_overview',
    description:
      'Pipeline overview (spec name links.overview): how many links sit in ' +
      'each pipeline state, how many parked links carry each park reason ' +
      '(login_wall, bot_block, js_shell, http_error, timeout, review_only, ' +
      'unknown), plus the busiest hosts with their per-state and per-reason ' +
      'breakdown. Read-only: it never mutates state. Use it to see where ' +
      'the whole corpus stands without listing every link.',
    inputSchema: z.object({
      topHosts: z.optional(z.number().check(z.int(), z.positive())),
    }),
    handler: async (env, args: { topHosts?: number }) => {
      const overview = await env.ops.overview({ topHosts: args.topHosts })
      return json({
        total: overview.total,
        byState: overview.byState,
        byParkReason: overview.byParkReason,
        byHost: overview.byHost,
      })
    },
  },

  {
    name: 'links_pipeline',
    description:
      'Pipeline rows (spec name links.pipeline): every link with its FSM ' +
      'state, the reason it carries and its next retry time. Filters: ' +
      'state, host, q. Unlike links_list this spans all states, not just ' +
      'the inbox projection.',
    inputSchema: z.object({
      state: z.optional(z.enum(STATES as [LinkStateName, ...LinkStateName[]])),
      host: z.optional(z.string()),
      q: z.optional(z.string()),
      limit: optionalLimit,
      offset: z.optional(z.number().check(z.int(), z.minimum(0))),
    }),
    handler: async (env, args: {
      state?: LinkStateName
      host?: string
      q?: string
      limit?: number
      offset?: number
    }) => {
      const rows = await env.ops.pipelineLinks({
        state: args.state,
        host: args.host,
        q: args.q,
        limit: args.limit,
        offset: args.offset,
      })
      return json({ links: rows })
    },
  },

  {
    name: 'links_get',
    description:
      'Get one link by id (spec name links.get). Extracted content only when fields includes it.',
    inputSchema: z.object({
      id: z.number().check(z.int(), z.positive()),
      fields: optionalFields,
    }),
    handler: async (env, args: { id: number; fields?: LinkField[] }) => {
      const row = await env.ops.get(args.id, args.fields)
      if (!row) return json({ link: null })
      return json({ link: row })
    },
  },

  {
    name: 'links_triage',
    description:
      'Aggregate triage tool (spec name links.triage): apply one action to many ids. ' +
      'Actions: read_now, schedule, archive, discard.',
    inputSchema: z.object({
      ids: z.array(z.number().check(z.int(), z.positive())).check(z.minLength(1)),
      action: z.enum(ACTIONS),
    }),
    handler: async (env, args: { ids: number[]; action: TriageAction }) => {
      const result = await env.ops.triage(args.ids, args.action)
      return json(result)
    },
  },

  {
    name: 'links_restore',
    description:
      'Restore parked links (archived, discarded, errored) back to the inbox. ' +
      'Deleted links are tombstones and are reported as blocked, never resurrected.',
    inputSchema: z.object({
      ids: z.array(z.number().check(z.int(), z.positive())).check(z.minLength(1)),
    }),
    handler: async (env, args: { ids: number[] }) => {
      return json(await env.ops.restore(args.ids))
    },
  },

  {
    name: 'links_sweep',
    description:
      'Sweep stale links (spec name links.sweep). Dry-run by default; apply archives. Never deletes.',
    inputSchema: z.object({
      apply: z.optional(z.boolean()),
    }),
    handler: async (env, args: { apply?: boolean }) => {
      const ops = env.ops
      const plan = await ops.sweepPlan(env.ctx.ttl)
      const archived = args.apply === true ? await ops.applySweepPlan(plan) : 0
      return json({ plan: planToJson(plan), archived })
    },
  },
]
