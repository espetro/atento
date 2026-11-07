/**
 * Ingest tools: run (files), file, text, urls, remote, status. Same job
 * summaries as before — payloads are never echoed.
 */
import { z } from 'zod/mini'
import type { ToolDef } from './types.js'
import { json } from './types.js'

const optionalLimit = z.optional(z.number().check(z.int(), z.positive()))

export const ingestTools: ToolDef[] = [
  {
    name: 'ingest_run',
    description:
      'Ingest links from files (spec name ingest.run). Same importers as the CLI import command.',
    inputSchema: z.object({
      files: z.array(z.string().check(z.minLength(1))).check(z.minLength(1)),
      limit: optionalLimit,
    }),
    handler: async (env, args: { files: string[]; limit?: number }) => {
      const { ctx, ops } = env
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
    },
  },

  {
    name: 'ingest_file',
    description:
      'Bulk-ingest links from a local file (spec name ingest.file): markdown, ' +
      'json, url list (.txt), Safari reading list (.plist) or html bookmarks. ' +
      'Costs zero tokens for the payload — the preferred ingest when the ' +
      'agent runs on the same machine as the linkinbox store. Returns only ' +
      'the job summary { jobId, accepted, duplicates, rejected, status }, ' +
      'never the links themselves.',
    inputSchema: z.object({
      path: z.string().check(z.minLength(1)),
    }),
    handler: async (env, args: { path: string }) => {
      const { ctx, ops } = env
      return json(await ops.ingest({ kind: 'file', path: args.path }, { logger: ctx.logger }))
    },
  },

  {
    name: 'ingest_text',
    description:
      'Bulk-ingest links found in long-form text (spec name ingest.text): ' +
      'notes, chat dumps, pasted pages. URLs are pulled out with the ' +
      'markdown and url-list importers. Returns only the job summary.',
    inputSchema: z.object({
      text: z.string().check(z.minLength(1)),
    }),
    handler: async (env, args: { text: string }) => {
      const { ctx, ops } = env
      return json(await ops.ingest({ kind: 'text', text: args.text }, { logger: ctx.logger }))
    },
  },

  {
    name: 'ingest_urls',
    description:
      'Bulk-ingest an explicit URL array (spec name ingest.urls), capped at ' +
      '500 urls per call — larger lists belong in a file via ingest_file. ' +
      'Optional note and tags are attached to every link. Returns only the ' +
      'job summary.',
    inputSchema: z.object({
      urls: z.array(z.string().check(z.minLength(1))).check(z.minLength(1), z.maxLength(500)),
      note: z.optional(z.string()),
      tags: z.optional(z.array(z.string())),
    }),
    handler: async (env, args: { urls: string[]; note?: string; tags?: string[] }) => {
      const { ctx, ops } = env
      return json(
        await ops.ingest(
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
  },

  {
    name: 'ingest_remote',
    description:
      'Bulk-ingest links from a remote file (spec name ingest.remote): a ' +
      'gist or raw URL is fetched, then parsed with the importer its ' +
      'extension selects (json, markdown, url list, plist). Returns only ' +
      'the job summary.',
    inputSchema: z.object({
      url: z.url(),
    }),
    handler: async (env, args: { url: string }) => {
      const { ctx, ops } = env
      return json(await ops.ingest({ kind: 'remote', url: args.url }, { logger: ctx.logger }))
    },
  },

  {
    name: 'ingest_status',
    description:
      'Progress of one ingest job (spec name ingest.status): status, ' +
      'total/done/cursor and the last error. Use it for large jobs; small ' +
      'jobs are already done when ingest_* returns.',
    inputSchema: z.object({
      jobId: z.string().check(z.minLength(1)),
    }),
    handler: async (env, args: { jobId: string }) => {
      const status = await env.ops.ingestStatus(args.jobId)
      return json({ job: status })
    },
  },
]
