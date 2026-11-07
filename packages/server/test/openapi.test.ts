import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openStore, type SqliteStore } from '@linkinbox/db'
import { createApp } from '../src/index.js'

let store: SqliteStore
let dir: string

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'linkinbox-openapi-'))
  store = await openStore({ path: join(dir, 'test.db') })
})

afterAll(async () => {
  await store.close()
  rmSync(dir, { recursive: true, force: true })
})

const EXPECTED_PATHS = [
  '/capture',
  '/api/ingest',
  '/api/ingest/{jobId}',
  '/api/collections/summary',
  '/api/collections/{name}',
  '/api/collections/export',
  '/api/links',
  '/api/pipeline',
  '/api/links/triage',
  '/api/links/{id}',
  '/api/links/{id}/reextract',
  '/api/links/{id}/artifacts/{name}',
  '/api/run',
  '/api/runs/{id}',
  '/api/events',
  '/api/sweep',
  '/api/sweep/apply',
  '/api/metrics',
]

describe('GET /openapi.json', () => {
  it('serves a valid OpenAPI 3.x document', async () => {
    const res = await createApp(store).request('/openapi.json')
    expect(res.status).toBe(200)
    const spec = (await res.json()) as {
      openapi: string
      info: { title?: string }
      paths: Record<string, Record<string, unknown>>
    }
    expect(spec.openapi).toMatch(/^3\./)
    expect(spec.info.title).toBeTruthy()
    expect(Object.keys(spec.paths).length).toBeGreaterThan(0)
  })

  it('documents every api route', async () => {
    const res = await createApp(store).request('/openapi.json')
    const spec = (await res.json()) as { paths: Record<string, unknown> }
    for (const path of EXPECTED_PATHS) {
      expect(spec.paths, `missing ${path}`).toHaveProperty(path)
    }
  })

  it('documents the expected methods per route', async () => {
    const res = await createApp(store).request('/openapi.json')
    const spec = (await res.json()) as {
      paths: Record<string, Record<string, { responses?: object }>>
    }
    expect(Object.keys(spec.paths['/api/links'] ?? {})).toContain('get')
    expect(Object.keys(spec.paths['/api/links/{id}'] ?? {})).toEqual(
      expect.arrayContaining(['get', 'patch']),
    )
    expect(Object.keys(spec.paths['/api/run'] ?? {})).toContain('post')
    expect(Object.keys(spec.paths['/api/events'] ?? {})).toContain('get')
    for (const path of EXPECTED_PATHS) {
      for (const method of Object.keys(spec.paths[path] ?? {})) {
        expect(spec.paths[path]![method]!.responses).toBeTruthy()
      }
    }
  })

  it('converts zod/mini schemas to JSON Schema in responses', async () => {
    const res = await createApp(store).request('/openapi.json')
    const spec = (await res.json()) as {
      paths: Record<string, any>
    }
    const schema =
      spec.paths['/api/links/{id}'].get.responses['200'].content['application/json']
        .schema
    expect(schema.type).toBe('object')
    expect(schema.properties.id.type).toBe('number')
  })

  it('declares the bearer security scheme on protected operations', async () => {
    const res = await createApp(store).request('/openapi.json')
    const spec = (await res.json()) as {
      components: { securitySchemes?: Record<string, { type?: string; scheme?: string }> }
      paths: Record<string, Record<string, { security?: unknown[] }>>
    }
    expect(spec.components.securitySchemes?.['bearerAuth']).toMatchObject({
      type: 'http',
      scheme: 'bearer',
    })
    for (const [path, methods] of Object.entries(spec.paths)) {
      for (const [method, op] of Object.entries(methods)) {
        expect(op.security, `${method.toUpperCase()} ${path}`).toEqual([{ bearerAuth: [] }])
      }
    }
  })

  it('documents /mcp when the MCP handler is mounted', async () => {
    const app = createApp(store, { mcpFetch: async () => new Response('ok') })
    const res = await app.request('/openapi.json')
    const spec = (await res.json()) as {
      paths: Record<string, Record<string, { security?: unknown[] }>>
    }
    const mcp = spec.paths['/mcp']
    expect(mcp).toBeTruthy()
    expect(Object.keys(mcp!)).toEqual(expect.arrayContaining(['get', 'post', 'delete']))
    expect(mcp!['post']!.security).toEqual([{ bearerAuth: [] }])
  })
})
