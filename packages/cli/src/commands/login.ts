/**
 * login command: interactive browser login via agent-browser, with profile
 * bookkeeping in the profiles table.
 *
 *   linkinbox login <host>       spawn agent-browser --headed with a profile
 *   linkinbox login list         show saved profiles
 *   linkinbox login clear <host> delete one profile
 */
import { spawn } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { Command } from 'commander'
import type { CliContext } from '../context.js'
import { renderTable } from '../render.js'

const AGENT_BROWSER = process.env['LINKINBOX_AGENT_BROWSER'] ?? 'agent-browser'

/** Profile directory for a host: <profilesDir>/<host>. */
export function profileDirFor(profilesDir: string, host: string): string {
  return join(profilesDir, host)
}

export interface LoginResult {
  host: string
  profilePath: string
  /** Exit code of the spawned browser (-1 when it could not start). */
  code: number
}

/**
 * Spawn `agent-browser --headed --profile <dir> open https://<host>` and wait
 * for the user to close the window. Records the profile in the store.
 */
export async function runLogin(
  ctx: CliContext,
  host: string,
  options: { url?: string; command?: string } = {},
): Promise<LoginResult> {
  const normalizedHost = normalizeHost(host)
  const profilePath = profileDirFor(ctx.config.profilesDir, normalizedHost)
  const command = options.command ?? AGENT_BROWSER
  const url = options.url ?? `https://${normalizedHost}/`

  const code = await new Promise<number>((resolve) => {
    const child = spawn(command, ['--headed', '--profile', profilePath, 'open', url], {
      stdio: 'inherit',
    })
    child.on('error', () => resolve(-1))
    child.on('exit', (c) => resolve(c ?? 0))
  })

  if (code === -1) {
    console.error(`could not start ${command}; is agent-browser installed?`)
    process.exitCode = 1
    return { host: normalizedHost, profilePath, code }
  }

  const profile = await ctx.store.upsertProfile({ host: normalizedHost, path: profilePath })
  console.log(`saved profile for ${profile.host} at ${profile.path}`)
  return { host: profile.host, profilePath: profile.path, code }
}

/** login list: saved profiles. */
export async function runLoginList(ctx: CliContext): Promise<void> {
  const profiles = await ctx.store.listProfiles()
  if (profiles.length === 0) {
    console.log('no saved profiles; run `linkinbox login <host>` to create one')
    return
  }
  console.log(
    renderTable(
      ['host', 'path', 'updated'],
      profiles.map((p) => [p.host, p.path, p.updatedAt.toISOString()]),
    ),
  )
}

/** login clear <host>: delete the profile row and its directory. */
export async function runLoginClear(ctx: CliContext, host: string): Promise<void> {
  const normalizedHost = normalizeHost(host)
  const profile = await ctx.store.getProfile(normalizedHost)
  if (!profile) {
    console.log(`no profile for ${normalizedHost}`)
    return
  }
  await ctx.store.deleteProfile(normalizedHost)
  if (profile.path && existsSync(profile.path)) {
    rmSync(profile.path, { recursive: true, force: true })
  }
  console.log(`cleared profile for ${normalizedHost}`)
}

function normalizeHost(host: string): string {
  const trimmed = host.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '')
  return trimmed.toLowerCase()
}

export function registerLoginCommand(
  program: Command,
  deps: { ctx: () => Promise<CliContext> },
): void {
  const login = program
    .command('login')
    .description('interactive browser login via agent-browser')

  login
    .argument('[host]')
    .description('host to log in to, e.g. x.com')
    .option('--url <url>', 'override the login url')
    .action(async (host: string | undefined, opts: { url?: string }) => {
      if (!host) {
        console.error('usage: linkinbox login <host>')
        process.exitCode = 1
        return
      }
      const ctx = await deps.ctx()
      try {
        await runLogin(ctx, host, { url: opts.url })
      } finally {
        await ctx.close()
      }
    })

  login
    .command('list')
    .description('list saved browser profiles')
    .action(async () => {
      const ctx = await deps.ctx()
      try {
        await runLoginList(ctx)
      } finally {
        await ctx.close()
      }
    })

  login
    .command('clear')
    .description('delete a saved browser profile')
    .argument('<host>')
    .action(async (host: string) => {
      const ctx = await deps.ctx()
      try {
        await runLoginClear(ctx, host)
      } finally {
        await ctx.close()
      }
    })
}
