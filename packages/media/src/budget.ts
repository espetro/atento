/**
 * Per-day budget for media runs. The counters are per tier and per total.
 * The default implementation lives in memory (one CLI invocation); callers
 * that need a shared budget across runs inject their own.
 */
import type { MediaTierName } from './types.js'

export interface MediaBudget {
  /** Try to spend one run of this tier. False when the budget is exhausted. */
  consume(tier: MediaTierName): Promise<boolean>
  /** Runs spent today, total and per tier. */
  snapshot(): Promise<{ total: number; byTier: Record<string, number> }>
}

export interface InMemoryBudgetOptions {
  /** Total runs allowed per day. */
  dailyCap: number
  /** Per-tier overrides. */
  dailyCaps?: Partial<Record<MediaTierName, number>>
  /** Current day key, e.g. "2026-10-29". Injected in tests. */
  day?: () => string
}

/** A budget that resets when the day key changes. */
export function createInMemoryBudget(options: InMemoryBudgetOptions): MediaBudget {
  const day = options.day ?? (() => new Date().toISOString().slice(0, 10))
  let currentDay = day()
  let total = 0
  const byTier: Record<string, number> = {}

  const reset = (): void => {
    const key = day()
    if (key === currentDay) return
    currentDay = key
    total = 0
    for (const key2 of Object.keys(byTier)) delete byTier[key2]
  }

  return {
    async consume(tier: MediaTierName): Promise<boolean> {
      reset()
      if (total >= options.dailyCap) return false
      const tierCap = options.dailyCaps?.[tier]
      if (tierCap !== undefined && (byTier[tier] ?? 0) >= tierCap) return false
      total += 1
      byTier[tier] = (byTier[tier] ?? 0) + 1
      return true
    },
    async snapshot() {
      reset()
      return { total, byTier: { ...byTier } }
    },
  }
}
