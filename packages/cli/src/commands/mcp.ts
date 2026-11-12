/**
 * mcp command: serve the MCP tools over stdio (`atento mcp`). The MCP server
 * is an optional dependency of the CLI; release tarballs always include it.
 */
import type { Command } from 'commander'
import { optionalModule } from '../modules.js'

export function registerMcpCommand(program: Command): void {
  program
    .command('mcp')
    .description('serve the MCP tools over stdio (for agent clients such as Claude Code or Cursor)')
    .action(async () => {
      const mcp = optionalModule('mcp')
      if (mcp === undefined) {
        throw new Error('the MCP server is not installed; install the release tarball or add @atento/mcp')
      }
      await mcp.runStdioServer()
    })
}
