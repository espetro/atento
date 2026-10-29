/**
 * Store-backed per-day budget for media runs: the counters live in the
 * `media_budget` table, so the daily cap survives restarts and is shared by
 * every process on the same database. The day key is UTC `YYYY-MM-DD`.
 */
import type { MediaBudget } from './media.js'
import type { MediaTierName } from './media-config.js'
import type { Store } from './store.js'

/** Current UTC day key, e.g. "2026-10-29". */
export function todayKey(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10)
}

export interface StoreBudgetOptions {
  /** Total runs allowed per day. */
  dailyCap: number
  /** Per-tier overrides. */
  dailyCaps?: Partial<Record<MediaTierName, number>>
  /** Clock, injected in tests. */
  now?: () => Date
}

/** The store-backed budget. One row per day in `media_budget`. */
export function createMediaBudget(
  store: Pick<Store, 'getMediaBudget' | 'saveMediaBudget'>,
  options: StoreBudgetOptions,
): MediaBudget {
  const now = options.now ?? (() => new Date())

  return {
    async consume(tier: MediaTierName): Promise<boolean> {
      const day = todayKey(now())
      const budget = (await store.getMediaBudget(day)) ?? { total: 0, byTier: {} }
      if (budget.total >= options.dailyCap) return false
      const tierCap = options.dailyCaps?.[tier]
      if (tierCap !== undefined && (budget.byTier[tier] ?? 0) >= tierCap) return false
      await store.saveMediaBudget(day, {
        total: budget.total + 1,
        byTier: { ...budget.byTier, [tier]: (budget.byTier[tier] ?? 0) + 1 },
      })
      return true
    },

    async snapshot() {
      const budget = await store.getMediaBudget(todayKey(now()))
      return budget ?? { total: 0, byTier: {} }
    },
  }
}
