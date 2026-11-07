/**
 * Bulk-ingest commands: `linkinbox ingest file|text|urls|remote|status`.
 * Thin shells over the app layer's `ingest`/`ingestStatus` use cases — the
 * same contract the MCP tools and the HTTP API expose.
 */
import type { Command } from 'commander'
import type { CliContext } from '../context.js'
import type { IngestInput } from '@linkinbox/app'

function printSummary(summary: {
  jobId: string
  accepted: number
  duplicates: number
  rejected: number
  status: string
  warnings?: string[]
  busy?: { runId: number; stage: string }
}): void {
  for (const warning of summary.warnings ?? []) {
    console.log(`warning: ${warning}`)
  }
  if (summary.busy) {
    console.log(
      `busy: ingest is held by run ${summary.busy.runId} (${summary.busy.stage}); try again later`,
    )
    process.exitCode = 3
    return
  }
  console.log(
    `job ${summary.jobId}: ${summary.accepted} accepted` +
      (summary.duplicates > 0 ? `, ${summary.duplicates} duplicates` : '') +
      (summary.rejected > 0 ? `, ${summary.rejected} rejected` : '') +
      ` (${summary.status})`,
  )
}

async function runIngest(ctx: CliContext, input: IngestInput): Promise<void> {
  const summary = await ctx.app.ingest(input)
  printSummary(summary)
}

export function registerIngestCommands(
  program: Command,
  deps: { ctx: () => Promise<CliContext> },
): void {
  const ingest = program
    .command('ingest')
    .description('bulk-ingest links (file, text, urls, remote) through the durable spool')

  ingest
    .command('file')
    .description('ingest links from a local file (md, json, txt, plist)')
    .argument('<path>')
    .action(async (path: string) => {
      const ctx = await deps.ctx()
      try {
        await runIngest(ctx, { kind: 'file', path })
      } finally {
        await ctx.close()
      }
    })

  ingest
    .command('text')
    .description('ingest links found in long-form text (markdown links and bare urls)')
    .argument('<text>')
    .action(async (text: string) => {
      const ctx = await deps.ctx()
      try {
        await runIngest(ctx, { kind: 'text', text })
      } finally {
        await ctx.close()
      }
    })

  ingest
    .command('urls')
    .description('ingest an explicit url array (max 500 per call)')
    .argument('<urls...>')
    .option('--note <note>', 'note attached to every link')
    .option('--tags <tags>', 'comma-separated tags attached to every link')
    .action(async (urls: string[], opts: { note?: string; tags?: string }) => {
      const ctx = await deps.ctx()
      try {
        await runIngest(ctx, {
          kind: 'urls',
          urls,
          ...(opts.note !== undefined ? { note: opts.note } : {}),
          ...(opts.tags !== undefined
            ? { tags: opts.tags.split(',').map((t) => t.trim()).filter(Boolean) }
            : {}),
        })
      } finally {
        await ctx.close()
      }
    })

  ingest
    .command('remote')
    .description('ingest links from a remote file (gist or raw url)')
    .argument('<url>')
    .action(async (url: string) => {
      const ctx = await deps.ctx()
      try {
        await runIngest(ctx, { kind: 'remote', url })
      } finally {
        await ctx.close()
      }
    })

  ingest
    .command('status')
    .description('show progress of an ingest job')
    .argument('<jobId>')
    .action(async (jobId: string) => {
      const ctx = await deps.ctx()
      try {
        const job = await ctx.app.ingestStatus(jobId)
        if (!job) {
          console.log(`job ${jobId}: not found`)
          process.exitCode = 1
          return
        }
        console.log(
          `job ${job.jobId}: ${job.status} ${job.done}/${job.total}` +
            (job.error ? ` — ${job.error}` : ''),
        )
      } finally {
        await ctx.close()
      }
    })
}
