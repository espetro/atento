import createClient, { type Client } from 'openapi-fetch'
import type { paths } from './schema.js'

export type { paths, components, operations } from './schema.js'

export interface LinkinboxClientOptions {
  /** Server base URL, e.g. `http://127.0.0.1:4173`. */
  baseUrl: string
  /** Bearer token for non-loopback binds (`[server] token_env`). */
  token?: string
  /** Custom fetch implementation (tests, proxies). */
  fetch?: typeof globalThis.fetch
}

/**
 * Typed client for the linkinbox HTTP API. `schema.d.ts` is generated from
 * `GET /openapi.json` — regenerate with `pnpm --filter @linkinbox/client
 * generate` after changing server routes.
 */
export function createLinkinboxClient(opts: LinkinboxClientOptions): Client<paths> {
  return createClient<paths>({
    baseUrl: opts.baseUrl,
    fetch: opts.fetch,
    headers: opts.token !== undefined ? { authorization: `Bearer ${opts.token}` } : undefined,
  })
}
