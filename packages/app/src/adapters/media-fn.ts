/**
 * Adapter between the media package and the CLI.
 *
 * The media package does the downloading and the orchestration; the ASR
 * provider lives in the enrich package. Both are loaded dynamically so the
 * CLI still starts when one of them is missing, and no provider or model is
 * named here: the enrich package reads its model config from the environment.
 *
 * The budget is store-backed (core.createMediaBudget), so the daily cap
 * survives restarts.
 */
import {
  createMediaBudget,
  type AsrFn,
  type GuardDeps,
  type MediaConfig,
  type MediaTierName,
  type Store,
} from '@atento/core'
import type { MediaReport } from '@atento/media'

export interface MediaFnInput {
  url: string
  content?: string | null
  meta?: Record<string, unknown> | null
  tiers?: MediaTierName[]
}

/** One media run: the per-tier report plus the rendered markdown. */
export interface MediaRun {
  report: MediaReport
  markdown: string
}

/** The media stage function the pipeline and the media command call. */
export type MediaFn = (input: MediaFnInput) => Promise<MediaRun>

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
  /** The store, for the store-backed daily budget. */
  store?: Pick<Store, 'getMediaBudget' | 'saveMediaBudget'>
  /** Override the daily budget (tests). */
  budget?: import('@atento/core').MediaBudget
}

interface MediaModule {
  runMediaStage?: (
    input: MediaFnInput,
    options?: unknown,
  ) => Promise<MediaReport>
  renderMedia?: (report: MediaReport) => string
}

interface EnrichModule {
  createAudiocppAsr?: (options?: unknown) => AsrFn
}

/** Default loader: dynamic import of @atento/media. */
async function defaultLoad(): Promise<unknown> {
  const specifier = '@atento/media'
  return import(specifier)
}

/** Default loader: dynamic import of @atento/enrich. */
async function defaultEnrichLoad(): Promise<unknown> {
  const specifier = '@atento/enrich'
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
  const renderMedia = mod.renderMedia ?? ((_report: MediaReport) => '')

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

  const config = options.config
  const budget =
    options.budget ??
    (options.store
      ? createMediaBudget(options.store, {
          dailyCap: config?.dailyCap ?? 20,
          dailyCaps: config?.dailyCaps,
        })
      : undefined)

  return async (input: MediaFnInput): Promise<MediaRun> => {
    const report = await runMediaStage(input, {
      asr,
      guard: options.guard,
      config,
      budget,
    })
    return { report, markdown: renderMedia(report) }
  }
}
