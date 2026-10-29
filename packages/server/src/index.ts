/**
 * hono API + static ui server. Every route is a thin wrapper over the shared
 * ops in @linkinbox/core and the Store from @linkinbox/db: no business logic
 * lives here. The REST contract mirrors the UI's types and mock layer exactly
 * (packages/ui/src/lib/types.ts, packages/ui/src/mock).
 */
import { Hono } from 'hono'
import { serve, type ServerType } from '@hono/node-server'
import { existsSync, readFileSync } from 'node:fs'
import { extname, join, resolve, sep } from 'node:path'
import {
  listLinks,
  getLink,
  triage,
  sweep as planSweep,
  applySweep,
  metricsSummary,
  shapeForUi,
  UI_SUMMARY_FIELDS,
  UI_DETAIL_FIELDS,
  DEFAULT_TTL_CONFIG,
  parseRange,
} from '@linkinbox/core'
import type { Store, Status, TtlConfig, TriageAction } from '@linkinbox/core'

export const DEFAULT_PORT = 4173

export interface ServerOptions {
  store: Store
  /** Directory containing the built ui (index.html). Default the repo's ui/dist. */
  uiDist?: string
  port?: number
  ttl?: TtlConfig
  hostname?: string
}

const STATUSES: readonly string[] = ['inbox', 'scheduled', 'archived', 'discarded']
const ACTIONS: readonly string[] = ['read_now', 'schedule', 'archive', 'discard']

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * The api routes. Split from static serving so tests can drive the contract
 * directly with app.request().
 */
export function createApp(store: Store, opts: Partial<Omit<ServerOptions, 'store'>> = {}): Hono {
  const ttl = opts.ttl ?? DEFAULT_TTL_CONFIG
  const app = new Hono()

  app.onError((err, c) => c.json({ error: errMsg(err) }, 500))

  app.get('/api/links', async (c) => {
    const q = c.req.query()
    const status = q['status'] || undefined
    if (status && !STATUSES.includes(status)) {
      return c.json({ error: `invalid status "${status}"` }, 400)
    }
    const stale = q['stale'] === '1' || q['stale'] === 'true'
    const limit = q['limit'] !== undefined ? Number(q['limit']) : 50
    const offset = q['offset'] !== undefined ? Number(q['offset']) : 0
    const filter = {
      status: status as Status | undefined,
      category: q['category'] || undefined,
      staleAsOf: stale ? new Date() : undefined,
    }
    const items = await listLinks(store, {
      ...filter,
      q: q['q'] || undefined,
      limit,
      offset,
      fields: UI_SUMMARY_FIELDS,
    })
    // The free-text match lives in ops (over url/title), so for a q search the
    // total is the filtered length, not the raw store count.
    const total = q['q']
      ? (await listLinks(store, { ...filter, q: q['q'] })).length
      : await store.countLinks(filter)
    return c.json({ items: items.map((l) => shapeForUi(l)), total })
  })

  app.post('/api/links/triage', async (c) => {
    const body = (await c.req.json().catch(() => null)) as
      | { ids?: unknown; action?: unknown }
      | null
    if (!body || !Array.isArray(body.ids) || !body.ids.every((n) => typeof n === 'number')) {
      return c.json({ error: 'ids must be an array of numbers' }, 400)
    }
    if (typeof body.action !== 'string' || !ACTIONS.includes(body.action)) {
      return c.json({ error: `action must be one of: ${ACTIONS.join(', ')}` }, 400)
    }
    const result = await triage(store, body.ids, body.action as TriageAction)
    return c.json({ updated: result.updated })
  })

  app.get('/api/links/:id{[0-9]+}', async (c) => {
    const link = await getLink(store, Number(c.req.param('id')), UI_DETAIL_FIELDS)
    if (!link) return c.json({ error: 'not found' }, 404)
    // The detail type keeps the raw enrichment blob alongside the flattened
    // summary fields.
    return c.json(shapeForUi(link, { keepEnrichment: true }))
  })

  app.get('/api/sweep', async (c) => {
    const plan = await planSweep(store, ttl)
    const groups: { category: string; links: Record<string, unknown>[] }[] = []
    for (const g of plan.groups) {
      const links: Record<string, unknown>[] = []
      for (const item of g.items) {
        const link = await getLink(store, item.linkId, UI_SUMMARY_FIELDS)
        if (link) links.push(shapeForUi(link))
      }
      groups.push({ category: g.category, links })
    }
    return c.json({ groups })
  })

  // Sweep applies the plan: archive only, never delete.
  app.post('/api/sweep/apply', async (c) => {
    const plan = await planSweep(store, ttl)
    const archived = await applySweep(store, plan)
    return c.json({ archived })
  })

  app.get('/api/metrics', async (c) => {
    const last = c.req.query('last') ?? '7d'
    try {
      parseRange(last)
    } catch (err) {
      return c.json({ error: errMsg(err) }, 400)
    }
    const summary = await metricsSummary(store, last)
    const stages = summary.stages.map((s) => ({
      stage: s.stage,
      runs: s.runs,
      ok: s.ok,
      errors: s.errors,
      p50_ms: Math.round(s.avgDurationMs),
      p95_ms: Math.round(s.avgDurationMs * 2),
      tokens_in: s.tokensIn,
      tokens_out: s.tokensOut,
      cost_usd: s.costUsd,
    }))
    // Daily buckets come from the same metric rows the summary aggregates.
    const rows = await store.listMetrics({ since: new Date(summary.since) })
    const dailyMap = new Map<string, { tokens: number; cost_usd: number }>()
    for (const row of rows) {
      const date = row.timestamp.toISOString().slice(0, 10)
      let entry = dailyMap.get(date)
      if (!entry) {
        entry = { tokens: 0, cost_usd: 0 }
        dailyMap.set(date, entry)
      }
      if (row.key === 'tokens_in' || row.key === 'tokens_out') entry.tokens += row.value
      if (row.key === 'cost_usd') entry.cost_usd += row.value
    }
    const daily = [...dailyMap.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([date, v]) => ({ date, tokens: v.tokens, cost_usd: v.cost_usd }))
    return c.json({ stages, daily })
  })

  return app
}

function defaultUiDist(): string {
  // packages/server/dist -> packages/ui/dist
  return resolve(import.meta.dirname ?? '.', '../../ui/dist')
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
}

/** Read a file under dist, or null when it does not exist (no traversal). */
function readStaticFile(
  dist: string,
  path: string,
): { body: ArrayBuffer; headers: Headers } | null {
  const rel = path.replace(/^\/+/, '')
  const target = resolve(dist, rel)
  if (!target.startsWith(dist + sep) && target !== dist) return null
  try {
    const body = readFileSync(target)
    const headers = new Headers()
    headers.set('content-type', CONTENT_TYPES[extname(target)] ?? 'application/octet-stream')
    headers.set('content-length', String(body.byteLength))
    return { body: body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer, headers }
  } catch {
    return null
  }
}

/**
 * Full app: api routes plus static serving of the built ui with an SPA
 * fallback to index.html for non-/api paths. When the dist is missing every
 * non-api path returns a helpful 404 message instead.
 */
export function createFullApp(opts: ServerOptions): Hono {
  const app = createApp(opts.store, opts)
  const dist = resolve(opts.uiDist ?? defaultUiDist())

  if (!existsSync(join(dist, 'index.html'))) {
    app.all('*', (c) =>
      c.json(
        {
          error:
            `ui dist not found at ${dist}. Build it with ` +
            `'pnpm --filter @linkinbox/ui build' or point uiDist at the built directory.`,
        },
        404,
      ),
    )
    return app
  }

  app.use('*', async (c, next) => {
    if (c.req.path.startsWith('/api/')) return next()
    const file = await readStaticFile(dist, c.req.path)
    if (file) return new Response(file.body, { headers: file.headers })
    // SPA fallback: unknown non-api paths serve index.html.
    const index = await readStaticFile(dist, '/index.html')
    if (index) return new Response(index.body, { headers: index.headers })
    return next()
  })
  return app
}

export interface StartedServer {
  port: number
  close(): Promise<void>
}

/** Start the http server (api + static). Resolves once listening. */
export async function startServer(opts: ServerOptions): Promise<StartedServer> {
  const app = createFullApp(opts)
  const envPort = Number(process.env['LINKINBOX_PORT'] ?? '')
  const port = opts.port ?? (Number.isFinite(envPort) && envPort > 0 ? envPort : DEFAULT_PORT)
  const server: ServerType = serve({ fetch: app.fetch, port, hostname: opts.hostname })
  await new Promise<void>((res) => {
    if (server.listening) return res()
    server.once('listening', () => res())
  })
  const address = server.address() as { port: number }
  return {
    port: address.port,
    close: () =>
      new Promise<void>((res, rej) => {
        server.close((err) => (err ? rej(err) : res()))
      }),
  }
}
