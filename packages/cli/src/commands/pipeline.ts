/**
 * Pipeline-running commands: import, extract, enrich, run.
 * Each is a thin shell over the corresponding core stage.
 */
import type { Command } from 'commander'
import { importFile } from '@linkinbox/importers'
import {
  enrich,
  extract,
  guardDepsFromStore,
  ingest,
  pipelineLogger,
  DEFAULT_LIMITS,
  type EnrichFn,
  type ExtractFn,
  type GuardDeps,
  type MediaFn,
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

/** import <file...>: run the matching importer per file, then the ingest stage. */
export async function runImport(ctx: CliContext, files: string[], limit?: number): Promise<void> {
  const logger = pipelineLogger('ingest')
  const raws = []
  for (const file of files) {
    const result = await importFile(file)
    for (const warning of result.warnings) ctx.logger.warn('importer warning: {warning}', { warning })
    raws.push(...result.links)
    console.log(`${file}: ${result.links.length} links via ${result.importer}`)
  }
  const outcome = await ingest(ctx.store, raws, { logger, limit })
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
): Promise<void> {
  const outcome = await extract(ctx.store, extractOptions(ctx, extractFn, mediaFn, limit, host))
  printStage(outcome)
  if (outcome.deferredCount > 0) {
    console.log(`(${outcome.deferredCount} deferred; retry in ${Math.round(outcome.retryAfter / 1000)}s)`)
  }
  if (outcome.needsBrowserCount > 0) {
    console.log(
      `(${outcome.needsBrowserCount} need a browser; run \`linkinbox login <host>\` and re-run)`,
    )
  }
  if (outcome.mediaCount > 0) {
    console.log(`(${outcome.mediaCount} media link${outcome.mediaCount === 1 ? '' : 's'} processed)`)
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
    const outcome = await ingest(ctx.store, raws, { logger, limit: options.limit })
    result.import = outcome
    printStage(outcome)
  }

  const extractOutcome = await extract(
    ctx.store,
    extractOptions(ctx, extractFn, options.mediaFn, options.limit),
  )
  result.extract = extractOutcome
  printStage(extractOutcome)

  const enrichOutcome = await enrich(ctx.store, {
    enrich: enrichFn,
    limit: options.limit,
    guard: guardFor(ctx),
    maxBatch: (ctx.config.limits ?? DEFAULT_LIMITS).maxBatch,
    ttl: ctx.config.ttl,
    logger: pipelineLogger('enrich'),
  })
  result.enrich = enrichOutcome
  printStage(enrichOutcome)
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
    .action(async (opts: { limit?: number; host?: string }) => {
      const ctx = await deps.ctx()
      try {
        await runExtract(ctx, await deps.extractFn(ctx), opts.limit, await deps.mediaFn?.(ctx), opts.host?.toLowerCase())
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
