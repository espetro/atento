/**
 * `linkinbox media <id|url>`: run the tiered media stage on one link that is
 * already in the store. Prints a per-tier report table, or JSON with --json.
 */
import type { Command } from 'commander'
import {
  getLink,
  MEDIA_TIERS,
  normalizeUrl,
  type MediaTierName,
} from '@linkinbox/core'
import type { MediaReport, TierResult } from '@linkinbox/media'
import type { CliContext } from '../context.js'
import { renderTable } from '../render.js'

/** Resolve a link by numeric id or by URL. */
export async function resolveLink(
  ctx: CliContext,
  idOrUrl: string,
): Promise<{ id: number; url: string; content: string | null } | null> {
  if (/^\d+$/.test(idOrUrl)) {
    const link = await ctx.store.getLink(Number(idOrUrl))
    if (!link) return null
    return { id: link.id, url: link.url, content: link.extractedContent }
  }
  const { hash } = normalizeUrl(idOrUrl)
  const link = await ctx.store.getLinkByUrlHash(hash)
  if (!link) return null
  return { id: link.id, url: link.url, content: link.extractedContent }
}

/** Parse the --tiers option: comma-separated names, validated. */
export function parseTiers(value: string | undefined): MediaTierName[] | undefined {
  if (value === undefined) return undefined
  const names = value
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t !== '')
  for (const name of names) {
    if (!MEDIA_TIERS.includes(name as MediaTierName)) {
      throw new Error(`unknown tier "${name}"; expected one of ${MEDIA_TIERS.join(', ')}`)
    }
  }
  return names as MediaTierName[]
}

/** One row of the report table. */
export function tierRow(tier: TierResult): (string | number)[] {
  const chars =
    (tier.kind === 'caption' || tier.kind === 'transcript' ? tier.text.length : 0) || 0
  const detail =
    tier.kind === 'failed'
      ? tier.error
      : tier.kind === 'unsupported' || tier.kind === 'skipped'
        ? tier.reason
        : tier.kind === 'empty'
          ? (tier.reason ?? '')
          : ''
  return [
    tier.tier,
    tier.status,
    tier.seconds.toFixed(2),
    chars,
    detail.slice(0, 60),
  ]
}

/** Render the report as a fixed-width table. */
export function renderMediaTable(report: MediaReport): string {
  return renderTable(
    ['tier', 'status', 'seconds', 'chars', 'reason'],
    report.tiers.map(tierRow),
  )
}

export interface MediaCommandDeps {
  ctx: () => Promise<CliContext>
  mediaFn: () => Promise<(input: { url: string; content?: string | null; tiers?: MediaTierName[] }) => Promise<MediaReport>>
}

export function registerMediaCommand(program: Command, deps: MediaCommandDeps): void {
  program
    .command('media <id|url>')
    .description('run the tiered media stage (caption, transcript, frames) on one link')
    .option('--tiers <tiers>', `comma-separated tiers to run (${MEDIA_TIERS.join(',')})`)
    .option('--json', 'emit the full report as JSON')
    .action(async (idOrUrl: string, opts: { tiers?: string; json?: boolean }) => {
      const ctx = await deps.ctx()
      try {
        const link = await resolveLink(ctx, idOrUrl)
        if (!link) {
          console.error(`no link found for "${idOrUrl}"`)
          process.exitCode = 1
          return
        }
        const tiers = parseTiers(opts.tiers)
        const run = await deps.mediaFn()
        const report = await run({ url: link.url, content: link.content, tiers })
        if (opts.json) {
          console.log(JSON.stringify(report, null, 2))
          return
        }
        console.log(renderMediaTable(report))
      } finally {
        await ctx.close()
      }
    })
}
