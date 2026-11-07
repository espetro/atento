/**
 * Smoke test for the composition root: loadConfig + createLinkinbox over a
 * temp LINKINBOX_HOME, then one cheap round-trip through the use cases.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createLinkinbox, loadConfig } from '../src/index.js'

const dirs: string[] = []

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'linkinbox-app-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true })
})

describe('createLinkinbox', () => {
  it('exposes the use-case surface and runs a store round-trip', async () => {
    const home = tempHome()
    const config = loadConfig({ LINKINBOX_HOME: home } as NodeJS.ProcessEnv)
    const app = await createLinkinbox(config, { env: {} })
    try {
      // The surface the driving adapters consume.
      for (const key of [
        'ingestFiles',
        'ingestRaws',
        'extract',
        'extractUntilEmpty',
        'enrich',
        'resumeIngest',
        'list',
        'get',
        'triage',
        'restore',
        'overview',
        'pipelineLinks',
        'metrics',
        'sweepPlan',
        'applySweepPlan',
        'loginPending',
        'browseRead',
        'browseHosts',
        'captureIngest',
        'guardDeps',
        'stageGuard',
        'close',
      ] as const) {
        expect(typeof app[key], key).toBe('function')
      }
      expect(app.spoolDir).toBe(join(home, '.linkinbox', 'spool'))

      const outcome = await app.ingestRaws([
        { url: 'https://example.com/a', title: 'A' },
      ])
      expect(outcome.okCount).toBe(1)
      const rows = await app.list({})
      expect(rows).toHaveLength(1)
      expect(rows[0]?.url).toBe('https://example.com/a')
    } finally {
      await app.close()
    }
  })

  it('honours an injected store and does not close it', async () => {
    const home = tempHome()
    const config = loadConfig({ LINKINBOX_HOME: home } as NodeJS.ProcessEnv)
    const first = await createLinkinbox(config, { env: {} })
    const second = await createLinkinbox(config, { store: first.store, env: {} })
    await second.close()
    // The injected store stays open: the first app still reads through it.
    await first.ingestRaws([{ url: 'https://example.com/b' }])
    expect(await first.list({})).toHaveLength(1)
    await first.close()
  })
})
