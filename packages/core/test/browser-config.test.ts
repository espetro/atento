import { describe, expect, it } from 'vitest'
import { parseBrowserConfig } from '../src/config.js'
import {
  DEFAULT_BROWSER_CONFIG,
  executablePathFor,
  isStealthHost,
  resolveBrowserAdapter,
  browserEscalation,
} from '../src/browser-config.js'

describe('browser config', () => {
  it('defaults apply when the table is missing', () => {
    const browser = parseBrowserConfig('')
    // The migration shim synthesizes the legacy adapter pair even for an
    // empty config so the registry always has a reader and an escalate
    // target, exactly like the pre-M1 engine defaults.
    expect(browser.engine).toBe(DEFAULT_BROWSER_CONFIG.engine)
    expect(browser.stealthHosts).toEqual(DEFAULT_BROWSER_CONFIG.stealthHosts)
    expect(browser.executablePath).toBeUndefined()
    expect(browser.reader).toBe('headless')
    expect(browser.login).toBe('headless')
    expect(browser.escalate).toEqual(['stealth'])
    expect(Object.keys(browser.adapters).sort()).toEqual(['headless', 'stealth'])
    expect(browser.adapters['headless']?.kind).toBe('agent-browser')
    expect(browser.adapters['stealth']?.kind).toBe('patchright')
  })

  it('defaults to the agent-browser engine with no stealth hosts', () => {
    const browser = parseBrowserConfig('')
    expect(browser.engine).toBe('agent-browser')
    expect(browser.stealthHosts).toEqual([])
    expect(browser.executablePath).toBeUndefined()
  })

  it('reads the engine, the stealth hosts and the executable path', () => {
    const browser = parseBrowserConfig(`
[browser]
engine = "patchright"
stealth_hosts = ["app.devin.ai", "*.usebrioso.com"]
executable_path = "/Applications/BrowserOS.app/Contents/MacOS/browseros"
`)
    expect(browser.engine).toBe('patchright')
    expect(browser.stealthHosts).toEqual(['app.devin.ai', '*.usebrioso.com'])
    expect(browser.executablePath).toBe('/Applications/BrowserOS.app/Contents/MacOS/browseros')
  })

  it('lowercases the stealth hosts like the skip-list', () => {
    const browser = parseBrowserConfig(`
[browser]
stealth_hosts = ["App.Devin.AI"]
`)
    expect(browser.stealthHosts).toEqual(['app.devin.ai'])
  })

  it('ignores garbage values and keeps the defaults', () => {
    const browser = parseBrowserConfig(`
[browser]
engine = "nope"
stealth_hosts = "nope"
executable_path = 42
`)
    expect(browser.engine).toBe('agent-browser')
    expect(browser.stealthHosts).toEqual([])
    expect(browser.executablePath).toBeUndefined()
  })
})

describe('stealth host selection', () => {
  it('routes the listed hosts to the stealth engine', () => {
    const browser = parseBrowserConfig(`
[browser]
stealth_hosts = ["app.devin.ai", "chat.z.ai", "beta.usebrioso.com", "www.figma.com", "docs.google.com"]
`)
    for (const host of [
      'app.devin.ai',
      'chat.z.ai',
      'beta.usebrioso.com',
      'www.figma.com',
      'docs.google.com',
    ]) {
      expect(isStealthHost(browser, host)).toBe(true)
    }
    expect(isStealthHost(browser, 'example.com')).toBe(false)
  })

  it('matches the skip-list patterns: exact host or *.suffix', () => {
    const browser = parseBrowserConfig(`
[browser]
stealth_hosts = ["*.usebrioso.com", "figma.com"]
`)
    expect(isStealthHost(browser, 'beta.usebrioso.com')).toBe(true)
    expect(isStealthHost(browser, 'usebrioso.com')).toBe(true)
    expect(isStealthHost(browser, 'www.figma.com')).toBe(false)
    expect(isStealthHost(browser, 'figma.com')).toBe(true)
  })

  it('routes every host to the stealth engine when the engine is patchright', () => {
    const browser = parseBrowserConfig(`
[browser]
engine = "patchright"
`)
    expect(isStealthHost(browser, 'example.com')).toBe(true)
    expect(isStealthHost(browser, 'x.com')).toBe(true)
  })
})

describe('executable path resolution', () => {
  it('prefers the AGENT_BROWSER_EXECUTABLE_PATH env var', () => {
    const browser = parseBrowserConfig(`
[browser]
executable_path = "/config/browser"
`)
    expect(
      executablePathFor(browser, { AGENT_BROWSER_EXECUTABLE_PATH: '/env/browser' }),
    ).toBe('/env/browser')
  })

  it('falls back to the config value', () => {
    const browser = parseBrowserConfig(`
[browser]
executable_path = "/config/browser"
`)
    expect(executablePathFor(browser, {})).toBe('/config/browser')
  })

  it('is undefined when neither is set', () => {
    expect(executablePathFor(parseBrowserConfig(''), {})).toBeUndefined()
  })
})

describe('browser adapter registry (M1)', () => {
  it('parses the new-style adapters, hosts and defaults', () => {
    const browser = parseBrowserConfig(`
[browser]
reader = "headless"
login = "user-session"
escalate = ["stealth", "user-session"]

[browser.adapters.headless]
kind = "agent-browser"
executable = "/bin/chromium"

[browser.adapters.stealth]
kind = "patchright"

[browser.adapters.user-session]
kind = "cdp-attach"
endpoint = "http://127.0.0.1:9222"

[browser.hosts]
"x.com" = "user-session"
"*.example.com" = "stealth"
`)
    expect(browser.reader).toBe('headless')
    expect(browser.login).toBe('user-session')
    expect(browser.escalate).toEqual(['stealth', 'user-session'])
    expect(browser.adapters['headless']?.kind).toBe('agent-browser')
    expect(browser.adapters['headless']?.options['executablePath']).toBe('/bin/chromium')
    expect(browser.adapters['user-session']?.options['endpoint']).toBe('http://127.0.0.1:9222')
    expect(browser.hosts['x.com']).toBe('user-session')
    expect(browser.hosts['*.example.com']).toBe('stealth')
  })

  it('resolves host mappings before the role defaults', () => {
    const browser = parseBrowserConfig(`
[browser]
reader = "headless"
login = "headless"

[browser.adapters.headless]
kind = "agent-browser"
[browser.adapters.user-session]
kind = "cdp-attach"
endpoint = "http://127.0.0.1:9222"

[browser.hosts]
"x.com" = "user-session"
`)
    expect(resolveBrowserAdapter(browser, 'reader', 'x.com')).toBe('user-session')
    expect(resolveBrowserAdapter(browser, 'login', 'x.com')).toBe('user-session')
    expect(resolveBrowserAdapter(browser, 'reader', 'example.com')).toBe('headless')
    expect(resolveBrowserAdapter(browser, 'login', 'example.com')).toBe('headless')
  })

  it('matches *.suffix host patterns', () => {
    const browser = parseBrowserConfig(`
[browser.adapters.a]
kind = "agent-browser"
[browser.adapters.b]
kind = "patchright"
[browser.hosts]
"*.corp.example" = "b"
`)
    expect(resolveBrowserAdapter(browser, 'reader', 'app.corp.example')).toBe('b')
    expect(resolveBrowserAdapter(browser, 'reader', 'corp.example')).toBe('b')
    expect(resolveBrowserAdapter(browser, 'reader', 'other.com')).toBe('a')
  })

  it('walks the escalate list minus the adapter that already ran', () => {
    const browser = parseBrowserConfig(`
[browser]
escalate = ["stealth", "user-session"]
[browser.adapters.headless]
kind = "agent-browser"
[browser.adapters.stealth]
kind = "patchright"
[browser.adapters.user-session]
kind = "cdp-attach"
`)
    expect(browserEscalation(browser, 'example.com')).toEqual(['stealth', 'user-session'])
    expect(browserEscalation(browser, 'example.com', 'stealth')).toEqual(['user-session'])
  })

  it('migrates legacy stealth_hosts into the hosts map', () => {
    const browser = parseBrowserConfig(`
[browser]
stealth_hosts = ["app.devin.ai"]
`)
    expect(browser.hosts['app.devin.ai']).toBe('stealth')
    expect(resolveBrowserAdapter(browser, 'reader', 'app.devin.ai')).toBe('stealth')
    expect(resolveBrowserAdapter(browser, 'reader', 'example.com')).toBe('headless')
    expect(browser.escalate).toEqual(['stealth'])
  })

  it('engine = patchright makes stealth the reader and login default', () => {
    const browser = parseBrowserConfig(`
[browser]
engine = "patchright"
`)
    expect(browser.reader).toBe('stealth')
    expect(browser.login).toBe('stealth')
    expect(browser.escalate).toEqual([])
  })
})
