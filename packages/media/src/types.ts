/**
 * Tiered media report types. Every tier reports one of the variants in
 * TierResult; the combined MediaReport tracks every layer so the caller sees
 * an honest picture of what worked, what was empty, and what is not built.
 */
import { z } from 'zod'

export const MEDIA_TIER_NAMES = ['caption', 'transcript', 'frames'] as const
export const mediaTierNameSchema = z.enum(MEDIA_TIER_NAMES)
export type MediaTierName = (typeof MEDIA_TIER_NAMES)[number]

export const MEDIA_TIER_STATUSES = [
  'ok',
  'empty',
  'failed',
  'unsupported',
  'skipped',
] as const
export const mediaTierStatusSchema = z.enum(MEDIA_TIER_STATUSES)
export type MediaTierStatus = (typeof MEDIA_TIER_STATUSES)[number]

/** Caption tier: page metadata only, nothing is fetched here. */
export const captionResultSchema = z.object({
  kind: z.literal('caption'),
  tier: z.literal('caption'),
  status: z.literal('ok'),
  seconds: z.number(),
  text: z.string(),
  caption: z.string().optional(),
  hashtags: z.array(z.string()).default([]),
  author: z.string().optional(),
  audioTrack: z.string().optional(),
  likeCount: z.number().optional(),
  commentCount: z.number().optional(),
  viewCount: z.number().optional(),
})

/** Transcript tier: downloaded audio, transcribed locally. */
export const transcriptResultSchema = z.object({
  kind: z.literal('transcript'),
  tier: z.literal('transcript'),
  status: z.literal('ok'),
  seconds: z.number(),
  text: z.string(),
  /** Real-time factor when the provider reported it (< 1 is faster than realtime). */
  rtf: z.number().optional(),
  audioDurationSeconds: z.number().optional(),
})

export const tierErrorSchema = z.object({
  kind: z.literal('failed'),
  tier: mediaTierNameSchema,
  status: z.literal('failed'),
  seconds: z.number(),
  error: z.string(),
})

export const tierUnsupportedSchema = z.object({
  kind: z.literal('unsupported'),
  tier: mediaTierNameSchema,
  status: z.literal('unsupported'),
  seconds: z.number(),
  reason: z.string(),
})

export const tierSkippedSchema = z.object({
  kind: z.literal('skipped'),
  tier: mediaTierNameSchema,
  status: z.literal('skipped'),
  seconds: z.number(),
  reason: z.string(),
})

export const tierEmptySchema = z.object({
  kind: z.literal('empty'),
  tier: mediaTierNameSchema,
  status: z.literal('empty'),
  seconds: z.number(),
  reason: z.string().optional(),
})

/**
 * The per-tier result: a discriminated union on `kind`. Every variant keeps
 * the `tier` it belongs to and the `status` it reports.
 */
export const tierResultSchema = z.discriminatedUnion('kind', [
  captionResultSchema,
  transcriptResultSchema,
  tierErrorSchema,
  tierUnsupportedSchema,
  tierSkippedSchema,
  tierEmptySchema,
])
export type TierResult = z.infer<typeof tierResultSchema>
export type CaptionResult = z.infer<typeof captionResultSchema>
export type TranscriptResult = z.infer<typeof transcriptResultSchema>

/** Combined report for one link: every requested tier appears exactly once. */
export const mediaReportSchema = z.object({
  url: z.string(),
  tiers: z.array(tierResultSchema),
})
export type MediaReport = z.infer<typeof mediaReportSchema>
