/**
 * Test set E, parity enumeration: every CLI command has a matching MCP tool
 * that hits the same core function, or an explicit documented exception.
 *
 * The exceptions are deliberate:
 *   login  - the browser step needs a terminal; the read-only listing is
 *            exposed as the login_pending MCP tool
 *   serve  - starts the web server, not an agent operation
 *   eval   - golden-set runner, developer tooling
 *   prune  - hard delete with an interactive confirmation; stays CLI-only
 */
import { describe, expect, it } from 'vitest'
import { createProgram } from '@linkinbox/cli'
import { TOOL_NAME_MAP } from '../src/index.js'

/** CLI commands with no MCP tool, and why. */
export const CLI_ONLY_EXCEPTIONS: Record<string, string> = {
  login: 'the browser step needs a terminal; the listing is available via the read-only login_pending tool',
  serve: 'starts the web server; not an agent operation',
  eval: 'golden-set runner for developers; the eval report is not an agent operation',
  prune: 'tombstone delete (purges content) with an interactive confirmation prompt; deliberately CLI-only',
  breaker:
    'breaker reset mutates the shared circuit breaker state; the MCP side exposes the read-only limits_status tool instead',
}

/** Which MCP tool(s) cover which CLI command. */
export const CLI_TO_TOOL: Record<string, string[]> = {
  import: ['ingest_run'],
  extract: ['extract_run'],
  enrich: ['enrich_run'],
  // `run` is the three pipeline stages in one pass.
  run: ['ingest_run', 'extract_run', 'enrich_run'],
  list: ['links_list'],
  show: ['links_get'],
  triage: ['links_triage'],
  restore: ['links_restore'],
  sweep: ['links_sweep'],
  metrics: ['metrics_get'],
  status: ['limits_status'],
  login: ['login_pending'],
}

/** The spec surface, in the spec's own names. */
const SPEC_TOOLS = [
  'links.list',
  'links.get',
  'links.triage',
  'links.restore',
  'links.sweep',
  'ingest.run',
  'extract.run',
  'enrich.run',
  'metrics.get',
  'limits.status',
  'login.pending',
]

/** Flatten the commander command tree into names like `login list`. */
function commandNames(program: ReturnType<typeof createProgram>): string[] {
  const out: string[] = []
  const walk = (cmd: { name(): string; commands: unknown[] }, prefix: string[]): void => {
    for (const sub of cmd.commands as { name(): string; commands: unknown[] }[]) {
      const path = [...prefix, sub.name()]
      out.push(path.join(' '))
      walk(sub, path)
    }
  }
  walk(program as unknown as { name(): string; commands: unknown[] }, [])
  return out
}

describe('cli/mcp parity', () => {
  it('maps every spec tool to an SDK tool name', () => {
    expect(Object.values(TOOL_NAME_MAP).sort()).toEqual([...SPEC_TOOLS].sort())
    for (const name of Object.keys(TOOL_NAME_MAP)) {
      expect(name).toMatch(/^[a-z][a-z0-9_]*$/)
    }
  })

  it('gives every CLI command a matching MCP tool or a documented exception', async () => {
    const program = createProgram({ env: {}, quiet: true })
    const names = commandNames(program)
    expect(names.length).toBeGreaterThan(0)

    const uncovered: string[] = []
    for (const name of names) {
      const head = name.split(' ')[0]
      const tools = CLI_TO_TOOL[head]
      const exception = CLI_ONLY_EXCEPTIONS[head]
      if (tools === undefined && exception === undefined) uncovered.push(name)
      for (const tool of tools ?? []) {
        expect(Object.keys(TOOL_NAME_MAP)).toContain(tool)
      }
    }
    expect(uncovered).toEqual([])
  })

  it('lists the exceptions explicitly', () => {
    // Every exception must have a reason, and prune must stay CLI-only.
    for (const [name, reason] of Object.entries(CLI_ONLY_EXCEPTIONS)) {
      expect(reason.length).toBeGreaterThan(10)
      expect(name.length).toBeGreaterThan(0)
    }
    expect(CLI_ONLY_EXCEPTIONS['prune']).toBeDefined()
    expect(CLI_TO_TOOL['prune']).toBeUndefined()
    // Breaker reset stays CLI-only: the MCP surface is read-only.
    expect(CLI_ONLY_EXCEPTIONS['breaker']).toBeDefined()
    expect(CLI_TO_TOOL['breaker']).toBeUndefined()
    // login keeps the browser step CLI-only, but the listing is a tool.
    expect(CLI_ONLY_EXCEPTIONS['login']).toBeDefined()
    expect(CLI_TO_TOOL['login']).toEqual(['login_pending'])
  })

  it('covers the CLI commands the spec calls out', () => {
    for (const cmd of ['list', 'show', 'triage', 'sweep', 'import', 'extract', 'enrich', 'metrics']) {
      expect(CLI_TO_TOOL[cmd]).toBeDefined()
    }
  })
})
