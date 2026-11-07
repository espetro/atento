/**
 * The commander program. Each command resolves its dependencies lazily so
 * `--help` never opens the database. All operations go through the app
 * layer (`ctx.app`): the CLI is a thin driving adapter.
 */
import { Command } from 'commander'
import type { AppConfig } from './config.js'
import { createContext, type CliContext, type ContextOptions } from './context.js'
import { registerPipelineCommands } from './commands/pipeline.js'
import { registerLinkCommands } from './commands/links.js'
import { registerMaintenanceCommands } from './commands/maintenance.js'
import { registerLoginCommand, registerRequeueCommand } from './commands/login.js'
import { registerReportingCommands } from './commands/metrics.js'
import { registerResilienceCommands } from './commands/resilience.js'
import { registerMediaCommand } from './commands/media.js'
import { registerBrowseCommand } from './commands/browse.js'
import { registerIngestCommands } from './commands/ingest.js'
import { loadConfig } from './config.js'
import type { EnrichFn, ExtractFn, TtlConfig } from '@linkinbox/app'
import type { MediaFn } from './media-fn.js'

export interface ProgramOptions extends ContextOptions {
  /** Override the config (tests). */
  config?: AppConfig
}

export function createProgram(options: ProgramOptions = {}): Command {  const program = new Command()
  program
    .name('linkinbox')
    .description('CLI/MCP-first link triage pipeline')
    .version('0.1.0')

  const ctx = async (): Promise<CliContext> =>
    createContext({
      env: options.env,
      store: options.store,
      quiet: options.quiet,
      logPath: options.logPath,
      config: options.config,
      extractFn: options.extractFn,
      enrichFn: options.enrichFn,
      mediaFn: options.mediaFn,
      asr: options.asr,
    })

  const ttl = (): TtlConfig => options.config?.ttl ?? loadConfig(options.env).ttl

  const extractFn = async (ctx: CliContext): Promise<ExtractFn> => ctx.app.extractFn()

  const enrichFn = async (ctx: CliContext): Promise<EnrichFn> => ctx.app.enrichFn()

  const mediaFn = async (ctx: CliContext): Promise<MediaFn> => ctx.app.mediaFn()

  registerPipelineCommands(program, {
    ctx,
    extractFn,
    enrichFn,
    mediaFn: (ctx: CliContext) => mediaFn(ctx),
  })
  registerLinkCommands(program, { ctx })
  registerMaintenanceCommands(program, { ctx, ttl })
  registerLoginCommand(program, { ctx })
  registerRequeueCommand(program, { ctx })
  registerReportingCommands(program, { ctx })
  registerResilienceCommands(program, { ctx })
  registerMediaCommand(program, {
    ctx,
    mediaFn: async () => await mediaFn(await ctx()),
  })
  registerBrowseCommand(program, { ctx })
  registerIngestCommands(program, { ctx })

  return program
}
