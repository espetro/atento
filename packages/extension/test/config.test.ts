import { describe, expect, it } from 'vitest'
import {
  authHeadersFor,
  endpointFor,
  normalizeServerUrl,
  pairUrl,
  readSettings,
  type ServerSettings,
} from '../src/config.js'

const settings = (overrides: Partial<ServerSettings> = {}): ServerSettings => ({
  serverUrl: 'http://127.0.0.1:4173',
  token: 'capture-tok',
  apiToken: 'api-tok',
  source: 'extension',
  ...overrides,
})

describe('normalizeServerUrl', () => {
  it('strips trailing slashes and defaults empty to loopback', () => {
    expect(normalizeServerUrl('http://x:1///')).toBe('http://x:1')
    expect(normalizeServerUrl('   ')).toBe('http://127.0.0.1:4173')
  })
})

describe('endpointFor', () => {
  it('derives capture and ingest endpoints from the base URL', () => {
    const s = settings({ serverUrl: 'https://box.tail.ts.net:8443' })
    expect(endpointFor(s, 'capture')).toBe('https://box.tail.ts.net:8443/capture')
    expect(endpointFor(s, 'ingest')).toBe('https://box.tail.ts.net:8443/api/ingest')
    expect(pairUrl(s)).toBe('https://box.tail.ts.net:8443/api/pair')
  })
})

describe('authHeadersFor', () => {
  it('sends the capture token to /capture and the api token to /api/*', () => {
    const s = settings()
    expect(authHeadersFor(s, 'capture')).toEqual({ authorization: 'Bearer capture-tok' })
    expect(authHeadersFor(s, 'ingest')).toEqual({ authorization: 'Bearer api-tok' })
  })

  it('omits the api header when no api token is stored', () => {
    const s = settings({ apiToken: '' })
    expect(authHeadersFor(s, 'ingest')).toEqual({})
  })

  it('omits the capture header when no token is stored', () => {
    const s = settings({ token: '' })
    expect(authHeadersFor(s, 'capture')).toEqual({})
  })
})

describe('readSettings', () => {
  function storageOf(values: Record<string, unknown>) {
    return { get: async (keys: string[]) => Object.fromEntries(keys.map((k) => [k, values[k]])) }
  }

  it('reads the current field names', async () => {
    const s = await readSettings(
      storageOf({ serverUrl: 'https://h/', token: 't', apiToken: 'a', source: 'ext@x' }),
    )
    expect(s).toEqual({
      serverUrl: 'https://h',
      token: 't',
      apiToken: 'a',
      source: 'ext@x',
    })
  })

  it('migrates the legacy endpoint field (full /capture URL)', async () => {
    const s = await readSettings(storageOf({ endpoint: 'http://127.0.0.1:9999/capture' }))
    expect(s.serverUrl).toBe('http://127.0.0.1:9999')
    expect(s.token).toBe('')
  })

  it('migrates a legacy endpoint that already is a bare base', async () => {
    const s = await readSettings(storageOf({ endpoint: 'http://127.0.0.1:9999' }))
    expect(s.serverUrl).toBe('http://127.0.0.1:9999')
  })

  it('defaults everything when storage is empty', async () => {
    const s = await readSettings(storageOf({}))
    expect(s.serverUrl).toBe('http://127.0.0.1:4173')
    expect(s.source).toBe('extension')
  })
})
