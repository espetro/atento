/**
 * Profile layout migration: <profiles>/<host> (+ /patchright) moves into
 * <profiles>/<host>/<adapterId>/, idempotently and without overwriting.
 */
import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseBrowserConfig } from '../src/config.js'
import {
  normalizeBrowserConfig,
  type BrowserConfig,
} from '../src/browser-config.js'
import {
  browserProfileDir,
  legacyAdapterIds,
  migrateBrowserProfiles,
  remapLegacyProfilePath,
} from '../src/profile-layout.js'

function tmpProfiles(): string {
  return mkdtempSync(join(tmpdir(), 'lb-profiles-'))
}

const migrated = parseBrowserConfig('')

describe('browserProfileDir', () => {
  it('is <profilesDir>/<host>/<adapterId>', () => {
    expect(browserProfileDir('/p', 'x.com', 'stealth')).toBe(join('/p', 'x.com', 'stealth'))
  })
})

describe('migrateBrowserProfiles', () => {
  it('moves the legacy patchright dir and the top-level entries into adapter dirs', () => {
    const dir = tmpProfiles()
    mkdirSync(join(dir, 'x.com', 'patchright'), { recursive: true })
    writeFileSync(join(dir, 'x.com', 'patchright', 'Cookies'), 'c')
    mkdirSync(join(dir, 'x.com', 'Default', 'Local Storage'), { recursive: true })
    writeFileSync(join(dir, 'x.com', 'Default', 'Local Storage', 'leveldb'), 'l')

    const result = migrateBrowserProfiles(dir, migrated, () => undefined)
    expect(result.moved.length).toBeGreaterThan(0)
    expect(existsSync(join(dir, 'x.com', 'stealth', 'Cookies'))).toBe(true)
    expect(existsSync(join(dir, 'x.com', 'headless', 'Default'))).toBe(true)
    expect(existsSync(join(dir, 'x.com', 'patchright'))).toBe(false)
    expect(existsSync(join(dir, 'x.com', 'Default'))).toBe(false)
  })

  it('is idempotent: a migrated host is left alone', () => {
    const dir = tmpProfiles()
    mkdirSync(join(dir, 'x.com', 'headless'), { recursive: true })
    writeFileSync(join(dir, 'x.com', 'headless', 'Default'), 'd')
    const first = migrateBrowserProfiles(dir, migrated, () => undefined)
    const second = migrateBrowserProfiles(dir, migrated, () => undefined)
    expect(first.moved).toEqual([])
    expect(second.moved).toEqual([])
    expect(existsSync(join(dir, 'x.com', 'headless', 'Default'))).toBe(true)
  })

  it('never overwrites an existing adapter entry', () => {
    const dir = tmpProfiles()
    mkdirSync(join(dir, 'x.com', 'patchright'), { recursive: true })
    writeFileSync(join(dir, 'x.com', 'patchright', 'old'), 'o')
    mkdirSync(join(dir, 'x.com', 'stealth'), { recursive: true })
    writeFileSync(join(dir, 'x.com', 'stealth', 'new'), 'n')

    const logs: string[] = []
    migrateBrowserProfiles(dir, migrated, (m) => logs.push(m))
    // The legacy patchright dir stays because the target already exists.
    expect(existsSync(join(dir, 'x.com', 'patchright', 'old'))).toBe(true)
    expect(existsSync(join(dir, 'x.com', 'stealth', 'new'))).toBe(true)
  })

  it('honours custom adapter ids from an explicit adapters table', () => {
    const dir = tmpProfiles()
    mkdirSync(join(dir, 'x.com', 'patchright'), { recursive: true })
    writeFileSync(join(dir, 'x.com', 'patchright', 'Cookies'), 'c')
    const config = parseBrowserConfig(`
[browser.adapters.ghost]
kind = "patchright"
[browser.adapters.plain]
kind = "agent-browser"
`)
    migrateBrowserProfiles(dir, config, () => undefined)
    expect(existsSync(join(dir, 'x.com', 'ghost', 'Cookies'))).toBe(true)
    expect(legacyAdapterIds(config)).toEqual({ agentBrowser: 'plain', patchright: 'ghost' })
  })

  it('normalizes a hand-built legacy config the same way', () => {
    const config = normalizeBrowserConfig({
      engine: 'agent-browser',
      stealthHosts: ['x.com'],
    } as unknown as BrowserConfig)
    const dir = tmpProfiles()
    mkdirSync(join(dir, 'x.com', 'patchright'), { recursive: true })
    migrateBrowserProfiles(dir, config, () => undefined)
    expect(existsSync(join(dir, 'x.com', 'stealth'))).toBe(true)
  })
})

describe('remapLegacyProfilePath', () => {
  it('maps <host> to the agent-browser adapter dir and <host>/patchright to stealth', () => {
    const dir = tmpProfiles()
    expect(remapLegacyProfilePath(dir, migrated, join(dir, 'x.com'))).toBe(
      join(dir, 'x.com', 'headless'),
    )
    expect(remapLegacyProfilePath(dir, migrated, join(dir, 'x.com', 'patchright'))).toBe(
      join(dir, 'x.com', 'stealth'),
    )
  })

  it('maps the Phase-1 <host>/agent-browser layout onto the agent-browser adapter', () => {
    const dir = tmpProfiles()
    expect(
      remapLegacyProfilePath(dir, migrated, join(dir, 'x.com', 'agent-browser')),
    ).toBe(join(dir, 'x.com', 'headless'))
  })

  it('returns undefined for new-layout and foreign paths', () => {
    const dir = tmpProfiles()
    expect(remapLegacyProfilePath(dir, migrated, join(dir, 'x.com', 'headless'))).toBeUndefined()
    expect(remapLegacyProfilePath(dir, migrated, '/elsewhere/x.com')).toBeUndefined()
  })
})
