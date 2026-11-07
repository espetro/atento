/**
 * stdio entry point: `linkinbox-mcp`. Wiring goes through the app layer:
 * `createLinkinbox` resolves the config, opens the SQLite store and builds
 * the extract/enrich/browse adapters — the same composition root the CLI
 * uses.
 *
 * The browse tools use the same read path as the CLI: the saved profile of
 * the host, the allowlist from `[share] hosts` and the same per-host budget
 * as the extraction stage. Nothing is written to the link store.
 *
 * Serving goes through SDK v2 `serveStdio`, which owns the era decision:
 * a 2025-era `initialize` handshake is served by a pinned legacy instance,
 * a modern opening by a modern one — both from the same factory, so the
 * tool surface cannot drift between eras.
 */
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import {
  createLinkinbox,
  loadConfig,
  pipelineLogger,
  type AppConfig,
} from '@linkinbox/app'
import { createMcpServer } from './server.js'
import { TOOL_NAME_MAP, type McpContext, type McpDeps } from './deps.js'

const app = await createLinkinbox(loadConfig(), { logger: pipelineLogger('mcp') })
const config = app.config as AppConfig
const logger = pipelineLogger('mcp')

const context: McpContext = {
  store: app.store,
  ttl: config.ttl,
  logger,
  limits: config.limits,
  login: config.login,
  share: config.share,
  spoolDir: app.spoolDir,
}

export const deps: McpDeps = {
  ctx: async () => context,
  extractFn: async () => app.extractFn(),
  enrichFn: () => app.enrichFn(),
  browseFn: async () => app.browseFn(),
  browseGuard: async () => app.browseGuard(),
  hasProfile: async (host) => (await app.store.getProfile(host)) !== null,
  close: async () => {
    await app.close()
  },
}

serveStdio(() => createMcpServer(deps))

process.on('SIGINT', async () => {
  await deps.close?.()
  process.exit(0)
})
process.on('SIGTERM', async () => {
  await deps.close?.()
  process.exit(0)
})

logger.info('linkinbox mcp server listening on stdio with tools {tools}', {
  tools: Object.keys(TOOL_NAME_MAP),
})
