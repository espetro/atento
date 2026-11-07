import { writable } from 'svelte/store'
import type { IngestJob, RunJournalRow } from './types'

/**
 * One SSE frame from GET /api/events. Three families share the stream;
 * the composite `evt:{l,r,i}` cursor is handled by the browser's
 * EventSource (Last-Event-ID resume is automatic on reconnect).
 */
export type SseEvent =
  | { kind: 'link'; data: Record<string, unknown> }
  | { kind: 'run'; data: RunJournalRow }
  | { kind: 'ingest'; data: IngestJob }

/** The most recent SSE frame per family (latest wins). */
export const sseEvents = writable<{
  link: Record<string, unknown> | null
  run: RunJournalRow | null
  ingest: IngestJob | null
}>({ link: null, run: null, ingest: null })

/** Rolling journal of run + ingest events for the run/ingest surfaces. */
export const sseRunLog = writable<RunJournalRow[]>([])
export const sseIngestJobs = writable<Map<string, IngestJob>>(new Map())

/** True while the EventSource is open; false while reconnecting. */
export const sseConnected = writable(true)

/**
 * Cross-component request bus: the link list asks the preview pane to
 * re-extract a specific link id (the 'r' shortcut lives in one place).
 */
export const reextractBus = writable<number | null>(null)

const RUN_LOG_CAP = 60

/**
 * Open the single EventSource for the session. Returns a stop function.
 * `onEvent` fires for every frame (query invalidation lives in App).
 */
export function startEvents(onEvent?: (e: SseEvent) => void): () => void {
  if (typeof EventSource === 'undefined') return () => {}
  const source = new EventSource('/api/events')

  const handle = (kind: SseEvent['kind']) => (ev: MessageEvent) => {
    let data: unknown
    try {
      data = JSON.parse(ev.data)
    } catch {
      return
    }
    const event: SseEvent =
      kind === 'link'
        ? { kind, data: data as Record<string, unknown> }
        : kind === 'run'
          ? { kind, data: data as RunJournalRow }
          : { kind, data: data as IngestJob }
    sseEvents.update((s) => ({ ...s, [kind]: event.data }))
    if (kind === 'run') {
      const row = event.data as RunJournalRow
      sseRunLog.update((log) => {
        const next = log.filter((r) => r.id !== row.id)
        next.push(row)
        return next.slice(-RUN_LOG_CAP)
      })
    }
    if (kind === 'ingest') {
      const job = event.data as IngestJob
      sseIngestJobs.update((map) => {
        const next = new Map(map)
        next.set(job.jobId, job)
        return next
      })
    }
    onEvent?.(event)
  }

  source.addEventListener('link', handle('link'))
  source.addEventListener('run', handle('run'))
  source.addEventListener('ingest', handle('ingest'))
  source.onopen = () => sseConnected.set(true)
  source.onerror = () => sseConnected.set(false)

  return () => {
    source.close()
    sseConnected.set(true)
  }
}
