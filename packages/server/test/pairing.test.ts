import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openStore, type SqliteStore } from '@atento/db'
import { DEFAULT_CAPTURE_CONFIG, DEFAULT_SERVER_CONFIG } from '@atento/core'
import { createApp } from '../src/index.js'

let store: SqliteStore
let dir: string

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'atento-pair-'))
  store = await openStore({ path: join(dir, 'test.db') })
})

afterAll(async () => {
  await store.close()
  rmSync(dir, { recursive: true, force: true })
})

const ENV = {
  ATENTO_CAPTURE_TOKEN: 'capture-secret',
  ATENTO_SERVER_TOKEN: 'server-secret',
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

  it('evicts the oldest code past the outstanding cap (default 10)', async () => {
    const capped = app()
    const codes: string[] = []
    for (let i = 0; i < 11; i++) codes.push(await issueCode(capped))
    const redeem = (code: string) =>
      capped.request('/api/pair', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code }),
      })
    // The first-issued code was evicted by the eleventh.
    expect((await redeem(codes[0] as string)).status).toBe(401)
    // The newest still redeems.
    expect((await redeem(codes[10] as string)).status).toBe(200)
  })

  it('throttles redeem attempts (default 30/min, counting failures too)', async () => {
    const throttled = app()
    const redeem = () =>
      throttled.request('/api/pair', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: 'ZZZZZZZZ' }),
      })
    for (let i = 0; i < 30; i++) {
      expect((await redeem()).status).toBe(401)
    }
    // The 31st attempt inside the window is throttled: still 401, but a
    // VALID code would also be refused — prove it with a real code.
    const code = await issueCode(throttled)
    const res = await throttled.request('/api/pair', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    })
    expect(res.status).toBe(401)
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
