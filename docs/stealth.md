# The stealth engine (Patchright)

Some hosts refuse a plain automated browser: the fingerprint of an ordinary
Chromium under automation (`navigator.webdriver`, CDP artifacts, the
`--enable-automation` flag) is enough for a challenge page. The stealth
engine is [Patchright](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright), a
patched Playwright fork that removes exactly those artifacts, and linkinbox
uses it for the hosts that need it. It is a risk reduction, not a bypass: it
does not beat captchas, account-level bans or rate limits, and it changes
nothing about the pacing rules (`docs/resilience.md`), which still apply in
full.

## Install

Patchright is an optional peer dependency of `@linkinbox/extractors`. With
pnpm (the package manager this repo uses):

```sh
pnpm add patchright
npx patchright install chromium
```

`pnpm add patchright` installs the Node driver (verified against patchright
1.64.2 from npm, whose README documents exactly these two commands).
`npx patchright install chromium` downloads the patched Chromium driver into
`~/Library/Caches/ms-playwright/` on macOS (the Playwright cache directory;
`chromium-<build>` is the headed browser and `chromium_headless_shell-<build>`
is the headless shell). Everything works without the package: the import is
dynamic and optional, so the workspace builds and every unit test passes
with patchright absent, and an extraction that needs the engine reports
`needsBrowser` with the launch error instead of crashing.

A custom Chromium (for example a BrowserOS or another anti-detect build) is
configured through `[browser] executable_path` or the
`AGENT_BROWSER_EXECUTABLE_PATH` env var, which wins over the config. The
same setting reaches both engines: patchright receives it as its
`executablePath` launch option, agent-browser as `--executable-path`.

## Engine selection

The `[browser]` config table decides which host uses which engine:

```toml
[browser]
# Route every browser-routed host through patchright.
engine = "patchright"
# Or: route only these hosts through patchright while the default engine
# stays agent-browser. A listed host always goes through the stealth
# browser, because the owner knows it blocks plain requests. Same pattern
# syntax as the limiter skip-list: exact host or *.suffix.
stealth_hosts = ["app.devin.ai", "*.usebrioso.com"]
# Chromium binary for either engine.
executable_path = "/Applications/BrowserOS.app/Contents/MacOS/browseros"
```

The single decision function is `engineForHost` in
`packages/core/src/engine.ts`: `patchright` when the config engine is
patchright or the host matches `stealth_hosts`, else `agent-browser`. The
router, the extract-fn adapter and the login command all call it (or the
`isStealthHost` predicate under it), so a host extracts with the same engine
it logged in with.

Routing rules, in the order the pipeline applies them:

- A host the `hostPolicy` marks browser-routed (a saved profile, a login
  gate, a manual `walled_gardens` override) routes to `patchright` when
  `engineForHost` says patchright, else to the agent-browser `browser`
  route.
- A host listed in `stealth_hosts` is browser-routed even without a profile
  or a flag: the owner listed it for a reason.
- An ordinary open host keeps the static defuddle route; `engine =
  "patchright"` never sends open hosts through a browser.
- A missing profile on a patchright route is terminal, exactly like on the
  agent-browser route: the link parks in `needs_browser` and the CLI
  suggests `linkinbox login <host>`.

## Login flow

`linkinbox login <host>` uses the engine the host extracts with:

- Patchright hosts: a headed persistent context is launched at
  `<profilesDir>/<host>/patchright` (default `~/.linkinbox/profiles/<host>/
  patchright`), the page navigates to `https://<host>/`, and the CLI waits
  for Enter after you log in in the browser window. Closing the context
  cleanly is what flushes the cookies and local storage into the profile
  directory, so let the process close the browser instead of quitting it by
  hand. The viewport is not forced (`viewport: null`), so the window keeps a
  real size.
- Every other host: the agent-browser headed flow as before, profile at
  `<profilesDir>/<host>`.

After either flow the profile row is saved in the `profiles` table and the
host's parked `needs_browser` links are requeued for the next extract run.
linkinbox never reads, logs or stores passwords, cookies or tokens: only
the profile directory path is recorded.

## Profile locations

| Engine | Directory |
|---|---|
| agent-browser | `~/.linkinbox/profiles/<host>` |
| patchright | `~/.linkinbox/profiles/<host>/patchright` |

`linkinbox login list` shows the saved rows, `linkinbox login clear <host>`
deletes the row and its directory, and `linkinbox login requeue <host>`
requeues a host's parked links again. The patchright subdirectory keeps the
two engines' sessions from colliding when a host is switched between
engines.

## Honest limits

- Patchright only patches Chromium. Firefox and WebKit are not supported,
  and the project's own README documents the Playwright tests it still
  fails; treat any "undetectable" claim as temporary.
- Headless Chromium still announces itself: the user agent keeps the
  `HeadlessChrome` token even with `channel: "chrome"`, and the CreepJS
  fingerprint page flags it (see the smoke test below). `navigator.webdriver`
  is `false`, but the UA is a separate signal that patchright does not
  patch. The headed login window has a clean UA.
- The stealth engine does not rotate proxies, does not solve captchas and
  does not warm up accounts. A flagged account stays flagged, a captcha
  still parks the link through the login-wall path, and the per-host
  spacing, daily caps and working-hours windows from `docs/resilience.md`
  apply unchanged.
- Console APIs are disabled inside Patchright pages (part of its leak
  patches), so page `console.*` output is not observable during extraction.
- The dynamic import means the first patchright extraction on a machine
  without the package fails with `needsBrowser` and the error text; install
  the package before relying on stealth routing.

## Smoke test record

Manual, run 2026-11-05 against patchright 1.64.2 with its downloaded
Chromium 156.0.8078.4, from this worktree (`node` with a scratch script, one
run per mode, results recorded verbatim):

| Mode | Page | `navigator.webdriver` | User agent |
|---|---|---|---|
| headless (bundled chromium) | example.com | `false` | `...HeadlessChrome/156.0.8078.4...` |
| headless (bundled chromium) | creepjs fingerprint page | `false` | `...HeadlessChrome/156.0.8078.4...` |
| headless (`channel: "chrome"`) | example.com | `false` | `...HeadlessChrome/156.0.0.0...` |
| headed (`channel: "chrome"`, the login flow) | example.com | `false` | `...Chrome/156.0.0.0...` (no Headless) |

Baseline for comparison: agent-browser (plain CDP automation) on the same
machine reports `navigator.webdriver` = `"true"`.

The headline artifact patchright exists to remove is gone in every mode
(`webdriver: false`). But headless still leaks: the UA string says
`HeadlessChrome` even with the real Chrome channel, and the CreepJS page
reports a "Headless" verdict and a "like headless" score in that mode.
Headed mode shows a clean UA. Practical reading: extraction (headless) is
fine for content that is merely JS-gated, while hosts that classify the UA
need the headed login once and then read better through a real profile; a
future engine setting could add `channel: "chrome"` for headed flows. This
was one manual run against two public pages, not a test suite: nothing is
automated and the result says nothing about any specific hardened target.
