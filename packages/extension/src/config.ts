/**
 * Extension settings: where the server is and which tokens to send.
 *
 * Stored in chrome.storage.local (a bearer token is a secret: never
 * chrome.storage.sync, never logged). The server URL is a BASE url
 * ("http://127.0.0.1:4173"); the per-kind endpoints are derived from it so
 * pairing can repoint everything at once.
 *
 * Two tokens exist because the server has two: `token` is the capture
 * bearer for POST /capture (`[capture] token_env`), `apiToken` is the
 * /api/* bearer (`[server] token_env`). On a loopback bind the api token
 * is not required; pairing fills in whatever the server has configured.
 */
import type { OutboxKind } from './queue.js'

export interface ServerSettings {
  /** Base server URL, no trailing slash, no path. */
  serverUrl: string
  /** Bearer token for POST /capture. */
  token: string
  /** Bearer token for /api/* (bulk ingest, pairing). May be empty. */
  apiToken: string
  /** Client identity stored as the link's source. */
  source: string
}

export const DEFAULT_SERVER_URL = 'http://127.0.0.1:4173'
export const DEFAULT_SOURCE = 'extension'

/** The slice of chrome.storage.local the settings need. */
export interface SettingsStorage {
  get(keys: string[]): Promise<Record<string, unknown>>
}

const STORAGE_KEYS = ['serverUrl', 'endpoint', 'token', 'apiToken', 'source'] as const

/** Strip trailing slashes and whitespace; '' becomes the default. */
export function normalizeServerUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '')
  return trimmed === '' ? DEFAULT_SERVER_URL : trimmed
}

/**
 * The endpoint for one outbox kind. `capture` is the single-page POST;
 * `ingest` is the bulk /api/ingest JSON endpoint.
 */
export function endpointFor(settings: ServerSettings, kind: OutboxKind): string {
  const base = normalizeServerUrl(settings.serverUrl)
  return kind === 'capture' ? `${base}/capture` : `${base}/api/ingest`
}

/** The pairing endpoints derived from the same base URL. */
export function pairCodeUrl(settings: ServerSettings): string {
  return `${normalizeServerUrl(settings.serverUrl)}/api/pair/code`
}

export function pairUrl(settings: ServerSettings): string {
  return `${normalizeServerUrl(settings.serverUrl)}/api/pair`
}

/**
 * Auth headers for one kind. The capture token goes to /capture; the api
 * token goes to /api/*. When no api token is stored the header is omitted
 * entirely — on a loopback bind /api/* needs no auth, and sending the
 * capture token there would only earn a 401 on a non-loopback bind.
 */
export function authHeadersFor(settings: ServerSettings, kind: OutboxKind): Record<string, string> {
  if (kind === 'capture') {
    return settings.token === '' ? {} : { authorization: `Bearer ${settings.token}` }
  }
  return settings.apiToken === '' ? {} : { authorization: `Bearer ${settings.apiToken}` }
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

/**
 * Read settings from storage. The pre-M5 `endpoint` field held the full
 * /capture URL; it migrates to `serverUrl` by stripping a trailing
 * /capture (or /api/ingest) path when present.
 */
export async function readSettings(storage: SettingsStorage): Promise<ServerSettings> {
  const stored = await storage.get([...STORAGE_KEYS])
  let serverUrl = str(stored['serverUrl'])
  if (serverUrl === undefined) {
    const legacy = str(stored['endpoint'])
    if (legacy !== undefined) {
      serverUrl = legacy.replace(/\/(capture|api\/ingest)\/?$/, '')
    }
  }
  return {
    serverUrl: normalizeServerUrl(serverUrl ?? DEFAULT_SERVER_URL),
    token: str(stored['token']) ?? '',
    apiToken: str(stored['apiToken']) ?? '',
    source: str(stored['source']) ?? DEFAULT_SOURCE,
  }
}
