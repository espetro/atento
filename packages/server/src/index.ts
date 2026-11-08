/**
 * hono API + static ui server. Every route is a thin wrapper over the app
 * layer's use cases (@linkinbox/app): no business logic lives here. The REST
 * contract mirrors the UI's types and mock layer exactly
 * (packages/ui/src/lib/types.ts, packages/ui/src/mock).
 *
 * M3 additions:
 *  - every route carries a `describeRoute` spec; `GET /openapi.json` serves
 *    the generated OpenAPI 3.1 document (packages/client is generated from it).
 *  - new endpoints: POST /api/run, GET /api/runs/:id,
 *    POST /api/links/:id/reextract, PATCH /api/links/:id,
 *    GET /api/links/:id/artifacts/:name, GET /api/events (SSE).
 *  - bearer auth: loopback binds are open; any other bind requires
 *    `Authorization: Bearer <token>` on /api/*, /mcp and /openapi.json.
 *    The token comes from `[server] token_env` (see core/server-config).
 *    /capture keeps its own token check; static ui assets stay open (they
 *    carry no data).
 */
import { Hono, type Context, type MiddlewareHandler } from 'hono'
import { serve, type ServerType } from '@hono/node-server'
import { describeRoute, openAPIRouteHandler } from 'hono-openapi'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, extname, join, resolve, sep } from 'node:path'
import {
  createLinkinboxOps,
  isCollectionName,
  serializeCollection,
  tsvWithCursor,
  COLLECTION_NAMES,
  DEFAULT_COLLECTION_FIELDS,
  type CollectionExportFormat,
  type CollectionName,
  type LinkinboxOps,
} from '@linkinbox/app'
import {
  shapeForUi,
  toPipelineRow,
  UI_SUMMARY_FIELDS,
  UI_DETAIL_FIELDS,
  DEFAULT_TTL_CONFIG,
  parseRange,
  DEFAULT_CAPTURE_CONFIG,
  DEFAULT_SERVER_CONFIG,
  captureToken,
  parseCapture,
  serverToken,
  tokensEqual,
  LINK_STATES,
  type CaptureConfig,
  type ServerConfig,
} from '@linkinbox/core'
import type {
  Store,
  Status,
  TtlConfig,
  TriageAction,
  LinkStateName,
  LinkProjection,
  LinkField,
  LinkPatch,
} from '@linkinbox/core'
import { createEventsResponse } from './events.js'
import { createPairingService } from './pairing.js'
import {
  BrowserAdaptersBody,
  CollectionsSummaryBody,
  CollectionExportBody,
  CollectionReadResponse,
  ConfigInfoBody,
  ErrorBody,
  errorResponses,
  IngestInputBody,
  IngestJobResponse,
  IngestJobSummaryBody,
  JsonObject,
  LinkListResponse,
  LinkPatchBody,
  LinkResponse,
  LinkRow,
  MetricsResponse,
  PairCodeBody,
  PairExchangeBody,
  PairTokensBody,
  PipelineOverviewResponse,
  ReextractBody,
  ReextractResponse,
  resolverOf,
  RunJournalBody,
  RunListResponse,
  RunResultBody,
  SweepApplyResponse,
  SweepResponse,
  TriageBody,
  RestoreBody,
} from './schemas.js'

export const DEFAULT_PORT = 4173

export interface ServerOptions {
  store: Store
  /**
   * The app-layer use cases to drive. When absent they are built from the
   * store plus the ttl below — the same ops the composition root exposes.
   * `linkinbox serve` passes its createLinkinbox instance here.
   */
  ops?: LinkinboxOps
  /** Directory containing the built ui (index.html). Default the repo's ui/dist. */
  uiDist?: string
  port?: number
  ttl?: TtlConfig
  hostname?: string
  /** Capture endpoint config. Default: token from LINKINBOX_CAPTURE_TOKEN. */
  capture?: CaptureConfig
  /**
   * `[server]` config: names the env var holding the bearer token for
   * non-loopback binds. Default LINKINBOX_SERVER_TOKEN.
   */
  server?: ServerConfig
  /** Env the capture/server tokens are read from. Default process.env. */
  env?: NodeJS.ProcessEnv
  /**
   * MCP streamable-HTTP handler mounted at /mcp (fetch-shaped, e.g. from
   * `createMcpHttpHandler` in @linkinbox/mcp). Absent = no /mcp route.
   */
  mcpFetch?: (request: Request) => Promise<Response>
  /** SSE poll interval for /api/events. Default 500ms. */
  eventsPollMs?: number
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

/** Shape one runs row the way the run journal endpoints document it. */
function shapeRunRow(run: {
  id: number
  stage: string
  status?: string | null
  pid?: number | null
  startedAt: Date
  heartbeatAt?: Date | null
  finishedAt: Date | null
  inputCount: number
  okCount: number
  errorCount: number
  durationMs: number | null
  tokensIn: number | null
  tokensOut: number | null
  costUsd: number | null
}): Record<string, unknown> {
  return {
    id: run.id,
    stage: run.stage,
    status: run.status ?? null,
    pid: run.pid ?? null,
    startedAt: run.startedAt.toISOString(),
    heartbeatAt: run.heartbeatAt?.toISOString() ?? null,
    finishedAt: run.finishedAt?.toISOString() ?? null,
    inputCount: run.inputCount,
    okCount: run.okCount,
    errorCount: run.errorCount,
    durationMs: run.durationMs,
    tokensIn: run.tokensIn,
    tokensOut: run.tokensOut,
    costUsd: run.costUsd,
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Loopback bind hostnames: no bearer token required on these. */
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', '::1', 'localhost'])

const jsonContent = (schema: Parameters<typeof resolverOf>[0]) => ({
  'application/json': { schema: resolverOf(schema) },
})

const okJson = (
  description: string,
  schema: Parameters<typeof resolverOf>[0],
) => ({
  200: { description, content: jsonContent(schema) },
})

const ID_PARAM = {
  name: 'id',
  in: 'path',
  required: true,
  schema: { type: 'integer' },
} as const

/**
 * The api routes. Split from static serving so tests can drive the contract
 * directly with app.request().
 */
export function createApp(store: Store, opts: Partial<Omit<ServerOptions, 'store'>> = {}): Hono {
  const ttl = opts.ttl ?? DEFAULT_TTL_CONFIG
  const capture = opts.capture ?? DEFAULT_CAPTURE_CONFIG
  const serverCfg = opts.server ?? DEFAULT_SERVER_CONFIG
  const env = opts.env ?? process.env
  const ops =
    opts.ops ?? createLinkinboxOps({ ttl }, { store, env })
  const pairing = createPairingService({ capture, server: serverCfg, env })
  const app = new Hono()

  app.onError((err, c) => c.json({ error: errMsg(err) }, 500))

  // ---- auth ------------------------------------------------------------
  //
  // Loopback binds (127.0.0.1, ::1, localhost — the default) need no token.
  // Any other bind requires `Authorization: Bearer <token>` on /api/*,
  // /mcp and /openapi.json; the token comes from `[server] token_env` and
  // is read per request. An unset token env on a non-loopback bind fails
  // closed: every protected route answers 401. /capture has its own token
  // check; static ui assets stay open (no data).
  const bindHost = opts.hostname ?? '127.0.0.1'
  const loopback = LOOPBACK_HOSTNAMES.has(bindHost)

  const bearerAuth: MiddlewareHandler = async (c, next) => {
    // POST /api/pair is the one unauthenticated /api route: the client
    // redeeming a one-time pairing code has no bearer token yet — the code
    // itself is the credential (see pairing.ts). GET /api/pair/code stays
    // gated so only an authenticated caller can mint codes.
    if (c.req.method === 'POST' && c.req.path === '/api/pair') return next()
    if (loopback) return next()
    const expected = serverToken(serverCfg, env)
    if (expected === null) return c.json({ error: 'unauthorized' }, 401)
    const auth = c.req.header('authorization') ?? ''
    const presented = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : ''
    if (presented === '' || !tokensEqual(presented, expected)) {
      return c.json({ error: 'unauthorized' }, 401)
    }
    await next()
  }
  app.use('/api/*', bearerAuth)
  app.use('/mcp', bearerAuth)
  app.use('/mcp/*', bearerAuth)
  app.use('/openapi.json', bearerAuth)

  // ---- pairing ---------------------------------------------------------
  //
  // A capture client (the browser extension) pairs without anyone typing
  // the bearer tokens: an authenticated caller (the web UI, same origin on
  // loopback) mints a short-lived one-time code, the client redeems it for
  // the tokens it needs. Codes live in memory — a server restart simply
  // means pairing again. See src/pairing.ts for the contract.

  app.get(
    '/api/pair/code',
    describeRoute({
      tags: ['pairing'],
      summary: 'Issue a one-time pairing code for POST /api/pair',
      description:
        'Returns a short-lived, single-use code. Display it to the user; ' +
        'the client redeems it at POST /api/pair for the bearer tokens.',
      responses: {
        ...okJson('Pairing code issued', PairCodeBody),
        401: {
          description: 'Missing or wrong bearer token (non-loopback binds)',
          content: jsonContent(ErrorBody),
        },
      },
    }),
    (c) => c.json(pairing.issue()),
  )

  app.post(
    '/api/pair',
    describeRoute({
      tags: ['pairing'],
      summary: 'Redeem a one-time pairing code for bearer tokens',
      description:
        'Exchanges a code from GET /api/pair/code for the capture and ' +
        'server bearer tokens. Single-use; 401 on unknown, expired or ' +
        'already-redeemed codes. Not bearer-gated: the code is the ' +
        'credential.',
      requestBody: {
        required: true,
        content: jsonContent(PairExchangeBody),
      },
      responses: {
        200: {
          description: 'Tokens for the client to store',
          content: jsonContent(PairTokensBody),
        },
        401: {
          description: 'Unknown, expired or already-used code',
          content: jsonContent(ErrorBody),
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const body = (await c.req.json().catch(() => null)) as { code?: unknown } | null
      if (typeof body?.code !== 'string' || body.code.trim() === '') {
        return c.json({ error: 'body must be { code: string }' }, 400)
      }
      const tokens = pairing.redeem(body.code)
      if (tokens === null) {
        return c.json({ error: 'invalid or expired pairing code' }, 401)
      }
      return c.json(tokens)
    },
  )

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

  app.post(
    '/capture',
    describeRoute({
      tags: ['capture'],
      summary: 'Ingest one client capture (browser extension / script)',
      description:
        'Bearer-token authenticated capture endpoint. Only enabled when the ' +
        'capture token env var is set; CORS is restricted to configured origins.',
      responses: {
        200: {
          description: 'Capture ingested (duplicate url)',
          content: jsonContent(LinkRow),
        },
        201: {
          description: 'Capture ingested (new link)',
          content: jsonContent(LinkRow),
        },
        ...errorResponses,
      },
    }),
    async (c) => {
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
      const result = await ops.captureIngest(captureBody)
      return c.json(
        {
          id: result.link.id,
          url: result.link.url,
          outcome: result.outcome,
        },
        result.outcome === 'created' ? 201 : 200,
      )
    },
  )

  // ---- bulk ingest ------------------------------------------------------
  //
  // One use case behind every content type, same as the CLI and MCP:
  //   multipart/form-data  -> a file upload, ingested like ingest_file
  //   text/plain           -> long-form text, ingested like ingest_text
  //   application/json     -> { kind: 'urls' | 'remote' | 'file' | 'text', ... }
  // The response is always the job summary — never the links.

  app.post(
    '/api/ingest',
    describeRoute({
      tags: ['ingest'],
      summary: 'Bulk-ingest links (multipart file, text/plain, or JSON kind)',
      requestBody: {
        required: false,
        content: {
          'application/json': { schema: resolverOf(IngestInputBody) },
          'text/plain': { schema: { type: 'string' } },
          'multipart/form-data': {
            schema: {
              type: 'object',
              properties: { file: { type: 'string', format: 'binary' } },
              required: ['file'],
            },
          },
        },
      },
      responses: {
        200: {
          description: 'Job accepted (or already running — check status "busy")',
          content: jsonContent(IngestJobSummaryBody),
        },
        409: {
          description: 'Another ingest run holds the lock (status "busy")',
          content: jsonContent(IngestJobSummaryBody),
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const contentType = c.req.header('content-type') ?? ''
      try {
        if (contentType.includes('multipart/form-data')) {
          const body = await c.req.parseBody()
          const file = body['file']
          if (!(file instanceof File)) {
            return c.json({ error: 'multipart body must carry a "file" part' }, 400)
          }
          const dir = await mkdtemp(join(tmpdir(), 'linkinbox-ingest-'))
          try {
            const name = file.name === '' ? 'upload' : basename(file.name)
            // A crafted multipart filename must never escape the temp dir.
            const safe = name === '.' || name === '..' || name.includes('/') || name.includes('\\')
              ? 'upload'
              : name
            const path = join(dir, safe)
            await writeFile(path, Buffer.from(await file.arrayBuffer()))
            const summary = await ops.ingest({ kind: 'file', path })
            return c.json(summary, summary.status === 'busy' ? 409 : 200)
          } finally {
            await rm(dir, { recursive: true, force: true }).catch(() => {})
          }
        }
        if (contentType.includes('text/plain')) {
          const text = await c.req.text()
          const summary = await ops.ingest({ kind: 'text', text })
          return c.json(summary, summary.status === 'busy' ? 409 : 200)
        }
        const body = (await c.req.json().catch(() => null)) as
          | { kind?: string; path?: string; text?: string; urls?: unknown; url?: string; note?: string; tags?: unknown }
          | null
        if (!body || typeof body.kind !== 'string') {
          return c.json(
            { error: 'json body must be { kind: "urls"|"remote"|"file"|"text", ... }' },
            400,
          )
        }
        switch (body.kind) {
          case 'urls': {
            if (!Array.isArray(body.urls) || !body.urls.every((u) => typeof u === 'string')) {
              return c.json({ error: 'urls must be an array of strings' }, 400)
            }
            const summary = await ops.ingest({
              kind: 'urls',
              urls: body.urls,
              ...(typeof body.note === 'string' ? { note: body.note } : {}),
              ...(Array.isArray(body.tags) && body.tags.every((t) => typeof t === 'string')
                ? { tags: body.tags as string[] }
                : {}),
            })
            return c.json(summary, summary.status === 'busy' ? 409 : 200)
          }
          case 'remote': {
            if (typeof body.url !== 'string') return c.json({ error: 'url must be a string' }, 400)
            const summary = await ops.ingest({ kind: 'remote', url: body.url })
            return c.json(summary, summary.status === 'busy' ? 409 : 200)
          }
          case 'file': {
            if (typeof body.path !== 'string') return c.json({ error: 'path must be a string' }, 400)
            const summary = await ops.ingest({ kind: 'file', path: body.path })
            return c.json(summary, summary.status === 'busy' ? 409 : 200)
          }
          case 'text': {
            if (typeof body.text !== 'string') return c.json({ error: 'text must be a string' }, 400)
            const summary = await ops.ingest({ kind: 'text', text: body.text })
            return c.json(summary, summary.status === 'busy' ? 409 : 200)
          }
          default:
            return c.json({ error: `unknown ingest kind "${body.kind}"` }, 400)
        }
      } catch (err) {
        const message = errMsg(err)
        // Input problems (missing file, bad url, too many urls, fetch failure)
        // are client errors, not server faults.
        if (
          message.includes('at most') ||
          message.includes('could not fetch') ||
          message.includes('fetch of') ||
          message.includes('exceeds')
        ) {
          return c.json({ error: message }, 400)
        }
        throw err
      }
    },
  )

  app.get(
    '/api/ingest/:jobId',
    describeRoute({
      tags: ['ingest'],
      summary: 'Progress of one ingest job',
      parameters: [
        {
          name: 'jobId',
          in: 'path',
          required: true,
          schema: { type: 'string' },
        },
      ],
      responses: {
        200: {
          description: 'Job status',
          content: jsonContent(IngestJobResponse),
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const job = await ops.ingestStatus(c.req.param('jobId'))
      if (!job) return c.json({ error: 'not found' }, 404)
      return c.json({ job })
    },
  )

  // ---- collections -------------------------------------------------------
  //
  // Token-efficient output for agents: summary counts, paginated reads with
  // a fields projection and tsv/jsonl streaming, plus file exports. The
  // `since` parameter is the link_events cursor returned by earlier reads.

  app.get(
    '/api/collections/summary',
    describeRoute({
      tags: ['collections'],
      summary: 'Counts per pipeline collection plus needs_login per host',
      responses: okJson('Collection summary', CollectionsSummaryBody),
    }),
    async (c) => {
      return c.json(await ops.collectionsSummary())
    },
  )

  app.get(
    '/api/collections/:name',
    describeRoute({
      tags: ['collections'],
      summary:
        'Read one collection: json (default), tsv, or streaming jsonl/md. ' +
        '`since`/`cursor` resume a delta; the cursor comes back in the body ' +
        'or the x-linkinbox-cursor header.',
      parameters: [
        {
          name: 'name',
          in: 'path',
          required: true,
          schema: { type: 'string', enum: [...COLLECTION_NAMES] },
        },
        { name: 'since', in: 'query', required: false, schema: { type: 'integer' } },
        { name: 'cursor', in: 'query', required: false, schema: { type: 'integer' } },
        {
          name: 'format',
          in: 'query',
          required: false,
          schema: { type: 'string', enum: ['json', 'tsv', 'jsonl', 'md'] },
        },
        { name: 'fields', in: 'query', required: false, schema: { type: 'string' } },
        { name: 'limit', in: 'query', required: false, schema: { type: 'integer' } },
        { name: 'offset', in: 'query', required: false, schema: { type: 'integer' } },
      ],
      responses: {
        200: {
          description: 'Collection rows (json) or a serialized stream (tsv/jsonl/md)',
          content: {
            'application/json': { schema: resolverOf(CollectionReadResponse) },
            'text/tab-separated-values': { schema: { type: 'string' } },
            'application/x-ndjson': { schema: { type: 'string' } },
            'text/markdown': { schema: { type: 'string' } },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const name = c.req.param('name')
      if (!isCollectionName(name)) {
        return c.json({ error: `unknown collection "${name}"; expected one of: ${COLLECTION_NAMES.join(', ')}` }, 400)
      }
      const q = c.req.query()
      const rawSince = q['since'] ?? q['cursor']
      const since = rawSince !== undefined ? Number(rawSince) : undefined
      if (since !== undefined && (!Number.isInteger(since) || since < 0)) {
        return c.json({ error: 'since/cursor must be a non-negative integer cursor' }, 400)
      }
      const format = q['format'] ?? 'json'
      const fields =
        q['fields'] !== undefined && q['fields'] !== ''
          ? q['fields'].split(',').map((f) => f.trim()).filter(Boolean)
          : undefined
      const limit = q['limit'] !== undefined ? Number(q['limit']) : undefined
      const offset = q['offset'] !== undefined ? Number(q['offset']) : undefined

      // Export-style formats stream EVERY matching row (no inline cap) — the
      // same data collection_export writes to a file.
      if (format === 'jsonl' || format === 'md') {
        const scan = await ops.collectionScan(name as CollectionName, {
          ...(since !== undefined ? { since } : {}),
          ...(fields !== undefined ? { fields } : {}),
        })
        const body = serializeCollection(scan.rows, fields ?? DEFAULT_COLLECTION_FIELDS, format)
        return new Response(body, {
          headers: {
            'content-type': format === 'jsonl' ? 'application/x-ndjson; charset=utf-8' : 'text/markdown; charset=utf-8',
            'x-linkinbox-cursor': String(scan.cursor),
          },
        })
      }
      if (format !== 'json' && format !== 'tsv') {
        return c.json({ error: `unknown format "${format}"; expected json, tsv, jsonl or md` }, 400)
      }
      const result = await ops.collectionRead(name as CollectionName, {
        ...(since !== undefined ? { since } : {}),
        ...(fields !== undefined ? { fields } : {}),
        ...(limit !== undefined ? { limit } : {}),
        ...(offset !== undefined ? { offset } : {}),
      })
      if (format === 'tsv') {
        // TSV carries its cursor as a trailing `# cursor:` line — the same
        // convention the CLI and MCP surfaces use.
        const body = tsvWithCursor(
          result.rows,
          fields ?? DEFAULT_COLLECTION_FIELDS,
          result.cursor,
        )
        return new Response(body, {
          headers: {
            'content-type': 'text/tab-separated-values; charset=utf-8',
            'x-linkinbox-cursor': String(result.cursor),
          },
        })
      }
      return c.json(result)
    },
  )

  app.post(
    '/api/collections/export',
    describeRoute({
      tags: ['collections'],
      summary: 'Export one collection (or its delta) to a file',
      requestBody: {
        required: true,
        content: { 'application/json': { schema: resolverOf(CollectionExportBody) } },
      },
      responses: {
        200: {
          description: 'Export handle { path, uri, count, bytes }',
          content: jsonContent(JsonObject),
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const body = (await c.req.json().catch(() => null)) as
        | { name?: unknown; since?: unknown; fields?: unknown; format?: unknown }
        | null
      if (!body || typeof body.name !== 'string' || !isCollectionName(body.name)) {
        return c.json({ error: `name must be one of: ${COLLECTION_NAMES.join(', ')}` }, 400)
      }
      const format = body.format ?? 'jsonl'
      if (format !== 'jsonl' && format !== 'md' && format !== 'tsv') {
        return c.json({ error: 'format must be jsonl, md or tsv' }, 400)
      }
      const fields =
        Array.isArray(body.fields) && body.fields.every((f) => typeof f === 'string')
          ? (body.fields as string[])
          : undefined
      const result = await ops.collectionExport(body.name as CollectionName, {
        ...(typeof body.since === 'number' ? { since: body.since } : {}),
        ...(fields !== undefined ? { fields } : {}),
        format: format as CollectionExportFormat,
      })
      return c.json(result)
    },
  )

  // ---- links -------------------------------------------------------------

  app.get(
    '/api/links',
    describeRoute({
      tags: ['links'],
      summary: 'List links (UI projection plus pipeline state fields)',
      parameters: [
        { name: 'q', in: 'query', required: false, schema: { type: 'string' } },
        {
          name: 'status',
          in: 'query',
          required: false,
          schema: { type: 'string', enum: [...STATUSES] },
        },
        { name: 'state', in: 'query', required: false, schema: { type: 'string' } },
        { name: 'category', in: 'query', required: false, schema: { type: 'string' } },
        { name: 'host', in: 'query', required: false, schema: { type: 'string' } },
        { name: 'stale', in: 'query', required: false, schema: { type: 'string' } },
        {
          name: 'collection',
          in: 'query',
          required: false,
          schema: { type: 'string', enum: [...COLLECTION_NAMES] },
        },
        { name: 'limit', in: 'query', required: false, schema: { type: 'integer' } },
        { name: 'offset', in: 'query', required: false, schema: { type: 'integer' } },
        {
          name: 'sort',
          in: 'query',
          required: false,
          description:
            "Ordering. 'relevance' ranks q hits by bm25 (requires q); " +
            'the default is created_at DESC, id DESC.',
          schema: { type: 'string', enum: ['relevance'] },
        },
      ],
      responses: okJson('Links page', LinkListResponse),
    }),
    async (c) => {
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
      // The collection filter (additive): restricts rows to one pipeline
      // collection — the membership the collections rail navigates by.
      let collection: CollectionName | undefined
      if (q['collection'] !== undefined && q['collection'] !== '') {
        if (!isCollectionName(q['collection'])) {
          return c.json(
            { error: `invalid collection "${q['collection']}"; expected one of: ${COLLECTION_NAMES.join(', ')}` },
            400,
          )
        }
        collection = q['collection']
      }
      // Optional ordering: 'relevance' ranks q hits by bm25. Anything else
      // is a client error, like an unknown status/state/collection.
      let sort: 'relevance' | undefined
      if (q['sort'] !== undefined && q['sort'] !== '') {
        if (q['sort'] !== 'relevance') {
          return c.json({ error: `invalid sort "${q['sort']}"; expected relevance` }, 400)
        }
        sort = 'relevance'
      }
      const filter = {
        status: status as Status | undefined,
        state,
        category: q['category'] || undefined,
        host: q['host'] || undefined,
        staleAsOf: stale ? new Date() : undefined,
        collection,
      }
      const items = await ops.list({
        ...filter,
        stale,
        q: q['q'] || undefined,
        sort,
        limit,
        offset,
        fields: PIPELINE_SUMMARY_FIELDS,
      })
      // The host filter and the collection filter post-filter inside ops
      // over full rows, and q counts every FTS match — not just the page —
      // so for those the total is the filtered length, not the raw store
      // count. The store count handles the state filter on the FSM
      // discriminant.
      const storeFilter = {
        status: (state ?? status) as Status | undefined,
        byState: state !== undefined,
        category: filter.category,
        staleAsOf: filter.staleAsOf,
      }
      const total = q['q'] || filter.host || collection
        ? (await ops.list({ ...filter, stale, q: q['q'] || undefined })).length
        : await store.countLinks(storeFilter)
      return c.json({ items: items.map(shapePipelineRow), total })
    },
  )

  // The pipeline overview: every state with its count, every park reason
  // with its parked-link count, plus the busiest hosts. Read-only: it reads
  // the link rows once.
  app.get(
    '/api/pipeline',
    describeRoute({
      tags: ['pipeline'],
      summary: 'Pipeline overview: state counts, park reasons, busiest hosts',
      responses: okJson('Pipeline overview', PipelineOverviewResponse),
    }),
    async (c) => {
      const overview = await ops.overview()
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
    },
  )

  app.post(
    '/api/links/triage',
    describeRoute({
      tags: ['links'],
      summary: 'Apply one triage action to many link ids',
      requestBody: {
        required: true,
        content: { 'application/json': { schema: resolverOf(TriageBody) } },
      },
      responses: {
        200: {
          description: 'Triage result',
          content: jsonContent(JsonObject),
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const body = (await c.req.json().catch(() => null)) as
        | { ids?: unknown; action?: unknown }
        | null
      if (!body || !Array.isArray(body.ids) || !body.ids.every((n) => typeof n === 'number')) {
        return c.json({ error: 'ids must be an array of numbers' }, 400)
      }
      if (typeof body.action !== 'string' || !ACTIONS.includes(body.action)) {
        return c.json({ error: `action must be one of: ${ACTIONS.join(', ')}` }, 400)
      }
      const result = await ops.triage(body.ids, body.action as TriageAction)
      return c.json({ updated: result.updated })
    },
  )

  app.post(
    '/api/links/restore',
    describeRoute({
      tags: ['links'],
      summary: 'Restore parked (archived/discarded) links back to the inbox',
      requestBody: {
        required: true,
        content: { 'application/json': { schema: resolverOf(RestoreBody) } },
      },
      responses: {
        200: {
          description: 'Restore result',
          content: { 'application/json': { schema: resolverOf(JsonObject) } },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const body = (await c.req.json().catch(() => null)) as { ids?: unknown } | null
      if (!body || !Array.isArray(body.ids) || !body.ids.every((n) => typeof n === 'number')) {
        return c.json({ error: 'ids must be an array of numbers' }, 400)
      }
      const result = await ops.restore(body.ids as number[])
      return c.json({
        updated: result.updated,
        missing: result.missing,
        blocked: result.blocked,
      })
    },
  )

  app.get(
    '/api/links/:id{[0-9]+}',
    describeRoute({
      tags: ['links'],
      summary: 'Get one link (detail projection)',
      parameters: [ID_PARAM],
      responses: {
        200: { description: 'Link detail', content: jsonContent(LinkResponse) },
        ...errorResponses,
      },
    }),
    async (c) => {
      const link = await ops.get(Number(c.req.param('id')), UI_DETAIL_FIELDS)
      if (!link) return c.json({ error: 'not found' }, 404)
      // The detail type keeps the raw enrichment blob alongside the flattened
      // summary fields.
      return c.json(shapeForUi(link, { keepEnrichment: true }))
    },
  )

  // Patch user-editable fields only (title, note, tags); FSM state changes
  // never go through this route.
  app.patch(
    '/api/links/:id{[0-9]+}',
    describeRoute({
      tags: ['links'],
      summary: 'Patch user-editable link fields (title, note, tags)',
      parameters: [ID_PARAM],
      requestBody: {
        required: true,
        content: { 'application/json': { schema: resolverOf(LinkPatchBody) } },
      },
      responses: {
        // Same UI detail projection as GET /api/links/:id.
        200: { description: 'Updated link', content: jsonContent(LinkResponse) },
        ...errorResponses,
      },
    }),
    async (c) => {
      const body = (await c.req.json().catch(() => null)) as
        | { title?: unknown; note?: unknown; tags?: unknown }
        | null
      if (body === null) return c.json({ error: 'body must be a JSON object' }, 400)
      const patch: LinkPatch = {}
      if (body.title !== undefined) {
        if (body.title !== null && typeof body.title !== 'string') {
          return c.json({ error: 'title must be a string or null' }, 400)
        }
        patch.title = body.title as string | null
      }
      if (body.note !== undefined) {
        if (body.note !== null && typeof body.note !== 'string') {
          return c.json({ error: 'note must be a string or null' }, 400)
        }
        patch.note = body.note as string | null
      }
      if (body.tags !== undefined) {
        if (body.tags !== null && (!Array.isArray(body.tags) || !body.tags.every((t) => typeof t === 'string'))) {
          return c.json({ error: 'tags must be an array of strings or null' }, 400)
        }
        patch.tags = body.tags as string[] | null
      }
      const patched = await ops.patchLink(Number(c.req.param('id')), patch)
      if (!patched) return c.json({ error: 'not found' }, 404)
      // Return the same UI detail projection as GET /api/links/:id.
      const link = await ops.get(patched.id, UI_DETAIL_FIELDS)
      return c.json(link !== null ? shapeForUi(link, { keepEnrichment: true }) : patched)
    },
  )

  // Re-extract one link through the FSM RETRY path; `adapter` forces one
  // browser adapter through the wired extract fn.
  app.post(
    '/api/links/:id{[0-9]+}/reextract',
    describeRoute({
      tags: ['links'],
      summary: 'Re-extract one link (FSM RETRY + scoped extract run)',
      parameters: [ID_PARAM],
      requestBody: {
        required: false,
        content: { 'application/json': { schema: resolverOf(ReextractBody) } },
      },
      responses: {
        200: {
          description: 'Re-extract outcome',
          content: jsonContent(ReextractResponse),
        },
        409: {
          description: 'Illegal state or another extract run is busy',
          content: jsonContent(ReextractResponse),
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const body = (await c.req.json().catch(() => null)) as
        | { adapter?: unknown; limit?: unknown }
        | null
      if (body !== null) {
        if (body.adapter !== undefined && typeof body.adapter !== 'string') {
          return c.json({ error: 'adapter must be a string' }, 400)
        }
        if (body.limit !== undefined && (typeof body.limit !== 'number' || !Number.isInteger(body.limit) || body.limit <= 0)) {
          return c.json({ error: 'limit must be a positive integer' }, 400)
        }
      }
      const result = await ops.reextractLink(Number(c.req.param('id')), {
        ...(body?.adapter !== undefined ? { adapter: body.adapter as string } : {}),
        ...(body?.limit !== undefined ? { limit: body.limit as number } : {}),
      })
      if (!result.ok) {
        const status = result.reason === 'not_found' || result.reason === 'deleted' ? 404 : 409
        return c.json(result, status as 404 | 409)
      }
      return c.json(result)
    },
  )

  // One stored artifact for a link (screenshot, snapshot, ...). Names are
  // single file names — traversal is rejected by the app layer.
  app.get(
    '/api/links/:id{[0-9]+}/artifacts/:name',
    describeRoute({
      tags: ['links'],
      summary: 'Read one stored artifact for a link',
      parameters: [
        ID_PARAM,
        { name: 'name', in: 'path', required: true, schema: { type: 'string' } },
      ],
      responses: {
        200: {
          description: 'Artifact bytes',
          content: { '*/*': { schema: { type: 'string', format: 'binary' } } },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const artifact = await ops.readArtifact(
        Number(c.req.param('id')),
        c.req.param('name'),
      )
      if (!artifact) return c.json({ error: 'not found' }, 404)
      return new Response(artifact.body as unknown as BodyInit, {
        headers: {
          'content-type': artifact.contentType,
          'content-length': String(artifact.body.byteLength),
          'content-disposition': `inline; filename="${artifact.name}"`,
        },
      })
    },
  )

  // ---- run journal ---------------------------------------------------------

  app.post(
    '/api/run',
    describeRoute({
      tags: ['run'],
      summary:
        'Run one full pipeline pass: ingest configured sources, extract ' +
        'until empty, enrich until empty, sweep. Returns cursors bracketing ' +
        'the pass and a per-stage summary.',
      responses: {
        200: {
          description: 'Run result',
          content: jsonContent(RunResultBody),
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      return c.json(await ops.run())
    },
  )

  app.get(
    '/api/runs/:id{[0-9]+}',
    describeRoute({
      tags: ['run'],
      summary: 'One run-journal row by id (stage, status, counters, tokens)',
      parameters: [ID_PARAM],
      responses: {
        200: { description: 'Run journal row', content: jsonContent(RunJournalBody) },
        ...errorResponses,
      },
    }),
    async (c) => {
      const run = await ops.getRun(Number(c.req.param('id')))
      if (!run) return c.json({ error: 'not found' }, 404)
      return c.json(shapeRunRow(run))
    },
  )

  // The recent journal, newest first — the run status view's "last run"
  // and journal list on a cold load (SSE only carries live transitions).
  app.get(
    '/api/runs',
    describeRoute({
      tags: ['run'],
      summary: 'Recent run-journal rows, newest first',
      parameters: [
        {
          name: 'limit',
          in: 'query',
          required: false,
          schema: { type: 'integer' },
        },
      ],
      responses: okJson('Run journal rows', RunListResponse),
    }),
    async (c) => {
      const raw = c.req.query('limit')
      const limit = raw !== undefined ? Number(raw) : 20
      const runs = await ops.listRuns(Number.isInteger(limit) && limit > 0 ? limit : 20)
      return c.json({ runs: runs.map(shapeRunRow) })
    },
  )

  // ---- browsers / config (settings UI, read-only) -------------------------

  app.get(
    '/api/browsers',
    describeRoute({
      tags: ['config'],
      summary:
        'Configured browser adapters with capabilities and health — the ' +
        'same dataset `linkinbox browsers` prints.',
      responses: okJson('Browser adapters', BrowserAdaptersBody),
    }),
    async (c) => {
      return c.json(await ops.browsers())
    },
  )

  app.get(
    '/api/config',
    describeRoute({
      tags: ['config'],
      summary:
        'Read-only config summary for the settings UI: sources, capture/' +
        'server token configuration (booleans only — never values), the ' +
        'config file path and the bind this server answers on.',
      responses: okJson('Config summary', ConfigInfoBody),
    }),
    (c) => {
      const info = ops.configInfo()
      return c.json({
        dir: info.dir,
        configPath: info.configPath,
        sources: info.sources,
        capture: info.capture,
        server: info.server,
        bind: {
          hostname: bindHost,
          port: opts.port ?? DEFAULT_PORT,
          tokenRequired: !loopback,
        },
      })
    },
  )

  // ---- events (SSE) ---------------------------------------------------------

  app.get(
    '/api/events',
    describeRoute({
      tags: ['events'],
      summary:
        'Server-sent events: link state transitions, run start/finish and ' +
        'ingest job progress. Every frame id is evt:{l,r,i} — the composite ' +
        'resume cursor for all three families; reconnect with Last-Event-ID ' +
        'or ?since= to replay without gaps.',
      parameters: [
        {
          name: 'since',
          in: 'query',
          required: false,
          schema: { type: 'string' },
        },
      ],
      responses: {
        200: {
          description: 'SSE stream (text/event-stream)',
          content: { 'text/event-stream': { schema: { type: 'string' } } },
        },
        ...errorResponses,
      },
    }),
    (c) => {
      const resume =
        c.req.header('last-event-id') ?? c.req.query('since') ?? undefined
      return createEventsResponse(
        { store, ...(opts.eventsPollMs !== undefined ? { pollMs: opts.eventsPollMs } : {}) },
        resume,
      )
    },
  )

  // ---- sweep / metrics ------------------------------------------------------

  app.get(
    '/api/sweep',
    describeRoute({
      tags: ['sweep'],
      summary: 'Dry-run sweep plan grouped by category',
      responses: okJson('Sweep plan', SweepResponse),
    }),
    async (c) => {
      const plan = await ops.sweepPlan(ttl)
      const groups: { category: string; links: Record<string, unknown>[] }[] = []
      for (const g of plan.groups) {
        const links: Record<string, unknown>[] = []
        for (const item of g.items) {
          const link = await ops.get(item.linkId, UI_SUMMARY_FIELDS)
          if (link) links.push(shapeForUi(link))
        }
        groups.push({ category: g.category, links })
      }
      return c.json({ groups })
    },
  )

  // Sweep applies the plan: archive only, never delete.
  app.post(
    '/api/sweep/apply',
    describeRoute({
      tags: ['sweep'],
      summary: 'Apply the sweep plan (archive only, never delete)',
      responses: okJson('Apply result', SweepApplyResponse),
    }),
    async (c) => {
      const plan = await ops.sweepPlan(ttl)
      const archived = await ops.applySweepPlan(plan)
      return c.json({ archived })
    },
  )

  app.get(
    '/api/metrics',
    describeRoute({
      tags: ['metrics'],
      summary: 'Per-stage metrics summary plus daily token/cost buckets',
      parameters: [
        {
          name: 'last',
          in: 'query',
          required: false,
          schema: { type: 'string', enum: ['24h', '7d', '2w', '30d'] },
        },
      ],
      responses: okJson('Metrics', MetricsResponse),
    }),
    async (c) => {
      const last = c.req.query('last') ?? '7d'
      try {
        parseRange(last)
      } catch (err) {
        return c.json({ error: errMsg(err) }, 400)
      }
      const summary = await ops.metrics(last)
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
    },
  )

  // ---- MCP (streamable HTTP) -------------------------------------------------
  //
  // Mounted only when the caller supplies the fetch-shaped handler (the
  // composition root builds it from @linkinbox/mcp's createMcpHttpHandler).
  // Auth above already covers /mcp on non-loopback binds.

  if (opts.mcpFetch) {
    const mcpFetch = opts.mcpFetch
    // Registered per-method (not app.all): hono-openapi only documents
    // concrete methods, so an ALL route would be invisible in the spec.
    // GET/POST/DELETE are the streamable-HTTP surface.
    const mcpSpec = describeRoute({
      tags: ['mcp'],
      summary:
        'MCP streamable-HTTP endpoint (JSON-RPC). GET/DELETE session ' +
        'operations are also accepted; see the MCP spec.',
      responses: {
        200: { description: 'JSON-RPC response (JSON or SSE)' },
        ...errorResponses,
      },
    })
    const mcpHandler = (c: Context) => mcpFetch(c.req.raw)
    app.on(['GET', 'POST', 'DELETE'], '/mcp', mcpSpec, mcpHandler)
  }

  // ---- OpenAPI document -----------------------------------------------------
  //
  // Served last so generateSpecs sees every registered route. On
  // non-loopback binds the bearer middleware above protects it too.
  // Every documented operation sits behind the same HTTP bearer scheme
  // (/capture uses its own token, still `Authorization: Bearer`); loopback
  // binds serve it openly, which the scheme description notes.
  app.get(
    '/openapi.json',
    openAPIRouteHandler(app, {
      documentation: {
        components: {
          securitySchemes: {
            bearerAuth: {
              type: 'http',
              scheme: 'bearer',
              description:
                'Bearer token. Required on non-loopback binds: the token ' +
                'comes from `[server] token_env` (default ' +
                'LINKINBOX_SERVER_TOKEN); /capture uses the capture token env.',
            },
          },
        },
      },
      // hono-openapi keys defaultOptions by uppercase method; every
      // documented route requires the bearer scheme on non-loopback binds.
      defaultOptions: {
        GET: { security: [{ bearerAuth: [] }] },
        POST: { security: [{ bearerAuth: [] }] },
        PATCH: { security: [{ bearerAuth: [] }] },
        PUT: { security: [{ bearerAuth: [] }] },
        DELETE: { security: [{ bearerAuth: [] }] },
        ALL: { security: [{ bearerAuth: [] }] },
      },
    }),
  )

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
    const p = c.req.path
    if (
      p.startsWith('/api/') ||
      p === '/capture' ||
      p === '/mcp' ||
      p === '/openapi.json' ||
      p.startsWith('/mcp/')
    ) {
      return next()
    }
    const file = await readStaticFile(dist, p)
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
