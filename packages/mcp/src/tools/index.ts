/**
 * The transport-agnostic tool array: every atento MCP tool as a plain
 * { name, description, inputSchema, handler } definition. Transports
 * (stdio, streamable HTTP) wrap this array; nothing here knows MCP.
 */
import type { ToolDef } from './types.js'
import { linkTools } from './links.js'
import { ingestTools } from './ingest.js'
import { pipelineTools } from './pipeline.js'
import { collectionTools } from './collections.js'
import { browseTools } from './browse.js'

export const TOOLS: ToolDef[] = [
  ...linkTools,
  ...ingestTools,
  ...pipelineTools,
  ...collectionTools,
  ...browseTools,
]

export type { ToolDef, ToolEnv, ToolResult, ToolHandler } from './types.js'
export { callTool, json, opsFor } from './types.js'
export { applyFilter } from './filter.js'
