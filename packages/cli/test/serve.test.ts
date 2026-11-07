/**
 * Serve-path integration tests: `runServe` is the real composition root the
 * `linkinbox serve` command uses. These drive the started server over a real
 * socket — /mcp must answer streamable-HTTP tools/list, and a custom
 * `[server] token_env` must be enforced when the bind is non-loopback.
 */
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client'
import { createContext, type CliContext } from '../src/context.js'
import { runServe } from '../src/commands/metrics.js'
import { loadConfig } from '../src/config.js'
import { tempDb, unlimitedLimits, type TempDb } from './helpers.js'
import type { EnrichFn, ExtractFn } from '@linkinbox/core'

const mockExtract: ExtractFn = async (url) => ({
  markdown: `# ${url}\n\nbody text`,
  extractor: 'defuddle',
})

const mockEnrich: EnrichFn = async () => ({
  ok: true,
  enrichment: {
    category: 'guide',
    priority: 'normal',
    why_it_matters: 'worth reading',
    read_minutes: 2,
    action: 'read_now',
    expires_at: null,
    expiry_reason: null,
    confidence: 0.9,
  },
  tokensIn: 10,
  tokensOut: 5,
  modelId: 'mock-model',
})

interface Started {
  port: number
  close(): Promise<void>
}

/** Build a real CLI context (live Linkinbox app) on a temp database. */
async function serveCtx(
  db: TempDb,
  tokenEnv = 'LINKINBOX_SERVER_TOKEN',
): Promise<CliContext> {
  const base = loadConfig({ LINKINBOX_DB: db.path })
  const config = {
    ...base,
    limits: unlimitedLimits(),
    server: { tokenEnv },
  }
  return createContext({
    store: db.store,
    config,
    env: {},
    quiet: true,
    logPath: join(db.dir, 'log.jsonl'),
    extractFn: mockExtract,
    enrichFn: mockEnrich,
  })
}

function startServer(
  ctx: CliContext,
  options?: { hostname?: string; env?: NodeJS.ProcessEnv },
): Promise<Started> {
  return new Promise((resolve, reject) => {
    void runServe(ctx, 0, resolve, options).then((ok) => {
      if (!ok) reject(new Error('runServe returned false'))
    })
  })
}

describe('runServe: real serve path', () => {
  it('mounts /mcp and answers streamable-HTTP tools/list', async () => {
    const db = await tempDb()
    const ctx = await serveCtx(db)
    let started: Started | undefined
    try {
      started = await startServer(ctx)
      const transport = new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${started.port}/mcp`),
      )
      const client = new Client({ name: 'serve-test', version: '0.0.1' })
      await client.connect(transport)
      try {
        const { tools } = await client.listTools()
        const names = tools.map((t) => t.name)
        expect(names).toContain('links_list')
        expect(names).toContain('links_get')
        expect(names.length).toBeGreaterThanOrEqual(20)
      } finally {
        await client.close()
      }
    } finally {
      await started?.close()
      await ctx.close()
      await db.cleanup()
    }
  })

  it('enforces a custom [server] token_env on a non-loopback bind', async () => {
    const db = await tempDb()
    const ctx = await serveCtx(db, 'LINKINBOX_TEST_TOKEN')
    let started: Started | undefined
    try {
      started = await startServer(ctx, {
        hostname: '0.0.0.0',
        env: { LINKINBOX_TEST_TOKEN: 'tok-serve-1' },
      })
      const base = `http://127.0.0.1:${started.port}`

      // No token -> 401 on the protected families.
      expect((await fetch(`${base}/api/links`)).status).toBe(401)
      expect((await fetch(`${base}/openapi.json`)).status).toBe(401)
      const mcpProbe = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: { name: 'probe', version: '0' },
          },
        }),
      })
      expect(mcpProbe.status).toBe(401)

      // Wrong token -> still 401.
      const wrong = await fetch(`${base}/api/links`, {
        headers: { authorization: 'Bearer wrong' },
      })
      expect(wrong.status).toBe(401)

      // The configured token -> through, including a real MCP session.
      const ok = await fetch(`${base}/api/links`, {
        headers: { authorization: 'Bearer tok-serve-1' },
      })
      expect(ok.status).toBe(200)

      const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        requestInit: { headers: { authorization: 'Bearer tok-serve-1' } },
      })
      const client = new Client({ name: 'serve-auth-test', version: '0.0.1' })
      await client.connect(transport)
      try {
        const { tools } = await client.listTools()
        expect(tools.map((t) => t.name)).toContain('links_list')
      } finally {
        await client.close()
      }
    } finally {
      await started?.close()
      await ctx.close()
      await db.cleanup()
    }
  })
})
