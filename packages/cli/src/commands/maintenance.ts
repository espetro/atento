/**
 * Maintenance commands: sweep and prune. Dry-run by default; both apply paths
 * go through the ops layer and prune asks for confirmation.
 */
import type { Command } from 'commander'
import { createInterface } from 'node:readline/promises'
import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  applyPrune,
  applySweep,
  prune,
  sweep,
  type PrunePlan,
  type SweepPlan,
  type TtlConfig,
} from '@linkinbox/core'
import type { CliContext } from '../context.js'
import { renderTable, shortDate } from '../render.js'

export function renderSweepPlan(plan: SweepPlan): string {
  if (plan.totals.archive === 0) return 'nothing to sweep'
  const out: string[] = []
  for (const group of plan.groups) {
    out.push(`\n${group.category} (${group.items.length})`)
    const table = group.items.map((item) => [
      item.linkId,
      shortDate(item.expiresAt.toISOString()),
      item.title ?? '',
      item.url,
    ])
    out.push(renderTable(['id', 'expires', 'title', 'url'], table))
  }
  out.push(`\n${plan.totals.archive} item(s) would be archived (dry-run; use --apply)`)
  return out.join('\n')
}

export function renderPrunePlan(plan: PrunePlan): string {
  if (plan.totals.delete === 0) return 'nothing to prune'
  const table = plan.items.map((item) => [
    item.linkId,
    `${item.ageDays}d`,
    item.category ?? '',
    item.title ?? '',
    item.url,
  ])
  return renderTable(['id', 'age', 'category', 'title', 'url'], table)
}

export interface SweepOptions {
  apply?: boolean
  now?: Date
}

/** sweep [--apply]: propose (or perform) archiving stale links. */
export async function runSweep(
  ctx: CliContext,
  ttl: TtlConfig,
  opts: SweepOptions = {},
): Promise<SweepPlan> {
  const plan = await sweep(ctx.store, ttl, { now: opts.now })
  console.log(renderSweepPlan(plan))
  if (opts.apply === true && plan.totals.archive > 0) {
    const updated = await applySweep(ctx.store, plan, opts.now ?? new Date())
    console.log(`archived ${updated} link(s)`)
  }
  return plan
}

export interface PruneOptions {
  apply?: boolean
  now?: Date
  /** Skip the interactive confirmation (tests). */
  yes?: boolean
  /** Override the confirmation reader (tests). */
  confirm?: (message: string) => Promise<string>
}

/** prune [--apply]: the only delete path, gated by a confirmation prompt. */
export async function runPrune(
  ctx: CliContext,
  ttl: TtlConfig,
  opts: PruneOptions = {},
): Promise<PrunePlan> {
  const plan = await prune(ctx.store, ttl, { now: opts.now })
  if (plan.totals.delete === 0) {
    console.log('nothing to prune')
    return plan
  }

  console.log(renderPrunePlan(plan))
  if (opts.apply !== true) {
    console.log(`\n${plan.totals.delete} item(s) would be deleted (dry-run; use --apply)`)
    return plan
  }

  const confirmed = opts.yes === true ? 'y' : await (opts.confirm ?? promptYesNo)(
    `delete ${plan.totals.delete} link(s) permanently? this cannot be undone [y/N] `,
  )
  if (confirmed.trim().toLowerCase() !== 'y') {
    console.log('aborted')
    return plan
  }

  const deleted = await applyPrune(ctx.store, plan)
  console.log(`deleted ${deleted} link(s)`)
  return plan
}

async function promptYesNo(message: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    return await rl.question(message)
  } finally {
    rl.close()
  }
}

export interface BackupOptions {
  /** Destination file. Default: <config dir>/backups/linkinbox-<timestamp>.db */
  out?: string
  now?: Date
}

/** Default backup destination inside the config dir (honours LINKINBOX_HOME). */
export function defaultBackupPath(ctx: CliContext, now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19)
  return join(ctx.config.dir, 'backups', `linkinbox-${stamp}.db`)
}

/**
 * backup [--out <path>]: consistent sqlite snapshot via the online backup
 * API. Safe while the pipeline runs — the backup is a point-in-time copy.
 */
export async function runBackup(ctx: CliContext, opts: BackupOptions = {}): Promise<string> {
  const dest = opts.out ?? defaultBackupPath(ctx, opts.now)
  await mkdir(dirname(dest), { recursive: true })
  await ctx.store.backup(dest)
  return dest
}

export function registerMaintenanceCommands(
  program: Command,
  deps: {
    ctx: () => Promise<CliContext>
    ttl: () => TtlConfig
  },
): void {
  program
    .command('sweep')
    .description('list stale links grouped by category (dry-run by default)')
    .option('--apply', 'archive the stale links')
    .action(async (opts: { apply?: boolean }) => {
      const ctx = await deps.ctx()
      try {
        await runSweep(ctx, deps.ttl(), { apply: opts.apply === true })
      } finally {
        await ctx.close()
      }
    })

  program
    .command('prune')
    .description('hard-delete links past delete_after_days (asks for confirmation)')
    .option('--apply', 'run the delete (a confirmation prompt follows)')
    .option('--yes', 'skip the confirmation prompt')
    .action(async (opts: { apply?: boolean; yes?: boolean }) => {
      const ctx = await deps.ctx()
      try {
        await runPrune(ctx, deps.ttl(), {
          apply: opts.apply === true,
          yes: opts.yes === true,
        })
      } finally {
        await ctx.close()
      }
    })

  program
    .command('backup')
    .description('write a consistent sqlite backup of the database')
    .option('--out <path>', 'destination file (default <config dir>/backups/linkinbox-<timestamp>.db)')
    .action(async (opts: { out?: string }) => {
      const ctx = await deps.ctx()
      try {
        const dest = await runBackup(ctx, { out: opts.out })
        console.log(`backup written to ${dest}`)
      } finally {
        await ctx.close()
      }
    })
}
