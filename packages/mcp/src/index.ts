/**
 * atento MCP server. Thin wrapper: every tool calls the same app-layer
 * use cases (AtentoOps) the CLI and the HTTP server drive — nothing here
 * formats rows or builds queries, and handlers never reach into
 * store/pipeline internals beyond what the ops object exposes.
 *
 * Tool names use underscores because MCP tool names reject dots. Mapping to
 * the spec surface:
 *
 *   links_list     = links.list
 *   links_get      = links.get
 *   links_triage   = links.triage   (the one aggregate tool: ids + action)
 *   links_restore  = links.restore  (parked states back to inbox, never from deleted)
 *   links_sweep    = links.sweep
 *   links_overview = links.overview (state counts plus the busiest hosts)
 *   links_pipeline = links.pipeline (every link with its state and reason)
 *   ingest_run     = ingest.run
 *   extract_run    = extract.run
 *   enrich_run     = enrich.run
 *   metrics_get    = metrics.get
 *   login_pending  = login.pending
 *   browse_read    = browse.read  (read-only page read through a saved profile)
 *   browse_hosts   = browse.hosts (which hosts are shareable, and why not)
 *
 * CLI commands with no tool (documented exceptions): login, serve, eval and
 * prune. prune is deliberately CLI-only: it tombstone-deletes and keeps its
 * confirmation prompt behind the terminal. login keeps its browser step
 * behind the terminal, but the read-only listing of pending logins is
 * available as login_pending.
 */
export { createMcpServer, withJsonSchema } from './server.js'
export { createMcpHttpHandler } from './http.js'
export { TOOLS, callTool, json, opsFor, applyFilter } from './tools/index.js'
export type {
  ToolDef,
  ToolEnv,
  ToolHandler,
  ToolResult,
} from './tools/index.js'
export {
  TOOL_NAME_MAP,
  createMcpDeps,
  type McpContext,
  type McpDeps,
} from './deps.js'
