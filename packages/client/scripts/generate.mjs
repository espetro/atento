// Regenerates src/schema.d.ts from the server's OpenAPI document.
//
//   pnpm --filter @linkinbox/client generate
//
// Requires @linkinbox/server and @linkinbox/db to be built (their dist/
// output is what this script imports). The document is produced by the
// real Hono app — the same one that serves GET /openapi.json — against a
// throwaway sqlite store, so generation needs no running server.
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import openapiTS, { astToString } from 'openapi-typescript'

const here = dirname(fileURLToPath(import.meta.url))
const outFile = join(here, '..', 'src', 'schema.d.ts')

const { createApp } = await import('@linkinbox/server')
const { openStore } = await import('@linkinbox/db')

const dir = mkdtempSync(join(tmpdir(), 'linkinbox-openapi-'))
const store = await openStore({ path: join(dir, 'gen.db') })

let doc
try {
  const app = createApp(store, { env: {} })
  const res = await app.request('/openapi.json')
  if (!res.ok) throw new Error(`GET /openapi.json → HTTP ${res.status}`)
  doc = await res.json()
} finally {
  await store.close()
}

const specPath = join(dir, 'openapi.json')
writeFileSync(specPath, JSON.stringify(doc, null, 2))
const ast = await openapiTS(pathToFileURL(specPath).href)
writeFileSync(outFile, astToString(ast))
console.log(`wrote ${outFile} (${doc.paths ? Object.keys(doc.paths).length : 0} paths)`)
