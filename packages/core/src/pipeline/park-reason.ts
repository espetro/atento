/**
 * Park reasons: why a link was parked.
 *
 * Every link the pipeline could not read ends up parked (in `needs_browser`,
 * or in `deferred` while the host is blocked) and every parked link carries a
 * reason class, so the owner can tell a login wall from a bot block from a
 * JS shell from a dead page. The class is decided in the extract stage from
 * the extractor outcome, never guessed later.
 *
 * The classes:
 *
 * | Reason | Meaning |
 * |---|---|
 * | `login_wall` | The host wants a session: a login page, a password form, a private 404/410, a 401/403 without a profile. |
 * | `bot_block` | The host refused the client: a captcha, a Cloudflare-style challenge, a 403/429/999 refusal. |
 * | `js_shell` | The page loaded but carried no readable content: the body is rendered by JavaScript. |
 * | `http_error` | The host answered with an error status (4xx or 5xx) that is none of the above. |
 * | `timeout` | The request never came back in time (408, 504, a network timeout). |
 * | `review_only` | The host is on the review list, or its login is not allowed: the owner reads it by hand. |
 * | `unknown` | A legacy row parked before reasons existed. It parses as unknown and is reclassified when the link is re-extracted. |
 */

/** The reason classes a parked link can carry, in stable order. */
export const PARK_REASONS = [
  'login_wall',
  'bot_block',
  'js_shell',
  'http_error',
  'timeout',
  'review_only',
  'skipped',
  'unknown',
] as const

export type ParkReason = (typeof PARK_REASONS)[number]

/** The known classes: every park reason but `unknown`. */
export const KNOWN_PARK_REASONS = PARK_REASONS.filter(
  (r): r is Exclude<ParkReason, 'unknown'> => r !== 'unknown',
)

/** True when the value is one of the known reason classes. */
export function isKnownParkReason(value: unknown): value is Exclude<ParkReason, 'unknown'> {
  return typeof value === 'string' && (KNOWN_PARK_REASONS as readonly string[]).includes(value)
}

/** A histogram with every park reason at zero. */
export function emptyParkReasonCounts(): Record<ParkReason, number> {
  const out = {} as Record<ParkReason, number>
  for (const reason of PARK_REASONS) out[reason] = 0
  return out
}

/**
 * The prefixes the guard puts on a deferral reason before the class name.
 * `blocked:` marks a hard block, `canary_flagged:` a host the canary probe
 * could not read; what follows names the signal.
 */
const REASON_PREFIXES = ['blocked:', 'canary_flagged:'] as const

/** Reasons the extractors and the pipeline use that all mean "log in first". */
const LOGIN_WALL_WORDS = new Set([
  'login_wall',
  'private_404',
  'private_410',
  'login',
  'signin',
  'login_required',
])

/** Reasons that mean the client was refused outright. */
const BOT_BLOCK_WORDS = new Set([
  'bot_block',
  'blocked_text',
  'captcha',
  'challenge',
  'cloudflare',
  'http_403',
  'http_429',
  'http_999',
])

/** Reasons that mean the request never came back in time. */
const TIMEOUT_WORDS = new Set(['timeout', 'timed_out', 'etimedout', 'http_408', 'http_504'])

/** Reasons that mean the page came back but without readable content. */
const JS_SHELL_WORDS = new Set(['js_shell', 'empty_page', 'empty', 'shell'])

/** The classes themselves, so a stored class parses back to itself. */
const CLASS_WORDS = new Set<string>(PARK_REASONS)

/**
 * Parse a stored reason into a park reason class.
 *
 * The stored reason is either a class itself (`login_wall` on a parked row)
 * or a guard composite (`blocked:http_429`, `canary_flagged:login_wall`,
 * `blocked:login_wall (max attempts exhausted)` on a deferred or errored
 * row). Composite prefixes are stripped and the signal inside is mapped to
 * its class. Anything that is not a known class (including the empty reason
 * a legacy parked row carries) parses as `unknown`.
 */
export function parseParkReason(value: unknown): ParkReason {
  if (typeof value !== 'string') return 'unknown'
  let s = value.trim()
  if (s === '') return 'unknown'
  for (const prefix of REASON_PREFIXES) {
    if (s.startsWith(prefix)) {
      s = s.slice(prefix.length).trim()
      break
    }
  }
  // A failure suffix the pipeline appends ("max attempts exhausted") is not
  // part of the signal.
  const cut = s.indexOf(' (')
  if (cut > 0) s = s.slice(0, cut).trim()
  if (s === '') return 'unknown'
  // A stored class parses back to itself (`http_error` and `unknown` are
  // only reachable through this branch).
  if (CLASS_WORDS.has(s)) return s as ParkReason
  if (s === 'skip_host') return 'skipped'
  if (LOGIN_WALL_WORDS.has(s)) return 'login_wall'
  if (s === 'review_only') return 'review_only'
  if (BOT_BLOCK_WORDS.has(s)) return 'bot_block'
  if (TIMEOUT_WORDS.has(s)) return 'timeout'
  if (JS_SHELL_WORDS.has(s)) return 'js_shell'
  // An HTTP status spelled out by the retry classifier (`http_502`): 403,
  // 429 and 999 are refusals (bot blocks), 408 and 504 are timeouts,
  // everything else is a plain error.
  const httpMatch = /^http_(\d{3})$/.exec(s)
  if (httpMatch) {
    const status = Number(httpMatch[1])
    if (status === 403 || status === 429 || status === 999) return 'bot_block'
    if (status === 408 || status === 504) return 'timeout'
    return 'http_error'
  }
  return 'unknown'
}

/**
 * The reason carried by a state payload. `needs_browser` carries a `reason`
 * (the class), `deferred` carries the guard's deferral reason and `errored`
 * carries an `error`; all three parse to a class.
 */
export function parkReasonOfStateData(stateData: Record<string, unknown> | null): ParkReason {
  if (!stateData) return 'unknown'
  const value = stateData['reason'] ?? stateData['error']
  return parseParkReason(value)
}

/**
 * The park reason of one link row, or null when the row is not parked.
 *
 * A `needs_browser` row is always parked: its reason is a class, and a
 * legacy row without one parses as `unknown`. A `deferred` row only counts
 * as parked when its reason names a blocker (`blocked:http_429`,
 * `canary_flagged:login_wall`); a pure throttle (`spacing`, `rate_limited`,
 * `breaker_open`) is a wait the link retries on its own, not a park, so it
 * returns null instead of muddying the `unknown` bucket.
 */
export function parkedReasonOf(
  state: string,
  stateData: Record<string, unknown> | null,
): ParkReason | null {
  if (state === 'needs_browser') return parkReasonOfStateData(stateData)
  if (state === 'deferred') {
    const reason = parkReasonOfStateData(stateData)
    return reason === 'unknown' ? null : reason
  }
  return null
}

/**
 * The markers of a bot block: a captcha or a Cloudflare-style challenge
 * page. A page-text marker list, not a host list: no host name is hardcoded
 * anywhere.
 */
export const BOT_BLOCK_MARKERS = [
  'captcha',
  'cf-browser-verification',
  'cf_chl_opt',
  'checking your browser before accessing',
  'checking your browser',
  'just a moment',
  'verify you are human',
  'are you a robot',
  'unusual activity',
  'attention required',
  'enable javascript and cookies to continue',
]

/** The HTTP statuses that mean the host refused the client outright. */
export const BOT_BLOCK_STATUSES = new Set([403, 429, 999])

/** True when the text carries a bot-block marker. */
export function looksLikeBotBlock(text: string | undefined | null): boolean {
  if (!text) return false
  const lower = text.toLowerCase()
  return BOT_BLOCK_MARKERS.some((marker) => lower.includes(marker))
}

/** The statuses that mean the request timed out. */
export const TIMEOUT_STATUSES = new Set([408, 504])

/** True when the status means the request timed out. */
export function looksLikeTimeoutStatus(status: number | undefined): boolean {
  return status !== undefined && TIMEOUT_STATUSES.has(status)
}

/** Timeout wording in an error text. */
export function looksLikeTimeoutError(error: string | undefined | null): boolean {
  if (!error) return false
  const lower = error.toLowerCase()
  return (
    lower.includes('timeout') ||
    lower.includes('timed out') ||
    lower.includes('etimedout') ||
    lower.includes('aborted') ||
    lower.includes('deadline exceeded')
  )
}

/**
 * The outcome of an extraction, as the extract stage sees it. Only the
 * fields the classification reads.
 */
export interface ParkOutcome {
  /** The extracted markdown. Empty means no content. */
  markdown?: string
  /** The HTTP status of the final response. */
  status?: number
  /** The raw HTML, for the block markers and the shell check. */
  html?: string
  /** True when the host refused the session. */
  blocked?: boolean
  /** The short reason the extractor gave for the block, e.g. `login_wall`. */
  blockReason?: string
  /** True when the pipeline decided the page is a login wall. */
  isLoginWall?: boolean
  /** The HTTP status when the page is permanently gone (404 or 410). */
  gone?: number
  /** The error text, when the extraction carried one. */
  error?: string
}

/** Reasons an extractor may report for a block that name a login wall. */
const LOGIN_WALL_BLOCK_REASONS = new Set([
  'login_wall',
  'private_404',
  'private_410',
  'login',
  'signin',
])

/**
 * Classify the outcome of an extraction into a park reason.
 *
 * The order of the rules:
 *   1. a login wall wins: the host wants a session
 *   2. a bot block: the extractor refused with a non-login reason, a captcha
 *      or challenge marker in the body, or a 403/429/999 status
 *   3. a timeout: 408 or 504, or timeout wording in the error text
 *   4. any other error status: 4xx or 5xx
 *   5. an empty or shell body: the page needs JavaScript
 *
 * The caller only classifies outcomes it is about to park, so real content
 * (`unknown`) never reaches a parked row.
 */
export function classifyParkOutcome(outcome: ParkOutcome): ParkReason {
  const body = outcome.html ?? outcome.markdown ?? ''
  const status = outcome.status

  // A login wall is decided by the pipeline's login-wall rules (or reported
  // by the extractor with a login reason): a 403 behind a login form is a
  // login wall, not a block.
  if (outcome.isLoginWall === true) return 'login_wall'
  if (outcome.blocked === true) {
    if (
      outcome.blockReason === undefined ||
      LOGIN_WALL_BLOCK_REASONS.has(outcome.blockReason)
    ) {
      return 'login_wall'
    }
    return 'bot_block'
  }

  // A bot block: the challenge markers in the body, or the statuses that
  // mean "this client was refused" (403, 429, the 999 some sites use).
  if (status !== undefined && BOT_BLOCK_STATUSES.has(status)) return 'bot_block'
  if (looksLikeBotBlock(body)) return 'bot_block'

  // A timeout: the request never came back.
  if (looksLikeTimeoutStatus(status)) return 'timeout'
  if (looksLikeTimeoutError(outcome.error)) return 'timeout'

  // Any other error status: the page is broken, a browser cannot fix it.
  if (status !== undefined && status >= 400) return 'http_error'
  if (outcome.gone !== undefined) return 'http_error'

  // No readable content: the body is a shell the browser has to fill in.
  if (!hasContent(outcome.markdown, body)) return 'js_shell'

  return 'unknown'
}

/** True when the body carries real content (not an empty or shell page). */
function hasContent(markdown: string | undefined, body: string): boolean {
  if ((markdown ?? '').trim() !== '') return true
  if (body.trim() === '') return false
  // An HTML body that only carries scripts and styles is still a shell.
  const text = body
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return text.length > 0
}
