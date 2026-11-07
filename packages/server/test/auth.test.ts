import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openStore, type SqliteStore } from '@linkinbox/db'
import { DEFAULT_SERVER_CONFIG } from '@linkinbox/core'
import { createApp } from '../src/index.js'

let store: SqliteStore
let dir: string

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'linkinbox-auth-'))
  store = await openStore({ path: join(dir, 'test.db') })
})

afterAll(async () => {
  await store.close()
  rmSync(dir, { recursive: true, force: true })
})

const TOKEN_ENV = { LINKINBOX_SERVER_TOKEN: 'sekret-token' }

function nonLoopbackApp(env: NodeJS.ProcessEnv = TOKEN_ENV) {
  return createApp(store, {
    hostname: '0.0.0.0',
    env,
    server: DEFAULT_SERVER_CONFIG,
    // A stub MCP fetch proves /mcp is mounted and auth-gated.
    mcpFetch: async () => new Response('mcp-ok'),
  })
}

describe('auth: non-loopback bind', () => {
  it('401s /api/* without a token', async () => {
    const res = await nonLoopbackApp().request('/api/links')
    expect(res.status).toBe(401)
  })

  it('401s /api/* with a wrong token', async () => {
    const res = await nonLoopbackApp().request('/api/links', {
      headers: { authorization: 'Bearer wrong' },
    })
    expect(res.status).toBe(401)
  })

  it('200s /api/* with the bearer token', async () => {
    const res = await nonLoopbackApp().request('/api/links', {
      headers: { authorization: 'Bearer sekret-token' },
    })
    expect(res.status).toBe(200)
  })

  it('401s /api/events without a token (before streaming)', async () => {
    const res = await nonLoopbackApp().request('/api/events')
    expect(res.status).toBe(401)
  })

  it('401s /openapi.json without a token, 200s with it', async () => {
    const app = nonLoopbackApp()
    expect((await app.request('/openapi.json')).status).toBe(401)
    const res = await app.request('/openapi.json', {
      headers: { authorization: 'Bearer sekret-token' },
    })
    expect(res.status).toBe(200)
  })

  it('401s /mcp without a token, reaches the handler with it', async () => {
    const app = nonLoopbackApp()
    expect((await app.request('/mcp', { method: 'POST' })).status).toBe(401)
    const res = await app.request('/mcp', {
      method: 'POST',
      headers: { authorization: 'Bearer sekret-token' },
    })
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('mcp-ok')
  })

  it('fails closed when the token env var is unset', async () => {
    const app = nonLoopbackApp({})
    const res = await app.request('/api/links', {
      headers: { authorization: 'Bearer anything' },
    })
    expect(res.status).toBe(401)
  })

  it('honours a custom [server] token_env name', async () => {
    const app = createApp(store, {
      hostname: '0.0.0.0',
      env: { MY_LINKINBOX_TOKEN: 'custom' },
      server: { tokenEnv: 'MY_LINKINBOX_TOKEN' },
    })
    expect((await app.request('/api/links')).status).toBe(401)
    const res = await app.request('/api/links', {
      headers: { authorization: 'Bearer custom' },
    })
    expect(res.status).toBe(200)
  })

  it('does not gate unrelated paths', async () => {
    const res = await nonLoopbackApp().request('/definitely-not-a-route')
    expect(res.status).toBe(404)
  })
})

describe('auth: loopback bind', () => {
  it('needs no token on the default loopback bind', async () => {
    const res = await createApp(store, { env: {} }).request('/api/links')
    expect(res.status).toBe(200)
  })

  it('treats ::1 and localhost as loopback too', async () => {
    for (const hostname of ['::1', 'localhost']) {
      const res = await createApp(store, { hostname, env: {} }).request('/api/links')
      expect(res.status).toBe(200)
    }
  })
})
