import { describe, expect, it } from 'vitest'
import { parseBrowserConfig } from '../src/config.js'
import {
  DEFAULT_BROWSER_CONFIG,
  executablePathFor,
  isStealthHost,
} from '../src/browser-config.js'

describe('browser config', () => {
  it('defaults apply when the table is missing', () => {
    expect(parseBrowserConfig('')).toEqual(DEFAULT_BROWSER_CONFIG)
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
