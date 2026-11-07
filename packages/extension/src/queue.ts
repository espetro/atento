/**
 * The durable capture outbox.
 *
 * Every capture and every bulk-ingest batch goes through this queue: the
 * item is persisted to chrome.storage.local FIRST, then POSTed. A 2xx is
 * the ack — the server commits before it answers (captureIngest applies
 * body+transition in one transaction; ingest is spooled and deduped on
 * url_hash), so deleting the item on 2xx never loses a capture, and a
 * retry can never duplicate one: the idempotency key dedupes client-side
 * and the server's url_hash dedupe covers the rest.
 *
 * Retry policy is the same classifier as packages/core/src/resilience/
 * retry.ts: network errors, 408, 425, 429 and 5xx are retryable, with
 * exponential backoff and full jitter plus Retry-After honoured. 401
 * (bad token), 403 (endpoint disabled), 400 and other 4xx are dead-lettered
 * — kept in storage with the error surfaced, never silently dropped and
 * never retried, because retrying cannot fix them.
 *
 * The module takes its storage, clock, random and fetch as injected
 * parameters, so the tests are deterministic, never sleep and never touch
 * the network or a real browser.
 */

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>

/** What kind of request an item carries. */
export type OutboxKind = 'capture' | 'ingest'

/**
 * One queued request. `payload` is the serialized JSON body; `url` is a
 * display/origin hint for the options page, not sent anywhere.
 */
export interface OutboxItem {
  /** Client-side dedupe key; stable across retries of the same request. */
  idempotencyKey: string
  kind: OutboxKind
  url: string
  payload: string
  attempts: number
  /** Epoch ms when the next attempt becomes due. */
  nextRetryAt: number
  createdAt: number
  /** Why the last attempt failed, surfaced for dead items. */
  lastError?: string
  /** True once the item exhausted attempts or hit a non-retryable status. */
  dead?: boolean
}

/** The slice of chrome.storage.local the outbox needs. */
export interface KeyValueStorage {
  get(keys: string | string[]): Promise<Record<string, unknown>>
  set(items: Record<string, unknown>): Promise<void>
}

/** Why a POST failed: the status, the transport error, or both. */
export interface AttemptOutcome {
  status?: number
  error?: string
  /** Server-requested delay in ms (Retry-After), when present. */
  retryAfterMs?: number
}

export interface EnqueueInput {
  idempotencyKey: string
  kind: OutboxKind
  url: string
  payload: string
}

export interface EnqueueResult {
  accepted: boolean
  /** True when a live item with the same idempotency key already exists. */
  duplicate?: boolean
  /** True when a dead-lettered item was revived for retry. */
  revived?: boolean
  /** Why the enqueue was refused (queue_full). */
  reason?: string
}

export interface DrainResult {
  /** Items acked by the server this pass (2xx, deleted). */
  sent: number
  /** Live items still waiting for a future attempt. */
  pending: number
  /** Items dead-lettered this pass. */
  failed: number
  /** Total dead-lettered items in the outbox. */
  dead: number
  /** ms until the next attempt is due, when at least one is waiting. */
  nextAttemptInMs?: number
}

/**
 * Classify one failure using the same rules as the pipeline's retry. True
 * when the attempt is worth retrying: transport errors, 408, 425, 429 and
 * 5xx. False for other 4xx (401 bad token, 403 disabled, 400 invalid),
 * which will not fix themselves, and for 2xx.
 */
export function classifyOutcome(outcome: AttemptOutcome): boolean {
  if (outcome.error !== undefined) return true
  const status = outcome.status
  if (status === undefined) return true
  if (status === 408 || status === 425 || status === 429) return true
  if (status >= 500) return true
  return false
}

/** Full-jitter backoff: uniform in [0, min(max, base * factor^(n-1))]. */
export function backoffDelay(
  attempt: number,
  opts: { baseDelayMs: number; maxDelayMs: number; factor: number },
  random: () => number,
): number {
  const ceiling = Math.min(opts.maxDelayMs, opts.baseDelayMs * opts.factor ** (attempt - 1))
  return Math.floor(random() * ceiling)
}

/** Parse a Retry-After header (seconds or HTTP-date) into ms. */
export function parseRetryAfter(header: string | null, now: number): number | undefined {
  if (header === null || header.trim() === '') return undefined
  const trimmed = header.trim()
  const seconds = Number(trimmed)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
  const date = Date.parse(trimmed)
  if (Number.isFinite(date)) return Math.max(0, date - now)
  return undefined
}

export interface OutboxOptions {
  /** chrome.storage.local (or a test double). */
  storage: KeyValueStorage
  /** Storage key holding the item array. Default 'linkinbox:outbox'. */
  storageKey?: string
  /** Injected fetch. Defaults to the global one; tests inject a fake. */
  fetch?: FetchLike
  /** Injected clock in ms. Defaults to Date.now; tests inject a fake. */
  now?: () => number
  /** Injected random for full jitter. Tests inject a deterministic one. */
  random?: () => number
  /** Endpoint for one kind, resolved at send time so config changes apply. */
  endpointFor: (kind: OutboxKind) => string
  /** Auth/content headers per kind, resolved fresh at send time. */
  headersFor?: (kind: OutboxKind) => Record<string, string> | Promise<Record<string, string>>
  /** Backoff base in ms. Default 1000. */
  baseDelayMs?: number
  /** Backoff cap in ms. Default 60000. */
  maxDelayMs?: number
  /** Backoff factor. Default 2. */
  factor?: number
  /** Dead-letter after this many attempts. Default 8. */
  maxAttempts?: number
  /** Live queue capacity. Enqueue past the cap is refused. Default 200. */
  maxSize?: number
  /** Dead-letter capacity; oldest dead items are dropped past it. Default 100. */
  maxDead?: number
}

/** Narrow an unknown stored value back into an OutboxItem. */
function asItem(value: unknown): OutboxItem | null {
  if (value === null || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  if (
    typeof v['idempotencyKey'] !== 'string' ||
    (v['kind'] !== 'capture' && v['kind'] !== 'ingest') ||
    typeof v['url'] !== 'string' ||
    typeof v['payload'] !== 'string' ||
    typeof v['attempts'] !== 'number' ||
    typeof v['nextRetryAt'] !== 'number' ||
    typeof v['createdAt'] !== 'number'
  ) {
    return null
  }
  const item: OutboxItem = {
    idempotencyKey: v['idempotencyKey'],
    kind: v['kind'],
    url: v['url'],
    payload: v['payload'],
    attempts: v['attempts'],
    nextRetryAt: v['nextRetryAt'],
    createdAt: v['createdAt'],
  }
  if (typeof v['lastError'] === 'string') item.lastError = v['lastError']
  if (v['dead'] === true) item.dead = true
  return item
}

export function createOutbox(options: OutboxOptions) {
  const storageKey = options.storageKey ?? 'linkinbox:outbox'
  const fetchImpl = options.fetch ?? ((url, init) => fetch(url, init))
  const clock = { now: options.now ?? (() => Date.now()) }
  const random = options.random ?? Math.random
  const baseDelayMs = options.baseDelayMs ?? 1000
  const maxDelayMs = options.maxDelayMs ?? 60000
  const factor = options.factor ?? 2
  const maxAttempts = options.maxAttempts ?? 8
  const maxSize = options.maxSize ?? 200
  const maxDead = options.maxDead ?? 100

  const items: OutboxItem[] = []

  /** Serialize every storage-touching operation; the worker is single
   *  threaded but async ops interleave, and a stale read-modify-write
   *  would drop items. */
  let chain: Promise<void> = Promise.resolve()
  function serialized<T>(fn: () => Promise<T>): Promise<T> {
    const run = chain.then(fn)
    chain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  async function persist(): Promise<void> {
    await options.storage.set({ [storageKey]: items.map((i) => ({ ...i })) })
  }

  async function load(): Promise<void> {
    const stored = await options.storage.get(storageKey)
    const raw = stored[storageKey]
    if (!Array.isArray(raw)) return
    for (const value of raw) {
      const item = asItem(value)
      if (item !== null) items.push(item)
    }
  }

  /** POST one item once. Never throws; errors come back as outcomes. */
  async function attemptPost(item: OutboxItem): Promise<AttemptOutcome> {
    try {
      const headers = (await options.headersFor?.(item.kind)) ?? {}
      const res = await fetchImpl(options.endpointFor(item.kind), {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: item.payload,
      })
      const outcome: AttemptOutcome = { status: res.status }
      const retryAfter = parseRetryAfter(res.headers.get('retry-after'), clock.now())
      if (retryAfter !== undefined) outcome.retryAfterMs = retryAfter
      return outcome
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
  }

  function describe(outcome: AttemptOutcome): string {
    if (outcome.error !== undefined) return outcome.error
    return `HTTP ${outcome.status ?? 'unknown'}`
  }

  /** The load runs first on the chain, so every later op sees the items. */
  const ready = serialized(load)

  return {
    /** Resolves once the persisted items are loaded. */
    ready,

    /** Live (non-dead) items, in queue order. */
    items(): readonly OutboxItem[] {
      return items.filter((i) => i.dead !== true)
    },

    /** Dead-lettered items, for the options page. */
    deadItems(): readonly OutboxItem[] {
      return items.filter((i) => i.dead === true)
    },

    /** One item by idempotency key, live or dead. */
    get(idempotencyKey: string): OutboxItem | undefined {
      return items.find((i) => i.idempotencyKey === idempotencyKey)
    },

    /**
     * Persist one request and queue it for delivery. Dedupes on the
     * idempotency key: enqueueing the same key twice is a no-op that still
     * reports accepted, so a capture retried after a worker restart never
     * doubles. A DEAD item with the same key is revived instead — the user
     * re-capturing a failed ingest batch (its key is a deterministic hash
     * of the url set) means "try again", not "silently ignore forever".
     */
    enqueue(input: EnqueueInput): Promise<EnqueueResult> {
      return serialized(async () => {
        await ready
        const existing = items.find((i) => i.idempotencyKey === input.idempotencyKey)
        if (existing !== undefined) {
          if (existing.dead === true) {
            // Revive: fresh attempts, due immediately, error cleared. The
            // payload is replaced too — a re-enqueue may carry newer content
            // under the same key (e.g. a re-extracted page).
            existing.kind = input.kind
            existing.url = input.url
            existing.payload = input.payload
            existing.attempts = 0
            existing.nextRetryAt = clock.now()
            delete existing.lastError
            delete existing.dead
            await persist()
            return { accepted: true, revived: true }
          }
          return { accepted: true, duplicate: true }
        }
        const live = items.filter((i) => i.dead !== true).length
        if (live >= maxSize) return { accepted: false, reason: 'queue_full' }
        const now = clock.now()
        items.push({
          idempotencyKey: input.idempotencyKey,
          kind: input.kind,
          url: input.url,
          payload: input.payload,
          attempts: 0,
          nextRetryAt: now,
          createdAt: now,
        })
        await persist()
        return { accepted: true }
      })
    },

    /** Drop one item by key (used after an ack or by the options page). */
    remove(idempotencyKey: string): Promise<boolean> {
      return serialized(async () => {
        await ready
        const index = items.findIndex((i) => i.idempotencyKey === idempotencyKey)
        if (index === -1) return false
        items.splice(index, 1)
        await persist()
        return true
      })
    },

    /** Clear every dead-lettered item. Returns how many were dropped. */
    clearDead(): Promise<number> {
      return serialized(async () => {
        await ready
        const before = items.length
        for (let i = items.length - 1; i >= 0; i--) {
          if (items[i]?.dead === true) items.splice(i, 1)
        }
        const dropped = before - items.length
        if (dropped > 0) await persist()
        return dropped
      })
    },

    /**
     * One drain pass: POST every due live item once, in order. A 2xx acks
     * and deletes; a retryable failure reschedules with backoff (never
     * sooner than the server's Retry-After); a non-retryable failure or
     * exhausted attempts dead-letters the item. Never throws.
     */
    drain(): Promise<DrainResult> {
      return serialized(async () => {
        await ready
        let sent = 0
        let failed = 0
        const now = clock.now()
        // Snapshot: acked items are spliced out mid-pass.
        for (const item of [...items]) {
          if (!items.includes(item)) continue
          if (item.dead === true || item.nextRetryAt > now) continue
          item.attempts += 1
          const outcome = await attemptPost(item)
          const status = outcome.status
          if (status !== undefined && status >= 200 && status < 300) {
            // The server acks only after commit: 2xx means done.
            items.splice(items.indexOf(item), 1)
            sent += 1
            continue
          }
          if (classifyOutcome(outcome)) {
            if (item.attempts >= maxAttempts) {
              item.dead = true
              item.lastError = `${describe(outcome)} (gave up after ${item.attempts} attempts)`
              failed += 1
            } else {
              const delay = Math.max(
                backoffDelay(
                  item.attempts,
                  { baseDelayMs, maxDelayMs, factor },
                  random,
                ),
                outcome.retryAfterMs ?? 0,
              )
              item.nextRetryAt = clock.now() + delay
              item.lastError = describe(outcome)
            }
            continue
          }
          item.dead = true
          item.lastError = describe(outcome)
          failed += 1
        }
        // Bound the dead-letter store: drop the oldest dead items past the cap.
        const dead = items.filter((i) => i.dead === true)
        if (dead.length > maxDead) {
          const excess = dead.length - maxDead
          for (const item of dead.slice(0, excess)) {
            items.splice(items.indexOf(item), 1)
          }
        }
        await persist()
        const pending = items.filter((i) => i.dead !== true)
        const nextDue = pending.length > 0 ? Math.min(...pending.map((i) => i.nextRetryAt)) : undefined
        return {
          sent,
          pending: pending.length,
          failed,
          dead: items.length - pending.length,
          nextAttemptInMs:
            nextDue !== undefined ? Math.max(0, nextDue - clock.now()) : undefined,
        }
      })
    },
  }
}

export type Outbox = ReturnType<typeof createOutbox>
