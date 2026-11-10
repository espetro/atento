/**
 * The media stage: run the requested tiers for one link and report each of
 * them. The download is routed through the core guard so a walled host gets
 * its strict spacing and daily budget like every other fetch.
 *
 * The stage never throws: every tier comes back as a result object.
 */
import type { AsrFn, GuardDeps, MediaConfig, MediaTierName } from '@atento/core'
import { guardRun } from '@atento/core'
import { captionTier, type CaptionInput } from './caption.js'
import { cleanupMedia, downloadAudio, type DownloadOptions } from './download.js'
import { framesTier } from './frames.js'
import { createInMemoryBudget, type MediaBudget } from './budget.js'
import { tierResultSchema, type MediaReport, type TierResult } from './types.js'

export interface MediaStageOptions {
  /** The transcription provider. Injected so the stage stays model-free. */
  asr?: AsrFn
  /** Guard deps over the store; the download runs through it. */
  guard?: GuardDeps
  /** Media config from `[media]`. */
  config?: MediaConfig
  /** Budget for media runs per day. */
  budget?: MediaBudget
  /** yt-dlp and ffmpeg options. */
  download?: DownloadOptions
  /** Media duration from yt-dlp info, when known before download. */
  durationSeconds?: number
  /** Clock, injected in tests. */
  now?: () => number
}

export interface MediaStageInput {
  /** The link URL. */
  url: string
  /** The link's extracted content (markdown) for the caption tier. */
  content?: string | null
  /** Page metadata for the caption tier. */
  meta?: Record<string, unknown> | null
  /** Tiers to run. Defaults to the configured enabled tiers. */
  tiers?: MediaTierName[]
}

function hostOf(url: string): string {
  try {
    return new URL(url).host.toLowerCase()
  } catch {
    return 'unknown'
  }
}

/** The media duration reported by yt-dlp, in seconds. */
/**
 * Run the tiers for one link.
 *
 * Every requested tier appears in the report exactly once, in the order the
 * tiers were requested.
 */
export async function runMediaStage(
  input: MediaStageInput,
  options: MediaStageOptions = {},
): Promise<MediaReport> {
  const now = options.now ?? (() => Date.now())
  const config = options.config
  const tiers = input.tiers ?? config?.enabledTiers ?? ['caption', 'transcript']
  const results: TierResult[] = []

  for (const tier of tiers) {
    const started = now()
    const seconds = (): number => Math.max(0, (now() - started) / 1000)

    if (tier === 'caption') {
      const result = captionTier({ content: input.content ?? null, meta: input.meta ?? null }, 0)
      results.push({ ...result, seconds: seconds() })
      continue
    }

    if (tier === 'frames') {
      results.push({ ...framesTier(), seconds: seconds() })
      continue
    }

    // transcript
    const budget =
      options.budget ??
      createInMemoryBudget({
        dailyCap: config?.dailyCap ?? 20,
        dailyCaps: config?.dailyCaps,
      })
    const allowed = await budget.consume('transcript')
    if (!allowed) {
      results.push({
        tier: 'transcript',
        kind: 'skipped',
        status: 'skipped',
        seconds: seconds(),
        reason: 'daily media budget exhausted',
      })
      continue
    }

    if (!options.asr) {
      results.push({
        tier: 'transcript',
        kind: 'failed',
        status: 'failed',
        seconds: seconds(),
        error: 'no ASR provider configured',
      })
      continue
    }

    let workDir: string | null = null
    const download = async (): Promise<{ wavPath: string; workDir: string }> => {
      const dl = await downloadAudio(input.url, {
        ...options.download,
        cookiesFromBrowser:
          options.download?.cookiesFromBrowser ?? config?.cookiesFromBrowser ?? false,
      })
      workDir = dl.workDir
      return { wavPath: dl.wavPath, workDir: dl.workDir }
    }

    const outcome = options.guard
      ? await guardRun(options.guard, hostOf(input.url), download)
      : await runUnguarded(download)

    if (outcome.kind !== 'ok') {
      results.push({
        tier: 'transcript',
        kind: 'failed',
        status: 'failed',
        seconds: seconds(),
        error: outcome.kind === 'defer' ? `deferred: ${outcome.reason}` : outcome.reason,
      })
      if (workDir) await cleanupMedia(workDir)
      continue
    }

    const { wavPath, workDir: dir } = outcome.value
    const durationSeconds = options.durationSeconds
    const maxDuration = config?.maxDurationSeconds
    if (
      maxDuration !== undefined &&
      durationSeconds !== undefined &&
      durationSeconds > maxDuration
    ) {
      results.push({
        tier: 'transcript',
        kind: 'skipped',
        status: 'skipped',
        seconds: seconds(),
        reason: `media is ${Math.round(durationSeconds)}s, over the ${maxDuration}s limit`,
      })
      await cleanupMedia(dir)
      continue
    }

    try {
      const asr = await options.asr({ audioPath: wavPath })
      const text = asr.text.trim()
      const rtf = asr.metrics?.['metrics.rtf']
      if (text === '') {
        results.push({
          tier: 'transcript',
          kind: 'empty',
        status: 'empty',
          seconds: seconds(),
          reason: 'the provider returned no speech',
        })
        continue
      }
      results.push({
        tier: 'transcript',
        kind: 'transcript',
        status: 'ok',
        seconds: seconds(),
        text,
        rtf,
        audioDurationSeconds: asr.audioDurationSeconds,
      })
    } catch (err) {
      results.push({
        tier: 'transcript',
        kind: 'failed',
        status: 'failed',
        seconds: seconds(),
        error: err instanceof Error ? err.message : String(err),
      })
    } finally {
      await cleanupMedia(dir)
    }
  }

  const report: MediaReport = {
    url: input.url,
    tiers: results.map((r) => tierResultSchema.parse(r)),
  }
  return report
}

type DownloadOutcome =
  | { kind: 'ok'; value: { wavPath: string; workDir: string } }
  | { kind: 'error'; reason: string }

/** Run the download without a guard (used when no guard is configured). */
async function runUnguarded(
  fn: () => Promise<{ wavPath: string; workDir: string }>,
): Promise<DownloadOutcome> {
  try {
    return { kind: 'ok', value: await fn() }
  } catch (err) {
    return { kind: 'error', reason: err instanceof Error ? err.message : String(err) }
  }
}
