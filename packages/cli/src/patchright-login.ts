/**
 * Patchright login: a HEADED persistent browser context for one host, so the
 * user can log in by hand and the session (cookies, local storage) persists
 * in the host's profile directory.
 *
 *   linkinbox login <host>
 *
 * The engine follows the `[browser]` config: a host the pipeline extracts
 * with Patchright (stealth_hosts or engine = "patchright") logs in through
 * the Patchright persistent context; every other host keeps the
 * agent-browser headed flow. In both cases linkinbox never sees the
 * password, the cookies or the tokens: only the profile directory path is
 * recorded.
 *
 * The Patchright import is dynamic and optional; the launcher is injected,
 * so the tests run with fakes and no real browser.
 */
import { engineForHost, type BrowserConfig } from '@linkinbox/app'
import {
  defaultPatchrightLaunch,
  patchrightProfileDir,
  type PatchrightContext,
  type PatchrightLaunch,
} from '@linkinbox/extractors'

/**
 * The injected Patchright login launcher. Tests pass a fake; production
 * uses the real launcher over the optional patchright package.
 */
export type PatchrightLoginLaunch = PatchrightLaunch

/** The injected "wait for Enter" prompt, so tests never block on stdin. */
export type WaitForEnter = (prompt: string) => Promise<void>

/** Result of one patchright login attempt. */
export interface PatchrightLoginResult {
  host: string
  /** The patchright profile directory that received the session. */
  profilePath: string
  /** True when the context closed cleanly and the session was flushed. */
  ok: boolean
}

/**
 * Run one Patchright login for a host: open a headed persistent context at
 * <profile>/<host>/patchright, navigate to the host, wait for the user to
 * press Enter (the login happens in the browser window), then close cleanly
 * so the cookies persist. Never throws: a failed launch comes back as
 * ok: false.
 */
export async function runPatchrightLogin(
  host: string,
  options: {
    profilesDir: string
    url?: string
    executablePath?: string
    launch?: PatchrightLoginLaunch
    waitForEnter?: WaitForEnter
    log?: (message: string) => void
  },
): Promise<PatchrightLoginResult> {
  const launch = options.launch ?? defaultPatchrightLaunch
  const prompt = options.waitForEnter ?? realWaitForEnter
  const say = options.log ?? ((message: string) => console.log(message))
  const profilePath = patchrightProfileDir(`https://${host}/`, options.profilesDir)
  const url = options.url ?? `https://${host}/`

  let context: PatchrightContext | undefined
  try {
    context = await launch(profilePath, {
      headless: false,
      ...(options.executablePath ? { executablePath: options.executablePath } : {}),
      viewport: null,
    })
    const page = context.pages()[0] ?? (await context.newPage())
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120_000 })
    await prompt(
      `Log in to ${host} in the browser window, then press Enter here to save the session... `,
    )
    // Closing cleanly flushes the session into the profile directory.
    try {
      await context.close()
    } catch (error) {
      say(`warning: the browser did not close cleanly (${String(error)})`)
    }
    context = undefined
    return { host, profilePath, ok: true }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    say(`could not start the patchright login browser: ${message.split('\n')[0] ?? message}`)
    say('is the patchright package installed and its chromium downloaded? see docs/stealth.md')
    return { host, profilePath, ok: false }
  } finally {
    // Best effort: whatever state the context is in, the profile directory
    // stays on disk.
    if (context) {
      try {
        await context.close()
      } catch {
        // Already reported above when it mattered.
      }
    }
  }
}

/** The real readline prompt. */
async function realWaitForEnter(promptText: string): Promise<void> {
  const { createInterface } = await import('node:readline')
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  return new Promise<void>((resolve) => rl.question(promptText, () => (rl.close(), resolve())))
}

/** True when a host logs in with the patchright engine (same rule as extraction). */
export function hostUsesPatchright(config: BrowserConfig, host: string): boolean {
  return engineForHost(config, host) === 'patchright'
}
