import { describe, expect, it } from 'vitest'
import { parseBrowserConfig } from '../src/config.js'
import { engineForHost } from '../src/engine.js'
import { isListedStealthHost } from '../src/browser-config.js'

describe('engineForHost', () => {
  it('defaults to the agent-browser engine', () => {
    const browser = parseBrowserConfig('')
    expect(engineForHost(browser, 'example.com')).toBe('agent-browser')
  })

  it('routes a stealth host to the patchright engine', () => {
    const browser = parseBrowserConfig(`
[browser]
stealth_hosts = ["app.devin.ai"]
`)
    expect(engineForHost(browser, 'app.devin.ai')).toBe('patchright')
    expect(engineForHost(browser, 'example.com')).toBe('agent-browser')
  })

  it('routes every host to patchright when the engine is patchright', () => {
    const browser = parseBrowserConfig(`
[browser]
engine = "patchright"
`)
    expect(engineForHost(browser, 'example.com')).toBe('patchright')
    expect(engineForHost(browser, 'app.devin.ai')).toBe('patchright')
  })

  it('matches a wildcard stealth host', () => {
    const browser = parseBrowserConfig(`
[browser]
stealth_hosts = ["*.usebrioso.com"]
`)
    expect(engineForHost(browser, 'app.usebrioso.com')).toBe('patchright')
    expect(engineForHost(browser, 'usebrioso.com')).toBe('patchright')
    expect(engineForHost(browser, 'notusebrioso.com')).toBe('agent-browser')
  })

  it('is case insensitive on the host', () => {
    const browser = parseBrowserConfig(`
[browser]
stealth_hosts = ["app.devin.ai"]
`)
    expect(engineForHost(browser, 'App.Devin.AI')).toBe('patchright')
  })
})

describe('isListedStealthHost', () => {
  it('ignores the global engine', () => {
    const browser = parseBrowserConfig(`
[browser]
engine = "patchright"
`)
    expect(isListedStealthHost(browser, 'example.com')).toBe(false)
  })

  it('is true for a listed host', () => {
    const browser = parseBrowserConfig(`
[browser]
stealth_hosts = ["app.devin.ai", "*.usebrioso.com"]
`)
    expect(isListedStealthHost(browser, 'app.devin.ai')).toBe(true)
    expect(isListedStealthHost(browser, 'beta.usebrioso.com')).toBe(true)
    expect(isListedStealthHost(browser, 'example.com')).toBe(false)
  })
})
