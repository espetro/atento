/**
 * Server assembly: an McpServer with the linkinbox tools registered.
 * `createMcpServer` returns the raw SDK server so tests can connect an
 * InMemoryTransport client pair; bin.ts attaches a stdio transport.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { registerTools } from './tools.js'
import type { McpDeps } from './deps.js'

export function createMcpServer(deps: McpDeps): McpServer {
  const server = new McpServer(
    { name: 'linkinbox', version: '0.1.0' },
    { capabilities: { tools: {} } },
  )
  registerTools(server, deps)
  return server
}
