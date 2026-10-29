#!/usr/bin/env node
/**
 * linkinbox CLI entry point. The command bodies live in program.ts; this
 * file only wires the process to it.
 */
import { createProgram } from './program.js'

const program = createProgram()

try {
  // parseAsync expects the full argv (node + script + args).
  await program.parseAsync(process.argv)
} catch (err) {
  const message = err instanceof Error ? err.message : String(err)
  console.error(`error: ${message}`)
  process.exitCode = 1
}
