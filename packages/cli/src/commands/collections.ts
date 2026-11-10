/**
 * Collections commands: `atento collections summary|read|export`.
 * Thin shells over the app layer's collection use cases — the same
 * contract the MCP tools and the HTTP API expose.
 */
import type { Command } from 'commander'
import {
  COLLECTION_NAMES,
  isCollectionName,
  tsvWithCursor,
  DEFAULT_COLLECTION_FIELDS,
  type CollectionExportFormat,
  type CollectionName,
} from '@atento/app'
import type { CliContext } from '../context.js'

function requireCollection(name: string): CollectionName {
  if (!isCollectionName(name)) {
    throw new Error(`unknown collection "${name}"; expected one of: ${COLLECTION_NAMES.join(', ')}`)
  }
  return name
}

function parseFields(raw: string | undefined): string[] | undefined {
  if (raw === undefined || raw === '') return undefined
  return raw.split(',').map((f) => f.trim()).filter(Boolean)
}

export function registerCollectionsCommands(
  program: Command,
  deps: { ctx: () => Promise<CliContext> },
): void {
  const collections = program
    .command('collections')
    .description('token-efficient pipeline views: summary, reads with cursors, exports')

  collections
    .command('summary')
    .description('counts per collection plus the hosts that need a login')
    .action(async () => {
      const ctx = await deps.ctx()
      try {
        const summary = await ctx.app.collectionsSummary()
        for (const name of COLLECTION_NAMES) {
          console.log(`${name}: ${summary.collections[name]}`)
        }
        console.log(`total: ${summary.total}`)
        for (const host of summary.needsLoginHosts) {
          console.log(`needs_login ${host.host}: ${host.count}`)
        }
      } finally {
        await ctx.close()
      }
    })

  collections
    .command('read')
    .description('read one collection (paginated, fields projection, --since cursor)')
    .argument('<name>')
    .option('--since <cursor>', 'only links changed after this link_events cursor', Number)
    .option('--fields <fields>', 'comma-separated field projection')
    .option('--format <format>', 'json or tsv', 'json')
    .option('--limit <n>', 'rows per page (max 200)', Number)
    .option('--offset <n>', 'row offset', Number)
    .action(
      async (
        name: string,
        opts: { since?: number; fields?: string; format?: string; limit?: number; offset?: number },
      ) => {
        const ctx = await deps.ctx()
        try {
          const result = await ctx.app.collectionRead(requireCollection(name), {
            ...(opts.since !== undefined ? { since: opts.since } : {}),
            ...(opts.fields !== undefined ? { fields: parseFields(opts.fields) } : {}),
            ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
            ...(opts.offset !== undefined ? { offset: opts.offset } : {}),
          })
          const fields = parseFields(opts.fields) ?? DEFAULT_COLLECTION_FIELDS
          if (opts.format === 'tsv') {
            // TSV carries its cursor as a trailing `# cursor:` line — the
            // same convention the MCP and HTTP surfaces use.
            process.stdout.write(tsvWithCursor(result.rows, fields, result.cursor))
          } else if (opts.format === 'json') {
            console.log(JSON.stringify(result, null, 2))
          } else {
            throw new Error(`unknown format "${opts.format}"; expected json or tsv`)
          }
        } finally {
          await ctx.close()
        }
      },
    )

  collections
    .command('export')
    .description('write one collection to ~/.atento/exports/ and print the handle')
    .argument('<name>')
    .option('--since <cursor>', 'only links changed after this cursor', Number)
    .option('--fields <fields>', 'comma-separated field projection')
    .option('--format <format>', 'jsonl, md or tsv', 'jsonl')
    .action(
      async (name: string, opts: { since?: number; fields?: string; format?: string }) => {
        const format = opts.format ?? 'jsonl'
        if (format !== 'jsonl' && format !== 'md' && format !== 'tsv') {
          throw new Error('format must be jsonl, md or tsv')
        }
        const ctx = await deps.ctx()
        try {
          const result = await ctx.app.collectionExport(requireCollection(name), {
            ...(opts.since !== undefined ? { since: opts.since } : {}),
            ...(opts.fields !== undefined ? { fields: parseFields(opts.fields) } : {}),
            format: format as CollectionExportFormat,
          })
          console.log(`${result.count} rows, ${result.bytes} bytes`)
          console.log(result.path)
          console.log(result.uri)
        } finally {
          await ctx.close()
        }
      },
    )
}
