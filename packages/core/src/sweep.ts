import type { Link, Status } from './types.js'
import type { TtlConfig } from './ttl.js'

/** The action a sweep proposes. Sweep only ever archives; delete is prune's job. */
export type ProposedAction = 'archive'

export interface SweepItem {
  linkId: number
  url: string
  title: string | null
  category: string | null
  expiresAt: Date
  expiryReason: string | null
  action: ProposedAction
  /** True when the link is also old enough (by delete_after_days) to be pruned. */
  pruneEligible: boolean
}

export interface SweepGroup {
  category: string
  action: ProposedAction
  items: SweepItem[]
}

export interface SweepPlan {
  /** Groups sorted by category name, each group homogeneous. */
  groups: SweepGroup[]
  totals: { archive: number }
}

export interface SweepOptions {
  /** Moment of evaluation. Stale means expiresAt strictly before now. */
  now: Date
  ttl: TtlConfig
  /** Statuses to consider. Default: inbox and scheduled. */
  statuses?: Status[]
}

export interface PruneItem {
  linkId: number
  url: string
  title: string | null
  category: string | null
  /** The date used for the age check (expiresAt, else addedAt, else createdAt). */
  referenceDate: Date
  ageDays: number
}

export interface PrunePlan {
  items: PruneItem[]
  totals: { delete: number }
}

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Pure sweep planner: given links + now + ttl config, list the stale items
 * grouped by category with the action sweep would take (archive). Dry-run by
 * construction. Applying is the caller's job: sweep --apply calls
 * `updateStatus(ids, 'archived')` and never deletes.
 */
export function planSweep(links: Link[], opts: SweepOptions): SweepPlan {
  const statuses = opts.statuses ?? (['inbox', 'scheduled'] as Status[])
  const allowed = new Set(statuses)
  const deleteCutoff = opts.now.getTime() - opts.ttl.delete_after_days * DAY_MS

  const groups = new Map<string, SweepGroup>()
  let total = 0

  for (const link of links) {
    if (!allowed.has(link.status)) continue
    if (link.expiresAt === null) continue
    const t = link.expiresAt.getTime()
    if (t >= opts.now.getTime()) continue // not stale yet
    const category = link.enrichment?.category ?? null
    const key = category ?? 'uncategorized'
    let group = groups.get(key)
    if (!group) {
      group = { category: key, action: 'archive', items: [] }
      groups.set(key, group)
    }
    group.items.push({
      linkId: link.id,
      url: link.url,
      title: link.title,
      category,
      expiresAt: link.expiresAt,
      expiryReason: link.expiryReason,
      action: 'archive',
      pruneEligible: t < deleteCutoff,
    })
    total += 1
  }

  for (const group of groups.values()) {
    group.items.sort((a, b) => a.expiresAt.getTime() - b.expiresAt.getTime())
  }

  return {
    groups: [...groups.values()].sort((a, b) => (a.category < b.category ? -1 : a.category > b.category ? 1 : 0)),
    totals: { archive: total },
  }
}

/**
 * Pure prune planner: the only delete path. Candidates are links that are
 * already actioned (archived or discarded) and older than `delete_after_days`
 * measured from `expiresAt` when present, else `addedAt`, else `createdAt`.
 * The confirmation prompt and the actual delete live in the CLI layer.
 */
export function planPrune(links: Link[], opts: SweepOptions): PrunePlan {
  const cutoff = opts.now.getTime() - opts.ttl.delete_after_days * DAY_MS
  const deletable: Status[] = ['archived', 'discarded']
  const items: PruneItem[] = []

  for (const link of links) {
    if (!deletable.includes(link.status)) continue
    const ref = link.expiresAt ?? link.addedAt ?? link.createdAt
    if (ref.getTime() >= cutoff) continue
    items.push({
      linkId: link.id,
      url: link.url,
      title: link.title,
      category: link.enrichment?.category ?? null,
      referenceDate: ref,
      ageDays: Math.floor((opts.now.getTime() - ref.getTime()) / DAY_MS),
    })
  }

  items.sort((a, b) => a.referenceDate.getTime() - b.referenceDate.getTime())
  return { items, totals: { delete: items.length } }
}
