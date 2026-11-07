import { describe, expect, it } from 'vitest'
import { parseBrowserConfig } from '../src/config.js'
import {
  DEFAULT_BROWSER_CONFIG,
  executablePathFor,
  isStealthHost,
  resolveBrowserAdapter,
  browserEscalation,
  normalizeBrowserConfig,
  type BrowserConfig,
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

describe('mixed legacy keys + explicit adapters', () => {
  it('engine = patchright keeps a patchright reader next to a cdp adapter', () => {
    const browser = parseBrowserConfig(`
[browser]
engine = "patchright"

[browser.adapters.cdp]
kind = "cdp-attach"
endpoint = "http://127.0.0.1:9222"
`)
    // The legacy engine demand synthesizes the stealth adapter; it — not
    // the alphabetically-first cdp adapter — stays the reader/login.
    expect(browser.adapters['stealth']?.kind).toBe('patchright')
    expect(browser.reader).toBe('stealth')
    expect(browser.login).toBe('stealth')
    expect(browser.adapters['cdp']?.kind).toBe('cdp-attach')
  })

  it('engine = patchright prefers an explicit patchright adapter over cdp', () => {
    const browser = parseBrowserConfig(`
[browser]
engine = "patchright"

[browser.adapters.cdp]
kind = "cdp-attach"
[browser.adapters.ghost]
kind = "patchright"
`)
    expect(browser.reader).toBe('ghost')
    expect(browser.login).toBe('ghost')
  })

  it('stealth_hosts map to the patchright-kind adapter, not only a literal stealth id', () => {
    const browser = parseBrowserConfig(`
[browser]
stealth_hosts = ["app.devin.ai"]

[browser.adapters.cdp]
kind = "cdp-attach"
[browser.adapters.ghost]
kind = "patchright"
`)
    expect(browser.hosts['app.devin.ai']).toBe('ghost')
    expect(resolveBrowserAdapter(browser, 'reader', 'app.devin.ai')).toBe('ghost')
    // The default reader stays the agent-browser side: no agent-browser
    // adapter exists, so the first configured one wins.
    expect(resolveBrowserAdapter(browser, 'reader', 'example.com')).toBe('cdp')
  })

  it('an explicit reader/login/hosts entry always wins over legacy fill', () => {
    const browser = parseBrowserConfig(`
[browser]
engine = "patchright"
reader = "cdp"

[browser.adapters.cdp]
kind = "cdp-attach"
[browser.hosts]
"app.devin.ai" = "cdp"
`)
    expect(browser.reader).toBe('cdp')
    expect(browser.hosts['app.devin.ai']).toBe('cdp')
  })
})

describe('normalizeBrowserConfig', () => {
  it('keeps a fully-specified adapters table unchanged', () => {
    const config = parseBrowserConfig(`
[browser]
reader = "cdp"
login = "cdp"
escalate = []

[browser.adapters.cdp]
kind = "cdp-attach"
endpoint = "http://127.0.0.1:9222"

[browser.hosts]
"x.com" = "cdp"
`)
    const normalized = normalizeBrowserConfig(config)
    expect(normalized.adapters).toEqual(config.adapters)
    expect(normalized.reader).toBe('cdp')
    expect(normalized.login).toBe('cdp')
    expect(normalized.escalate).toEqual([])
    expect(normalized.hosts).toEqual(config.hosts)
  })

  it('fills missing registry fields on a hand-built legacy literal', () => {
    const normalized = normalizeBrowserConfig({
      engine: 'agent-browser',
      stealthHosts: ['x.com'],
    } as unknown as BrowserConfig)
    expect(normalized.adapters['headless']?.kind).toBe('agent-browser')
    expect(normalized.adapters['stealth']?.kind).toBe('patchright')
    expect(normalized.hosts['x.com']).toBe('stealth')
    expect(normalized.escalate).toEqual(['stealth'])
  })

  it('honours engine = patchright on a hand-built literal with a cdp adapter', () => {
    const normalized = normalizeBrowserConfig({
      engine: 'patchright',
      stealthHosts: [],
      adapters: { cdp: { kind: 'cdp-attach', options: {} } },
    } as unknown as BrowserConfig)
    expect(normalized.adapters['stealth']?.kind).toBe('patchright')
    expect(normalized.adapters['cdp']?.kind).toBe('cdp-attach')
    expect(normalized.reader).toBe('stealth')
    expect(normalized.login).toBe('stealth')
  })
})
