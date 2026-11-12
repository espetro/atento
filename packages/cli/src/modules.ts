/**
 * Registry for the heavy optional packages (@atento/mcp, @atento/server).
 *
 * The CLI used to `await import('@atento/mcp')` at the use site. scriptc only
 * follows static imports into the compiled module graph, so those sites were
 * SC2013 refusals (or forced the whole package into a Node island). bin.ts now
 * imports them statically and registers them here; commands ask the registry.
 * Tests and slim builds simply do not register a module.
 */
export interface OptionalModules {
  mcp?: typeof import('@atento/mcp')
  server?: typeof import('@atento/server')
  /** Loads the eval runner module by file URL (a dynamic import, Node builds only). */
  evalLoader?: (url: string) => Promise<unknown>
}

const registered: OptionalModules = {}

export function registerModules(modules: OptionalModules): void {
  if (modules.mcp !== undefined) registered.mcp = modules.mcp
  if (modules.server !== undefined) registered.server = modules.server
  if (modules.evalLoader !== undefined) registered.evalLoader = modules.evalLoader
}

export function evalLoader(): ((url: string) => Promise<unknown>) | undefined {
  return registered.evalLoader
}

export function optionalModule<K extends keyof OptionalModules>(name: K): OptionalModules[K] {
  return registered[name]
}
