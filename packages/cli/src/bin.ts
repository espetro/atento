#!/usr/bin/env node
/**
 * atento CLI entry point. The command bodies live in program.ts; this
 * file only wires the process to it.
 */
import * as mcp from '@atento/mcp'
import * as server from '@atento/server'
import { registerModules } from './modules.js'
import { createProgram } from './program.js'

registerModules({ mcp, server, evalLoader: (url) => import(url) })

const program = createProgram()

try {
  // parseAsync expects the full argv (node + script + args).
  await program.parseAsync(process.argv)
} catch (err) {
  const message = err instanceof Error ? err.message : String(err)
  console.error(`error: ${message}`)
  process.exitCode = 1
}
