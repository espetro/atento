import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { atentoVersion } from '../src/version.js'

const here = dirname(fileURLToPath(import.meta.url))
const modulePath = join(here, '..', 'dist', 'version.js')

/** Run the compiled module from a given directory and print its answer. */
function runFrom(dir: string): string {
  return execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { atentoVersion } from ${JSON.stringify(join(dir, 'version.js'))}; console.log(atentoVersion())`,
    ],
    { encoding: 'utf8' },
  ).trim()
}

describe('atentoVersion', () => {
  it('resolves the umbrella package version in the source tree', () => {
    expect(atentoVersion()).toMatch(/^\d+\.\d+\.\d+/)
  })

  it('resolves version.json beside the deployed packages', () => {
    // The deployed layout: lib/version.json next to lib/node_modules.
    const root = join(here, '.tmp-deployed')
    const lib = join(root, 'lib')
    const dist = join(lib, 'node_modules', '@atento', 'core', 'dist')
    mkdirSync(dist, { recursive: true })
    copyFileSync(modulePath, join(dist, 'version.js'))
    writeFileSync(join(lib, 'version.json'), JSON.stringify({ version: '9.9.9-test' }))
    try {
      expect(runFrom(dist)).toBe('9.9.9-test')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('falls back to 0.0.0 when nothing is findable', () => {
    // Outside the repository, so no umbrella package.json sits above.
    const base = mkdtempSync(join(tmpdir(), 'atento-version-'))
    const root = join(base, 'deep')
    mkdirSync(root, { recursive: true })
    copyFileSync(modulePath, join(root, 'version.js'))
    try {
      expect(runFrom(root)).toBe('0.0.0')
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })
})
