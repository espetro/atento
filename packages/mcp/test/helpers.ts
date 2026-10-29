/**
 * Test helpers: an in-memory MCP client connected to a fresh server whose
 * deps point at a temp SQLite store, plus seed data and console capture.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { openStore, type SqliteStore } from '@linkinbox/db'
import {
  createCollectingLogger,
  normalizeUrl,
  type EnrichFn,
  type ExtractFn,
  type Link,
} from '@linkinbox/core'
import { DEFAULT_TTL_CONFIG, type TtlConfig } from '@linkinbox/core'
import { createMcpServer } from '../src/index.js'
import type { McpContext, McpDeps } from '../src/index.js'

export interface TestHarness {
  client: Client
  store: SqliteStore
  ttl: TtlConfig
  logger: ReturnType<typeof createCollectingLogger>
  cleanup(): Promise<void>
}

export async function createHarness(options: {
  extractFn?: ExtractFn
  enrichFn?: EnrichFn
  ttl?: Partial<TtlConfig>
} = {}): Promise<TestHarness> {
  const dir = mkdtempSync(join(tmpdir(), 'linkinbox-mcp-'))
  const store = await openStore({ path: join(dir, 'links.db') })
  const logger = createCollectingLogger()
  const ttl: TtlConfig = { ...DEFAULT_TTL_CONFIG, ...options.ttl }
  const context: McpContext = { store, ttl, logger }

  const deps: McpDeps = {
    ctx: async () => context,
    extractFn:
      options.extractFn !== undefined
        ? async () => options.extractFn!
        : async () => async () => ({ markdown: 'unused', needsBrowser: true }),
    enrichFn:
      options.enrichFn !== undefined
        ? async () => options.enrichFn!
        : async () => async () => ({ ok: false, error: 'enrichment not configured in test' }),
  }

  const server = createMcpServer(deps)
  const client = new Client({ name: 'test-client', version: '0.0.1' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

  return {
    client,
    store,
    ttl,
    logger,
    async cleanup() {
      await client.close()
      await server.close()
      await store.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
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

/** Unwrap a callTool result: parsed text JSON, plus the isError flag. */
export function callJson(result: {
  isError?: boolean
  content: { type: string; text: string }[]
}): { isError: boolean; data: any } {
  const text = result.content.map((c) => ('text' in c ? c.text : '')).join('')
  return { isError: result.isError === true, data: JSON.parse(text) }
}

export async function capture<T>(fn: () => Promise<T>): Promise<{ stdout: string; result: T }> {
  const chunks: string[] = []
  const original = console.log
  console.log = (...args: unknown[]) => {
    chunks.push(args.map(String).join(' '))
  }
  try {
    const result = await fn()
    return { stdout: chunks.join('\n'), result }
  } finally {
    console.log = original
  }
}
