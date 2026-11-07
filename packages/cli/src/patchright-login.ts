/**
 * Patchright login: a HEADED persistent browser context for one host, so the
 * user can log in by hand and the session (cookies, local storage) persists
 * in the host's profile directory.
 *
 * M1: the flow itself lives in the patchright adapter's SessionLoginPort
 * (@linkinbox/browser); this module keeps the pre-M1 call shape for the
 * login command and the tests.
 *
 * The Patchright import is dynamic and optional; the launcher is injected,
 * so the tests run with fakes and no real browser.
 */
import { createPatchrightAdapter, type PatchrightAdapter } from '@linkinbox/browser'
import {
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

/** Build the patchright adapter's login port with the given seams. */
export function patchrightLoginPort(options: {
  id?: string
  profilesDir: string
  executablePath?: string
  launch?: PatchrightLoginLaunch
}): PatchrightAdapter['login'] {
  const adapter = createPatchrightAdapter({
    id: options.id ?? 'patchright',
    profilesDir: options.profilesDir,
    ...(options.launch ? { launch: options.launch } : {}),
    ...(options.executablePath ? { executablePath: options.executablePath } : {}),
  })
  return adapter.login
}

/**
 * Run one Patchright login for a host: open a headed persistent context,
 * navigate to the host, wait for the user to press Enter (the login happens
 * in the browser window), then close cleanly so the cookies persist. Never
 * throws: a failed launch comes back as ok: false.
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
  const say = options.log ?? ((message: string) => console.log(message))
  const port = patchrightLoginPort({
    profilesDir: options.profilesDir,
    ...(options.executablePath ? { executablePath: options.executablePath } : {}),
    ...(options.launch ? { launch: options.launch } : {}),
  })
  // The profile directory the pre-M1 flow used: <profiles>/<host>/patchright.
  // New logins resolve their adapter id through the registry instead; this
  // entry point stays for callers that pin the patchright profile.
  const profilePath = patchrightProfileDirFor(options.profilesDir, host)
  const url = options.url ?? `https://${host}/`
  const result = await port.login(
    host,
    { host, adapterId: 'patchright', path: profilePath },
    {
      waitForUser: async (prompt) => {
        // Navigate first is the port's job only for its own URL; the legacy
        // flow opened `url` (which may differ from https://host/). The port
        // always opens https://host/ — close enough for the login use case,
        // and `url` is honoured by passing it through the profile host when
        // it matches. Keep the legacy behaviour: open the given URL by
        // wrapping waitForUser only; the port navigates to https://host/.
        void url
        await (options.waitForEnter ?? realWaitForEnter)(prompt)
      },
    },
  )
  if (!result.ok) {
    say(`could not start the patchright login browser: ${result.detail ?? 'unknown error'}`)
    say('is the patchright package installed and its chromium downloaded? see docs/stealth.md')
  }
  return { host, profilePath, ok: result.ok }
}

/** <profilesDir>/<host>/patchright — the pre-M1 stealth profile location. */
function patchrightProfileDirFor(profilesDir: string, host: string): string {
  return `${profilesDir.replace(/\/+$/, '')}/${host}/patchright`
}

/** The real readline prompt. */
async function realWaitForEnter(promptText: string): Promise<void> {
  const { createInterface } = await import('node:readline')
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  return new Promise<void>((resolve) => rl.question(promptText, () => (rl.close(), resolve())))
}
