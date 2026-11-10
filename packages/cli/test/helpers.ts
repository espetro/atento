/**
 * Test helpers: a temporary SQLite-backed CLI context plus console capture.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openStore, type SqliteStore } from '@atento/db'
import { normalizeUrl, type Link } from '@atento/core'
import { UNLIMITED_LIMITS } from '@atento/core'

export interface TempDb {
  path: string
  dir: string
  store: SqliteStore
  cleanup(): Promise<void>
}

/** Open a fresh SQLite database in a temp dir. */
export async function tempDb(): Promise<TempDb> {
  const dir = mkdtempSync(join(tmpdir(), 'atento-cli-'))
  const path = join(dir, 'links.db')
  const store = await openStore({ path })
  return {
    path,
    dir,
    store,
    async cleanup() {
      await store.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

/**
 * Limits config with no throttling at all. The CLI tests run many links
 * against the same fake host in a second, so the production spacing and daily
 * cap would defer them. The resilience tests inject their own limits.
 */
export function unlimitedLimits(): typeof UNLIMITED_LIMITS {
  return UNLIMITED_LIMITS
}

/** Insert a link with the given fields into the store. */
export async function insertLink(
  store: SqliteStore,
  url: string,
  overrides: Partial<Link> = {},
): Promise<Link> {
  const { url: normalized, hash } = normalizeUrl(url)
  return store.upsertLink({
    urlHash: hash,
    url: normalized,
    source: 'test',
    status: 'inbox',
    needsBrowser: false,
    ...overrides,
  })
}

export interface Captured<T = void> {
  stdout: string
  stderr: string
  lines: string[]
  result: T
}

/** Capture console.log and console.error while fn runs. */
export async function capture<T>(fn: () => Promise<T>): Promise<Captured<T>> {
  const stdout: string[] = []
  const stderr: string[] = []
  const originalLog = console.log
  const originalError = console.error
  console.log = (...args: unknown[]) => {
    stdout.push(args.map(String).join(' '))
  }
  console.error = (...args: unknown[]) => {
    stderr.push(args.map(String).join(' '))
  }
  let result: T
  try {
    result = await fn()
  } finally {
    console.log = originalLog
    console.error = originalError
  }
  return { stdout: stdout.join('\n'), stderr: stderr.join('\n'), lines: stdout, result }
}
