import type { Connect, Plugin } from 'vite'
import type { ServerResponse } from 'node:http'
import {
  addRunRow,
  browsers,
  collectionsSummary,
  configInfo,
  createMockState,
  getLink,
  ingestUrls,
  listLinks,
  listRuns,
  metrics,
  patchLink,
  pipelineOverview,
  runPipeline,
  triageLinks,
  type MockState,
} from './data'

/**
 * Vite dev/preview middleware implementing the fixed REST contract so the UI
 * can run standalone. Enabled with VITE_MOCK=1. In production the hono server
 * implements the same routes; this plugin is never bundled into dist/.
 */
export function mockApiPlugin(enabled: boolean): Plugin {
  if (!enabled) {
    return { name: 'linkinbox-mock-api', apply: 'serve' }
  }
  let state: MockState = createMockState(128)

  // ---- SSE -----------------------------------------------------------------
  const sseClients = new Set<ServerResponse>()
  function sseWrite(res: ServerResponse, event: string, data: unknown) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\nid: mock-${Date.now()}\n\n`)
  }
  function broadcast(event: string, data: unknown) {
    for (const res of sseClients) {
      try {
        sseWrite(res, event, data)
      } catch {
        sseClients.delete(res)
      }
    }
  }

  return {
    name: 'linkinbox-mock-api',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        void handle(req, res, next)
      })
    },
    configurePreviewServer(server) {
      server.middlewares.use((req, res, next) => {
        void handle(req, res, next)
      })
    },
  }

  async function handle(
    req: Connect.IncomingMessage,
    res: ServerResponse,
    next: () => void,
  ): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = url.pathname
    const send = (status: number, body: unknown) => {
      res.statusCode = status
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(body))
    }

    try {
      // SSE stream
      if (path === '/api/events' && req.method === 'GET') {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        })
        res.write(': connected\n\n')
        sseClients.add(res)
        req.on('close', () => sseClients.delete(res))
        // Heartbeat so proxies don't kill the stream.
        const hb = setInterval(() => {
          try {
            res.write(': hb\n\n')
          } catch {
            clearInterval(hb)
          }
        }, 15_000)
        req.on('close', () => clearInterval(hb))
        return
      }

      if (path === '/api/links' && req.method === 'GET') {
        return void send(200, listLinks(state, url.searchParams))
      }
      if (path === '/api/collections/summary' && req.method === 'GET') {
        return void send(200, collectionsSummary(state))
      }
      if (path === '/api/pipeline' && req.method === 'GET') {
        return void send(200, pipelineOverview(state))
      }

      const triage = path.match(/^\/api\/links\/triage$/)
      if (triage && req.method === 'POST') {
        const body = (await readBody(req)) as {
          ids: number[]
          action: 'read_now' | 'schedule' | 'archive' | 'discard'
        }
        const updated = triageLinks(state, body.ids ?? [], body.action)
        broadcast('link', { ids: body.ids, action: body.action })
        broadcast('run', addRunRow(state, 'triage', 'done'))
        return void send(200, { updated })
      }

      const reextract = path.match(/^\/api\/links\/(\d+)\/reextract$/)
      if (reextract && req.method === 'POST') {
        const id = Number(reextract[1])
        const link = getLink(state, id)
        if (!link) return void send(404, { error: 'not found' })
        return void send(200, { ok: true, reason: 'queued' })
      }

      const artifacts = path.match(/^\/api\/links\/(\d+)\/artifacts\/([^/]+)$/)
      if (artifacts && req.method === 'GET') {
        // Demo snapshot: a tiny placeholder PNG so the Snapshot/Live tabs
        // render an image instead of a 404 (the real server 404s honestly
        // until an artifact writer ships).
        const png = Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
          'base64',
        )
        res.statusCode = 200
        res.setHeader('content-type', 'image/png')
        res.end(png)
        return
      }

      const detail = path.match(/^\/api\/links\/(\d+)$/)
      if (detail && req.method === 'GET') {
        const link = getLink(state, Number(detail[1]))
        return void (link ? send(200, link) : send(404, { error: 'not found' }))
      }
      if (detail && req.method === 'PATCH') {
        const body = (await readBody(req)) as {
          title?: string | null
          note?: string | null
          tags?: string[] | null
        }
        const link = patchLink(state, Number(detail[1]), body)
        if (!link) return void send(404, { error: 'not found' })
        broadcast('link', { id: link.id })
        return void send(200, link)
      }

      if (path === '/api/ingest' && req.method === 'POST') {
        const contentType = String(req.headers['content-type'] ?? '')
        if (contentType.includes('multipart/form-data')) {
          // File uploads: drain the body, synthesize a job with no links.
          await drain(req)
          const now = new Date().toISOString()
          const jobId = `mock-upload-${Date.now().toString(36)}`
          const job = {
            jobId,
            source: 'upload',
            status: 'done' as const,
            total: 0,
            done: 0,
            cursor: 0,
            runId: null,
            error: null,
            createdAt: now,
            updatedAt: now,
            finishedAt: now,
          }
          state.ingestJobs.set(jobId, job)
          broadcast('ingest', job)
          return void send(200, {
            jobId,
            accepted: 0,
            duplicates: 0,
            rejected: 0,
            status: 'done',
            warnings: ['file import not simulated in demo mode'],
          })
        }
        const body = (await readBody(req)) as
          | { kind: 'urls'; urls: string[] }
          | { kind: 'text'; text: string }
          | { kind: 'remote'; url: string }
        let urls: string[] = []
        if (body.kind === 'urls') urls = body.urls ?? []
        else if (body.kind === 'text') {
          urls = (body.text ?? '')
            .split(/\s+/)
            .map((t) => t.replace(/[),.;\]]+$/, ''))
            .filter((t) => /^https?:\/\//.test(t))
        } else if (body.kind === 'remote') {
          urls = [body.url]
        }
        if (urls.length === 0) {
          return void send(400, { error: 'no urls found in input' })
        }
        if (urls.length > 500) {
          return void send(400, { error: 'too many urls (max 500)' })
        }
        const { job } = ingestUrls(state, urls, body.kind)
        broadcast('ingest', job)
        broadcast('link', { ingest: job.jobId })
        return void send(200, {
          jobId: job.jobId,
          accepted: job.total,
          duplicates: 0,
          rejected: 0,
          status: 'done',
          warnings: [],
        })
      }

      const ingestJob = path.match(/^\/api\/ingest\/([^/]+)$/)
      if (ingestJob && req.method === 'GET') {
        const job = state.ingestJobs.get(ingestJob[1]!)
        return void (job ? send(200, { job }) : send(404, { error: 'job not found' }))
      }

      if (path === '/api/run' && req.method === 'POST') {
        const result = runPipeline(state)
        broadcast('run', addRunRow(state, 'pipeline', 'done'))
        broadcast('link', { run: result.runId })
        return void send(200, result)
      }

      if (path === '/api/runs' && req.method === 'GET') {
        const limit = Number(url.searchParams.get('limit') ?? 20)
        return void send(200, { runs: listRuns(state, limit) })
      }
      const runRow = path.match(/^\/api\/runs\/(\d+)$/)
      if (runRow && req.method === 'GET') {
        const row = state.runRows.find((r) => r.id === Number(runRow[1]))
        return void (row ? send(200, row) : send(404, { error: 'not found' }))
      }

      if (path === '/api/browsers' && req.method === 'GET') {
        return void send(200, browsers())
      }
      if (path === '/api/config' && req.method === 'GET') {
        return void send(200, configInfo())
      }
      if (path === '/api/pair/code' && req.method === 'GET') {
        return void send(200, {
          code: `DEMO-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
          expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
        })
      }
      if (path === '/api/metrics' && req.method === 'GET') {
        return void send(200, metrics())
      }
      // Collection-scoped read used by saved filters / debugging.
      const collectionRead = path.match(/^\/api\/collections\/([a-z_]+)$/)
      if (collectionRead && req.method === 'GET') {
        const name = collectionRead[1]!
        const filtered = listLinks(
          state,
          new URLSearchParams({ ...Object.fromEntries(url.searchParams), collection: name }),
        )
        return void send(200, filtered)
      }
    } catch (err) {
      return void send(500, { error: String(err) })
    }
    next()
  }
}

function readBody(req: Connect.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (c) => (data += c))
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {})
      } catch (e) {
        reject(e)
      }
    })
    req.on('error', reject)
  })
}

function drain(req: Connect.IncomingMessage): Promise<void> {
  return new Promise((resolve) => {
    req.on('data', () => {})
    req.on('end', resolve)
    req.on('error', resolve)
  })
}
