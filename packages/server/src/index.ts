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
  pipelineOverview,
  shapeForUi,
  toPipelineRow,
  UI_SUMMARY_FIELDS,
  UI_DETAIL_FIELDS,
  DEFAULT_TTL_CONFIG,
  parseRange,
  DEFAULT_CAPTURE_CONFIG,
  captureIngest,
  captureToken,
  parseCapture,
  tokensEqual,
  LINK_STATES,
  type CaptureConfig,
} from '@linkinbox/core'
import type {
  Store,
  Status,
  TtlConfig,
  TriageAction,
  LinkStateName,
  LinkProjection,
  LinkField,
} from '@linkinbox/core'

export const DEFAULT_PORT = 4173

export interface ServerOptions {
  store: Store
  /** Directory containing the built ui (index.html). Default the repo's ui/dist. */
  uiDist?: string
  port?: number
  ttl?: TtlConfig
  hostname?: string
  /** Capture endpoint config. Default: token from LINKINBOX_CAPTURE_TOKEN. */
  capture?: CaptureConfig
  /** Env the capture token is read from. Default process.env (tests inject). */
  env?: NodeJS.ProcessEnv
}

const STATUSES: readonly string[] = ['inbox', 'scheduled', 'archived', 'discarded']
const ACTIONS: readonly string[] = ['read_now', 'schedule', 'archive', 'discard']

/**
 * The UI summary fields plus the pipeline fields: the FSM state, the reason
 * it carries and the state payload. The pipeline row is additive, so the
 * existing callers of /api/links keep working unchanged.
 */
const PIPELINE_SUMMARY_FIELDS: LinkField[] = [
  ...UI_SUMMARY_FIELDS,
  'state',
  'stateData',
  'updatedAt',
]

/**
 * Shape one link for the API: the UI summary plus the pipeline fields
 * (`state`, `reason`, `next_attempt_at`, `host`, `updated_at`). The legacy
 * summary keys are untouched, so existing clients keep working.
 */
function shapePipelineRow(link: LinkProjection): Record<string, unknown> {
  const row = shapeForUi(link) as Record<string, unknown>
  const pipeline = toPipelineRow(link)
  row['state'] = pipeline.state
  row['reason'] = pipeline.reason
  row['host'] = pipeline.host
  row['next_attempt_at'] = pipeline.nextAttemptAt
  row['updated_at'] = pipeline.updatedAt
  return row
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * The api routes. Split from static serving so tests can drive the contract
 * directly with app.request().
 */
export function createApp(store: Store, opts: Partial<Omit<ServerOptions, 'store'>> = {}): Hono {
  const ttl = opts.ttl ?? DEFAULT_TTL_CONFIG
  const capture = opts.capture ?? DEFAULT_CAPTURE_CONFIG
  const env = opts.env ?? process.env
  const app = new Hono()

  app.onError((err, c) => c.json({ error: errMsg(err) }, 500))

  // ---- capture endpoint ----------------------------------------------
  //
  // Any client that can POST JSON can use it (a browser extension, a
  // script). Bearer-token auth, CORS restricted to the configured origins
  // and a hard body-size cap. The endpoint only exists when the token env
  // var is set: an unset token means capture is disabled, not open.

  app.use('/capture', async (c, next) => {
    // CORS: only the configured origins get browser-facing headers. An
    // extension origin (chrome-extension://<id>) is listed explicitly in the
    // config; nothing is wildcarded.
    const origin = c.req.header('origin')
    if (origin !== undefined && capture.allowedOrigins.includes(origin)) {
      c.header('access-control-allow-origin', origin)
      c.header('access-control-allow-methods', 'POST, OPTIONS')
      c.header('access-control-allow-headers', 'authorization, content-type')
      c.header('vary', 'origin')
    }
    if (c.req.method === 'OPTIONS') return c.body(null, 204)
    await next()
  })

  app.post('/capture', async (c) => {
    const token = captureToken(capture, env)
    if (token === null) {
      // Refuse to serve when the token is unset: the endpoint is disabled.
      return c.json({ error: 'capture endpoint is disabled (token not configured)' }, 403)
    }
    const auth = c.req.header('authorization') ?? ''
    const presented = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : ''
    if (presented === '' || !tokensEqual(presented, token)) {
      return c.json({ error: 'unauthorized' }, 401)
    }

    const raw = await c.req.arrayBuffer()
    if (raw.byteLength > capture.maxBodyBytes) {
      return c.json({ error: `body too large (max ${capture.maxBodyBytes} bytes)` }, 413)
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(new TextDecoder().decode(raw))
    } catch {
      return c.json({ error: 'body must be valid JSON' }, 400)
    }
    let captureBody
    try {
      captureBody = parseCapture(parsed)
    } catch (err) {
      return c.json(
        { error: errMsg(err), issues: (err as { issues?: string[] }).issues ?? [] },
        400,
      )
    }
    const result = await captureIngest(store, captureBody)
    return c.json(
      {
        id: result.link.id,
        url: result.link.url,
        outcome: result.outcome,
      },
      result.outcome === 'created' ? 201 : 200,
    )
  })

  app.get('/api/links', async (c) => {
    const q = c.req.query()
    const status = q['status'] || undefined
    if (status && !STATUSES.includes(status)) {
      return c.json({ error: `invalid status "${status}"` }, 400)
    }
    const stale = q['stale'] === '1' || q['stale'] === 'true'
    const limit = q['limit'] !== undefined ? Number(q['limit']) : 50
    const offset = q['offset'] !== undefined ? Number(q['offset']) : 0
    // The pipeline filters (additive): `state` filters on the FSM
    // discriminant, `host` on the host of the url.
    let state: LinkStateName | undefined
    if (q['state'] !== undefined && q['state'] !== '') {
      if (!LINK_STATES.includes(q['state'] as LinkStateName)) {
        return c.json({ error: `invalid state "${q['state']}"` }, 400)
      }
      state = q['state'] as LinkStateName
    }
    const filter = {
      status: status as Status | undefined,
      state,
      category: q['category'] || undefined,
      host: q['host'] || undefined,
      staleAsOf: stale ? new Date() : undefined,
    }
    const items = await listLinks(store, {
      ...filter,
      q: q['q'] || undefined,
      limit,
      offset,
      fields: PIPELINE_SUMMARY_FIELDS,
    })
    // The free-text match (and the host filter) live in ops (over url/title),
    // so for those the total is the filtered length, not the raw store count.
    // The store count handles the state filter on the FSM discriminant.
    const storeFilter = {
      status: (state ?? status) as Status | undefined,
      byState: state !== undefined,
      category: filter.category,
      staleAsOf: filter.staleAsOf,
    }
    const total = q['q'] || filter.host
      ? (await listLinks(store, { ...filter, q: q['q'] || undefined })).length
      : await store.countLinks(storeFilter)
    return c.json({ items: items.map(shapePipelineRow), total })
  })

  // The pipeline overview: every state with its count, every park reason
  // with its parked-link count, plus the busiest hosts. Read-only: it reads
  // the link rows once.
  app.get('/api/pipeline', async (c) => {
    const overview = await pipelineOverview(store)
    return c.json({
      byState: overview.byState,
      byParkReason: overview.byParkReason,
      byHost: overview.byHost.map((h) => ({
        host: h.host,
        total: h.total,
        byState: h.byState,
        byParkReason: h.byParkReason,
      })),
    })
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
    if (c.req.path.startsWith('/api/') || c.req.path === '/capture') return next()
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
  const server: ServerType = serve({
    fetch: app.fetch,
    port,
    // Loopback by default: the capture endpoint must never be exposed on a
    // public interface without a deliberate override.
    hostname: opts.hostname ?? '127.0.0.1',
  })
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
