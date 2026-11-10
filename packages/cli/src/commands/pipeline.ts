/**
 * Pipeline-running commands: import, extract, enrich, run.
 * Each is a thin shell over the app layer's stage use cases.
 */
import type { Command } from 'commander'
import {
  formatBatchSummary,
  formatTotals,
  pipelineLogger,
  DEFAULT_LIMITS,
  type EnrichFn,
  type ExtractFn,
  type MediaFn,
  type BusyRun,
} from '@atento/app'
import type { CliContext } from '../context.js'

/** The stage logger names the pipeline always used. */
function stageLogger(stage: string) {
  return pipelineLogger(stage)
}

export interface RunOutcome {
  stage: string
  inputCount: number
  okCount: number
  errorCount: number
}

function printStage(outcome: RunOutcome): void {
  console.log(
    `${outcome.stage}: ${outcome.okCount}/${outcome.inputCount} ok` +
      (outcome.errorCount > 0 ? `, ${outcome.errorCount} errors` : ''),
  )
}

/**
 * A stage found its single-writer lock held: report it and exit 3 (the
 * documented busy code), never as a failure. The holder keeps running.
 */
function reportBusy(busy: BusyRun | undefined, stage: string): void {
  if (!busy) return
  console.log(
    `busy: ${stage} is held by run ${busy.runId}` +
      (busy.pid !== null ? ` (pid ${busy.pid})` : '') +
      '; try again later',
  )
  process.exitCode = 3
}

/**
 * Finish ingest jobs a previous run left behind (crash resume). Returns
 * true when the ingest lock is held elsewhere — the caller must stop.
 */
async function resumePendingIngest(ctx: CliContext): Promise<boolean> {
  const resumed = await ctx.app.resumeIngest({ logger: stageLogger('ingest') })
  for (const result of resumed) {
    if (result.busy) {
      reportBusy(result.busy, 'ingest')
      return true
    }
    if (result.errorCount > 0 || result.job.status === 'failed') {
      ctx.logger.warn('resumed ingest job {jobId} finished with errors', {
        jobId: result.job.id,
      })
    }
  }
  return false
}

/** import <file...>: run the matching importer per file, then the ingest stage. */
export async function runImport(ctx: CliContext, files: string[], limit?: number): Promise<void> {
  if (await resumePendingIngest(ctx)) return
  const { outcome } = await ctx.app.ingestFiles(files, {
    limit,
    logger: stageLogger('ingest'),
    onFile: (file, result) => {
      for (const warning of result.warnings) {
        ctx.logger.warn('importer warning: {warning}', { warning })
      }
      console.log(`${file}: ${result.links.length} links via ${result.importer}`)
    },
  })
  if (outcome.busy) {
    reportBusy(outcome.busy, 'ingest')
    return
  }
  printStage(outcome)
  if (outcome.duplicates > 0) console.log(`(${outcome.duplicates} already known, no-op)`)
}

/** extract [--limit N] [--host H]: extraction on inbox links lacking content. */
export async function runExtract(
  ctx: CliContext,
  extractFn: ExtractFn,
  limit?: number,
  mediaFn?: MediaFn,
  host?: string,
  untilEmpty = false,
): Promise<void> {
  const shared = {
    extract: extractFn,
    limit,
    host,
    guard: ctx.app.stageGuard(),
    maxBatch: (ctx.config.limits ?? DEFAULT_LIMITS).maxBatch,
    // The media stage runs inside extract for video links; the store-backed
    // budget lives in the media adapter, so no budget wiring here.
    ...(mediaFn ? { media: mediaFn } : {}),
    logger: stageLogger('extract'),
  }
  if (untilEmpty) {
    const outcome = await ctx.app.extractUntilEmpty({
      ...shared,
      // Never sleep inside the CLI loop: the next `atento extract`
      // invocation handles the spacing wait, and a process that sleeps
      // minutes is a process that gets killed.
      sleep: async () => {},
      onBatch: (summary) => console.log(formatBatchSummary(summary)),
    })
    if (outcome.busy) {
      reportBusy(outcome.busy, 'extract')
      return
    }
    console.log(formatTotals(outcome))
    if (outcome.hitCap) {
      console.log('(stopped at the 100-batch cap with links still queued; re-run to continue)')
    }
    if (outcome.retryAfter > 0) {
      console.log(`(deferred links wait; retry in ${Math.round(outcome.retryAfter / 1000)}s)`)
    }
    return
  }
  const result = await ctx.app.extract(shared)
  if (result.busy) {
    reportBusy(result.busy, 'extract')
    return
  }
  printStage(result)
  if (result.deferredCount > 0) {
    console.log(`(${result.deferredCount} deferred; retry in ${Math.round(result.retryAfter / 1000)}s)`)
  }
  if (result.needsBrowserCount > 0) {
    console.log(
      `(${result.needsBrowserCount} need a browser; run \`atento login <host>\` and re-run)`,
    )
  }
  if (result.mediaCount > 0) {
    console.log(`(${result.mediaCount} media link${result.mediaCount === 1 ? '' : 's'} processed)`)
  }
}

/** enrich [--limit N]: one structured-output call per link lacking enrichment. */
export async function runEnrich(ctx: CliContext, enrichFn: EnrichFn, limit?: number): Promise<void> {
  const outcome = await ctx.app.enrich({
    enrich: enrichFn,
    limit,
    guard: ctx.app.stageGuard(),
    maxBatch: (ctx.config.limits ?? DEFAULT_LIMITS).maxBatch,
    ttl: ctx.config.ttl,
    logger: stageLogger('enrich'),
  })
  if (outcome.busy) {
    reportBusy(outcome.busy, 'enrich')
    return
  }
  printStage(outcome)
  if (outcome.deferredCount > 0) {
    console.log(`(${outcome.deferredCount} deferred; retry in ${Math.round(outcome.retryAfter / 1000)}s)`)
  }
}

export interface RunAllResult {
  import?: RunOutcome
  extract?: RunOutcome
  enrich?: RunOutcome
}

/**
 * `run`: one full app-level pass — ingest `[sources]` + files, extract
 * until empty, enrich until empty, sweep — then map the outcome onto the
 * documented exit codes: 3 busy, 2 finished-but-needs-you, 0 all done.
 * (1 is reserved for thrown failures, handled by the entry point.)
 */
export async function runAll(
  ctx: CliContext,
  files: string[],
  extractFn: ExtractFn,
  enrichFn: EnrichFn,
  options: { limit?: number; mediaFn?: MediaFn } = {},
): Promise<RunAllResult> {
  const result = await ctx.app.run({
    files,
    extract: extractFn,
    enrich: enrichFn,
    ...(options.mediaFn ? { media: options.mediaFn } : {}),
    ...(options.limit !== undefined ? { limit: options.limit } : {}),
    // Never sleep inside the CLI loop: deferred links wait for the next
    // invocation, and a process that sleeps minutes gets killed.
    sleep: async () => {},
    logger: stageLogger('run'),
  })

  for (const job of result.summary.ingest.jobs) {
    if (job.busy) {
      reportBusy(job.busy, 'ingest')
    } else {
      console.log(
        `ingest ${job.jobId}: ${job.accepted} accepted` +
          (job.duplicates > 0 ? `, ${job.duplicates} duplicates` : '') +
          (job.rejected > 0 ? `, ${job.rejected} rejected` : '') +
          ` (${job.status})`,
      )
    }
  }
  if (result.summary.ingest.jobs.length > 0) {
    const tin = result.summary.ingest.jobs.reduce((n, j) => n + j.accepted + j.rejected, 0)
    const tok = result.summary.ingest.jobs.reduce((n, j) => n + j.accepted, 0)
    console.log(`ingest: ${tok}/${tin} ok`)
  }
  const { extract: ex, enrich: en } = result.summary
  const stageLine = (name: string, s: { input: number; ok: number; errors: number; deferred: number; needsBrowser: number }) =>
    `${name}: ${s.ok}/${s.input} ok` +
    (s.deferred > 0 ? `, ${s.deferred} deferred` : '') +
    (s.needsBrowser > 0 ? `, ${s.needsBrowser} need browser` : '') +
    (s.errors > 0 ? `, ${s.errors} errors` : '')
  console.log(stageLine('extract', ex))
  console.log(stageLine('enrich', en))
  if (result.summary.swept > 0) {
    console.log(`sweep: ${result.summary.swept} archived`)
  }
  console.log(
    `run ${result.runId}: cursor ${result.cursorBefore} -> ${result.cursorAfter}`,
  )

  const busy =
    ex.busy ??
    en.busy ??
    result.summary.ingest.jobs.find((j) => j.busy)?.busy
  if (busy) {
    reportBusy(busy, 'run')
    return {}
  }
  if (result.summary.needsAction) {
    const c = result.summary.collections.collections
    const parts: string[] = []
    if (c.needs_login > 0) parts.push(`${c.needs_login} need login`)
    if (c.blocked > 0) parts.push(`${c.blocked} blocked`)
    if (c.errored > 0) parts.push(`${c.errored} errored`)
    console.log(`needs action: ${parts.join(', ')} — see \`atento collections summary\``)
    process.exitCode = 2
  }
  const accepted = result.summary.ingest.jobs.reduce((n, j) => n + j.accepted, 0)
  const rejected = result.summary.ingest.jobs.reduce((n, j) => n + j.rejected, 0)
  return {
    ...(result.summary.ingest.jobs.length > 0
      ? {
          import: {
            stage: 'ingest',
            inputCount: accepted + rejected,
            okCount: accepted,
            errorCount: rejected,
          },
        }
      : {}),
    extract: { stage: 'extract', inputCount: ex.input, okCount: ex.ok, errorCount: ex.errors },
    enrich: { stage: 'enrich', inputCount: en.input, okCount: en.ok, errorCount: en.errors },
  }
}

export function registerPipelineCommands(
  program: Command,
  deps: {
    ctx: () => Promise<CliContext>
    extractFn: (ctx: CliContext) => Promise<ExtractFn>
    enrichFn: (ctx: CliContext) => Promise<EnrichFn>
    mediaFn?: (ctx: CliContext) => Promise<MediaFn>
  },
): void {
  program
    .command('import')
    .description('import links from files (markdown, json, url list, safari reading list)')
    .argument('<files...>')
    .option('--limit <n>', 'cap the number of links ingested', Number)
    .action(async (files: string[], opts: { limit?: number }) => {
      const ctx = await deps.ctx()
      try {
        await runImport(ctx, files, opts.limit)
      } finally {
        await ctx.close()
      }
    })

  program
    .command('extract')
    .description('extract content for inbox links that lack it')
    .option('--limit <n>', 'cap the number of links processed', Number)
    .option('--host <host>', 'only process links of this host (one site at a time)')
    .option('--until-empty', 'repeat batches until no created link is eligible or no batch makes progress')
    .action(async (opts: { limit?: number; host?: string; untilEmpty?: boolean }) => {
      const ctx = await deps.ctx()
      try {
        await runExtract(
          ctx,
          await deps.extractFn(ctx),
          opts.limit,
          await deps.mediaFn?.(ctx),
          opts.host?.toLowerCase(),
          opts.untilEmpty === true,
        )
      } finally {
        await ctx.close()
      }
    })

  program
    .command('enrich')
    .description('run enrichment (one structured-output call per link)')
    .option('--limit <n>', 'cap the number of links processed', Number)
    .option('--until-empty', 'repeat batches until no enrichable link remains or no batch makes progress')
    .action(async (opts: { limit?: number; untilEmpty?: boolean }) => {
      const ctx = await deps.ctx()
      try {
        const shared = {
          enrich: await deps.enrichFn(ctx),
          limit: opts.limit,
          guard: ctx.app.stageGuard(),
          maxBatch: (ctx.config.limits ?? DEFAULT_LIMITS).maxBatch,
          ttl: ctx.config.ttl,
          logger: stageLogger('enrich'),
        }
        if (opts.untilEmpty === true) {
          const outcome = await ctx.app.enrichUntilEmpty({
            ...shared,
            sleep: async () => {},
            onBatch: (summary) => console.log(formatBatchSummary(summary)),
          })
          if (outcome.busy) {
            reportBusy(outcome.busy, 'enrich')
            return
          }
          console.log(formatTotals(outcome))
          if (outcome.hitCap) {
            console.log('(stopped at the 100-batch cap with links still queued; re-run to continue)')
          }
          return
        }
        await runEnrich(ctx, shared.enrich, opts.limit)
      } finally {
        await ctx.close()
      }
    })

  program
    .command('run')
    .description('ingest+extract+enrich in one pass (idempotent)')
    .argument('[files...]')
    .option('--limit <n>', 'cap the number of links processed per stage', Number)
    .action(async (files: string[], opts: { limit?: number }) => {
      const ctx = await deps.ctx()
      try {
        await runAll(ctx, files, await deps.extractFn(ctx), await deps.enrichFn(ctx), {
          limit: opts.limit,
          mediaFn: await deps.mediaFn?.(ctx),
        })
      } finally {
        await ctx.close()
      }
    })
}
