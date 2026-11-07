/**
 * Pipeline-running commands: import, extract, enrich, run.
 * Each is a thin shell over the corresponding core stage.
 */
import type { Command } from 'commander'
import { join } from 'node:path'
import { importFile } from '@linkinbox/importers'
import {
  enrich,
  extract,
  extractUntilEmpty,
  formatBatchSummary,
  formatTotals,
  guardDepsFromStore,
  ingest,
  pipelineLogger,
  resumeIngestJobs,
  DEFAULT_LIMITS,
  type EnrichFn,
  type ExtractFn,
  type GuardDeps,
  type MediaFn,
  type BusyRun,
} from '@linkinbox/core'
import { loadConfig } from '../config.js'
import type { CliContext } from '../context.js'

/** Build a guard over the store, using the CLI config limits and pacing. */
function guardFor(ctx: CliContext): GuardDeps | undefined {
  const limits = ctx.config.limits ?? DEFAULT_LIMITS
  if (limits.disabled === true) return undefined
  return guardDepsFromStore(ctx.store, {
    // Only set keys: an undefined value would replace the default with nothing.
    config: {
      limits,
      pacing: ctx.config.pacing,
      ...(ctx.config.login ? { login: ctx.config.login } : {}),
    },
  })
}

/** Extract options shared by the extract and run commands. */
function extractOptions(
  ctx: CliContext,
  extractFn: ExtractFn,
  mediaFn: MediaFn | undefined,
  limit?: number,
  host?: string,
) {
  return {
    extract: extractFn,
    limit,
    host,
    guard: guardFor(ctx),
    maxBatch: (ctx.config.limits ?? DEFAULT_LIMITS).maxBatch,
    // The media stage runs inside extract for video links; the store-backed
    // budget lives in the media adapter, so no budget wiring here.
    ...(mediaFn ? { media: mediaFn } : {}),
    logger: pipelineLogger('extract'),
  }
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

/** The durable-ingest spool root: <config dir>/spool ( honours LINKINBOX_HOME ). */
function spoolDirFor(ctx: CliContext): string {
  return join(ctx.config.dir, 'spool')
}

/**
 * Finish ingest jobs a previous run left behind (crash resume). Returns
 * true when the ingest lock is held elsewhere — the caller must stop.
 */
async function resumePendingIngest(ctx: CliContext): Promise<boolean> {
  const resumed = await resumeIngestJobs(ctx.store, {
    logger: pipelineLogger('ingest'),
  })
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
  const logger = pipelineLogger('ingest')
  if (await resumePendingIngest(ctx)) return
  const raws = []
  for (const file of files) {
    const result = await importFile(file)
    for (const warning of result.warnings) ctx.logger.warn('importer warning: {warning}', { warning })
    raws.push(...result.links)
    console.log(`${file}: ${result.links.length} links via ${result.importer}`)
  }
  const outcome = await ingest(ctx.store, raws, {
    logger,
    limit,
    spoolDir: spoolDirFor(ctx),
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
  const outcome = untilEmpty
    ? await extractUntilEmpty(ctx.store, {
        ...extractOptions(ctx, extractFn, mediaFn, limit, host),
        // Never sleep inside the CLI loop: the next `linkinbox extract`
        // invocation handles the spacing wait, and a process that sleeps
        // minutes is a process that gets killed.
        sleep: async () => {},
        onBatch: (summary) => console.log(formatBatchSummary(summary)),
      })
    : null
  if (outcome) {
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
  const result = await extract(ctx.store, extractOptions(ctx, extractFn, mediaFn, limit, host))
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
      `(${result.needsBrowserCount} need a browser; run \`linkinbox login <host>\` and re-run)`,
    )
  }
  if (result.mediaCount > 0) {
    console.log(`(${result.mediaCount} media link${result.mediaCount === 1 ? '' : 's'} processed)`)
  }
}

/** enrich [--limit N]: one structured-output call per link lacking enrichment. */
export async function runEnrich(ctx: CliContext, enrichFn: EnrichFn, limit?: number): Promise<void> {
  const outcome = await enrich(ctx.store, {
    enrich: enrichFn,
    limit,
    guard: guardFor(ctx),
    maxBatch: (ctx.config.limits ?? DEFAULT_LIMITS).maxBatch,
    ttl: ctx.config.ttl,
    logger: pipelineLogger('enrich'),
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

/** run: ingest+extract+enrich in one pass. Import only when files are given. */
export async function runAll(
  ctx: CliContext,
  files: string[],
  extractFn: ExtractFn,
  enrichFn: EnrichFn,
  options: { limit?: number; mediaFn?: MediaFn } = {},
): Promise<RunAllResult> {
  const result: RunAllResult = {}
  // Crash resume first: a killed import finishes before new work starts.
  // Busy only blocks the ingest stage — extract/enrich have own locks.
  await resumePendingIngest(ctx)
  if (files.length > 0) {
    const logger = pipelineLogger('ingest')
    const raws = []
    for (const file of files) {
      const imported = await importFile(file)
      for (const warning of imported.warnings) {
        ctx.logger.warn('importer warning: {warning}', { warning })
      }
      raws.push(...imported.links)
    }
    const outcome = await ingest(ctx.store, raws, {
      logger,
      limit: options.limit,
      spoolDir: spoolDirFor(ctx),
    })
    result.import = outcome
    if (outcome.busy) {
      reportBusy(outcome.busy, 'ingest')
    } else {
      printStage(outcome)
    }
  }

  const extractOutcome = await extract(
    ctx.store,
    extractOptions(ctx, extractFn, options.mediaFn, options.limit),
  )
  result.extract = extractOutcome
  if (extractOutcome.busy) {
    reportBusy(extractOutcome.busy, 'extract')
  } else {
    printStage(extractOutcome)
  }

  const enrichOutcome = await enrich(ctx.store, {
    enrich: enrichFn,
    limit: options.limit,
    guard: guardFor(ctx),
    maxBatch: (ctx.config.limits ?? DEFAULT_LIMITS).maxBatch,
    ttl: ctx.config.ttl,
    logger: pipelineLogger('enrich'),
  })
  result.enrich = enrichOutcome
  if (enrichOutcome.busy) {
    reportBusy(enrichOutcome.busy, 'enrich')
  } else {
    printStage(enrichOutcome)
  }
  return result
}

export function registerPipelineCommands(
  program: Command,
  deps: {
    ctx: () => Promise<CliContext>
    extractFn: (ctx: CliContext) => Promise<ExtractFn>
    enrichFn: () => Promise<EnrichFn>
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
    .action(async (opts: { limit?: number }) => {
      const ctx = await deps.ctx()
      try {
        await runEnrich(ctx, await deps.enrichFn(), opts.limit)
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
        await runAll(ctx, files, await deps.extractFn(ctx), await deps.enrichFn(), {
          limit: opts.limit,
          mediaFn: await deps.mediaFn?.(ctx),
        })
      } finally {
        await ctx.close()
      }
    })
}
