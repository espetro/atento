import { z } from 'zod'

/** Zod schema for one structured-output enrichment call. */
export const EnrichmentSchema = z.object({
  category: z.string().min(1),
  priority: z.enum(['low', 'normal', 'high']),
  why_it_matters: z.string().min(1),
  read_minutes: z.number().int().nonnegative(),
  action: z.enum(['read_now', 'schedule', 'archive', 'discard']),
  expires_at: z.string().nullable(),
  expiry_reason: z.string().nullable(),
  confidence: z.number().min(0).max(1),
})

export type EnrichmentInput = z.infer<typeof EnrichmentSchema>
