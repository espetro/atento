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
import { existsSync, rmSync } from 'node:fs'
import { createInterface } from 'node:readline'
import type { Command } from 'commander'
import type { CliContext } from '../context.js'
import { hostPolicy } from '@linkinbox/app'
import { renderTable } from '../render.js'
import {
  browserAdapterConfig,
  browserProfileDir,
  migrateBrowserProfiles,
  normalizeBrowserConfig,
  remapLegacyProfilePath,
  resolveBrowserAdapter,
  type BrowserConfig,
  type SessionLoginPort,
} from '@linkinbox/core'
import { createAgentBrowserAdapter, createBrowserRegistry, createPatchrightAdapter } from '@linkinbox/browser'
import type { PatchrightLoginLaunch, WaitForEnter } from '../patchright-login.js'
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

/** Profile directory for a host on an adapter: <profilesDir>/<host>/<adapterId>. */
export function profileDirFor(profilesDir: string, host: string, adapterId = 'headless'): string {
  return browserProfileDir(profilesDir, host, adapterId)
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

/** The hosts a picker picked, in the order the user chose them. */
export type SelectedHosts = { selected: string[]; quit: boolean; walk?: boolean }

/** Injected picker: returns the hosts the user selected, or null to quit. */
export type LoginPicker = (
  pending: LoginReport['pending'],
  done: LoginReport['done'],
) => Promise<SelectedHosts | null>

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
  /** Injected walk prompt, used when the walk runs (tests). */
  prompt?: WalkPrompt
}

function waitForEnter(prompt: string): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  return new Promise<void>((resolve) => rl.question(prompt, () => (rl.close(), resolve())))
}

/**
 * Spawn the login browser through the host's SessionLoginPort and wait
 * for the user to finish. Records the profile in the store.
 *
 * M1: the engine is no longer an if/else — the `[browser]` registry
 * resolves the login adapter for the host (host mapping -> login
 * default), and the adapter's SessionLoginPort runs the flow. Test seams
 * (`launch`, `patchrightLaunch`, `waitForEnter`) map onto the ports.
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
  const browser = normalizeBrowserConfig(ctx.config.browser)
  await migrateStoredBrowserProfiles(ctx, browser)
  const adapterId = resolveBrowserAdapter(browser, 'login', normalizedHost)
  const profilePath = profileDirFor(ctx.config.profilesDir, normalizedHost, adapterId)

  const port = loginPortFor(ctx, normalizedHost, adapterId, browser, options)
  if (!port) {
    console.error(`adapter "${adapterId}" has no login port; it cannot capture a session`)
    process.exitCode = 1
    return { host: normalizedHost, profilePath, code: -1, requeued: 0 }
  }

  const result = await port.login(
    normalizedHost,
    { host: normalizedHost, adapterId, path: profilePath },
    { waitForUser: options.waitForEnter ?? waitForEnter },
  )

  if (!result.ok) {
    if (result.detail) console.error(result.detail)
    process.exitCode = 1
    return { host: normalizedHost, profilePath, code: -1, requeued: 0 }
  }

  const profile = await ctx.store.upsertProfile({ host: normalizedHost, path: profilePath })
  console.log(`saved profile for ${profile.host} at ${profile.path}`)
  return {
    host: profile.host,
    profilePath: profile.path,
    code: 0,
    requeued: await requeueHostLinks(ctx, profile.host),
  }
}

/**
 * The SessionLoginPort for one host's resolved login adapter. Test seams
 * wrap the built-in ports; cdp-attach and external adapters come straight
 * from the registry.
 */
function loginPortFor(
  ctx: CliContext,
  host: string,
  adapterId: string,
  browser: BrowserConfig,
  options: {
    command?: string
    launch?: LoginLauncher
    patchrightLaunch?: PatchrightLoginLaunch
  },
): SessionLoginPort | undefined {
  const adapterConfig = browserAdapterConfig(browser, adapterId)
  const executablePath =
    (typeof adapterConfig?.options['executablePath'] === 'string'
      ? (adapterConfig.options['executablePath'] as string)
      : undefined) ?? browser.executablePath

  if (adapterConfig?.kind === 'agent-browser') {
    if (options.launch) {
      // The legacy launcher seam: it owns the whole headed flow and
      // resolves the exit code (-1 = could not start).
      const launch = options.launch
      return {
        id: adapterId,
        async login(_host, profile) {
          const code = await launch(host, profile.path)
          return { ok: code !== -1, ...(code !== 0 ? { detail: `exit code ${code}` } : {}) }
        },
        async verify() {
          return false
        },
      }
    }
    return createAgentBrowserAdapter({
      id: adapterId,
      profilesDir: ctx.config.profilesDir,
      ...(options.command ? { command: options.command } : {}),
      ...(executablePath ? { executablePath } : {}),
    }).login
  }

  if (adapterConfig?.kind === 'patchright') {
    return createPatchrightAdapter({
      id: adapterId,
      profilesDir: ctx.config.profilesDir,
      ...(options.patchrightLaunch ? { launch: options.patchrightLaunch } : {}),
      ...(executablePath ? { executablePath } : {}),
    }).login
  }

  // cdp-attach (login is a no-op + verify) and external plugins resolve
  // through the registry like every other adapter.
  const registry = createBrowserRegistry(browser, {
    profilesDir: ctx.config.profilesDir,
  })
  return registry.loginFor(host)
}

/**
 * The one-time profile migration plus the stored-path rewrite, run before
 * a login so the session lands where the extractors will look for it.
 */
async function migrateStoredBrowserProfiles(ctx: CliContext, browser: BrowserConfig): Promise<void> {
  try {
    migrateBrowserProfiles(ctx.config.profilesDir, browser, (m) =>
      ctx.logger.info(m),
    )
    for (const profile of await ctx.store.listProfiles()) {
      const next = remapLegacyProfilePath(ctx.config.profilesDir, browser, profile.path)
      if (next === undefined || next === profile.path) continue
      if (existsSync(next) && !existsSync(profile.path)) {
        await ctx.store.upsertProfile({ host: profile.host, path: next })
      }
    }
  } catch {
    // Best effort: a migration failure must never block a login.
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

/**
 * Injected walk prompt (tests): asked before each host. Returns "s" to skip
 * the host, "q" to stop the walk, anything else (Enter) to proceed.
 */
export type WalkPrompt = (host: string, index: number, total: number) => Promise<string>

export interface LoginWalkDeps {
  loadLogins?: LoadPendingLogins
  launch?: LoginLauncher
  patchrightLaunch?: PatchrightLoginLaunch
  waitForEnter?: WaitForEnter
  prompt?: WalkPrompt
}

/** The default walk prompt: a readline question on stdin/stdout. */
function askWalkPrompt(host: string, index: number, total: number): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  return new Promise<string>((resolve) => {
    rl.on('close', () => resolve(''))
    rl.question(`proceed with ${host}? [Enter/s/q] `, (line) => resolve(line.trim().toLowerCase()))
  }).finally(() => rl.close())
}

export interface LoginWalkResult {
  loggedIn: string[]
  skipped: string[]
  failed: string[]
  requeued: number
  quit: boolean
}

/**
 * The login walk: visit every pending host in order (most parked links
 * first, review-only hosts excluded as always), log in to it, requeue its
 * parked links, then continue. Enter proceeds, `s` skips a host for the
 * rest of this run, `q` stops the walk.
 */
export async function runLoginWalk(
  ctx: CliContext,
  deps: LoginWalkDeps = {},
  onlyHosts?: string[],
): Promise<LoginWalkResult> {
  const load = deps.loadLogins ?? loadPendingLogins
  const launch = deps.launch
  const ask = deps.prompt ?? askWalkPrompt
  const report = buildLoginReport(await load(ctx.store, pendingPolicy(ctx)))
  const hosts = onlyHosts ?? report.pending.map((p) => p.host)
  const total = hosts.length

  if (total === 0) {
    console.log('no pending logins; nothing to walk')
    return { loggedIn: [], skipped: [], failed: [], requeued: 0, quit: false }
  }

  const skipped = new Set<string>()
  const loggedIn: string[] = []
  const failed: string[] = []
  let requeued = 0
  let quit = false

  for (let i = 0; i < total; i++) {
    const host = hosts[i]!
    if (skipped.has(host)) continue
    const entry = report.pending.find((p) => p.host === host)
    console.log(`${i + 1} of ${total}: ${host} (${entry?.links ?? 0} link${entry?.links === 1 ? '' : 's'})`)
    const answer = await ask(host, i + 1, total)
    if (answer === 'q') {
      quit = true
      break
    }
    if (answer === 's') {
      skipped.add(host)
      console.log(`skipped ${host} for this run`)
      continue
    }
    const result = await runLogin(ctx, host, {
      ...(launch ? { launch } : {}),
      ...(deps.patchrightLaunch ? { patchrightLaunch: deps.patchrightLaunch } : {}),
      ...(deps.waitForEnter ? { waitForEnter: deps.waitForEnter } : {}),
    })
    if (result.code === -1) {
      failed.push(host)
      console.log(`login failed for ${host}; continuing`)
      continue
    }
    loggedIn.push(host)
    if (result.requeued > 0) {
      console.log(`requeued ${result.requeued} link${result.requeued === 1 ? '' : 's'} for ${result.host}`)
    }
    requeued += result.requeued
  }

  console.log('')
  if (quit) {
    console.log(
      `stopped after ${loggedIn.length} of ${total} host${total === 1 ? '' : 's'}, requeued ${requeued} link${requeued === 1 ? '' : 's'}`,
    )
  } else {
    const parts = [`logged in to ${loggedIn.length} host${loggedIn.length === 1 ? '' : 's'}, requeued ${requeued} link${requeued === 1 ? '' : 's'}`]
    if (skipped.size > 0) parts.push(`skipped ${skipped.size} host${skipped.size === 1 ? '' : 's'}`)
    if (failed.length > 0) parts.push(`failed ${failed.length} host${failed.length === 1 ? '' : 's'}`)
    console.log(parts.join(', '))
  }
  const remaining = buildLoginReport(await load(ctx.store, pendingPolicy(ctx)))
  console.log(renderLoginReport(remaining))
  return { loggedIn, skipped: [...skipped], failed, requeued, quit }
}

export interface ParkedRequeueResult {
  /** Total links moved back to the created queue. */
  requeued: number
  /** Per-host counts, in host-name order. */
  counts: Record<string, number>
}

/**
 * The parked backfill: move every needs_browser link (plus deferred
 * extract-stage links whose backoff is pending) back to `created` through
 * the RETRY event, so the next extract run's auto-escalation reprocesses
 * them. Review-only and skip-listed hosts are never touched.
 */
export async function runParkedRequeue(
  ctx: CliContext,
  options: { host?: string } = {},
): Promise<ParkedRequeueResult> {
  const links = await ctx.store.listByStates(['needs_browser', 'deferred'])
  const counts: Record<string, number> = {}
  let requeued = 0
  for (const link of links) {
    if (link.state === 'deferred') {
      const stage = link.stateData?.['stage']
      if (stage !== 'extract') continue
    }
    const host = hostOf(link.url)
    if (host === '' || host === 'unknown') continue
    if (options.host !== undefined && host !== options.host.toLowerCase()) continue
    const state = await ctx.store.getHostState(host)
    const hasProfile = (await ctx.store.getProfile(host)) !== null
    const policy = hostPolicy(ctx.config.limits, host, {
      hasProfile,
      trialState: state?.trialState ?? 'unknown',
      loginGated: state?.loginGated ?? false,
      loginAllow: ctx.config.login?.allow,
    })
    if (policy.skipped || policy.reviewOnly) continue
    const outcome = await ctx.store.applyEvent(link.id, {
      type: 'RETRY',
      at: new Date().toISOString(),
    })
    if (!outcome.ok) continue
    requeued += 1
    counts[host] = (counts[host] ?? 0) + 1
  }
  const ordered = Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)))
  for (const [host, n] of Object.entries(ordered)) {
    console.log(`${host}: ${n}`)
  }
  if (requeued === 0) console.log('nothing to requeue')
  else console.log(`requeued ${requeued} link${requeued === 1 ? '' : 's'}`)
  return { requeued, counts: ordered }
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
  if (choice.walk === true) {
    await runLoginWalk(ctx, {
      ...(deps.loadLogins ? { loadLogins: deps.loadLogins } : {}),
      ...(deps.launch ? { launch: deps.launch } : {}),
      ...(deps.patchrightLaunch ? { patchrightLaunch: deps.patchrightLaunch } : {}),
      ...(deps.waitForEnter ? { waitForEnter: deps.waitForEnter } : {}),
      ...(deps.prompt ? { prompt: deps.prompt } : {}),
    })
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
): Promise<SelectedHosts | null> {
  pending.forEach((p, i) => {
    console.log(`  ${i + 1}. ${p.host} (${p.links} link${p.links === 1 ? '' : 's'}, ${p.reason})`)
  })
  console.log('')
  console.log(
    'pick hosts to log in to (e.g. `1` or `1,3`), `a` to walk every pending host one by one, `s` to skip, `q` to quit:',
  )

  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer: string = await new Promise((resolve) => {
      // stdin closed before an answer (EOF): treat it as skip so the flow
      // always terminates.
      rl.on('close', () => resolve(''))
      rl.question('> ', (line) => resolve(line.trim()))
    })
    if (answer.toLowerCase() === 'q') return { selected: [], quit: true }
    if (answer.toLowerCase() === 'a') {
      return { selected: pending.map((p) => p.host), quit: false, walk: true }
    }
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
  const { spawn } = await import('node:child_process')
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

/**
 * The `requeue` command. Today only the parked backfill:
 *   linkinbox requeue --parked [--host <h>]
 * moves needs_browser links (and pending deferred ones) back to created via
 * the RETRY path, skipping review-only and skip-listed hosts.
 */
export function registerRequeueCommand(
  program: Command,
  deps: { ctx: () => Promise<CliContext> },
): void {
  program
    .command('requeue')
    .description('backfill parked links back into the extraction queue')
    .option('--parked', 'requeue needs_browser and pending deferred links back to created')
    .option('--host <host>', 'restrict the backfill to one host')
    .action(async (opts: { parked?: boolean; host?: string }) => {
      if (opts.parked !== true) {
        console.error('nothing to do: pass --parked (e.g. `linkinbox requeue --parked`)')
        process.exitCode = 1
        return
      }
      const ctx = await deps.ctx()
      try {
        await runParkedRequeue(ctx, opts.host !== undefined ? { host: opts.host } : {})
      } finally {
        await ctx.close()
      }
    })
}
