/**
 * Browser profile layout (M1): profiles live at
 * `<profilesDir>/<host>/<adapterId>/` so two adapters can hold separate
 * sessions for the same host.
 *
 * Legacy layout (pre-M1):
 *   <profilesDir>/<host>/            agent-browser profile (files at top)
 *   <profilesDir>/<host>/patchright/ patchright profile
 *
 * `migrateBrowserProfiles` performs the one-time move: the patchright
 * subdir becomes `<host>/<patchright-adapter>/`, and the remaining
 * top-level entries move into `<host>/<agent-browser-adapter>/`. It is
 * idempotent — a host dir that already contains adapter subdirs and no
 * legacy entries is left alone — and it never deletes anything: entries
 * it cannot place stay put.
 */
import { existsSync, mkdirSync, readdirSync, renameSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import type { BrowserConfig } from './browser-config.js'
import { LEGACY_HEADLESS_ADAPTER, LEGACY_STEALTH_ADAPTER } from './browser-config.js'

/** The profile directory of one host on one adapter. */
export function browserProfileDir(
  profilesDir: string,
  host: string,
  adapterId: string,
): string {
  return join(profilesDir, host, adapterId)
}

/** The first adapter id whose kind matches, when one exists. */
function adapterIdForKind(config: BrowserConfig, kind: string): string | undefined {
  for (const [id, adapter] of Object.entries(config.adapters ?? {})) {
    if (adapter.kind === kind) return id
  }
  return undefined
}

export interface ProfileMigrationResult {
  /** "<host>/<entry>" paths that were moved into place. */
  moved: string[]
  /** Host directories inspected. */
  hosts: number
}

function safeReaddir(dir: string): string[] | undefined {
  try {
    return readdirSync(dir)
  } catch {
    return undefined
  }
}

/**
 * Move legacy profile directories into the per-adapter layout. Safe to run
 * on every startup: already-migrated hosts are skipped, and a host whose
 * agent-browser profile already exists at the target keeps its legacy
 * leftovers untouched (nothing is overwritten).
 */
export function migrateBrowserProfiles(
  profilesDir: string,
  config: BrowserConfig,
  log?: (message: string) => void,
): ProfileMigrationResult {
  const say = log ?? (() => undefined)
  const result: ProfileMigrationResult = { moved: [], hosts: 0 }
  if (!existsSync(profilesDir)) return result

  const agentBrowserId = adapterIdForKind(config, 'agent-browser') ?? LEGACY_HEADLESS_ADAPTER
  const patchrightId = adapterIdForKind(config, 'patchright') ?? LEGACY_STEALTH_ADAPTER
  const adapterIds = new Set(Object.keys(config.adapters ?? {}))
  adapterIds.add(agentBrowserId)
  adapterIds.add(patchrightId)

  for (const host of safeReaddir(profilesDir) ?? []) {
    const hostDir = join(profilesDir, host)
    try {
      if (!statSync(hostDir).isDirectory()) continue
    } catch {
      continue
    }
    result.hosts += 1

    const children = safeReaddir(hostDir) ?? []
    const hasLegacy = children.some((c) => !adapterIds.has(c))
    if (!hasLegacy) continue // already migrated (or never had a legacy layout)

    // 1. The legacy patchright profile: <host>/patchright -> <host>/<patchrightId>
    if (children.includes('patchright')) {
      const from = join(hostDir, 'patchright')
      const to = join(hostDir, patchrightId)
      if (patchrightId !== 'patchright' && !existsSync(to)) {
        try {
          renameSync(from, to)
          result.moved.push(`${host}/${patchrightId}`)
          say(`migrated browser profile ${host}/patchright -> ${host}/${patchrightId}`)
        } catch (error) {
          say(`warning: could not migrate profile ${host}/patchright: ${String(error)}`)
        }
      }
    }

    // 2. The legacy agent-browser profile: every remaining top-level entry
    //    moves into <host>/<agentBrowserId>/.
    const remaining = (safeReaddir(hostDir) ?? []).filter(
      (c) => c !== 'patchright' && !adapterIds.has(c),
    )
    if (remaining.length === 0) continue
    const target = join(hostDir, agentBrowserId)
    try {
      mkdirSync(target, { recursive: true })
    } catch (error) {
      say(`warning: could not create ${target}: ${String(error)}`)
      continue
    }
    for (const child of remaining) {
      const from = join(hostDir, child)
      const to = join(target, child)
      if (existsSync(to)) {
        // Never overwrite an existing migrated profile entry.
        say(`warning: kept legacy ${host}/${child}: ${to} already exists`)
        continue
      }
      try {
        renameSync(from, to)
        result.moved.push(`${host}/${agentBrowserId}`)
        say(`migrated browser profile ${host}/${child} -> ${host}/${agentBrowserId}/${child}`)
      } catch (error) {
        say(`warning: could not migrate profile ${host}/${child}: ${String(error)}`)
      }
    }
  }
  return result
}

/**
 * The adapter ids the legacy profile dirs map to: the first agent-browser
 * and patchright kind adapters in config, else the migrated defaults.
 */
export function legacyAdapterIds(config: BrowserConfig): {
  agentBrowser: string
  patchright: string
} {
  return {
    agentBrowser: adapterIdForKind(config, 'agent-browser') ?? LEGACY_HEADLESS_ADAPTER,
    patchright: adapterIdForKind(config, 'patchright') ?? LEGACY_STEALTH_ADAPTER,
  }
}

/**
 * The new-layout path a legacy stored profile path maps to, or undefined
 * when the path is already in the new layout (or outside profilesDir).
 * Used to rewrite the profiles table after migrateBrowserProfiles moves
 * the directories.
 */
export function remapLegacyProfilePath(
  profilesDir: string,
  config: BrowserConfig,
  oldPath: string,
): string | undefined {
  const rel = relative(profilesDir, oldPath)
  if (rel === '' || rel.startsWith('..') || rel.startsWith(sep)) return undefined
  const segments = rel.split(sep)
  const host = segments[0]
  if (!host) return undefined
  const ids = legacyAdapterIds(config)
  if (segments.length === 1) {
    // <profilesDir>/<host> was the agent-browser profile.
    return browserProfileDir(profilesDir, host, ids.agentBrowser)
  }
  if (segments.length === 2 && segments[1] === 'patchright') {
    // <profilesDir>/<host>/patchright was the stealth profile.
    return browserProfileDir(profilesDir, host, ids.patchright)
  }
  return undefined
}
