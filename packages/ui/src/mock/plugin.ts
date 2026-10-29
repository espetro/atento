import type { Connect, Plugin } from 'vite'
import type { ServerResponse } from 'node:http'
import { createMockState, listLinks, metrics, sweep, type MockState } from './data'

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
  const json = (data: unknown, status = 200): Response =>
    new Response(JSON.stringify(data), {
      status,
      headers: { 'content-type': 'application/json' },
    })

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
      if (path === '/api/links' && req.method === 'GET') {
        return void send(200, listLinks(state, url.searchParams))
      }
      const triage = path.match(/^\/api\/links\/triage$/)
      if (triage && req.method === 'POST') {
        const body = (await readBody(req)) as { ids: number[]; action: string }
        let updated = 0
        const statusMap: Record<string, string> = {
          read_now: 'inbox',
          schedule: 'scheduled',
          archive: 'archived',
          discard: 'discarded',
        }
        const next = statusMap[body.action]
        if (next) {
          for (const l of state.links) {
            if (body.ids.includes(l.id) && l.status !== next) {
              l.status = next as MockState['links'][number]['status']
              updated++
            }
          }
        }
        return void send(200, { updated })
      }
      const detail = path.match(/^\/api\/links\/(\d+)$/)
      if (detail && req.method === 'GET') {
        const link = state.links.find((l) => l.id === Number(detail[1]))
        return void (link ? send(200, link) : send(404, { error: 'not found' }))
      }
      if (path === '/api/sweep' && req.method === 'GET') {
        return void send(200, sweep(state))
      }
      if (path === '/api/sweep/apply' && req.method === 'POST') {
        let archived = 0
        const now = Date.now()
        for (const l of state.links) {
          if (l.expires_at && new Date(l.expires_at).getTime() < now && l.status !== 'archived') {
            l.status = 'archived'
            archived++
          }
        }
        return void send(200, { archived })
      }
      if (path === '/api/metrics' && req.method === 'GET') {
        return void send(200, metrics())
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
