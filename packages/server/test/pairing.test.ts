import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openStore, type SqliteStore } from '@linkinbox/db'
import { DEFAULT_CAPTURE_CONFIG, DEFAULT_SERVER_CONFIG } from '@linkinbox/core'
import { createApp } from '../src/index.js'

let store: SqliteStore
let dir: string

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'linkinbox-pair-'))
  store = await openStore({ path: join(dir, 'test.db') })
})

afterAll(async () => {
  await store.close()
  rmSync(dir, { recursive: true, force: true })
})

const ENV = {
  LINKINBOX_CAPTURE_TOKEN: 'capture-secret',
  LINKINBOX_SERVER_TOKEN: 'server-secret',
}

// One app instance per describe block: pairing codes live in memory, so a
// code issued by one createApp() is unknown to another.
function app(env: NodeJS.ProcessEnv = ENV) {
  return createApp(store, {
    capture: DEFAULT_CAPTURE_CONFIG,
    server: DEFAULT_SERVER_CONFIG,
    env,
  })
}

async function issueCode(a: ReturnType<typeof app>): Promise<string> {
  const res = await a.request('/api/pair/code')
  expect(res.status).toBe(200)
  const body = (await res.json()) as { code: string; expiresAt: string }
  expect(body.code).toMatch(/^[A-Z2-9]{8}$/)
  expect(Date.parse(body.expiresAt)).toBeGreaterThan(Date.now())
  return body.code
}

describe('pairing: loopback', () => {
  const a = app()
  it('redeems a code for the capture and server tokens', async () => {
    const code = await issueCode(a)
    const res = await a.request('/api/pair', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      captureToken: 'capture-secret',
      serverToken: 'server-secret',
    })
  })

  it('rejects a second redemption of the same code (single-use)', async () => {
    const code = await issueCode(a)
    const redeem = () =>
      a.request('/api/pair', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code }),
      })
    expect((await redeem()).status).toBe(200)
    expect((await redeem()).status).toBe(401)
  })

  it('401s an unknown code and 400s a malformed body', async () => {
    const bad = await a.request('/api/pair', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'ZZZZZZZZ' }),
    })
    expect(bad.status).toBe(401)
    const malformed = await a.request('/api/pair', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nope: 1 }),
    })
    expect(malformed.status).toBe(400)
  })

  it('returns null tokens when the env vars are unset', async () => {
    const empty = app({})
    const code = await issueCode(empty)
    const res = await empty.request('/api/pair', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ captureToken: null, serverToken: null })
  })
})

describe('pairing: non-loopback bind', () => {
  function remoteApp() {
    return createApp(store, {
      hostname: '0.0.0.0',
      capture: DEFAULT_CAPTURE_CONFIG,
      server: DEFAULT_SERVER_CONFIG,
      env: ENV,
    })
  }

  it('gates GET /api/pair/code behind the bearer token', async () => {
    expect((await remoteApp().request('/api/pair/code')).status).toBe(401)
    const res = await remoteApp().request('/api/pair/code', {
      headers: { authorization: 'Bearer server-secret' },
    })
    expect(res.status).toBe(200)
  })

  it('lets POST /api/pair redeem without a bearer token', async () => {
    const ra = remoteApp()
    const issued = await ra.request('/api/pair/code', {
      headers: { authorization: 'Bearer server-secret' },
    })
    const { code } = (await issued.json()) as { code: string }
    const res = await ra.request('/api/pair', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      captureToken: 'capture-secret',
      serverToken: 'server-secret',
    })
  })
})
