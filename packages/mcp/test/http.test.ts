/**
 * Streamable-HTTP transport tests (SDK v2 `createMcpHandler` mounted at
 * /mcp): a real Client over StreamableHTTPClientTransport whose fetch is
 * routed straight into the handler — no socket needed.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  Client,
  InMemoryTransport,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { openStore } from '@linkinbox/db'
import { createMcpHttpHandler, createMcpServer } from '../src/index.js'
import { createTestDeps, insertLink, callJson } from './helpers.js'

const MCP_URL = 'http://localhost/mcp'

async function createHttpHarness() {
  const dir = mkdtempSync(join(tmpdir(), 'linkinbox-mcp-http-'))
  const store = await openStore({ path: join(dir, 'links.db') })
  const { deps } = createTestDeps(store)
  const handler = createMcpHttpHandler(deps)
  // Route the client's HTTP through the web-standard handler in-process.
  const fetchLike: typeof fetch = (input, init) =>
    handler.fetch(new Request(input as RequestInfo | URL, init))
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
    fetch: fetchLike,
  })
  const client = new Client({ name: 'http-test-client', version: '0.0.1' })
  await client.connect(transport)
  return {
    client,
    store,
    async cleanup() {
      await client.close()
      await handler.close()
      await store.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

describe('mcp streamable http', () => {
  it('lists the same tools over HTTP as over stdio/in-memory', async () => {
    const h = await createHttpHarness()
    try {
      const { tools } = await h.client.listTools()
      const names = tools.map((t) => t.name).sort()
      expect(names).toContain('links_list')
      expect(names).toContain('links_get')
      expect(names).toContain('ingest_run')
      expect(names.length).toBeGreaterThanOrEqual(20)
      // JSON Schema is advertised for the input shape.
      const linksGet = tools.find((t) => t.name === 'links_get')
      expect(linksGet?.inputSchema).toMatchObject({ type: 'object' })
    } finally {
      await h.cleanup()
    }
  })

  it('runs a links_get round trip over HTTP', async () => {
    const h = await createHttpHarness()
    try {
      const link = await insertLink(h.store, 'https://example.com/post', {
        title: 'HTTP round trip',
      })
      const result = await h.client.callTool({
        name: 'links_get',
        arguments: { id: link.id },
      })
      const { isError, data } = callJson(result)
      expect(isError).toBe(false)
      expect(data.link.id).toBe(link.id)
      expect(data.link.title).toBe('HTTP round trip')
    } finally {
      await h.cleanup()
    }
  })

  it('validates tool arguments over HTTP', async () => {
    const h = await createHttpHarness()
    try {
      const result = await h.client.callTool({
        name: 'links_get',
        arguments: { id: 'not-a-number' },
      })
      expect(result.isError).toBe(true)
    } finally {
      await h.cleanup()
    }
  })
})

describe('mcp stdio (serveStdio)', () => {
  it('lists tools and runs links_get through the real stdio entry path', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'linkinbox-mcp-stdio-'))
    const store = await openStore({ path: join(dir, 'links.db') })
    const { deps } = createTestDeps(store)
    // serveStdio owns the transport; hand it one end of an in-memory pair
    // instead of process stdio so the test stays in-process.
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const handle = serveStdio(() => createMcpServer(deps), {
      transport: serverTransport,
    })
    const client = new Client({ name: 'stdio-test-client', version: '0.0.1' })
    try {
      await client.connect(clientTransport)
      const { tools } = await client.listTools()
      expect(tools.map((t) => t.name)).toContain('links_list')

      const link = await insertLink(store, 'https://example.com/stdio', {
        title: 'stdio round trip',
      })
      const result = await client.callTool({
        name: 'links_get',
        arguments: { id: link.id },
      })
      const { isError, data } = callJson(result)
      expect(isError).toBe(false)
      expect(data.link.title).toBe('stdio round trip')
    } finally {
      await client.close()
      await handle.close()
      await store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
