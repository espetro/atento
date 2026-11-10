#!/usr/bin/env node
/** stdio entry point: `atento-mcp` (same server as `atento mcp`). */
import { runStdioServer } from './stdio.js'

await runStdioServer()
