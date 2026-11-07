/**
 * external adapter: loads a PageReaderPort / SessionLoginPort implementation
 * from a module path, so engines like Camoufox or a Firefox build can be
 * added later as plugins without touching this package.
 *
 * The module may export:
 *   - `default` or a named `adapter` / `createAdapter`: a ports object
 *     ({ reader?, login?, caps? }) or a factory called with { id, options }
 *   - `reader` / `login`: the port objects directly
 *
 * Loading is lazy: the module is imported on first use (and for health), so
 * a missing plugin never breaks registry construction.
 */
import { pathToFileURL } from 'node:url'
import { isAbsolute } from 'node:path'
import type {
  BrowserCaps,
  BrowserHealth,
  PageReaderPort,
  SessionLoginPort,
} from '@linkinbox/core'

export interface ExternalAdapterOptions {
  /** The adapter instance id (config key). */
  id: string
  /** Module specifier: absolute path, file:// URL, or bare specifier. */
  module: string
  /** Kind-specific options handed to a factory export. */
  options?: Record<string, unknown>
}

export interface ExternalAdapter {
  /** Lazy PageReaderPort; the module loads on first open(). */
  reader: PageReaderPort
  /** Lazy SessionLoginPort; the module loads on first login()/verify(). */
  login: SessionLoginPort
  /** Caps once the module has loaded; undefined before or on failure. */
  caps(): Promise<BrowserCaps | undefined>
  health(): Promise<BrowserHealth>
}

interface MaybePorts {
  reader?: PageReaderPort
  login?: SessionLoginPort
  caps?: BrowserCaps
}

async function loadModule(options: ExternalAdapterOptions): Promise<MaybePorts> {
  const specifier = options.module.includes('://')
    ? options.module
    : isAbsolute(options.module)
      ? pathToFileURL(options.module).href
      : options.module
  const mod = (await import(specifier)) as Record<string, unknown>
  const candidate =
    mod['default'] ?? mod['adapter'] ?? mod['createAdapter'] ?? mod['module']

  let ports: unknown = candidate
  if (typeof candidate === 'function') {
    ports = await (
      candidate as (ctx: { id: string; options: Record<string, unknown> }) => unknown
    )({ id: options.id, options: options.options ?? {} })
  }
  if (ports && typeof ports === 'object') {
    const p = ports as MaybePorts
    if (p.reader || p.login) return p
  }
  // Fall back to named port exports.
  const reader = mod['reader'] as PageReaderPort | undefined
  const login = mod['login'] as SessionLoginPort | undefined
  if (reader || login) return { reader, login }
  throw new Error(
    `external adapter ${options.id}: module ${options.module} exports no reader/login port`,
  )
}

export function createExternalAdapter(options: ExternalAdapterOptions): ExternalAdapter {
  let cached: Promise<MaybePorts> | undefined
  const load = () => (cached ??= loadModule(options))

  const reader: PageReaderPort = {
    id: options.id,
    // Placeholder caps until the module loads; caps() reports the real ones.
    caps: { stealth: false, headless: true, persistentProfile: false },
    contentFormat: 'html',
    async open(opts) {
      const ports = await load()
      if (!ports.reader) {
        throw new Error(`external adapter ${options.id} exports no PageReaderPort`)
      }
      return ports.reader.open(opts)
    },
  }

  const login: SessionLoginPort = {
    id: options.id,
    async login(host, profile, ui, url) {
      const ports = await load()
      if (!ports.login) {
        throw new Error(`external adapter ${options.id} exports no SessionLoginPort`)
      }
      return ports.login.login(host, profile, ui, url)
    },
    async verify(host, profile) {
      const ports = await load()
      if (!ports.login) return false
      return ports.login.verify(host, profile)
    },
  }

  return {
    reader,
    login,
    async caps(): Promise<BrowserCaps | undefined> {
      try {
        const ports = await load()
        return ports.caps ?? ports.reader?.caps
      } catch {
        return undefined
      }
    },
    async health(): Promise<BrowserHealth> {
      try {
        await load()
        return {
          id: options.id,
          kind: 'external',
          ok: true,
          detail: `module ${options.module} loaded`,
        }
      } catch (error) {
        return {
          id: options.id,
          kind: 'external',
          ok: false,
          detail: String(error).split('\n')[0],
        }
      }
    },
  }
}
