/**
 * browsers command: list the configured browser adapters with their
 * capabilities and a health check.
 *
 *   linkinbox browsers          table of adapters + health
 *   linkinbox browsers --json   machine-readable output
 *
 * Health checks never launch a real browsing session: agent-browser runs
 * `<bin> --version`, patchright checks the optional package imports,
 * cdp-attach probes the endpoint's /json/version, external loads the
 * module.
 */
import type { Command } from 'commander'
import type { CliContext } from '../context.js'
import { createBrowserRegistry } from '@linkinbox/browser'
import { normalizeBrowserConfig, type BrowserHealth } from '@linkinbox/core'
import { renderTable } from '../render.js'

interface Row {
  id: string
  kind: string
  roles: string
  caps: string
  forRoles: string
  escalate: string
  health: string
  detail: string
}

export async function runBrowsers(ctx: CliContext, json = false): Promise<void> {
  const browser = normalizeBrowserConfig(ctx.config.browser)
  const registry = createBrowserRegistry(browser, {
    profilesDir: ctx.config.profilesDir,
  })
  const listings = registry.list()
  const rows: Row[] = []
  const healths: Record<string, BrowserHealth> = {}
  for (const listing of listings) {
    const health = await registry.health(listing.id)
    healths[listing.id] = health
    const caps = listing.caps
    rows.push({
      id: listing.id,
      kind: listing.kind,
      roles: listing.roles.join('+') || '-',
      caps: caps
        ? [
            caps.stealth ? 'stealth' : 'plain',
            caps.headless ? 'headless' : 'headed',
            caps.persistentProfile ? 'profile' : 'no-profile',
          ].join(',')
        : listing.kind === 'external'
          ? 'plugin'
          : '-',
      forRoles: [
        listing.defaultFor.reader ? 'reader' : '',
        listing.defaultFor.login ? 'login' : '',
      ]
        .filter(Boolean)
        .join('+') || '-',
      escalate: listing.inEscalate ? 'yes' : '-',
      health: health.ok ? 'ok' : 'FAIL',
      detail: health.detail,
    })
  }

  if (json) {
    console.log(
      JSON.stringify(
        {
          adapters: rows,
          hostMappings: browser.hosts,
          reader: browser.reader,
          login: browser.login,
          escalate: browser.escalate,
        },
        null,
        2,
      ),
    )
    return
  }

  if (rows.length === 0) {
    console.log('no browser adapters configured')
    return
  }
  console.log(
    renderTable(
      ['id', 'kind', 'roles', 'caps', 'default', 'escalate', 'health', 'detail'],
      rows.map((r) => [
        r.id,
        r.kind,
        r.roles,
        r.caps,
        r.forRoles,
        r.escalate,
        r.health,
        r.detail,
      ]),
    ),
  )
  const failed = rows.filter((r) => r.health === 'FAIL')
  if (failed.length > 0) process.exitCode = 1
}

export function registerBrowsersCommand(
  program: Command,
  deps: { ctx: () => Promise<CliContext> },
): void {
  program
    .command('browsers')
    .description('list the configured browser adapters, their capabilities and health')
    .option('--json', 'print the adapter list as JSON')
    .action(async (opts: { json?: boolean }) => {
      const ctx = await deps.ctx()
      try {
        await runBrowsers(ctx, opts.json === true)
      } finally {
        await ctx.close()
      }
    })
}
