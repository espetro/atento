/**
 * stdio entry point: `linkinbox-mcp`. Wiring mirrors the CLI program: config
 * from the environment, a SQLite store, a LogTape-backed pipeline logger and
 * the same extract/enrich adapters the CLI builds.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { loadConfig, createExtractFn, createEnrichFn } from '@linkinbox/cli'
import { pipelineLogger } from '@linkinbox/core'
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
}

export const deps: McpDeps = {
  ctx: async () => context,
  extractFn: async (ctx) =>
    createExtractFn({
      profilesDir: config.profilesDir,
      limits: config.limits,
      pacing: config.pacing,
      store: (ctx ?? context).store,
    }),
  enrichFn: () => createEnrichFn(),
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
