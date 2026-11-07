/**
 * browse command: read one page through the saved profile of its host and
 * print it as markdown.
 *
 *   linkinbox browse <url>          read the page as markdown
 *   linkinbox browse <url> --json   machine-readable result
 *   linkinbox browse hosts          which hosts are shareable, and why not
 *
 * READ-ONLY: there is no click, no type, no form here. Only the hosts in
 * the `[share] hosts` config list may be read (it ships empty, so nothing
 * is shared until the owner opts in), and only through a saved profile
 * from `linkinbox login`. The read spends the same per-host budget as the
 * extraction stage: human pacing, the daily cap, the working-hours window
 * and the circuit breaker. Nothing is written to the link store.
 */
import type { Command } from 'commander'
import { guardDepsFromStore, type BrowseResult } from '@linkinbox/app'
import type { CliContext } from '../context.js'
import { runBrowse, runBrowseHosts, type BrowseDeps } from '../browse-fn.js'

/** The deps for one browse call, resolved from the CLI context. */
export function browseDeps(ctx: CliContext, reader?: BrowseDeps['reader']): BrowseDeps {
  return {
    share: ctx.config.share,
    browser: ctx.config.browser,
    profilesDir: ctx.config.profilesDir,
    hasProfile: async (host) => (await ctx.store.getProfile(host)) !== null,
    guard: guardDepsFromStore(ctx.store, {
      config: { limits: ctx.config.limits, pacing: ctx.config.pacing },
    }),
    reader,
  }
}

/** Human rendering of a browse result. */
export function renderBrowseResult(result: BrowseResult): string {
  if (result.ok) return result.markdown
  const lines: string[] = [`browse failed: ${result.reason}`]
  if (result.detail) lines.push(result.detail)
  if (result.retryAfterMs !== undefined && result.retryAfterMs > 0) {
    const s = Math.round(result.retryAfterMs / 1000)
    lines.push(`retry after ~${s >= 90 ? `${Math.round(s / 60)}m` : `${s}s`}`)
  }
  return lines.join('\n')
}

export function registerBrowseCommand(
  program: Command,
  deps: { ctx: () => Promise<CliContext> },
): void {
  const browse = program
    .command('browse')
    .description(
      'read one page through the saved profile of its host (read-only, ' +
        'allowlisted hosts only, same pacing and daily cap as extraction)',
    )

  browse
    .argument('[url]')
    .description('the page to read; omit with `hosts` to list the shareable hosts')
    .option('--json', 'print the result as JSON')
    .action(async (url: string | undefined, opts: { json?: boolean }) => {
      const ctx = await deps.ctx()
      try {
        if (!url) {
          console.error('usage: linkinbox browse <url> | linkinbox browse hosts')
          process.exitCode = 1
          return
        }
        const result = await runBrowse(url, browseDeps(ctx))
        if (opts.json) {
          console.log(JSON.stringify(result, null, 2))
          if (!result.ok) process.exitCode = 1
          return
        }
        console.log(renderBrowseResult(result))
        if (!result.ok) process.exitCode = 1
      } finally {
        await ctx.close()
      }
    })

  browse
    .command('hosts')
    .description('list the saved profiles with their share verdict (who may read what)')
    .option('--json', 'print the list as JSON')
    .action(async (opts: { json?: boolean }) => {
      const ctx = await deps.ctx()
      try {
        const profiles = await ctx.store.listProfiles()
        const rows = await runBrowseHosts(profiles, { share: ctx.config.share })
        if (opts.json) {
          console.log(JSON.stringify({ hosts: rows }, null, 2))
          return
        }
        if (rows.length === 0) {
          console.log('no saved profiles; run `linkinbox login <host>` first')
          return
        }
        for (const row of rows) {
          const verdict = row.shared ? 'shared' : 'not shared (add it to [share] hosts to share it)'
          console.log(`${row.host}: ${verdict}`)
        }
      } finally {
        await ctx.close()
      }
    })
}
