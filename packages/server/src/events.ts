/**
 * GET /api/events — resumable SSE over the pipeline journals.
 *
 * Three event families share one stream:
 *
 *   event: link    id: <link_events.id>          exact cursor replay
 *   event: run     id: run:<runs.id>             run journal cursor
 *   event: ingest  id: ingest:<ingest_jobs.id>   job progress (state announcements)
 *
 * `Last-Event-ID` (or `?since=`) carries the last delivered id. Resume is
 * exact for link events; for run/ingest events the id's timestamp anchors a
 * wall-clock watermark, so a reconnect replays every run/ingest change that
 * happened after the last seen event — no gaps, and no duplicates beyond a
 * sub-poll-interval margin (dedup by event id on the client if needed).
 *
 * Mechanism: a lightweight poll of the SQLite store (no LISTEN/NOTIFY).
 */
import type { Store } from '@linkinbox/core'
import type { IngestJob, LinkHistoryEntry, Run } from '@linkinbox/core'

const DEFAULT_POLL_MS = 500
const KEEPALIVE_MS = 15_000
/** Wall-clock margin when replaying run/ingest by timestamp. */
const REPLAY_MARGIN_MS = 1_000
const LINK_PAGE = 500

interface ParsedResume {
  /** link_events cursor to resume after (0 = from the beginning). */
  linkSince: number
  /** Wall-clock watermark: emit run/ingest activity strictly after this. */
  sinceTime: Date
}

/** The latest activity timestamp of a run row (finish beats heartbeat beats start). */
function runActivityAt(run: Run): Date {
  return run.finishedAt ?? run.heartbeatAt ?? run.startedAt
}

/**
 * The link_events cursor whose `at` is the greatest timestamp <= `time`.
 * Binary search over the monotonic id space using listLinkEvents pages.
 */
async function linkCursorAtOrBefore(store: Store, time: Date): Promise<number> {
  const hi = await store.linkEventCursor()
  if (hi === 0) return 0
  // Invariant: cursor c means "all events <= c have at <= time" is what we
  // want the greatest c for. Probe ids directly.
  const atOf = async (id: number): Promise<Date | null> => {
    const rows = await store.listLinkEvents(id - 1, 1)
    return rows.length > 0 && rows[0]!.id === id ? rows[0]!.at : null
  }
  let lo = 0
  let best = 0
  let high = hi
  while (lo <= high) {
    const mid = Math.floor((lo + high) / 2)
    if (mid === 0) {
      lo = 1
      continue
    }
    const at = await atOf(mid)
    if (at === null) {
      // id mid does not exist (shouldn't happen — autoincrement is dense);
      // treat as "before" and search lower.
      high = mid - 1
      continue
    }
    if (at.getTime() <= time.getTime()) {
      best = mid
      lo = mid + 1
    } else {
      high = mid - 1
    }
  }
  return best
}

/** Parse a Last-Event-ID / since value into per-family resume watermarks. */
async function parseResume(store: Store, raw: string | undefined): Promise<ParsedResume> {
  if (raw === undefined || raw === '') {
    // No cursor: start of the link journal, and only very recent run/ingest
    // activity (a fresh connect does not replay history).
    return { linkSince: 0, sinceTime: new Date(0) }
  }
  if (/^\d+$/.test(raw)) {
    const linkSince = Number(raw)
    // The timestamp of that exact event anchors run/ingest replay.
    const rows = await store.listLinkEvents(linkSince - 1, 1)
    const at = rows.length > 0 && rows[0]!.id === linkSince ? rows[0]!.at : new Date()
    return { linkSince, sinceTime: at }
  }
  if (raw.startsWith('run:')) {
    const id = Number(raw.slice(4))
    if (Number.isInteger(id) && id > 0) {
      const run = await store.getRun(id)
      const at = run !== null ? runActivityAt(run) : new Date()
      return { linkSince: await linkCursorAtOrBefore(store, at), sinceTime: at }
    }
  }
  if (raw.startsWith('ingest:')) {
    const jobId = raw.slice('ingest:'.length)
    const job = await store.getIngestJob(jobId)
    const at = job !== null ? job.updatedAt : new Date()
    return { linkSince: await linkCursorAtOrBefore(store, at), sinceTime: at }
  }
  // Unknown format: fail safe — resume the link journal from the start and
  // replay recent run/ingest activity.
  return { linkSince: 0, sinceTime: new Date(0) }
}

function sseFrame(id: string | null, event: string, data: unknown): string {
  const lines: string[] = []
  if (id !== null) lines.push(`id: ${id}`)
  lines.push(`event: ${event}`)
  // data is one JSON line; stringify then split defensively.
  for (const line of JSON.stringify(data).split('\n')) {
    lines.push(`data: ${line}`)
  }
  return lines.join('\n') + '\n\n'
}

const LINK_EVENT_PAYLOAD = (e: LinkHistoryEntry) => ({
  id: e.id,
  linkId: e.linkId,
  fromState: e.fromState,
  toState: e.toState,
  event: e.event,
  data: e.data,
  at: e.at.toISOString(),
})

const RUN_PAYLOAD = (r: Run) => ({
  id: r.id,
  stage: r.stage,
  status: r.status ?? 'done',
  pid: r.pid ?? null,
  startedAt: r.startedAt.toISOString(),
  heartbeatAt: r.heartbeatAt?.toISOString() ?? null,
  finishedAt: r.finishedAt?.toISOString() ?? null,
  inputCount: r.inputCount,
  okCount: r.okCount,
  errorCount: r.errorCount,
  durationMs: r.durationMs,
  tokensIn: r.tokensIn,
  tokensOut: r.tokensOut,
  costUsd: r.costUsd,
})

const INGEST_PAYLOAD = (j: IngestJob) => ({
  jobId: j.id,
  source: j.source,
  status: j.status,
  total: j.total,
  done: j.done,
  cursor: j.cursor,
  runId: j.runId,
  error: j.error,
  createdAt: j.createdAt.toISOString(),
  updatedAt: j.updatedAt.toISOString(),
  finishedAt: j.finishedAt?.toISOString() ?? null,
})

export interface EventsStreamOptions {
  store: Store
  /** Poll interval for the lightweight db poll. Default 500ms. */
  pollMs?: number
}

/**
 * Build the SSE Response for one client. `resume` is the raw
 * Last-Event-ID/`since` value (undefined for a fresh connect).
 */
export function createEventsResponse(
  opts: EventsStreamOptions,
  resume: string | undefined,
): Response {
  const { store } = opts
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS
  const encoder = new TextEncoder()

  let linkCursor = 0
  let sinceTime = new Date(0)
  let closed = false
  let timer: ReturnType<typeof setInterval> | null = null
  let keepalive: ReturnType<typeof setInterval> | null = null

  // Per-connection change detection for the state-style families.
  const runSignatures = new Map<number, string>()
  const ingestSignatures = new Map<string, string>()
  let runPollSince = new Date(0)
  let pollInFlight = false

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (frame: string) => {
        if (closed) return
        try {
          controller.enqueue(encoder.encode(frame))
        } catch {
          closed = true
        }
      }

      // ---- resume -------------------------------------------------------
      const parsed = await parseResume(store, resume)
      linkCursor = parsed.linkSince
      sinceTime = parsed.sinceTime

      // Initial backlog: every link event after the cursor.
      for (;;) {
        const page = await store.listLinkEvents(linkCursor, LINK_PAGE)
        if (page.length === 0) break
        for (const entry of page) {
          linkCursor = entry.id
          sinceTime = entry.at
          send(sseFrame(String(entry.id), 'link', LINK_EVENT_PAYLOAD(entry)))
        }
        if (page.length < LINK_PAGE) break
      }

      // Run/ingest replay: activity after the resume watermark (minus a
      // small margin so an event emitted in the same poll tick is not lost).
      const replayFloor = new Date(sinceTime.getTime() - REPLAY_MARGIN_MS)
      const recentRuns = await store.listRuns({ since: replayFloor, limit: 500 })
      for (const run of recentRuns) {
        const sig = `${run.status ?? ''}:${runActivityAt(run).getTime()}`
        runSignatures.set(run.id, sig)
        send(sseFrame(`run:${run.id}`, 'run', RUN_PAYLOAD(run)))
      }
      const jobs = await store.listIngestJobs()
      for (const job of jobs) {
        if (job.status === 'done' && job.updatedAt.getTime() <= sinceTime.getTime()) continue
        ingestSignatures.set(job.id, ingestSignature(job))
        send(sseFrame(`ingest:${job.id}`, 'ingest', INGEST_PAYLOAD(job)))
      }

      // ---- live poll ----------------------------------------------------
      const poll = async () => {
        if (closed || pollInFlight) return
        pollInFlight = true
        try {
          const now = new Date()
          // Link journal: exact cursor replay, paged.
          for (;;) {
            const page = await store.listLinkEvents(linkCursor, LINK_PAGE)
            if (page.length === 0) break
            for (const entry of page) {
              linkCursor = entry.id
              sinceTime = entry.at
              send(sseFrame(String(entry.id), 'link', LINK_EVENT_PAYLOAD(entry)))
            }
            if (page.length < LINK_PAGE) break
          }

          // Runs: rows whose startedAt or finishedAt moved since the last
          // poll; emit only on signature change (start vs finish vs crash).
          const runs = await store.listRuns({
            since: new Date(runPollSince.getTime() - REPLAY_MARGIN_MS),
            limit: 500,
          })
          runPollSince = now
          for (const run of runs) {
            const sig = `${run.status ?? ''}:${runActivityAt(run).getTime()}`
            if (runSignatures.get(run.id) === sig) continue
            runSignatures.set(run.id, sig)
            send(sseFrame(`run:${run.id}`, 'run', RUN_PAYLOAD(run)))
          }

          // Ingest jobs: latest status of every job; emit on change.
          for (const job of await store.listIngestJobs()) {
            const sig = ingestSignature(job)
            if (ingestSignatures.get(job.id) === sig) continue
            ingestSignatures.set(job.id, sig)
            send(sseFrame(`ingest:${job.id}`, 'ingest', INGEST_PAYLOAD(job)))
          }
        } catch {
          // A poll failure must not kill the stream; the next tick retries.
        } finally {
          pollInFlight = false
        }
      }

      timer = setInterval(() => void poll(), pollMs)
      keepalive = setInterval(() => {
        send(': keepalive\n\n')
      }, KEEPALIVE_MS)
      // Run once immediately so a quiet journal still emits the backlog
      // above was already sent; the first poll catches post-resume changes.
      void poll()
    },
    cancel() {
      closed = true
      if (timer !== null) clearInterval(timer)
      if (keepalive !== null) clearInterval(keepalive)
    },
  })

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  })
}

function ingestSignature(job: IngestJob): string {
  return [
    job.status,
    job.total,
    job.done,
    job.cursor,
    job.updatedAt.getTime(),
    job.error ?? '',
  ].join(':')
}
