/**
 * Bounded queue with backpressure. Stages process bounded batches: work is
 * enqueued, and the queue refuses anything past `maxSize` so memory cannot
 * grow without bound. Enqueue returns `accepted` or `deferred`.
 */
export type EnqueueResult<T> =
  | { accepted: true; item: T; size: number }
  | { accepted: false; item: T; size: number; reason: 'queue_full' | 'queue_closed' }

export interface BoundedQueueOptions {
  /** Maximum number of queued items. */
  maxSize: number
  /** Maximum number of items processed at the same time. */
  concurrency: number
}

export interface BoundedQueue<T> {
  /** Enqueue one item. Never blocks and never grows past maxSize. */
  enqueue(item: T): EnqueueResult<T>
  /** Current number of queued items. */
  size(): number
  /** Current number of items being processed. */
  inFlight(): number
  /** Process every queued item with the given worker, at bounded concurrency. */
  drain(worker: (item: T) => Promise<void>): Promise<void>
  /** Mark the queue closed; further enqueues are refused. */
  close(): void
  /** Whether the queue is closed. */
  closed(): boolean
}

/** Create a bounded queue. `maxSize` and `concurrency` are clamped to >= 1. */
export function createBoundedQueue<T>(options: BoundedQueueOptions): BoundedQueue<T> {
  const maxSize = Math.max(1, Math.floor(options.maxSize))
  const concurrency = Math.max(1, Math.floor(options.concurrency))
  const items: T[] = []
  let active = 0
  let closed = false

  return {
    enqueue(item: T): EnqueueResult<T> {
      if (closed) {
        return { accepted: false, item, size: items.length, reason: 'queue_closed' }
      }
      if (items.length >= maxSize) {
        return { accepted: false, item, size: items.length, reason: 'queue_full' }
      }
      items.push(item)
      return { accepted: true, item, size: items.length }
    },
    size: () => items.length,
    inFlight: () => active,
    async drain(worker: (item: T) => Promise<void>): Promise<void> {
      let cursor = 0
      const runWorker = async (): Promise<void> => {
        while (cursor < items.length) {
          const item = items[cursor]
          cursor += 1
          active += 1
          try {
            await worker(item)
          } finally {
            active -= 1
          }
        }
      }
      const workers = Array.from(
        { length: Math.min(concurrency, items.length) },
        () => runWorker(),
      )
      await Promise.all(workers)
      items.length = 0
    },
    close(): void {
      closed = true
    },
    closed: () => closed,
  }
}
