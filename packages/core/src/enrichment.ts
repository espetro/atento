import { z } from 'zod/mini'

/** Zod mini schema for one structured-output enrichment call. */
export const EnrichmentSchema = z.object({
  category: z.string().check(z.minLength(1)),
  priority: z.enum(['low', 'normal', 'high']),
  why_it_matters: z.string().check(z.minLength(1)),
  read_minutes: z.number().check(z.int(), z.nonnegative()),
  action: z.enum(['read_now', 'schedule', 'archive', 'discard']),
  expires_at: z.nullable(z.string()),
  expiry_reason: z.nullable(z.string()),
  confidence: z.number().check(z.minimum(0), z.maximum(1)),
})

export type EnrichmentInput = z.infer<typeof EnrichmentSchema>
