import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LINK_EVENTS, LINK_STATES, TRANSITION_PAIRS } from '../src/index.js'
import { renderDiagram } from '../scripts/gen-fsm-docs.js'

const here = fileURLToPath(new URL('.', import.meta.url))
const docPath = join(here, '..', '..', '..', 'docs', 'fsm.md')

describe('docs/fsm.md', () => {
  it('contains the mermaid diagram generated from the transition table', async () => {
    const doc = await readFile(docPath, 'utf8')
    expect(doc).toContain(renderDiagram().trimEnd())
  })

  it('the diagram lists every legal transition exactly once', () => {
    const edges = renderDiagram()
      .split('\n')
      .filter((l) => l.includes('-->'))
      .map((l) => l.trim())
    expect(edges).toHaveLength(TRANSITION_PAIRS.length)
    expect(new Set(edges).size).toBe(edges.length)
  })

  it('every state and every event appears in the diagram', () => {
    const diagram = renderDiagram()
    for (const state of LINK_STATES) expect(diagram).toContain(state)
    for (const event of LINK_EVENTS) expect(diagram).toContain(event)
  })

  it('the mermaid source renders (when mmdr is available)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'atento-mmd-'))
    try {
      const mmd = join(dir, 'fsm.mmd')
      const svg = join(dir, 'fsm.svg')
      writeFileSync(mmd, renderDiagram())
      try {
        execFileSync('mmdr', ['-i', mmd, '-o', svg], { stdio: 'pipe' })
      } catch (err) {
        // mmdr is optional tooling: skip when it is not installed.
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
        throw err
      }
      const size = execFileSync('wc', ['-c', svg]).toString().trim().split(' ')[0]
      expect(Number(size)).toBeGreaterThan(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
