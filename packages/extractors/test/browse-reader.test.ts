/**
 * The read-only browse reader: the engine choice per host and the mapping
 * from an extractor outcome to a browse outcome. The subprocess runner is
 * a fake, so nothing opens a browser and nothing touches the network.
 */
import { describe, expect, it } from 'vitest'
import { createBrowseReader, toBrowseOutcome } from '../src/browse-reader.js'

describe('browse reader: the engine choice', () => {
  it('uses the default engine for an ordinary host', async () => {
    const calls: string[][] = []
    const exec = async (_file: string, args: string[]) => {
      calls.push(args)
      if (args.includes('open')) return { code: 0, stdout: '', stderr: '' }
      return { code: 0, stdout: '# the page\n\nhello', stderr: '' }
    }
    const reader = createBrowseReader({
      profilesDir: '/tmp/profiles',
      command: 'agent-browser',
      exec,
      profileExists: () => true,
      stealthHost: (host) => host === 'stealth.example',
    })
    const outcome = await reader('https://plain.example/a', 'plain.example')
    expect(outcome.ok).toBe(true)
    expect(outcome.engine).toBe('headless')
    expect(outcome.markdown).toContain('hello')
    // The only commands are the ones a read needs: open the page, read it
    // and close the session. No click, no type.
    const verbs = calls.map((args) => args.filter((a) => !a.startsWith('--') && !a.includes('example'))[0])
    expect(verbs).toEqual(['open', 'read', 'close'])
  })

  it('uses the stealth engine for a stealth host, with its own profile', async () => {
    const seenDirs: string[] = []
    const reader = createBrowseReader({
      profilesDir: '/tmp/profiles',
      command: 'agent-browser',
      exec: async () => ({ code: 0, stdout: '', stderr: '' }),
      // Only the agent-browser profile exists: the stealth adapter keeps its
      // own profile directory, so it never touches the other one.
      profileExists: (dir) => {
        seenDirs.push(dir)
        return !dir.endsWith('/stealth')
      },
      stealthHost: (host) => host === 'stealth.example',
    })
    const outcome = await reader('https://stealth.example/a', 'stealth.example')
    expect(outcome.ok).toBe(false)
    expect(outcome.reason).toBe('no_profile')
    expect(outcome.engine).toBe('stealth')
    // The stealth adapter looked in its own profile subdirectory.
    expect(seenDirs[0]).toMatch(/\/stealth$/)
  })
})

describe('browse reader: the outcome mapping', () => {
  it('maps a good result to a successful read', () => {
    const outcome = toBrowseOutcome({ markdown: '# hi' }, 'agent-browser')
    expect(outcome.ok).toBe(true)
    expect(outcome.markdown).toBe('# hi')
  })

  it('maps a missing profile', () => {
    const outcome = toBrowseOutcome(
      { markdown: '', needsBrowser: true, meta: { missingProfile: true } },
      'agent-browser',
    )
    expect(outcome.ok).toBe(false)
    expect(outcome.reason).toBe('no_profile')
  })

  it('maps a login wall', () => {
    const outcome = toBrowseOutcome(
      { markdown: '', needsBrowser: true, meta: { blocked: true, reason: 'login_wall' } },
      'agent-browser',
    )
    expect(outcome.reason).toBe('login_wall')
  })

  it('maps a failed read with the stderr of the browser', () => {
    const outcome = toBrowseOutcome(
      { markdown: '', needsBrowser: true, meta: { exitCode: 1, stderr: 'boom' } },
      'agent-browser',
    )
    expect(outcome.reason).toBe('error')
    expect(outcome.detail).toContain('boom')
  })
})
