/**
 * Link-facing commands: list, show, triage.
 * All of them call the core ops layer, never the store directly.
 */
import type { Command } from 'commander'
import {
  listLinks,
  getLink,
  triage,
  restore,
  linkHistory,
  LINK_STATES,
  type LinkField,
  type Status,
  type TriageAction,
  type LinkStateName,
} from '@linkinbox/core'
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

/** list [--status --category --stale --json] */
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

  const rows = await listLinks(ctx.store, {
    status,
    state,
    category: opts.category,
    stale: opts.stale === true,
    q: opts.q,
    fields,
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

  const headers = ['id', 'status', 'category', 'expires', 'title', 'url']
  const table = rows.map((r) => [
    cell(r['id']),
    cell(r['status']),
    cell(r['category']),
    shortDate(cell(r['expiresAt']) || null),
    cell(r['title']),
    cell(r['url']),
  ])
  console.log(renderTable(headers, table))
  console.log(`\n${rows.length} link${rows.length === 1 ? '' : 's'}`)
}

/** show <id>: the full record including extracted markdown. */
export async function runShow(ctx: CliContext, id: number, json: boolean): Promise<void> {
  const row = await getLink(ctx.store, id, [
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
    if (key === 'extracted_content') continue
    console.log(`${key}: ${formatValue(value)}`)
  }
  const content = row['extracted_content']
  if (typeof content === 'string' && content !== '') {
    console.log('\n--- extracted content ---')
    console.log(content)
  }

  const history = await linkHistory(ctx.store, id)
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
    const rows = await listLinks(ctx.store, {
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

  const result = await triage(ctx.store, ids, action)
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

/** restore <ids...>: move archived/discarded/errored links back to the inbox. */
export async function runRestore(ctx: CliContext, ids: number[]): Promise<void> {
  const result = await restore(ctx.store, ids)
  console.log(
    `${result.updated} link${result.updated === 1 ? '' : 's'} restored to inbox`,
  )
  if (result.missing.length > 0) console.log(`missing: ${result.missing.join(', ')}`)
  if (result.blocked.length > 0) {
    console.log(`blocked (deleted or not restorable): ${result.blocked.join(', ')}`)
    process.exitCode = 1
  }
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
    .option('--stale', 'only links whose expiry has passed')
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
