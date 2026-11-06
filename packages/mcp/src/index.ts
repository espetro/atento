/**
 * linkinbox MCP server. Thin wrapper: every tool calls the same core ops and
 * pipeline functions as the CLI (packages/core). Nothing here formats rows or
 * builds queries.
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
 *
 * CLI commands with no tool (documented exceptions): login, serve, eval and
 * prune. prune is deliberately CLI-only: it tombstone-deletes and keeps its
 * confirmation prompt behind the terminal. login keeps its browser step
 * behind the terminal, but the read-only listing of pending logins is
 * available as login_pending.
 */
export { createMcpServer } from './server.js'
export { registerTools, applyFilter } from './tools.js'
export {
  TOOL_NAME_MAP,
  type McpContext,
  type McpDeps,
} from './deps.js'
