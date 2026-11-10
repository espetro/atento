/**
 * Server assembly: an McpServer (SDK v2, @modelcontextprotocol/server) with
 * the transport-agnostic TOOLS array registered once. `createMcpServer`
 * returns the raw server so tests can connect an InMemoryTransport pair;
 * serveStdio (bin.ts) and createMcpHandler (http.ts) wrap the same factory.
 *
 * Tool input schemas stay zod/mini for byte-for-byte parity with the
 * pre-M3 wire shape. SDK v2's registerTool needs a Standard Schema that also
 * advertises JSON Schema (`~standard.jsonSchema`), which zod/mini does not
 * attach; withJsonSchema() builds that adapter on top of
 * zod/mini's toJSONSchema — validation still runs through the same zod/mini
 * schema, so behaviour is unchanged.
 */
import {
  McpServer,
  type CallToolResult,
  type StandardSchemaWithJSON,
} from '@modelcontextprotocol/server'
import { toJSONSchema } from 'zod/mini'
import type { z } from 'zod/mini'
import type { McpDeps } from './deps.js'
import { TOOLS, callTool, type ToolDef } from './tools/index.js'

/**
 * Adapt a zod/mini schema to the StandardSchemaWithJSON interface SDK v2
 * requires: `validate` delegates to the schema's own `~standard.validate`,
 * and `jsonSchema` converts with zod/mini's toJSONSchema.
 */
export function withJsonSchema<S extends z.ZodMiniType>(
  schema: S,
): StandardSchemaWithJSON<z.core.input<S>, z.core.output<S>> {
  const standard = schema['~standard'] as {
    validate: (
      value: unknown,
      options?: unknown,
    ) => { value?: unknown; issues?: ReadonlyArray<{ message: string }> }
    vendor?: string
    version?: number
  }
  const convert = (options: { target?: string; libraryOptions?: Record<string, unknown> }) =>
    toJSONSchema(schema as never, options as never) as Record<string, unknown>
  return {
    '~standard': {
      ...standard,
      jsonSchema: {
        input: convert,
        output: convert,
      },
    },
  } as unknown as StandardSchemaWithJSON<z.core.input<S>, z.core.output<S>>
}

function registerToolDefs(server: McpServer, deps: McpDeps): void {
  for (const tool of TOOLS) {
    registerTool(server, deps, tool)
  }
}

function registerTool(server: McpServer, deps: McpDeps, tool: ToolDef): void {
  server.registerTool(
    tool.name,
    {
      description: tool.description,
      inputSchema: withJsonSchema(tool.inputSchema),
    },
    // ToolResult is the transport-agnostic shape ({content:[{type:'text'}]});
    // it is wire-compatible with CallToolResult, which is schema-inferred
    // and too narrow to name directly.
    async (args) => (await callTool(deps, tool, args)) as CallToolResult,
  )
}

export function createMcpServer(deps: McpDeps): McpServer {
  const server = new McpServer(
    { name: 'atento', version: '0.1.0' },
    { capabilities: { tools: {} } },
  )
  registerToolDefs(server, deps)
  return server
}
