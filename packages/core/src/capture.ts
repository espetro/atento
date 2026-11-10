import { timingSafeEqual } from 'node:crypto'
import { z } from 'zod/mini'

/**
 * Client-side capture ingest contract.
 *
 * Any client that can POST JSON (a browser extension, a script, another
 * machine) sends content it already extracted in the user's own logged-in
 * session. The pipeline trusts that content more than anything it fetches
 * itself and skips the headless extract step for captured links. The contract
 * is deliberately open: nothing here knows what a client is, only what it
 * sends.
 *
 * Only page captures are supported today. The `contentType` field exists so
 * future content types (notes, highlights, ...) can be added without a
 * breaking change.
 */

export const CAPTURE_CONTENT_TYPES = ['page'] as const
export type CaptureContentType = (typeof CAPTURE_CONTENT_TYPES)[number]

/** How much raw body bytes a single capture may carry. Default 2 MiB. */
export const DEFAULT_CAPTURE_MAX_BODY_BYTES = 2 * 1024 * 1024

/**
 * Source trust ranking. A capture from the user's own session outranks a
 * headless browser run, which outranks an anonymous fetch. Higher wins.
 */
export const TRUST_CAPTURED = 3
export const TRUST_HEADLESS_PROFILE = 2
export const TRUST_ANONYMOUS = 1

/** The zod schema for one capture. Discriminated-union ready on `contentType`. */
export const captureSchema = z.object({
  url: z.string().check(z.minLength(1)),
  title: z.optional(z.string()),
  capturedAt: z.iso.datetime({ offset: true }),
  contentType: z.literal(CAPTURE_CONTENT_TYPES),
  body: z.string().check(z.minLength(1)),
  selection: z.optional(z.string()),
  meta: z.optional(z.record(z.string(), z.unknown())),
  /** Free-form client identity, e.g. "stash" or "stash@laptop". Stored as the link source. */
  source: z.string().check(z.minLength(1)),
})

export type Capture = z.infer<typeof captureSchema>
export type CaptureInput = z.input<typeof captureSchema>

export class CaptureValidationError extends Error {
  readonly code = 'CAPTURE_INVALID' as const
  constructor(
    readonly issues: string[],
    message?: string,
  ) {
    super(message ?? `invalid capture: ${issues.join('; ')}`)
    this.name = 'CaptureValidationError'
  }
}

/** Parse a capture payload, throwing a typed validation error. */
export function parseCapture(raw: unknown): Capture {
  const parsed = captureSchema.safeParse(raw)
  if (!parsed.success) {
    throw new CaptureValidationError(
      parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    )
  }
  return parsed.data
}

/**
 * Config for the capture endpoint, parsed from the `[capture]` TOML table.
 * The bearer token itself is never stored in the config file: `token_env`
 * names the environment variable that holds it, and the value is read from
 * that variable at request time. An unset variable disables the endpoint.
 */
export interface CaptureConfig {
  /** Env var that holds the bearer token. Default ATENTO_CAPTURE_TOKEN. */
  tokenEnv: string
  /** Origins allowed by CORS. Default: none (same-origin / non-browser clients only). */
  allowedOrigins: string[]
  /** Maximum accepted body size in bytes. */
  maxBodyBytes: number
}

export const DEFAULT_CAPTURE_CONFIG: CaptureConfig = {
  tokenEnv: 'ATENTO_CAPTURE_TOKEN',
  allowedOrigins: [],
  maxBodyBytes: DEFAULT_CAPTURE_MAX_BODY_BYTES,
}

function tomlTable(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

/**
 * Parse the `[capture]` table:
 *
 *   [capture]
 *   token_env = "ATENTO_CAPTURE_TOKEN"
 *   allowed_origins = ["chrome-extension://abcdef"]
 *   max_body_bytes = 2097152
 */
export function captureFromToml(toml: Record<string, unknown>): CaptureConfig {
  const out: CaptureConfig = {
    tokenEnv: DEFAULT_CAPTURE_CONFIG.tokenEnv,
    allowedOrigins: [...DEFAULT_CAPTURE_CONFIG.allowedOrigins],
    maxBodyBytes: DEFAULT_CAPTURE_CONFIG.maxBodyBytes,
  }
  const table = tomlTable(toml['capture'])
  const tokenEnv = table['token_env']
  if (typeof tokenEnv === 'string' && tokenEnv.trim() !== '') out.tokenEnv = tokenEnv
  const origins = table['allowed_origins']
  if (Array.isArray(origins)) {
    out.allowedOrigins = origins.filter((o): o is string => typeof o === 'string')
  }
  const max = table['max_body_bytes']
  if (typeof max === 'number' && Number.isFinite(max) && max > 0) out.maxBodyBytes = Math.floor(max)
  return out
}

/**
 * Constant-time string compare (always compares the full length so timing
 * does not leak the token). Returns true when equal.
 */
export function tokensEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  if (ab.length !== bb.length) {
    // Lengths differ: still burn a comparison against itself to keep the
    // timing shape identical, then fail.
    timingSafeEqual(ab, ab)
    return false
  }
  return timingSafeEqual(ab, bb)
}

/** Read the bearer token for the capture endpoint from the configured env var. */
export function captureToken(config: CaptureConfig, env: NodeJS.ProcessEnv): string | null {
  const value = env[config.tokenEnv]
  return value !== undefined && value.trim() !== '' ? value : null
}
