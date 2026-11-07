/**
 * Link-facing commands: list, show, overview, triage.
 * All of them call the core ops layer, never the store directly.
 */
import type { Command } from 'commander'
import {
  LINK_STATES,
  toPipelineRow,
  type LinkField,
  type Status,
  type TriageAction,
  type LinkStateName,
  type PipelineOverview,
} from '@linkinbox/app'
import type { CliContext } from '../context.js'
import { renderTable, shortDate } from '../render.js'

const STATUSES: Status[] = ['inbox', 'scheduled', 'archived', 'discarded']
const ACTIONS: TriageAction[] = ['read_now', 'schedule', 'archive', 'discard']

export interface ListOptions {
  status?: string
  /** FSM state filter (overrides --status). */
  state?: string
  category?: string
  stale?: boolean
  json?: boolean
  limit?: number
  fields?: string
  q?: string
}

/**
 * The fields the state-filtered list asks the store for: the pipeline row
 * needs the FSM state and its payload (the reason and the retry time).
 */
const STATE_LIST_FIELDS: LinkField[] = [
  'id',
  'url',
  'title',
  'status',
  'category',
  'expiresAt',
  'state',
  'stateData',
]

/** list [--status --state --category --stale --json] */
export async function runList(ctx: CliContext, opts: ListOptions): Promise<void> {
  const status = opts.status as Status | undefined
  if (status && !STATUSES.includes(status)) {
    throw new Error(`unknown status "${status}"; expected one of ${STATUSES.join(', ')}`)
  }
  let state: LinkStateName | undefined
  if (opts.state !== undefined) {
    if (!LINK_STATES.includes(opts.state as LinkStateName)) {
      throw new Error(`unknown state "${opts.state}"; expected one of ${LINK_STATES.join(', ')}`)
    }
    state = opts.state as LinkStateName
  }
  const fields = opts.fields
    ? (opts.fields.split(',').map((f) => f.trim()) as LinkField[])
    : undefined

  const rows = await ctx.app.list({
    status,
    state,
    category: opts.category,
    stale: opts.stale === true,
    q: opts.q,
    fields: fields ?? (state !== undefined ? STATE_LIST_FIELDS : undefined),
    limit: opts.limit,
  })

  if (opts.json) {
    console.log(JSON.stringify(rows, null, 2))
    return
  }

  if (rows.length === 0) {
    console.log('no links')
    return
  }

  // With a state filter the table grows the state, reason and retry columns,
  // so the fine-grained pipeline position is visible without --json.
  const headers =
    state !== undefined
      ? ['id', 'state', 'reason', 'retry', 'title', 'url']
      : ['id', 'status', 'category', 'expires', 'title', 'url']
  const table = rows.map((r) => {
    if (state !== undefined) {
      const row = toPipelineRow(r)
      return [
        cell(r['id']),
        row.state,
        row.reason ?? '',
        shortDate(row.nextAttemptAt),
        cell(r['title']),
        cell(r['url']),
      ]
    }
    return [
      cell(r['id']),
      cell(r['status']),
      cell(r['category']),
      shortDate(cell(r['expiresAt']) || null),
      cell(r['title']),
      cell(r['url']),
    ]
  })
  console.log(renderTable(headers, table))
  console.log(`\n${rows.length} link${rows.length === 1 ? '' : 's'}`)
}

/** show <id>: the full record including extracted markdown. */
export async function runShow(ctx: CliContext, id: number, json: boolean): Promise<void> {
  const row = await ctx.app.get(id, [
    'id',
    'url',
    'title',
    'source',
    'addedAt',
    'tags',
    'note',
    'status',
    'state',
    'stateData',
    'category',
    'priority',
    'action',
    'confidence',
    'readMinutes',
    'expiresAt',
    'expiryReason',
    'needsBrowser',
    'extractedAt',
    'enrichment',
    'mediaReport',
    'extracted_content',
  ])
  if (!row) {
    console.error(`no link with id ${id}`)
    process.exitCode = 1
    return
  }
  if (json) {
    console.log(JSON.stringify(row, null, 2))
    return
  }
  for (const [key, value] of Object.entries(row)) {
    if (key === 'extracted_content' || key === 'mediaReport') continue
    console.log(`${key}: ${formatValue(value)}`)
  }
  const media = row['mediaReport'] as
    | { url: string; tiers: { tier: string; status: string; reason?: string; error?: string }[] }
    | undefined
  if (media && Array.isArray(media.tiers) && media.tiers.length > 0) {
    console.log('\n--- media report ---')
    for (const tier of media.tiers) {
      const detail = tier.error ?? tier.reason ?? ''
      console.log(`${tier.tier.padEnd(12)} ${tier.status}${detail !== '' ? `  ${detail}` : ''}`)
    }
  }
  const content = row['extracted_content']
  if (typeof content === 'string' && content !== '') {
    console.log('\n--- extracted content ---')
    console.log(content)
  }

  const history = await ctx.app.history(id)
  if (history.length > 0) {
    console.log('\n--- history ---')
    for (const h of history) {
      console.log(`${h.at.toISOString()}  ${h.event.padEnd(16)} ${h.fromState} -> ${h.toState}`)
    }
  }
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

/** Coerce a projection value to a table cell string. */
function cell(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

export interface TriageOptions {
  action: string
  batch?: boolean
  filter?: string
  ids?: number[]
}

/** triage <id> --action ... and triage --batch --filter ... --action ... */
export async function runTriage(ctx: CliContext, opts: TriageOptions): Promise<void> {
  const action = opts.action as TriageAction
  if (!ACTIONS.includes(action)) {
    throw new Error(`unknown action "${opts.action}"; expected one of ${ACTIONS.join(', ')}`)
  }

  let ids = opts.ids ?? []
  if (opts.batch) {
    // The batch filter needs the fields it filters on, so they are requested
    // explicitly (the default projection is deliberately compact).
    const rows = await ctx.app.list({
      fields: ['id', 'status', 'category', 'title'],
      limit: 100000,
    })
    const filtered = applyFilter(rows, opts.filter)
    ids = filtered.map((r) => Number(r['id']))
    if (ids.length === 0) {
      console.log('no links matched the filter')
      return
    }
  }

  if (ids.length === 0) {
    throw new Error('triage needs at least one link id (or --batch with a filter)')
  }

  const result = await ctx.app.triage(ids, action)
  console.log(`${result.updated} link${result.updated === 1 ? '' : 's'} -> ${result.status}`)
  if (result.missing.length > 0) {
    console.log(`missing: ${result.missing.join(', ')}`)
  }
}

/** Batch filter syntax: `status:archived category:job stale:1`. */
export function applyFilter(rows: Record<string, unknown>[], filter?: string): Record<string, unknown>[] {
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

export interface RetryHeadlessOptions {
  ids: number[]
  /** Must be true: the headless retry is opt-in only. */
  headless: boolean
}

/**
 * retry <ids...> --headless: re-trigger headless extraction for a captured
 * link. Optional and never automatic; captured content is only replaced when
 * the headless run produces something better (lower-trust rules apply).
 */
export async function runRetryHeadless(
  ctx: CliContext,
  opts: RetryHeadlessOptions,
): Promise<void> {
  if (opts.headless !== true) {
    throw new Error('retry needs --headless; captured content is never re-fetched implicitly')
  }
  const result = await ctx.app.retryHeadless(opts.ids)
  if (result.updated.length > 0) {
    console.log(
      `${result.updated.length} link${result.updated.length === 1 ? '' : 's'} requeued for headless extraction: ${result.updated.join(', ')}`,
    )
  }
  if (result.missing.length > 0) {
    console.log(`missing: ${result.missing.join(', ')}`)
    process.exitCode = 1
  }
  if (result.blocked.length > 0) {
    console.log(`blocked (state does not allow a retry): ${result.blocked.join(', ')}`)
    process.exitCode = 1
  }
}

/** restore <ids...>: move archived/discarded/errored links back to the inbox. */
export async function runRestore(ctx: CliContext, ids: number[]): Promise<void> {
  const result = await ctx.app.restore(ids)
  console.log(
    `${result.updated} link${result.updated === 1 ? '' : 's'} restored to inbox`,
  )
  if (result.missing.length > 0) console.log(`missing: ${result.missing.join(', ')}`)
  if (result.blocked.length > 0) {
    console.log(`blocked (deleted or not restorable): ${result.blocked.join(', ')}`)
    process.exitCode = 1
  }
}

export interface OverviewOptions {
  json?: boolean
}

/** Render the overview as a compact set of tables. */
export function formatOverview(overview: PipelineOverview): string {
  const stateRows = Object.entries(overview.byState).map(([state, n]) => [state, String(n)])
  const stateTable = renderTable(['state', 'count'], stateRows)
  const reasonRows = Object.entries(overview.byParkReason)
    .filter(([, n]) => n > 0)
    .map(([reason, n]) => [reason, String(n)])
  const reasonTable =
    reasonRows.length > 0 ? renderTable(['park reason', 'count'], reasonRows) : 'no parked links'
  const hostRows = overview.byHost.map((h) => [
    h.host,
    String(h.total),
    Object.entries(h.byState)
      .filter(([, n]) => n > 0)
      .map(([state, n]) => `${state}:${n}`)
      .join(' '),
    Object.entries(h.byParkReason)
      .filter(([, n]) => n > 0)
      .map(([reason, n]) => `${reason}:${n}`)
      .join(' '),
  ])
  const hostTable =
    hostRows.length > 0 ? renderTable(['host', 'total', 'states', 'park reasons'], hostRows) : 'no hosts'
  return [
    `${overview.total} link${overview.total === 1 ? '' : 's'}`,
    '',
    stateTable,
    '',
    reasonTable,
    '',
    hostTable,
  ].join('\n')
}

/** overview [--json]: the state counts and the busiest hosts. */
export async function runOverview(ctx: CliContext, opts: OverviewOptions): Promise<void> {
  const overview = await ctx.app.overview()
  if (opts.json === true) {
    console.log(JSON.stringify(overview, null, 2))
    return
  }
  console.log(formatOverview(overview))
}

export function registerLinkCommands(
  program: Command,
  deps: { ctx: () => Promise<CliContext> },
): void {
  program
    .command('list')
    .description('list links')
    .option('--status <status>', 'filter by status (inbox, scheduled, archived, discarded)')
    .option(`--state <state>`, `filter by FSM state (${LINK_STATES.join('|')})`)
    .option('--category <category>', 'filter by category')
    .option('--stale', 'only links whose expiresAt has passed')
    .option('--json', 'print json')
    .option('--limit <n>', 'cap the number of rows', Number)
    .option('--fields <fields>', 'comma separated field list (extracted_content is opt-in)')
    .option('--q <query>', 'filter by url or title')
    .action(async (opts: ListOptions) => {
      const ctx = await deps.ctx()
      try {
        await runList(ctx, opts)
      } finally {
        await ctx.close()
      }
    })

  program
    .command('overview')
    .description('overview of every link by pipeline state and host')
    .option('--json', 'print json')
    .action(async (opts: { json?: boolean }) => {
      const ctx = await deps.ctx()
      try {
        await runOverview(ctx, { json: opts.json === true })
      } finally {
        await ctx.close()
      }
    })

  program
    .command('show')
    .description('show one link in full')
    .argument('<id>')
    .option('--json', 'print json')
    .action(async (id: string, opts: { json?: boolean }) => {
      const ctx = await deps.ctx()
      try {
        await runShow(ctx, Number(id), opts.json === true)
      } finally {
        await ctx.close()
      }
    })

  program
    .command('restore')
    .description('restore archived, discarded or errored links to the inbox (never deleted)')
    .argument('<ids...>')
    .action(async (ids: string[]) => {
      const ctx = await deps.ctx()
      try {
        await runRestore(ctx, ids.map((id) => Number(id)))
      } finally {
        await ctx.close()
      }
    })

  program
    .command('retry')
    .description('re-trigger headless extraction for a captured link (explicit, never automatic)')
    .argument('<ids...>')
    .option('--headless', 're-run the headless extractor over the link')
    .action(async (ids: string[], opts: { headless?: boolean }) => {
      const ctx = await deps.ctx()
      try {
        await runRetryHeadless(ctx, {
          ids: ids.map((id) => Number(id)),
          headless: opts.headless === true,
        })
      } finally {
        await ctx.close()
      }
    })

  program
    .command('triage')
    .description('triage links (read_now, schedule, archive, discard)')
    .argument('[ids...]')
    .requiredOption('--action <action>', 'read_now, schedule, archive or discard')
    .option('--batch', 'apply to every link matching --filter')
    .option('--filter <filter>', 'batch filter, e.g. "status:inbox category:job"')
    .action(async (ids: string[], opts: { action: string; batch?: boolean; filter?: string }) => {
      const ctx = await deps.ctx()
      try {
        await runTriage(ctx, {
          action: opts.action,
          batch: opts.batch === true,
          filter: opts.filter,
          ids: ids.map((id) => Number(id)),
        })
      } finally {
        await ctx.close()
      }
    })
}
