/**
 * The product version, resolved at run time so no build ships a stale
 * hard-coded string. The release tarball carries the version the CLI and the
 * MCP server report; the source tree resolves it from the release umbrella.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

let cached: string | undefined

function readVersionFile(path: string): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { version?: unknown }
    return typeof parsed.version === 'string' ? parsed.version : undefined
  } catch {
    return undefined
  }
}

/**
 * Walk up from this module looking for the version. Two layouts exist:
 * the deployed tarball (lib/version.json beside the deployed packages) and
 * the source tree (packages/atento/package.json).
 */
function findVersion(): string {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let depth = 0; depth < 8; depth++) {
    const deployed = join(dir, 'version.json')
    if (existsSync(deployed)) {
      const version = readVersionFile(deployed)
      if (version !== undefined) return version
    }
    const umbrella = join(dir, 'packages', 'atento', 'package.json')
    if (existsSync(umbrella)) {
      const version = readVersionFile(umbrella)
      if (version !== undefined) return version
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return '0.0.0'
}

/** The release version, or '0.0.0' when it cannot be resolved. */
export function atentoVersion(): string {
  if (cached === undefined) cached = findVersion()
  return cached
}
