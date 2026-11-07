/**
 * stdio entry point: `linkinbox-mcp`. Wiring mirrors the CLI program: config
 * from the environment, a SQLite store, a LogTape-backed pipeline logger and
 * the same extract/enrich adapters the CLI builds.
 *
 * The browse tools use the same read path as the CLI: the saved profile of
 * the host, the allowlist from `[share] hosts` and the same per-host budget
 * as the extraction stage. Nothing is written to the link store.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { loadConfig, createExtractFn, createEnrichFn, createBrowseFn } from '@linkinbox/cli'
import { join } from 'node:path'
import { guardDepsFromStore, pipelineLogger } from '@linkinbox/core'
import { openStore } from '@linkinbox/db'
import { createMcpServer } from './server.js'
import { TOOL_NAME_MAP, type McpContext, type McpDeps } from './deps.js'

const config = loadConfig()
const store = await openStore({ path: config.dbPath })
const logger = pipelineLogger('mcp')

const context: McpContext = {
  store,
  ttl: config.ttl,
  logger,
  limits: config.limits,
  login: config.login,
  share: config.share,
  spoolDir: join(config.dir, 'spool'),
}

export const deps: McpDeps = {
  ctx: async () => context,
  extractFn: async (ctx) =>
    createExtractFn({
      profilesDir: config.profilesDir,
      limits: config.limits,
      login: config.login,
      pacing: config.pacing,
      browserConfig: config.browser,
      store: (ctx ?? context).store,
    }),
  enrichFn: () => createEnrichFn(),
  browseFn: async () =>
    createBrowseFn({
      share: config.share,
      browser: config.browser,
      profilesDir: config.profilesDir,
    }),
  browseGuard: async (ctx) =>
    guardDepsFromStore((ctx ?? context).store, {
      config: { limits: config.limits, pacing: config.pacing },
    }),
  hasProfile: async (host) => (await store.getProfile(host)) !== null,
  close: async () => {
    await store.close()
  },
}

const server = createMcpServer(deps)

process.on('SIGINT', async () => {
  await deps.close?.()
  process.exit(0)
})
process.on('SIGTERM', async () => {
  await deps.close?.()
  process.exit(0)
})

await server.connect(new StdioServerTransport())
logger.info('linkinbox mcp server listening on stdio with tools {tools}', {
  tools: Object.keys(TOOL_NAME_MAP),
})
