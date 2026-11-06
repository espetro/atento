/**
 * login command: interactive browser login via agent-browser, with profile
 * bookkeeping in the profiles table.
 *
 *   linkinbox login              show the remaining logins (interactive pick)
 *   linkinbox login --all        log in to every pending host in turn
 *   linkinbox login <host>       spawn agent-browser --headed with a profile
 *   linkinbox login --json       print the pending list as JSON (agent mode)
 *   linkinbox login list         show saved profiles
 *   linkinbox login clear <host> delete one profile
 *
 * `linkinbox login` with no argument lists the hosts that still need a
 * login: links parked in needs_browser, plus flagged hosts without a saved
 * profile. In a TTY it offers a picker; with --json (or no TTY) it prints
 * machine-readable JSON and never opens a browser. linkinbox never reads,
 * logs or stores passwords, cookies or tokens: only the profile directory
 * path is recorded.
 */
import { spawn } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import type { Command } from 'commander'
import type { CliContext } from '../context.js'
import { renderTable } from '../render.js'
import { runPatchrightLogin, hostUsesPatchright, type PatchrightLoginLaunch, type WaitForEnter } from '../patchright-login.js'
import {
  buildLoginReport,
  loadPendingLogins,
  type DoneLogin,
  type LoadPendingLogins,
  type LoginReport,
  type PendingLogin,
  type PendingLoginPolicy,
} from '../pending-logins.js'

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
  /**
   * How many parked links of the host were requeued for the next extract
   * run. Zero when nothing was parked.
   */
  requeued: number
}

export type { LoginReport } from '../pending-logins.js'

/** Injected browser launcher so tests never spawn a real browser. */
export type LoginLauncher = (host: string, profilePath: string) => Promise<number>

/** Injected picker: returns the hosts the user selected, or null to quit. */
export type LoginPicker = (
  pending: LoginReport['pending'],
  done: LoginReport['done'],
) => Promise<{ selected: string[]; quit: boolean } | null>

/** The hosts a picker picked, in the order the user chose them. */
export type SelectedHosts = { selected: string[]; quit: boolean }

export interface LoginFlowDeps {
  loadLogins?: LoadPendingLogins
  launch?: LoginLauncher
  /** Injected patchright launcher for stealth hosts (tests). */
  patchrightLaunch?: PatchrightLoginLaunch
  /** Injected "wait for Enter" prompt for the patchright flow (tests). */
  waitForEnter?: WaitForEnter
  pick?: LoginPicker
  /** Injected stdin/stdout TTY check (tests). Defaults to process streams. */
  isInteractive?: () => boolean
  /** Force the CI/non-interactive branch regardless of the streams. */
  nonInteractive?: boolean
  /** Log in to every pending host without asking. */
  all?: boolean
}

function runCommand(command: string, args: string[]): Promise<number> {
  return new Promise<number>((resolve) => {
    const child = spawn(command, args, { stdio: 'inherit' })
    child.on('error', () => resolve(-1))
    child.on('exit', (c) => resolve(c ?? 0))
  })
}

function waitForEnter(prompt: string): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  return new Promise<void>((resolve) => rl.question(prompt, () => (rl.close(), resolve())))
}

/**
 * Spawn `agent-browser --headed --profile <dir> open https://<host>` and wait
 * for the user to close the window. Records the profile in the store.
 */
export async function runLogin(
  ctx: CliContext,
  host: string,
  options: {
    url?: string
    command?: string
    launch?: LoginLauncher
    /** Injected patchright launcher (tests). */
    patchrightLaunch?: PatchrightLoginLaunch
    /** Injected "wait for Enter" prompt (tests). */
    waitForEnter?: WaitForEnter
  } = {},
): Promise<LoginResult> {
  const normalizedHost = normalizeHost(host)
  const profilePath = profileDirFor(ctx.config.profilesDir, normalizedHost)
  const url = options.url ?? `https://${normalizedHost}/`

  // The engine follows the config: a host the pipeline extracts with
  // patchright logs in through the same engine, so the saved session is the
  // one the extractor reuses.
  if (hostUsesPatchright(ctx.config.browser, normalizedHost)) {
    return await runPatchrightLoginFlow(ctx, normalizedHost, url, options)
  }

  const command = options.command ?? AGENT_BROWSER
  const launch: LoginLauncher =
    options.launch ??
    (async () => {
      // `open` returns once the page loads while the browser keeps running,
      // so the login is finished by the user, not by this process exiting.
      const code = await runCommand(command, ['--headed', '--profile', profilePath, 'open', url])
      if (code !== 0) return code
      await waitForEnter(
        `Log in to ${normalizedHost} in the browser window, then press Enter here to save the session... `,
      )
      // Closing flushes the session into the profile directory.
      await runCommand(command, ['--profile', profilePath, 'close'])
      return 0
    })

  const code = await launch(normalizedHost, profilePath)

  if (code === -1) {
    console.error(`could not start the login browser; is agent-browser installed?`)
    process.exitCode = 1
    return { host: normalizedHost, profilePath, code, requeued: 0 }
  }

  const profile = await ctx.store.upsertProfile({ host: normalizedHost, path: profilePath })
  console.log(`saved profile for ${profile.host} at ${profile.path}`)
  return {
    host: profile.host,
    profilePath: profile.path,
    code,
    requeued: await requeueHostLinks(ctx, profile.host),
  }
}

/**
 * The patchright login path: a headed persistent context, wait for Enter,
 * close cleanly so the cookies persist, then save the profile row exactly
 * like the agent-browser flow does. Returns code -1 when the browser could
 * not start, so callers treat it like the agent-browser failure path.
 */
async function runPatchrightLoginFlow(
  ctx: CliContext,
  host: string,
  url: string,
  options: { patchrightLaunch?: PatchrightLoginLaunch; waitForEnter?: WaitForEnter } = {},
): Promise<LoginResult> {
  const result = await runPatchrightLogin(host, {
    profilesDir: ctx.config.profilesDir,
    url,
    executablePath: ctx.config.browser.executablePath,
    ...(options.patchrightLaunch ? { launch: options.patchrightLaunch } : {}),
    ...(options.waitForEnter ? { waitForEnter: options.waitForEnter } : {}),
  })
  if (!result.ok) {
    process.exitCode = 1
    return { host, profilePath: result.profilePath, code: -1, requeued: 0 }
  }
  const profile = await ctx.store.upsertProfile({ host, path: result.profilePath })
  console.log(`saved profile for ${profile.host} at ${profile.path}`)
  return {
    host: profile.host,
    profilePath: profile.path,
    code: 0,
    requeued: await requeueHostLinks(ctx, profile.host),
  }
}

/**
 * Requeue a host's parked links: needs_browser -> created via the RETRY
 * event, so the next extract run picks them up with the saved profile.
 */
export async function requeueHostLinks(ctx: CliContext, host: string): Promise<number> {
  const links = await ctx.store.listByStates(['needs_browser'])
  let requeued = 0
  for (const link of links) {
    if (hostOf(link.url) !== host) continue
    const outcome = await ctx.store.applyEvent(link.id, {
      type: 'RETRY',
      at: new Date().toISOString(),
    })
    if (outcome.ok) requeued += 1
  }
  return requeued
}

/** login list: saved profiles. */
export async function runLoginList(ctx: CliContext): Promise<void> {
  const profiles = await ctx.store.listProfiles()
  if (profiles.length === 0) {
    console.log('no saved profiles; run `linkinbox login` to see the remaining logins')
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

/**
 * The host policy the pending list honours, from the config: the skip list,
 * the review list and the `[login] allow` list.
 */
function pendingPolicy(ctx: CliContext): PendingLoginPolicy {
  return {
    limits: ctx.config.limits,
    loginAllow: ctx.config.login?.allow,
  }
}

/**
 * The listing itself: pending hosts ordered by waiting links, then the hosts
 * that already have a profile with its age. Pure data; both the interactive
 * and the JSON branch render from this.
 */
export async function runLoginPending(
  ctx: CliContext,
  deps: LoginFlowDeps = {},
): Promise<LoginReport> {
  const load = deps.loadLogins ?? loadPendingLogins
  return buildLoginReport(await load(ctx.store, pendingPolicy(ctx)))
}

/** Human rendering of the report. */
export function renderLoginReport(report: LoginReport): string {
  const lines: string[] = []
  if (report.pending.length === 0) {
    lines.push('no logins pending')
  } else {
    lines.push('logins still needed (most waiting links first):')
    lines.push(
      renderTable(
        ['host', 'links', 'reason'],
        report.pending.map((p) => [p.host, p.links, p.reason]),
      ),
    )
  }
  if (report.done.length > 0) {
    lines.push('')
    lines.push('done (saved profiles):')
    lines.push(
      renderTable(
        ['host', 'profile age (days)'],
        report.done.map((d) => [d.host, d.profileAgeDays]),
      ),
    )
  }
  if (report.reviewOnly !== undefined && report.reviewOnly > 0) {
    // The review-only links are never fetched and never logged in to: the
    // owner reads them by hand. Say so, so nothing is silently hidden.
    lines.push('')
    const n = report.reviewOnly
    lines.push(
      `review only (never fetched, read by hand): ${n} link${n === 1 ? '' : 's'}`,
    )
  }
  return lines.join('\n')
}

/**
 * The no-argument flow: print the report; in a TTY also offer the picker and
 * run the logins the user selects. Non-interactive mode never opens a
 * browser. Returns the process exit code.
 */
export async function runLoginFlow(
  ctx: CliContext,
  deps: LoginFlowDeps = {},
): Promise<number> {
  const load = deps.loadLogins ?? loadPendingLogins
  const launch = deps.launch
  const interactive =
    deps.nonInteractive !== true && (deps.isInteractive?.() ?? isInteractiveProcess())

  const report = buildLoginReport(await load(ctx.store, pendingPolicy(ctx)))

  if (!interactive) {
    console.log(JSON.stringify(report, null, 2))
    return 0
  }

  if (report.pending.length === 0) {
    console.log(renderLoginReport(report))
    return 0
  }

  console.log(renderLoginReport(report))
  console.log('')

  const pick = deps.pick ?? pickHosts
  const choice: SelectedHosts | null =
    deps.all === true
      ? { selected: report.pending.map((p) => p.host), quit: false }
      : await pick(report.pending, report.done)
  if (choice === null) return 0
  if (choice.quit) {
    console.log('quit; nothing logged in')
    return 0
  }

  const browser: LoginLauncher = launch ?? spawnBrowser

  let logged = 0
  let requeued = 0
  for (const host of choice.selected) {
    const result = await runLogin(ctx, host, {
      launch: browser,
      ...(deps.patchrightLaunch ? { patchrightLaunch: deps.patchrightLaunch } : {}),
      ...(deps.waitForEnter ? { waitForEnter: deps.waitForEnter } : {}),
    })
    if (result.code === -1) continue
    logged += 1
    if (result.requeued > 0) {
      console.log(`requeued ${result.requeued} link${result.requeued === 1 ? '' : 's'} for ${result.host}`)
    }
    requeued += result.requeued
  }

  const remaining = buildLoginReport(await load(ctx.store, pendingPolicy(ctx)))
  console.log('')
  console.log(`logged in to ${logged} host${logged === 1 ? '' : 's'}, requeued ${requeued} link${requeued === 1 ? '' : 's'}`)
  console.log(renderLoginReport(remaining))
  return 0
}

/** Interactive readline picker: comma separated host selection. */
async function pickHosts(
  pending: LoginReport['pending'],
): Promise<{ selected: string[]; quit: boolean } | null> {
  pending.forEach((p, i) => {
    console.log(`  ${i + 1}. ${p.host} (${p.links} link${p.links === 1 ? '' : 's'}, ${p.reason})`)
  })
  console.log('')
  console.log('pick hosts to log in to (e.g. `1` or `1,3`), `s` to skip, `q` to quit:')

  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer: string = await new Promise((resolve) => {
      // stdin closed before an answer (EOF): treat it as skip so the flow
      // always terminates.
      rl.on('close', () => resolve(''))
      rl.question('> ', (line) => resolve(line.trim()))
    })
    if (answer.toLowerCase() === 'q') return { selected: [], quit: true }
    if (answer.toLowerCase() === 's' || answer === '') return { selected: [], quit: false }
    const selected: string[] = []
    for (const part of answer.split(/[\s,]+/)) {
      const idx = Number(part)
      if (!Number.isInteger(idx) || idx < 1 || idx > pending.length) {
        console.error(`ignoring invalid selection: ${part}`)
        continue
      }
      selected.push(pending[idx - 1]!.host)
    }
    return { selected: [...new Set(selected)], quit: false }
  } finally {
    rl.close()
  }
}

/** The default browser launcher: the real agent-browser spawn. */
async function spawnBrowser(host: string, profilePath: string): Promise<number> {
  return await new Promise<number>((resolve) => {
    const child = spawn(AGENT_BROWSER, ['--headed', '--profile', profilePath, 'open', `https://${host}/`], {
      stdio: 'inherit',
    })
    child.on('error', () => resolve(-1))
    child.on('exit', (c) => resolve(c ?? 0))
  })
}

function hostOf(url: string): string {
  try {
    return new URL(url).host.toLowerCase()
  } catch {
    return ''
  }
}

function isInteractiveProcess(): boolean {
  if (process.env['CI']) return false
  return process.stdin.isTTY === true && process.stdout.isTTY === true
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
    .description(
      'browser login via agent-browser. linkinbox never sees your password, ' +
        'cookies or tokens: only the profile directory path is recorded',
    )

  login
    .argument('[host]')
    .description('host to log in to, e.g. x.com; omit to list the remaining logins')
    .option('--url <url>', 'override the login url')
    .option('--json', 'print the pending-login list as JSON and exit')
    .option('--non-interactive', 'never prompt and never open a browser')
    .option('--all', 'log in to every pending host without asking')
    .option('--fail-if-pending', 'exit 2 when logins are still pending (with --json)')
    .action(
      async (
        host: string | undefined,
        opts: {
          url?: string
          json?: boolean
          nonInteractive?: boolean
          all?: boolean
          failIfPending?: boolean
        },
      ) => {
        if (host) {
          const ctx = await deps.ctx()
          try {
            await runLogin(ctx, host, { url: opts.url })
          } finally {
            await ctx.close()
          }
          return
        }

        const ctx = await deps.ctx()
        try {
          if (opts.json || opts.nonInteractive || !isInteractiveProcess()) {
            const report = await runLoginPending(ctx)
            console.log(JSON.stringify(report, null, 2))
            if (opts.failIfPending && report.pending.length > 0) process.exitCode = 2
            return
          }
          process.exitCode = await runLoginFlow(ctx, { all: opts.all === true })
        } finally {
          await ctx.close()
        }
      },
    )

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

  login
    .command('requeue')
    .description("requeue a host's parked needs_browser links (the host must have a saved profile)")
    .argument('<host>')
    .action(async (host: string) => {
      const ctx = await deps.ctx()
      try {
        const normalized = host.toLowerCase()
        if ((await ctx.store.getProfile(normalized)) === null) {
          console.error(`no saved profile for ${normalized}; run: linkinbox login ${normalized}`)
          process.exitCode = 1
          return
        }
        const n = await requeueHostLinks(ctx, normalized)
        console.log(`requeued ${n} link(s) for ${normalized}`)
      } finally {
        await ctx.close()
      }
    })
}
