/**
 * The commander program. Each command resolves its dependencies lazily so
 * `--help` never opens the database.
 */
import { Command } from 'commander'
import { loadConfig, type AppConfig } from './config.js'
import { createContext, type CliContext, type ContextOptions } from './context.js'
import { registerPipelineCommands } from './commands/pipeline.js'
import { registerLinkCommands } from './commands/links.js'
import { registerMaintenanceCommands } from './commands/maintenance.js'
import { registerLoginCommand } from './commands/login.js'
import { registerReportingCommands } from './commands/metrics.js'
import { registerResilienceCommands } from './commands/resilience.js'
import { registerMediaCommand } from './commands/media.js'
import { registerBrowseCommand } from './commands/browse.js'
import { createMediaFn, type MediaFn } from './media-fn.js'
import { createExtractFn } from './extract-fn.js'
import { createEnrichFn } from './enrich-fn.js'
import type { EnrichFn, ExtractFn, TtlConfig } from '@linkinbox/core'
import { DEFAULT_LIMITS, guardDepsFromStore } from '@linkinbox/core'
import type { AsrFn } from '@linkinbox/core'

export interface ProgramOptions extends ContextOptions {
  /** Override the config (tests). */
  config?: AppConfig
  /** Override the extract fn (tests). */
  extractFn?: ExtractFn
  /** Override the enrich fn (tests). */
  enrichFn?: EnrichFn
  /** Override the ASR provider for the media stage (tests). */
  asr?: AsrFn
  /** Override the media stage function (tests). */
  mediaFn?: MediaFn
}

export function createProgram(options: ProgramOptions = {}): Command {  const program = new Command()
  program
    .name('linkinbox')
    .description('CLI/MCP-first link triage pipeline')
    .version('0.1.0')

  const ctx = async (): Promise<CliContext> => {
    const contextOptions: ContextOptions = {
      env: options.env,
      store: options.store,
      quiet: options.quiet,
      logPath: options.logPath,
    }
    const context = await createContext(contextOptions)
    if (options.config) context.config = options.config
    return context
  }

  const ttl = (): TtlConfig => options.config?.ttl ?? loadConfig(options.env).ttl

  const extractFn = async (ctx: CliContext): Promise<ExtractFn> => {
    if (options.extractFn) return options.extractFn
    const config = options.config ?? loadConfig(options.env)
    return createExtractFn({
      profilesDir: config.profilesDir,
      limits: config.limits,
      login: config.login,
      pacing: config.pacing,
      store: ctx.store,
    })
  }

  const enrichFn = async (): Promise<EnrichFn> => {
    if (options.enrichFn) return options.enrichFn
    return createEnrichFn()
  }

  const mediaFn = (ctx: CliContext): Promise<MediaFn> => {
    if (options.mediaFn) return Promise.resolve(options.mediaFn)
    const build = async (): Promise<MediaFn> => {
      const config = options.config ?? loadConfig(options.env)
      const limits = config.limits ?? DEFAULT_LIMITS
      const guard =
        limits.disabled === true
          ? undefined
          : guardDepsFromStore(ctx.store, {
              config: { limits, pacing: config.pacing },
            })
      return createMediaFn({
        env: options.env,
        config: config.media,
        guard,
        asr: options.asr,
        store: ctx.store,
      })
    }
    return build()
  }

  registerPipelineCommands(program, {
    ctx,
    extractFn,
    enrichFn,
    mediaFn: (ctx: CliContext) => mediaFn(ctx),
  })
  registerLinkCommands(program, { ctx })
  registerMaintenanceCommands(program, { ctx, ttl })
  registerLoginCommand(program, { ctx })
  registerReportingCommands(program, { ctx })
  registerResilienceCommands(program, { ctx })
  registerMediaCommand(program, {
    ctx,
    mediaFn: async () => await mediaFn(await ctx()),
  })
  registerBrowseCommand(program, { ctx })

  return program
}
