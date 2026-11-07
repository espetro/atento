/**
 * browsers command: list the configured browser adapters with their
 * capabilities and a health check.
 *
 *   linkinbox browsers          table of adapters + health
 *   linkinbox browsers --json   machine-readable output
 *
 * The data comes from the app layer (`app.browsers()`); this command only
 * formats it. Health checks never launch a real browsing session:
 * agent-browser runs `<bin> --version`, patchright checks the optional
 * package imports, cdp-attach probes the endpoint's /json/version,
 * external loads the module.
 */
import type { Command } from 'commander'
import type { CliContext } from '../context.js'
import type { BrowserAdapterInfo } from '@linkinbox/app'
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

function rowFor(adapter: BrowserAdapterInfo): Row {
  const caps = adapter.caps
  return {
    id: adapter.id,
    kind: adapter.kind,
    roles: adapter.roles.join('+') || '-',
    caps: caps
      ? [
          caps.stealth ? 'stealth' : 'plain',
          caps.headless ? 'headless' : 'headed',
          caps.persistentProfile ? 'profile' : 'no-profile',
        ].join(',')
      : adapter.kind === 'external'
        ? 'plugin'
        : '-',
    forRoles: [
      adapter.defaultFor.reader ? 'reader' : '',
      adapter.defaultFor.login ? 'login' : '',
    ]
      .filter(Boolean)
      .join('+') || '-',
    escalate: adapter.inEscalate ? 'yes' : '-',
    health: adapter.health.ok ? 'ok' : 'FAIL',
    detail: adapter.health.detail,
  }
}

export async function runBrowsers(ctx: CliContext, json = false): Promise<void> {
  const info = await ctx.app.browsers()
  const rows = info.adapters.map(rowFor)

  if (json) {
    console.log(
      JSON.stringify(
        {
          adapters: rows,
          hostMappings: info.hostMappings,
          reader: info.reader,
          login: info.login,
          escalate: info.escalate,
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
