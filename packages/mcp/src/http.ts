/**
 * Streamable-HTTP face of the MCP server (SDK v2 `createMcpHandler`).
 * `createMcpHttpHandler` returns the web-standard `{ fetch }` handler the
 * Hono server mounts at /mcp; it serves both the modern (2026-07-28)
 * envelope era and — by default — the stateless 2025-era fallback, so old
 * MCP clients keep working.
 *
 * The handler performs no auth of its own; the Hono app applies the
 * loopback/bearer middleware before delegating. Host/Origin DNS-rebinding
 * validation lives in the Hono mount (@modelcontextprotocol/hono helpers
 * are available if a standalone deployment wants them).
 */
import {
  createMcpHandler,
  type McpHttpHandler,
} from '@modelcontextprotocol/server'
import type { McpDeps } from './deps.js'
import { createMcpServer } from './server.js'

export function createMcpHttpHandler(deps: McpDeps): McpHttpHandler {
  return createMcpHandler(() => createMcpServer(deps))
}
