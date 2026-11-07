/**
 * Service composition root: `start` builds the whole harness in-process —
 * createLinkinbox (app layer) → createApp (hono api/mcp/capture) → static
 * middleware (apps/web) → http listener — plus the recurrence scheduler.
 * No MCP hop, no spawned CLI: the server calls `app` directly so SSE and
 * latency stay intact.
 */
import { serve, type ServerType } from '@hono/node-server'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createLinkinbox,
  pipelineLogger,
  type AppConfig,
  type AsrFn,
  type EnrichFn,
  type ExtractFn,
  type Linkinbox,
  type MediaFn,
} from '@linkinbox/app'
import type { Store } from '@linkinbox/core'
import { createMcpDeps, createMcpHttpHandler } from '@linkinbox/mcp'
import { createApp, DEFAULT_PORT } from '@linkinbox/server'
import type { MiddlewareHandler } from 'hono'
import { loadHarnessConfig, type HarnessConfig } from './config.js'
import { harnessPidPath, removePidFile, writePidFile, type PidInfo } from './lifecycle.js'
import { createNotifier, type Notifier } from './notify.js'
import { createJsonlRunStore, harnessRunsPath } from './runs.js'
import { HarnessScheduler } from './scheduler.js'
import { createStaticMiddleware } from './static.js'

/** Repo root: apps/harness/{src,dist} → up three levels. */
function repoRoot(): string {
  return fileURLToPath(new URL('../../../', import.meta.url))
}

/**
 * Candidate build outputs for the web UI, in preference order. apps/web is
 * a separate workstream (M4b): SvelteKit emits `build/`, plain Vite emits
 * `dist/` — accept either, plus a harness.toml `web_dir` override.
 */
export function webDirCandidates(root: string = repoRoot()): string[] {
  return [join(root, 'apps', 'web', 'build'), join(root, 'apps', 'web', 'dist')]
}

/** Resolve the web dir: explicit option > env > harness.toml > candidates. */
export function resolveWebDir(
  harness: HarnessConfig,
  env: NodeJS.ProcessEnv = process.env,
  root: string = repoRoot(),
): string | null {
  const explicit = env['LINKINBOX_WEB_DIR'] ?? harness.webDir
  if (explicit !== undefined && explicit.trim() !== '') {
    return existsSync(join(explicit, 'index.html')) ? explicit : null
  }
  for (const candidate of webDirCandidates(root)) {
    if (existsSync(join(candidate, 'index.html'))) return candidate
  }
  return null
}

export interface HarnessRuntimeOptions {
  /** Loaded app config (loadConfig). */
  config: AppConfig
  /** Loaded harness config (loadHarnessConfig); defaults are loaded when absent. */
  harness?: HarnessConfig
  env?: NodeJS.ProcessEnv
  port?: number
  hostname?: string
  /** Explicit web dir override (beats env/config/candidates). */
  webDir?: string | null
  /** Notifier override (tests). */
  notifier?: Notifier
  /** Pre-built app (tests); created via createLinkinbox when absent. */
  app?: Linkinbox
  /** Pre-built store (tests); the app's store is used when absent. */
  store?: Store
  /** Adapter overrides forwarded to createLinkinbox (tests). */
  extractFn?: ExtractFn
  enrichFn?: EnrichFn
  mediaFn?: MediaFn
  asr?: AsrFn
  /** Repo root for web-dir candidates (tests). */
  root?: string
  /** Pidfile path override (tests). */
  pidPath?: string
  /** Extra middleware mounted before static serving (tests). */
  extraMiddleware?: MiddlewareHandler
}

export interface HarnessRuntime {
  port: number
  hostname: string
  url: string
  webDir: string | null
  scheduler: HarnessScheduler
  close(): Promise<void>
}

function displayHost(hostname: string): string {
  if (hostname === '0.0.0.0' || hostname === '::') return '127.0.0.1'
  if (hostname.includes(':')) return `[${hostname}]`
  return hostname
}

export async function startHarness(options: HarnessRuntimeOptions): Promise<HarnessRuntime> {
  const env = options.env ?? process.env
  const harness = options.harness ?? loadHarnessConfig(env, options.config)

  // 1. App layer: store + adapters + use cases.
  const ownsApp = options.app === undefined
  const app =
    options.app ??
    (await createLinkinbox(options.config, {
      env,
      ...(options.store !== undefined ? { store: options.store } : {}),
      logger: pipelineLogger('harness'),
      ...(options.extractFn !== undefined ? { extractFn: options.extractFn } : {}),
      ...(options.enrichFn !== undefined ? { enrichFn: options.enrichFn } : {}),
      ...(options.mediaFn !== undefined ? { mediaFn: options.mediaFn } : {}),
      ...(options.asr !== undefined ? { asr: options.asr } : {}),
    }))
  const store = options.store ?? app.store

  // 2. HTTP surface: api + capture + mcp + openapi via @linkinbox/server,
  //    then the harness's own static layer for apps/web.
  const envPort = Number(env['LINKINBOX_PORT'] ?? '')
  const port =
    options.port ??
    (Number.isFinite(envPort) && envPort > 0 ? envPort : DEFAULT_PORT)
  const hostname = options.hostname ?? env['LINKINBOX_HOST'] ?? '127.0.0.1'

  const mcpFetch = (() => {
    const handler = createMcpHttpHandler(createMcpDeps(app, app.logger))
    return (request: Request) => handler.fetch(request)
  })()

  const hono = createApp(store, {
    ops: app,
    ttl: options.config.ttl,
    hostname,
    capture: options.config.capture,
    server: options.config.server,
    env,
    mcpFetch,
  })
  if (options.extraMiddleware !== undefined) hono.use('*', options.extraMiddleware)

  const webDir =
    options.webDir !== undefined
      ? options.webDir
      : resolveWebDir(harness, env, options.root ?? repoRoot())
  hono.use('*', createStaticMiddleware({ webDir }))

  const server: ServerType = serve({ fetch: hono.fetch, port, hostname })
  await new Promise<void>((res) => {
    if (server.listening) return res()
    server.once('listening', () => res())
  })
  const address = server.address() as { port: number }
  const boundPort = address.port
  const url = `http://${displayHost(hostname)}:${boundPort}`

  // 3. Recurrence: cron schedule and/or ingest-triggered runs.
  const notifier =
    options.notifier ?? (harness.notify ? createNotifier() : undefined)
  const scheduler = new HarnessScheduler({
    run: () => app.run(),
    store,
    config: harness,
    runs: createJsonlRunStore(harnessRunsPath(env)),
    ...(notifier !== undefined ? { notifier } : {}),
    uiUrl: url,
  })
  try {
    scheduler.start()
  } catch (err) {
    // Bad harness.toml (e.g. invalid cron) must not leak the listener.
    await new Promise<void>((res) => server.close(() => res()))
    if (ownsApp) await app.close()
    throw err
  }

  // 4. Lifecycle record so `status`/`stop` can find us.
  const pidInfo: PidInfo = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    port: boundPort,
    url,
  }
  const pidPath = options.pidPath ?? harnessPidPath(env)
  writePidFile(pidPath, pidInfo)

  let closed = false
  return {
    port: boundPort,
    hostname,
    url,
    webDir,
    scheduler,
    async close() {
      if (closed) return
      closed = true
      try {
        await scheduler.stop()
        await new Promise<void>((res, rej) =>
          server.close((err) => (err ? rej(err) : res())),
        )
        if (ownsApp) await app.close()
      } finally {
        removePidFile(pidPath)
      }
    },
  }
}
