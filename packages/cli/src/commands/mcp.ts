/**
 * mcp command: serve the MCP tools over stdio (`atento mcp`). The MCP server
 * is an optional dependency of the CLI; release tarballs always include it.
 */
import type { Command } from 'commander'

export function registerMcpCommand(program: Command): void {
  program
    .command('mcp')
    .description('serve the MCP tools over stdio (for agent clients such as Claude Code or Cursor)')
    .action(async () => {
      let mcp: typeof import('@atento/mcp')
      try {
        mcp = await import('@atento/mcp')
      } catch {
        throw new Error('the MCP server is not installed; install the release tarball or add @atento/mcp')
      }
      await mcp.runStdioServer()
    })
}
