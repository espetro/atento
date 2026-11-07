/**
 * Collection tools: summary, read (json/tsv with since-cursor deltas) and
 * export to file. Token-cheap output for agents.
 */
import { z } from 'zod/mini'
import {
  COLLECTION_NAMES,
  type CollectionName,
} from '@linkinbox/app'
import { json, type ToolDef, type ToolResult } from './types.js'

const COLLECTION_FIELD_NAMES = [
  'id', 'url', 'url_hash', 'title', 'source', 'added_at', 'note', 'tags',
  'category', 'priority', 'action', 'confidence', 'read_minutes', 'status',
  'state', 'reason', 'needs_browser', 'expires_at', 'expiry_reason',
  'why_it_matters', 'summary', 'created_at', 'updated_at',
] as const

const collectionNameSchema = z.enum(COLLECTION_NAMES as unknown as [CollectionName, ...CollectionName[]])
const collectionFieldsSchema = z.optional(z.array(z.enum(COLLECTION_FIELD_NAMES)))
const sinceSchema = z.optional(z.number().check(z.int(), z.minimum(0)))

export const collectionTools: ToolDef[] = [
  {
    name: 'collections_summary',
    description:
      'Counts per pipeline collection plus the per-host breakdown of ' +
      'needs_login (spec name collections.summary). This is the tool a ' +
      'harness calls after a run: one line per host that still needs a ' +
      'login. Read-only.',
    inputSchema: z.object({}),
    handler: async (env) => {
      return json(await env.ops.collectionsSummary())
    },
  },

  {
    name: 'collection_read',
    description:
      'Read one collection inline (spec name collections.read): paginated ' +
      '(<=50 rows by default), fields projection, format=json|tsv. Pass ' +
      'since=<cursor> from a previous read or export to get only the ' +
      'delta; the JSON response carries `cursor`, and TSV ends with a ' +
      '`# cursor: <n>` trailer line — store it for the next read. ' +
      'Collections: ' +
      COLLECTION_NAMES.join(', ') + '.',
    inputSchema: z.object({
      name: collectionNameSchema,
      since: sinceSchema,
      fields: collectionFieldsSchema,
      format: z.optional(z.enum(['json', 'tsv'])),
      limit: z.optional(z.number().check(z.int(), z.positive())),
      offset: z.optional(z.number().check(z.int(), z.minimum(0))),
    }),
    handler: async (env, args: {
      name: CollectionName
      since?: number
      fields?: string[]
      format?: 'json' | 'tsv'
      limit?: number
      offset?: number
    }): Promise<ToolResult> => {
      const result = await env.ops.collectionRead(args.name, {
        ...(args.since !== undefined ? { since: args.since } : {}),
        ...(args.fields !== undefined ? { fields: args.fields } : {}),
        ...(args.limit !== undefined ? { limit: args.limit } : {}),
        ...(args.offset !== undefined ? { offset: args.offset } : {}),
      })
      if (args.format === 'tsv') {
        // TSV is the token-cheap form: emit it as the raw text payload.
        // The cursor rides a trailing `# cursor: <n>` line — the same
        // convention the CLI and HTTP surfaces use — so delta reads work
        // in this format too.
        const { tsvWithCursor } = await import('@linkinbox/app')
        const fields = args.fields ?? ['id', 'url', 'title', 'category', 'priority', 'summary']
        return {
          content: [
            {
              type: 'text' as const,
              text: tsvWithCursor(result.rows, fields, result.cursor),
            },
          ],
        }
      }
      return json(result)
    },
  },

  {
    name: 'collection_export',
    description:
      'Export one collection to a file (spec name collections.export): ' +
      'writes ~/.linkinbox/exports/<name>-<cursor>.<ext> and returns ' +
      '{ path, uri, count, bytes } where uri is a linkinbox:// resource ' +
      'link to read lazily. Use it instead of collection_read for large ' +
      'result sets.',
    inputSchema: z.object({
      name: collectionNameSchema,
      since: sinceSchema,
      fields: collectionFieldsSchema,
      format: z.optional(z.enum(['jsonl', 'md', 'tsv'])),
    }),
    handler: async (env, args: {
      name: CollectionName
      since?: number
      fields?: string[]
      format?: 'jsonl' | 'md' | 'tsv'
    }) => {
      const result = await env.ops.collectionExport(args.name, {
        ...(args.since !== undefined ? { since: args.since } : {}),
        ...(args.fields !== undefined ? { fields: args.fields } : {}),
        ...(args.format !== undefined ? { format: args.format } : {}),
      })
      return json(result)
    },
  },
]
