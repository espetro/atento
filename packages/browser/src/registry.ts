/**
 * The browser adapter registry: resolves (role, host) to a concrete adapter
 * instance built from `[browser.adapters.*]` config.
 *
 * Resolution order per role:
 *   1. `[browser.hosts]` pattern match (exact host or `*.suffix`)
 *   2. the role default (`reader` / `login`)
 *
 * Escalation walks `[browser] escalate` in order, skipping the adapter
 * that already ran for the host.
 */
import {
  browserAdapterConfig,
  browserEscalation,
  browserHostAdapter,
  resolveBrowserAdapter,
  type BrowserAdapterConfig,
  type BrowserConfig,
  type BrowserRole,
} from '@linkinbox/core'
import type {
  BrowserCaps,
  BrowserHealth,
  PageReaderPort,
  SessionLoginPort,
} from '@linkinbox/core'
import { createAgentBrowserAdapter, type AgentBrowserAdapterOptions } from './agent-browser.js'
import { createPatchrightAdapter, type PatchrightAdapterOptions } from './patchright.js'
import { createCdpAttachAdapter, type CdpAttachAdapterOptions } from './cdp-attach.js'
import { createExternalAdapter, type ExternalAdapterOptions } from './external.js'
import type { ExecLike } from '@linkinbox/extractors'
import type { PatchrightLaunch } from '@linkinbox/extractors'
import type { CdpConnect } from './cdp-attach.js'

/** One built adapter instance. */
export interface BrowserAdapterInstance {
  id: string
  kind: BrowserAdapterConfig['kind']
  config: BrowserAdapterConfig
  reader?: PageReaderPort
  login?: SessionLoginPort
  /** Caps when known without loading the module (external: via caps()). */
  caps?(): BrowserCaps | undefined | Promise<BrowserCaps | undefined>
  health?(): Promise<BrowserHealth>
}

/** What `linkinbox browsers` prints per adapter. */
export interface BrowserAdapterListing {
  id: string
  kind: BrowserAdapterConfig['kind']
  roles: string[]
  caps?: BrowserCaps
  defaultFor: { reader: boolean; login: boolean }
  inEscalate: boolean
}

export interface BrowserRegistry {
  readonly config: BrowserConfig
  readonly profilesDir: string
  /** The adapter instance id a host resolves to for a role. */
  resolve(role: BrowserRole, host: string): string
  /** The `[browser.hosts]` adapter id for a host, when mapped. */
  hostAdapter(host: string): string | undefined
  /** Ordered escalation adapter ids for a host. */
  escalate(host: string, usedAdapterId?: string): string[]
  /** The built instance for an adapter id. */
  adapter(id: string): BrowserAdapterInstance | undefined
  /** The PageReaderPort a host resolves to, when the adapter has one. */
  readerFor(host: string): PageReaderPort | undefined
  /** The SessionLoginPort a host resolves to, when the adapter has one. */
  loginFor(host: string): SessionLoginPort | undefined
  /** Every configured adapter instance, in config order. */
  list(): BrowserAdapterListing[]
  /** Health check for one adapter id. */
  health(id: string): Promise<BrowserHealth>
}

/** Injectable seams, mostly for tests. */
export interface BrowserRegistryDeps {
  profilesDir?: string
  /** agent-browser subprocess runner (tests). */
  exec?: ExecLike
  /** agent-browser login spawner (tests). */
  spawn?: AgentBrowserAdapterOptions['spawn']
  /** patchright launcher (tests). */
  launch?: PatchrightLaunch
  /** cdp-attach connector (tests). */
  connect?: CdpConnect
  /** cdp-attach health fetch (tests). */
  fetchImpl?: typeof fetch
  env?: Record<string, string | undefined>
  /** Per-adapter instance overrides (tests). */
  adapters?: Record<string, Partial<Pick<BrowserAdapterInstance, 'reader' | 'login'>>>
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

export function createBrowserRegistry(
  config: BrowserConfig,
  deps: BrowserRegistryDeps = {},
): BrowserRegistry {
  const profilesDir = deps.profilesDir ?? defaultProfilesDir()
  const instances = new Map<string, BrowserAdapterInstance>()

  const build = (id: string, adapterConfig: BrowserAdapterConfig): BrowserAdapterInstance => {
    const override = deps.adapters?.[id]
    const base: BrowserAdapterInstance = {
      id,
      kind: adapterConfig.kind,
      config: adapterConfig,
    }
    if (override?.reader) base.reader = override.reader
    if (override?.login) base.login = override.login

    switch (adapterConfig.kind) {
      case 'agent-browser': {
        const built = createAgentBrowserAdapter({
          id,
          profilesDir,
          ...(deps.exec ? { exec: deps.exec } : {}),
          ...(deps.spawn ? { spawn: deps.spawn } : {}),
          ...(deps.env ? { env: deps.env } : {}),
          ...(str(adapterConfig.options['command'])
            ? { command: str(adapterConfig.options['command']) }
            : {}),
          ...(str(adapterConfig.options['executablePath'])
            ? { executablePath: str(adapterConfig.options['executablePath']) }
            : {}),
        })
        base.reader ??= built.reader
        base.login ??= built.login
        base.health = () => built.health()
        break
      }
      case 'patchright': {
        const built = createPatchrightAdapter({
          id,
          profilesDir,
          ...(deps.launch ? { launch: deps.launch } : {}),
          ...(str(adapterConfig.options['executablePath'])
            ? { executablePath: str(adapterConfig.options['executablePath']) }
            : {}),
          ...(typeof adapterConfig.options['timeoutMs'] === 'number'
            ? { timeoutMs: adapterConfig.options['timeoutMs'] }
            : {}),
        })
        base.reader ??= built.reader
        base.login ??= built.login
        base.health = () => built.health()
        break
      }
      case 'cdp-attach': {
        const endpoint = str(adapterConfig.options['endpoint']) ?? 'http://127.0.0.1:9222'
        const built = createCdpAttachAdapter({
          id,
          endpoint,
          ...(deps.connect ? { connect: deps.connect } : {}),
          ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
        })
        base.reader ??= built.reader
        base.login ??= built.login
        base.health = () => built.health()
        break
      }
      case 'external': {
        const module = str(adapterConfig.options['module'])
        if (!module) {
          base.health = async () => ({
            id,
            kind: 'external',
            ok: false,
            detail: 'external adapter has no module path',
          })
          break
        }
        const built = createExternalAdapter({
          id,
          module,
          options: adapterConfig.options,
        })
        base.reader = built.reader
        base.login = built.login
        base.caps = () => built.caps()
        base.health = () => built.health()
        break
      }
    }
    return base
  }

  for (const [id, adapterConfig] of Object.entries(config.adapters ?? {})) {
    instances.set(id, build(id, adapterConfig))
  }

  const capsOf = async (instance: BrowserAdapterInstance): Promise<BrowserCaps | undefined> =>
    instance.caps ? await instance.caps() : instance.reader?.caps

  return {
    config,
    profilesDir,

    resolve(role, host) {
      return resolveBrowserAdapter(config, role, host)
    },

    hostAdapter(host) {
      return browserHostAdapter(config, host)
    },

    escalate(host, usedAdapterId) {
      return browserEscalation(config, host, usedAdapterId)
    },

    adapter(id) {
      return instances.get(id)
    },

    readerFor(host) {
      const id = resolveBrowserAdapter(config, 'reader', host)
      return instances.get(id)?.reader
    },

    loginFor(host) {
      const id = resolveBrowserAdapter(config, 'login', host)
      return instances.get(id)?.login
    },

    list() {
      return [...instances.entries()].map(([id, instance]) => {
        const roles: string[] = []
        if (instance.reader) roles.push('reader')
        if (instance.login) roles.push('login')
        const caps = instance.reader?.caps
        return {
          id,
          kind: instance.kind,
          roles,
          ...(caps ? { caps } : {}),
          defaultFor: {
            reader: config.reader === id,
            login: config.login === id,
          },
          inEscalate: (config.escalate ?? []).includes(id),
        }
      })
    },

    async health(id) {
      const instance = instances.get(id)
      if (!instance) {
        return { id, kind: 'external' as const, ok: false, detail: `unknown adapter "${id}"` }
      }
      if (instance.health) return instance.health()
      const caps = await capsOf(instance)
      return {
        id,
        kind: instance.kind,
        ok: instance.reader !== undefined || instance.login !== undefined || caps !== undefined,
        detail:
          instance.reader !== undefined || instance.login !== undefined
            ? 'adapter loaded'
            : 'adapter exposes no ports',
      }
    },
  }
}

function defaultProfilesDir(): string {
  const home = process.env['HOME'] ?? ''
  return `${home}/.linkinbox/profiles`
}

// Re-exported so callers can type adapter options without deep imports.
export type { AgentBrowserAdapterOptions, PatchrightAdapterOptions, CdpAttachAdapterOptions, ExternalAdapterOptions }
export { browserAdapterConfig }
