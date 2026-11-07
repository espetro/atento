/**
 * GET /api/events — resumable SSE over the pipeline journals.
 *
 * Three event families share one stream:
 *
 *   event: link    link_events row   (data.id = link_events.id)
 *   event: run     runs row          (data.id = runs.id)
 *   event: ingest  ingest_jobs row   (data.jobId = ingest_jobs.id)
 *
 * Every frame's `id:` field encodes the resume cursor for ALL families, so
 * a single `Last-Event-ID` reconnects exactly:
 *
 *   evt:{"l":<linkCursor>,"r":<runMs>,"i":<ingestMs>}
 *
 *   - `l` is the exact `link_events.id` high-water mark: link events replay
 *     strictly after it — no gaps, no duplicates.
 *   - `r`/`i` are conservative millisecond floors (the newest announced
 *     activity per family at emit time). On resume, run/ingest candidates
 *     newer than `floor - REPLAY_MARGIN_MS` are re-announced; a per-
 *     connection signature map then dedupes unchanged rows, so the replay
 *     is a bounded superset: at most the events from the margin window are
 *     repeated, and nothing in the gap is skipped. Run "activity" is
 *     `finishedAt ?? startedAt` — heartbeats deliberately do NOT advance
 *     it, so a running run announces start and finish, not every beat.
 *
 * Fresh connects (no Last-Event-ID / ?since=) start at the head: the link
 * journal is not replayed; the stream emits one snapshot frame per
 * in-flight run (`status='running'`) and ingest job (pending/running),
 * then only changes. Explicit cursors replay without a snapshot.
 *
 * Legacy id formats are still understood on resume: a bare number is a
 * link_events cursor, `run:<id>` / `ingest:<jobId>` anchor that family by
 * the row's current timestamp (approximate, kept for older clients).
 *
 * Mechanism: a lightweight poll of the SQLite store (no LISTEN/NOTIFY).
 */
import type { Store } from '@linkinbox/core'
import type { IngestJob, LinkHistoryEntry, Run } from '@linkinbox/core'

const DEFAULT_POLL_MS = 500
const KEEPALIVE_MS = 15_000
/** Candidate floor margin when resuming run/ingest by timestamp. */
const REPLAY_MARGIN_MS = 1_000
const LINK_PAGE = 500
const RUN_PAGE = 500

/** Per-family resume state carried inside every emitted `id:`. */
interface EventCursor {
  /** link_events.id high-water mark (exact). */
  link: number
  /** Newest announced run activity (finishedAt ?? startedAt) in ms. */
  runMs: number
  /** Newest announced ingest job updatedAt in ms. */
  ingestMs: number
}

/** The latest activity timestamp of a run row for announcement purposes.
 *  Heartbeats are excluded on purpose: they are liveness, not transitions. */
function runAnnouncedAt(run: Run): Date {
  return run.finishedAt ?? run.startedAt
}

function runSignature(run: Run): string {
  return `${run.status ?? ''}:${runAnnouncedAt(run).getTime()}`
}

function encodeCursor(cursor: EventCursor): string {
  return `evt:${JSON.stringify({ l: cursor.link, r: cursor.runMs, i: cursor.ingestMs })}`
}

/**
 * The link_events cursor whose `at` is the greatest timestamp <= `time`.
 * Binary search over the monotonic id space using listLinkEvents pages.
 * Only used for legacy (pre-`evt:`) resume ids.
 */
async function linkCursorAtOrBefore(store: Store, time: Date): Promise<number> {
  const hi = await store.linkEventCursor()
  if (hi === 0) return 0
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

type ParsedResume = { head: true } | { head: false; cursor: EventCursor }

/** Parse a Last-Event-ID / since value into per-family resume floors. */
async function parseResume(store: Store, raw: string | undefined): Promise<ParsedResume> {
  if (raw === undefined || raw === '') return { head: true }
  if (raw.startsWith('evt:')) {
    try {
      const parsed = JSON.parse(raw.slice(4)) as {
        l?: unknown
        r?: unknown
        i?: unknown
      }
      if (
        typeof parsed.l === 'number' &&
        typeof parsed.r === 'number' &&
        typeof parsed.i === 'number'
      ) {
        return {
          head: false,
          cursor: { link: parsed.l, runMs: parsed.r, ingestMs: parsed.i },
        }
      }
    } catch {
      // fall through to head
    }
    return { head: true }
  }
  if (/^\d+$/.test(raw)) {
    // Legacy bare link_events id: anchor run/ingest at that event's time.
    const link = Number(raw)
    const rows = await store.listLinkEvents(link - 1, 1)
    const at = rows.length > 0 && rows[0]!.id === link ? rows[0]!.at.getTime() : Date.now()
    return { head: false, cursor: { link, runMs: at, ingestMs: at } }
  }
  if (raw.startsWith('run:')) {
    const id = Number(raw.slice(4))
    if (Number.isInteger(id) && id > 0) {
      const run = await store.getRun(id)
      const at = run !== null ? runAnnouncedAt(run).getTime() : Date.now()
      return {
        head: false,
        cursor: {
          link: await linkCursorAtOrBefore(store, new Date(at)),
          runMs: at,
          ingestMs: at,
        },
      }
    }
  }
  if (raw.startsWith('ingest:')) {
    const jobId = raw.slice('ingest:'.length)
    const job = await store.getIngestJob(jobId)
    const at = job !== null ? job.updatedAt.getTime() : Date.now()
    return {
      head: false,
      cursor: {
        link: await linkCursorAtOrBefore(store, new Date(at)),
        runMs: at,
        ingestMs: at,
      },
    }
  }
  // Unknown format: fail safe — start at the head like a fresh connect.
  return { head: true }
}

/**
 * Cursor for a fresh connect: link journal at its head, run/ingest floors
 * at now. Existing rows are silenced by signature seeding (see start()),
 * so a fresh connect emits no history — only the in-flight snapshot and
 * new work.
 */
async function headCursor(store: Store): Promise<EventCursor> {
  const now = Date.now()
  return { link: await store.linkEventCursor(), runMs: now, ingestMs: now }
}

function sseFrame(id: string | null, event: string, data: unknown): string {
  const lines: string[] = []
  if (id !== null) lines.push(`id: ${id}`)
  lines.push(`event: ${event}`)
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
  // Pre-journal rows carry no status: report null, not a guessed 'done'.
  status: r.status ?? null,
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

  let closed = false
  let timer: ReturnType<typeof setInterval> | null = null
  let keepalive: ReturnType<typeof setInterval> | null = null

  // Per-connection change detection for the state-style families. The
  // cursor floors in `id:` bound the candidate set; these signatures make
  // the emission exact within the connection (no repeat announcements for
  // an unchanged row).
  const runSignatures = new Map<number, string>()
  const ingestSignatures = new Map<string, string>()
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

      const parsed = await parseResume(store, resume)
      // Fresh connects start at the head; explicit cursors replay.
      const cursor: EventCursor = parsed.head ? await headCursor(store) : parsed.cursor

      const emitLink = (entry: LinkHistoryEntry) => {
        cursor.link = entry.id
        send(sseFrame(encodeCursor(cursor), 'link', LINK_EVENT_PAYLOAD(entry)))
      }
      const emitRun = (run: Run) => {
        cursor.runMs = Math.max(cursor.runMs, runAnnouncedAt(run).getTime())
        runSignatures.set(run.id, runSignature(run))
        send(sseFrame(encodeCursor(cursor), 'run', RUN_PAYLOAD(run)))
      }
      const emitIngest = (job: IngestJob) => {
        cursor.ingestMs = Math.max(cursor.ingestMs, job.updatedAt.getTime())
        ingestSignatures.set(job.id, ingestSignature(job))
        send(sseFrame(encodeCursor(cursor), 'ingest', INGEST_PAYLOAD(job)))
      }

      // ---- catch-up / replay ---------------------------------------------
      //
      // Link events: exact cursor replay, paged. For a head connect the
      // cursor is already the journal max, so this emits nothing.
      const drainLinks = async () => {
        for (;;) {
          const page = await store.listLinkEvents(cursor.link, LINK_PAGE)
          if (page.length === 0) break
          for (const entry of page) emitLink(entry)
          if (page.length < LINK_PAGE) break
        }
      }

      // Run candidates: rows whose startedAt or finishedAt moved inside the
      // floor margin; the signature map drops rows already announced.
      // Keyset-paginated by run id: emitRun advances cursor.runMs to the
      // max announced activity, so a single truncated page could push the
      // floor past candidates that were never scanned (a low-id run
      // finishing last would permanently skip higher-id pending runs).
      // Paging until exhaustion keeps the floor honest; each page stays
      // bounded.
      const drainRuns = async () => {
        const floor = new Date(cursor.runMs - REPLAY_MARGIN_MS)
        let afterId: number | undefined
        for (;;) {
          const page = await store.listRuns({
            since: floor,
            limit: RUN_PAGE,
            ...(afterId !== undefined ? { afterId } : {}),
          })
          if (page.length === 0) break
          for (const run of page) {
            const sig = runSignature(run)
            if (runSignatures.get(run.id) === sig) continue
            emitRun(run)
          }
          afterId = page[page.length - 1]!.id
          if (page.length < RUN_PAGE) break
        }
      }

      // Ingest candidates: every job touched inside the floor window. The
      // signature map — seeded on head connects, empty on resume — decides
      // what actually emits, so the millisecond floor only bounds the scan.
      const drainIngest = async () => {
        const floor = cursor.ingestMs - REPLAY_MARGIN_MS
        for (const job of await store.listIngestJobs()) {
          if (job.updatedAt.getTime() < floor) continue
          const sig = ingestSignature(job)
          if (ingestSignatures.get(job.id) === sig) continue
          emitIngest(job)
        }
      }

      // Fresh connect: seed the signature maps with every existing row so
      // the margin-window candidates stay silent (no history replay), then
      // announce in-flight work once — bounded by the number of active
      // runs/jobs. Explicit cursors skip both steps and replay instead.
      if (parsed.head) {
        const now = Date.now()
        // Seed signatures for exactly the rows drainRuns can see as
        // candidates (same floor), paginated so a >page backlog cannot
        // leave rows unseeded — an unseeded candidate would replay as if
        // it were new work.
        const seedFloor = new Date(now - REPLAY_MARGIN_MS)
        let seedAfterId: number | undefined
        for (;;) {
          const page = await store.listRuns({
            since: seedFloor,
            limit: RUN_PAGE,
            ...(seedAfterId !== undefined ? { afterId: seedAfterId } : {}),
          })
          if (page.length === 0) break
          for (const run of page) runSignatures.set(run.id, runSignature(run))
          seedAfterId = page[page.length - 1]!.id
          if (page.length < RUN_PAGE) break
        }
        for (const job of await store.listIngestJobs()) {
          ingestSignatures.set(job.id, ingestSignature(job))
        }
        for (const entry of await store.listRunningRuns()) {
          const run = await store.getRun(entry.id)
          if (run !== null) emitRun(run)
        }
        for (const job of await store.listIngestJobs({
          status: ['pending', 'running'],
        })) {
          emitIngest(job)
        }
      }

      await drainLinks()
      await drainRuns()
      await drainIngest()

      // ---- live poll ----------------------------------------------------
      const poll = async () => {
        if (closed || pollInFlight) return
        pollInFlight = true
        try {
          await drainLinks()
          await drainRuns()
          await drainIngest()
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
