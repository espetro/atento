/**
 * Engine selection per host: which browser extractor runs for a host.
 *
 * The stealth engine (Patchright) is chosen for a host when the config
 * engine is patchright (everyone) or the host matches `[browser]
 * stealth_hosts` (per-host override). Every other host keeps the default
 * agent-browser engine.
 *
 * Pure decision logic: no config parsing here (that is browser-config.ts)
 * and no browser process. Nothing about a provider or a model.
 */
import { isStealthHost, type BrowserConfig } from './browser-config.js'

/** The browser engines the pipeline can route a host to. */
export type EngineName = BrowserConfig['engine']

/**
 * The engine a host extracts with.
 *
 * `isStealthHost` already answers "patchright or not", so this is the
 * single seam the router, the login flow and the docs share: one decision,
 * one place.
 */
export function engineForHost(config: BrowserConfig, host: string): EngineName {
  return isStealthHost(config, host) ? 'patchright' : 'agent-browser'
}
