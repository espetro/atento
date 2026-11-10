/**
 * Pairing: a short-lived one-time code that exchanges for the bearer
 * tokens a capture client needs.
 *
 * The flow (the web UI half is a later milestone; this is the server
 * contract):
 *
 *   1. GET /api/pair/code   -> { code, expiresAt }
 *      Authenticated like every /api/* route on non-loopback binds, open
 *      on loopback. The UI displays the code.
 *   2. POST /api/pair { code } -> { captureToken, serverToken }
 *      Deliberately NOT bearer-gated: the client has no token yet — the
 *      code is the credential. Single-use, expires after `codeTtlMs`,
 *      and only redeemable while the issuing server process lives (the
 *      code table is in memory on purpose: a restart just means pairing
 *      again).
 *
 * The response carries the token the client should send to POST /capture
 * (`captureToken`, from `[capture] token_env`) and the token for /api/*
 * (`serverToken`, from `[server] token_env`). Either is null when the
 * corresponding env var is unset; the extension stores what it gets.
 *
 * Security note: on a loopback bind GET /api/pair/code is unauthenticated
 * (the web UI calls it same-origin) and POST /api/pair is never
 * bearer-gated, so ANY local process can mint a code and redeem the bearer
 * tokens. That is a deliberate tradeoff — pairing exists so a local client
 * does not need the tokens typed by hand, and loopback already implies
 * local trust — but it is bounded, not free: codes are 39-bit, single-use,
 * expire in 5 minutes, at most `maxOutstandingCodes` may be live at once,
 * and redeems are rate-limited per window. A non-loopback bind keeps
 * /api/pair/code behind the server bearer token, so remote clients cannot
 * mint codes at all.
 */
import { randomInt } from 'node:crypto'
import type { CaptureConfig } from '@atento/core'
import { captureToken, type ServerConfig, serverToken } from '@atento/core'

/** Default pairing-code lifetime. */
export const DEFAULT_PAIR_CODE_TTL_MS = 5 * 60 * 1000
/** Default cap on simultaneously-live codes. */
export const DEFAULT_MAX_OUTSTANDING_CODES = 10
/** Default redeem throttle: this many redemptions per window. */
export const DEFAULT_MAX_REDEEMS_PER_WINDOW = 30
/** Default redeem throttle window. */
export const DEFAULT_REDEEM_WINDOW_MS = 60 * 1000

/** Unambiguous alphabet: no 0/O, 1/I/L. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
/** 8 chars from a 31-char alphabet: ~39 bits, unguessable in 5 minutes. */
const CODE_LENGTH = 8

export interface PairingService {
  /** Issue a fresh one-time code. Returns the code and its expiry. */
  issue(): { code: string; expiresAt: string }
  /**
   * Redeem a code exactly once. Returns the tokens to store, or null when
   * the code is unknown, expired or already used.
   */
  redeem(code: string): { captureToken: string | null; serverToken: string | null } | null
}

export interface PairingOptions {
  capture: CaptureConfig
  server: ServerConfig
  env: NodeJS.ProcessEnv
  /** Code lifetime in ms. Default 5 minutes. */
  codeTtlMs?: number
  /** Max simultaneously-live codes; oldest evicted past it. Default 10. */
  maxOutstandingCodes?: number
  /** Redeem throttle: max redemptions per redeemWindowMs. Default 30/min. */
  maxRedeemsPerWindow?: number
  /** Redeem throttle window in ms. Default 60000. */
  redeemWindowMs?: number
  /** Injectable clock for tests. */
  now?: () => number
  /** Injectable randomness for tests (0..1). */
  random?: () => number
}

export function createPairingService(options: PairingOptions): PairingService {
  const now = options.now ?? Date.now
  const random = options.random ?? Math.random
  const ttl = options.codeTtlMs ?? DEFAULT_PAIR_CODE_TTL_MS
  const maxCodes = options.maxOutstandingCodes ?? DEFAULT_MAX_OUTSTANDING_CODES
  const maxRedeems = options.maxRedeemsPerWindow ?? DEFAULT_MAX_REDEEMS_PER_WINDOW
  const redeemWindow = options.redeemWindowMs ?? DEFAULT_REDEEM_WINDOW_MS
  /** code -> expiry ms. Entries are deleted on redeem or when expired. */
  const codes = new Map<string, number>()
  /** Timestamps of recent redeem attempts, for the throttle window. */
  const redeemLog: number[] = []

  function sweep(): void {
    const t = now()
    for (const [code, expiresAt] of codes) {
      if (expiresAt <= t) codes.delete(code)
    }
  }

  /** True when the redeem throttle allows another attempt. */
  function redeemAllowed(): boolean {
    const t = now()
    while (redeemLog.length > 0 && (redeemLog[0] ?? 0) <= t - redeemWindow) {
      redeemLog.shift()
    }
    return redeemLog.length < maxRedeems
  }

  return {
    issue() {
      sweep()
      // Bound outstanding codes: evict the oldest live ones first.
      while (codes.size >= maxCodes) {
        const oldest = codes.keys().next()
        if (oldest.done) break
        codes.delete(oldest.value)
      }
      // Regenerate on collision, but bounded: a deterministic injected
      // random (tests) must not loop forever — a clobbered live code is
      // still single-use and expires in minutes.
      let code = ''
      for (let attempt = 0; attempt < 10; attempt++) {
        code = ''
        for (let i = 0; i < CODE_LENGTH; i++) {
          // randomInt is the production path; `random` exists for tests.
          const idx =
            options.random !== undefined
              ? Math.floor(random() * CODE_ALPHABET.length)
              : randomInt(0, CODE_ALPHABET.length)
          code += CODE_ALPHABET[idx]
        }
        if (!codes.has(code)) break
      }
      const expiresAtMs = now() + ttl
      codes.set(code, expiresAtMs)
      return { code, expiresAt: new Date(expiresAtMs).toISOString() }
    },

    redeem(rawCode) {
      const code = rawCode.trim().toUpperCase()
      if (code === '') return null
      sweep()
      // Throttle EVERY redeem attempt (valid or not): guessing codes is
      // the attack this bound exists for.
      if (!redeemAllowed()) return null
      redeemLog.push(now())
      const expiresAt = codes.get(code)
      if (expiresAt === undefined) return null
      // Single-use: consume before answering so a replay finds nothing.
      codes.delete(code)
      return {
        captureToken: captureToken(options.capture, options.env),
        serverToken: serverToken(options.server, options.env),
      }
    },
  }
}
