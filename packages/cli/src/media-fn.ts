/**
 * Adapter between the media package and the CLI.
 *
 * The media package does the downloading and the orchestration; the ASR
 * provider lives in the enrich package. Both are loaded dynamically so the
 * CLI still starts when one of them is missing, and no provider or model is
 * named here: the enrich package reads its model config from the environment.
 */
import type { AsrFn, GuardDeps, MediaConfig, MediaTierName } from '@linkinbox/core'
import type { MediaReport } from '@linkinbox/media'

export interface MediaFnInput {
  url: string
  content?: string | null
  meta?: Record<string, unknown> | null
  tiers?: MediaTierName[]
}

export type MediaFn = (input: MediaFnInput) => Promise<MediaReport>

export interface MediaAdapterOptions {
  /** Override the module loader (tests). */
  load?: () => Promise<unknown>
  /** Environment holding the ASR model config. Defaults to process.env. */
  env?: NodeJS.ProcessEnv
  /** Guard deps over the store: the download runs through it. */
  guard?: GuardDeps
  /** Media config from `[media]`. */
  config?: MediaConfig
  /** Override the ASR provider (tests). */
  asr?: AsrFn
}

interface MediaModule {
  runMediaStage?: (
    input: MediaFnInput,
    options?: unknown,
  ) => Promise<MediaReport>
}

interface EnrichModule {
  createAudiocppAsr?: (options?: unknown) => AsrFn
}

/** Default loader: dynamic import of @linkinbox/media. */
async function defaultLoad(): Promise<unknown> {
  const specifier = '@linkinbox/media'
  return import(specifier)
}

/** Default loader: dynamic import of @linkinbox/enrich. */
async function defaultEnrichLoad(): Promise<unknown> {
  const specifier = '@linkinbox/enrich'
  return import(specifier)
}

/**
 * Build the media stage function for the CLI.
 *
 * When the media or enrich package is missing, every call fails with a clear
 * message so the command reports an explicit error instead of crashing.
 */
export async function createMediaFn(options: MediaAdapterOptions = {}): Promise<MediaFn> {
  const load = options.load ?? defaultLoad
  let mod: MediaModule
  try {
    mod = (await load()) as MediaModule
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    return async () => {
      throw new Error(`the media package is not available: ${reason}`)
    }
  }
  if (typeof mod.runMediaStage !== 'function') {
    return async () => {
      throw new Error('the media package does not export runMediaStage')
    }
  }
  const runMediaStage = mod.runMediaStage

  let asr = options.asr
  if (!asr) {
    try {
      const enrich = (await defaultEnrichLoad()) as EnrichModule
      if (typeof enrich.createAudiocppAsr === 'function') {
        asr = enrich.createAudiocppAsr({ env: options.env ?? process.env })
      }
    } catch {
      asr = undefined
    }
  }

  return async (input: MediaFnInput): Promise<MediaReport> => {
    return runMediaStage(input, {
      asr,
      guard: options.guard,
      config: options.config,
    })
  }
}
