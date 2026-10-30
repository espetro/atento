/**
 * The capture retry queue.
 *
 * When the server is down, the payload is queued and retried with
 * exponential backoff and full jitter, the same classifier as
 * packages/core/src/resilience/retry.ts: network errors, 408, 425 and 5xx
 * are retryable; 401 (bad token), 403 (endpoint disabled, token unset) and
 * 400 (invalid payload) are not, because retrying will not fix them.
 *
 * The proof of concept queue is in memory and explicitly does NOT survive
 * an MV3 service worker restart. Persisting it in chrome.storage.local is
 * milestone M3 in docs/extension.md. The queue takes its clock, its random
 * and its fetch as injected parameters, so the tests are deterministic,
 * never sleep and never touch the network.
 */

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>

/** One queued capture, with its attempt history. */
export interface QueuedCapture {
  payload: string
  url: string
  attempts: number
}

/** Why a POST failed: the status, the transport error, or both. */
export interface AttemptOutcome {
  status?: number
  error?: string
}

export interface QueueOptions {
  /** The endpoint, e.g. http://127.0.0.1:4173/capture. */
  endpoint: string
  /** Bearer token, read from storage by the caller. */
  token: string
  /** Injected fetch. Defaults to the global one; tests inject a fake. */
  fetch?: FetchLike
  /** Injected clock in ms. Defaults to Date.now; tests inject a fake. */
  now?: () => number
  /** Injected random for full jitter. Tests inject a deterministic one. */
  random?: () => number
  /** Backoff base in ms. Default 1000. */
  baseDelayMs?: number
  /** Backoff cap in ms. Default 60000. */
  maxDelayMs?: number
  /** Backoff factor. Default 2. */
  factor?: number
  /** Give up after this many attempts. Default 5. */
  maxAttempts?: number
  /** Queue capacity. Enqueue past the cap is refused. Default 100. */
  maxSize?: number
}

export interface EnqueueResult {
  accepted: boolean
  /** Why the enqueue was refused (queue_full). */
  reason?: string
}

export interface DrainResult {
  sent: number
  /** Payloads still queued, waiting for their next attempt. */
  pending: number
  /** Payloads given up on (max attempts or a non-retryable response). */
  failed: number
  /** ms until the next attempt is due, when at least one is waiting. */
  nextAttemptInMs?: number
}

/**
 * Classify one failure using the same rules as the pipeline's retry. True
 * when the attempt is worth retrying: transport errors, 408, 425 and 5xx.
 * False for 401 (bad token), 403 (endpoint disabled) and 400 (invalid
 * payload), which will not fix themselves.
 */
export function classifyOutcome(outcome: AttemptOutcome): boolean {
  if (outcome.error !== undefined) return true
  const status = outcome.status
  if (status === undefined) return true
  if (status === 408 || status === 425) return true
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

export interface Clock {
  now(): number
  /** Resolve when at least `ms` have passed on this clock. */
  wait(ms: number): Promise<void>
}

/**
 * A real clock for production use. Tests inject a fake clock instead of
 * waiting for real time.
 */
export const realClock: Clock = {
  now: () => Date.now(),
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}

export function createCaptureQueue(options: QueueOptions) {
  const clock: Clock = options.now
    ? {
        now: options.now,
        wait: () => Promise.resolve(),
      }
    : realClock
  const random = options.random ?? Math.random
  const fetchImpl = options.fetch ?? ((url, init) => fetch(url, init))
  const baseDelayMs = options.baseDelayMs ?? 1000
  const maxDelayMs = options.maxDelayMs ?? 60000
  const factor = options.factor ?? 2
  const maxAttempts = options.maxAttempts ?? 5
  const maxSize = options.maxSize ?? 100

  const queue: QueuedCapture[] = []
  /** nextAttemptAt per queued item, parallel to `queue`. */
  const dueAt: number[] = []

  /**
   * POST one payload. Returns the outcome; never throws. A thrown fetch is
   * reported as a retryable network error, which is what the classifier
   * expects.
   */
  async function attemptPost(item: QueuedCapture): Promise<AttemptOutcome> {
    try {
      const res = await fetchImpl(options.endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${options.token}`,
          'content-type': 'application/json',
        },
        body: item.payload,
      })
      return { status: res.status }
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
  }

  return {
    /** How many payloads are queued. */
    size(): number {
      return queue.length
    },

    /** The queued payloads, oldest first. For tests and for persistence. */
    items(): readonly QueuedCapture[] {
      return queue
    },

    /** Queue one payload for delivery. Bounded: past maxSize it is refused. */
    enqueue(url: string, payload: string): EnqueueResult {
      if (queue.length >= maxSize) return { accepted: false, reason: 'queue_full' }
      queue.push({ url, payload, attempts: 0 })
      dueAt.push(clock.now())
      return { accepted: true }
    },

    /**
     * One drain pass: POST every due payload once. Retryable failures stay
     * queued with a backoff-scheduled next attempt; non-retryable ones are
     * dropped from the queue with failed incremented. Never throws.
     */
    async drain(): Promise<DrainResult> {
      let sent = 0
      let failed = 0
      const now = clock.now()
      const requeue: { item: QueuedCapture; at: number }[] = []
      // Snapshot: attemptPost may mutate nothing, but drain must not process
      // an item twice when the loop reorders.
      const batch = queue.splice(0, queue.length)
      const batchDue = dueAt.splice(0, dueAt.length)
      for (let i = 0; i < batch.length; i++) {
        const item = batch[i]
        if (batchDue[i] > now) {
          requeue.push({ item, at: batchDue[i] })
          continue
        }
        item.attempts += 1
        const outcome = await attemptPost(item)
        if (!classifyOutcome(outcome)) {
          // A 2xx was sent; 401/403/400 will not fix themselves.
          if (outcome.status !== undefined && outcome.status < 300) {
            sent += 1
          } else {
            failed += 1
          }
          continue
        }
        if (item.attempts >= maxAttempts) {
          failed += 1
          continue
        }
        const delay = backoffDelay(item.attempts, { baseDelayMs, maxDelayMs, factor }, random)
        requeue.push({ item, at: clock.now() + delay })
      }
      for (const { item, at } of requeue) {
        queue.push(item)
        dueAt.push(at)
      }
      const nextDue = dueAt.length > 0 ? Math.min(...dueAt) : undefined
      return {
        sent,
        pending: queue.length,
        failed,
        nextAttemptInMs: nextDue !== undefined ? Math.max(0, nextDue - clock.now()) : undefined,
      }
    },

    /**
     * Wait until the next attempt is due, then drain once. The production
     * loop calls this forever; a test calls it once with a fake clock,
     * where wait() resolves immediately.
     */
    async drainWhenDue(): Promise<DrainResult> {
      const nextDue = dueAt.length > 0 ? Math.min(...dueAt) : undefined
      if (nextDue !== undefined) {
        await clock.wait(Math.max(0, nextDue - clock.now()))
      }
      return this.drain()
    },
  }
}

export type CaptureQueue = ReturnType<typeof createCaptureQueue>
