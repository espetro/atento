import Database from 'better-sqlite3'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { eq, inArray, and, gte, lte, sql } from 'drizzle-orm'
import {
  SCHEMA_VERSION,
  links,
  linkEvents,
  meta,
  metrics,
  profiles,
  runs,
  hostState,
  mediaBudget,
  ingestJobs,
  type LinkRow,
  type IngestJobRow,
} from './schema.js'
import { runMigrations } from './migrations.js'
import type {
  Link,
  LinkFilter,
  LinkInput,
  Metric,
  MetricFilter,
  Profile,
  ProfileInput,
  RawLink,
  Run,
  Status,
  Store,
  Enrichment,
  IngestJob,
  IngestJobStatus,
  LinkEvent,
  LinkState,
  LinkStateName,
  TransitionOutcome,
  LinkHistoryEntry,
  HostState,
  MediaReport,
} from '@linkinbox/core'
import {
  transition,
  parseLinkState,
  legacyStatus,
  isTerminal,
  LINK_STATES,
  LEASED_STATES,
  normalizeUrl,
  pidAlive,
  heartbeatStale,
  RUN_STALE_MS,
  type AcquireRunResult,
  type RunJournalEntry,
  type RunJournalStatus,
  type NewIngestJob,
  type IngestChunkCommit,
  type IngestItemResult,
  type LinkPatch,
} from '@linkinbox/core'

export interface SqliteStoreOptions {
  /** Path to the sqlite file, or ':memory:'. */
  path: string
  /** WAL is on for file DBs; memory DBs keep it off (WAL is meaningless there). */
  wal?: boolean
  busyTimeoutMs?: number
}

const DEFAULT_BUSY_TIMEOUT_MS = 5000

type Db = BetterSQLite3Database<Record<string, never>>

/**
 * SQLite Store implementation: better-sqlite3 (synchronous) under drizzle.
 * All pipeline stages consume this through the `Store` interface.
 */
export class SqliteStore implements Store {
  private readonly sqlite: Database.Database
  private readonly db: Db
  private readonly ownsSqlite: boolean

  constructor(options: SqliteStoreOptions)
  /** Wrap an existing better-sqlite3 handle (does not close it on close()). */
  constructor(sqlite: Database.Database)
  constructor(arg: SqliteStoreOptions | Database.Database) {
    if (typeof arg === 'object' && 'path' in arg === false && 'exec' in arg) {
      this.sqlite = arg as Database.Database
      this.ownsSqlite = false
      // Same durability contract as the owned-handle path.
      this.sqlite.pragma('synchronous = FULL')
      this.db = drizzle(this.sqlite) as unknown as Db
      return
    }
    const opts = arg as SqliteStoreOptions
    this.ownsSqlite = true
    this.sqlite = new Database(opts.path)
    const busy = opts.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS
    this.sqlite.pragma(`busy_timeout = ${busy}`)
    if (opts.wal !== false && opts.path !== ':memory:') {
      this.sqlite.pragma('journal_mode = WAL')
    }
    this.sqlite.pragma('foreign_keys = ON')
    // Durability: every commit is fsynced before it is acknowledged. WAL
    // stays on for file DBs; synchronous=FULL makes each commit wait for
    // the WAL frames to hit stable storage.
    this.sqlite.pragma('synchronous = FULL')
    this.db = drizzle(this.sqlite) as unknown as Db
  }

  /** Run a PRAGMA. `simple: true` returns the first row column as a scalar. */
  pragma(source: string, options?: { simple?: boolean }): unknown {
    return this.sqlite.pragma(source, options)
  }

  /**
   * Consistent online backup of the database to `destPath` (better-sqlite3's
   * backup API). Safe while the store is open and serving: the backup is a
   * snapshot, WAL included. The destination is created/truncated.
   */
  async backup(destPath: string): Promise<void> {
    // better-sqlite3 refuses to create missing directories: make the parent
    // first so `backup('backups/snap.db')` just works.
    await mkdir(dirname(destPath), { recursive: true })
    await this.sqlite.backup(destPath)
  }

  /** All run rows, newest first. Convenience for the metrics CLI. */
  allRuns(): Run[] {
    return this.db
      .select()
      .from(runs)
      .orderBy(sql`${runs.startedAt} DESC, ${runs.id} DESC`)
      .all()
      .map((r) => ({
        id: r.id,
        stage: r.stage,
        status: (r.status as RunJournalStatus | null) ?? null,
        pid: r.pid ?? null,
        heartbeatAt: r.heartbeatAt ?? null,
        startedAt: r.startedAt,
        finishedAt: r.finishedAt ?? null,
        inputCount: r.inputCount,
        okCount: r.okCount,
        errorCount: r.errorCount,
        durationMs: r.durationMs ?? null,
        tokensIn: r.tokensIn ?? null,
        tokensOut: r.tokensOut ?? null,
        costUsd: r.costUsd ?? null,
      }))
  }

  async migrate(): Promise<void> {
    const applied = runMigrations(this.sqlite)
    if (applied.length > 0 || (await this.getMeta('schema_version')) === null) {
      this.setMetaSync('schema_version', SCHEMA_VERSION)
    }
  }

  /** Migration names recorded as applied on this database. */
  appliedMigrations(): string[] {
    return this.db
      .select({ key: meta.key })
      .from(meta)
      .where(sql`${meta.key} LIKE 'migration:%'`)
      .all()
      .map((r) => r.key.slice('migration:'.length))
      .sort()
  }

  async schemaVersion(): Promise<string> {
    const row = this.db.select().from(meta).where(eq(meta.key, 'schema_version')).get()
    return row?.value ?? '0'
  }

  async close(): Promise<void> {
    if (this.ownsSqlite) this.sqlite.close()
  }

  async upsertLink(input: LinkInput): Promise<Link> {
    return this.upsertLinkSync(input, new Date())
  }

  /**
   * Synchronous upsert core, callable inside a better-sqlite3 transaction
   * (commitIngestChunk). All drizzle calls here are synchronous.
   */
  private upsertLinkSync(input: LinkInput, now: Date): Link {
    // FSM: a tombstoned url is never resurrected by a re-import.
    const tombstone = this.db
      .select({ id: links.id })
      .from(links)
      .where(and(eq(links.urlHash, input.urlHash), eq(links.state, 'deleted')))
      .get()
    if (tombstone) {
      const existing = this.db.select().from(links).where(eq(links.id, tombstone.id)).get()
      return fromRow(existing!)
    }
    const row = toRow(input, now)
    // FSM: a freshly stored link starts in the state that matches its
    // legacy status column, so old rows and new rows agree.
    if (!input.state) {
      // Derive the initial state from the actual data, so a link with
      // enrichment content but no explicit state still lands in inbox.
      if (row.enrichment !== null || (row.category !== null && row.category !== undefined)) {
        row.state = 'inbox'
        row.stateData = { enriched: true }
      } else if (row.extractedContent !== null && row.extractedContent !== undefined) {
        row.state = 'extracted'
        row.stateData = { chars: row.extractedContent.length }
      } else {
        row.state = input.status ? stateForLegacyStatus(row.status ?? 'inbox') : 'created'
        row.stateData = input.status ? dataForLegacyStatus(row.status ?? 'inbox', row, now) : {}
      }
    }
    const inserted = this.db
      .insert(links)
      .values(row)
      .onConflictDoUpdate({
        target: links.urlHash,
        set: {
          url: row.url,
          title: row.title,
          source: row.source,
          addedAt: row.addedAt,
          note: row.note,
          tags: row.tags,
          updatedAt: now,
          // ingest is idempotent and non-destructive: never clobber
          // downstream fields (enrichment, extraction, status) on re-import.
        },
      })
      .returning()
      .get()
    return fromRow(inserted)
  }

  async getLink(id: number): Promise<Link | null> {
    const row = this.db.select().from(links).where(eq(links.id, id)).get()
    return row ? fromRow(row) : null
  }

  async getLinkByUrlHash(urlHash: string): Promise<Link | null> {
    const row = this.db.select().from(links).where(eq(links.urlHash, urlHash)).get()
    return row ? fromRow(row) : null
  }

  async listLinks(filter?: LinkFilter): Promise<Link[]> {
    const conds = []
    if (filter?.status) {
      if (filter.byState === true) {
        conds.push(eq(links.state, filter.status))
      } else {
        conds.push(eq(links.status, filter.status))
      }
    }
    if (filter?.category) conds.push(eq(links.category, filter.category))
    if (filter?.staleAsOf) {
      conds.push(sql`${links.expiresAt} IS NOT NULL AND ${links.expiresAt} < ${filter.staleAsOf.getTime()}`)
    }
    const q = this.db.select().from(links)
    const filtered = conds.length ? q.where(and(...conds)) : q
    const ordered = filtered.orderBy(sql`${links.createdAt} DESC, ${links.id} DESC`)
    const paged = filter?.limit !== undefined ? ordered.limit(filter.limit) : ordered
    const final = filter?.offset !== undefined ? paged.offset(filter.offset) : paged
    return final.all().map(fromRow)
  }

  async countLinks(filter?: LinkFilter): Promise<number> {
    const conds = []
    if (filter?.status) {
      if (filter.byState === true) {
        conds.push(eq(links.state, filter.status))
      } else {
        conds.push(eq(links.status, filter.status))
      }
    }
    if (filter?.category) conds.push(eq(links.category, filter.category))
    if (filter?.staleAsOf) {
      conds.push(sql`${links.expiresAt} IS NOT NULL AND ${links.expiresAt} < ${filter.staleAsOf.getTime()}`)
    }
    const q = this.db.select({ n: sql<number>`count(*)` }).from(links)
    const filtered = conds.length ? q.where(and(...conds)) : q
    const r = filtered.get()
    return Number(r?.n ?? 0)
  }

  async updateStatus(ids: number[], status: Status, updatedAt?: Date): Promise<number> {
    if (ids.length === 0) return 0
    // Legacy signature preserved: routes every change through the FSM so no
    // code path writes a state directly. Links that cannot legally make the
    // move are skipped (idempotent for callers that just bulk-archive).
    const at = updatedAt ?? new Date()
    let updated = 0
    for (const id of ids) {
      const link = await this.getLink(id)
      if (!link) continue
      const outcome = await this.applyEvent(
        id,
        eventForStatus(status, at),
        link.state as LinkStateName,
      )
      if (outcome.ok) updated += 1
    }
    return updated
  }

  async deleteLinks(ids: number[]): Promise<number> {
    if (ids.length === 0) return 0
    // FSM semantics: prune does not remove the row. It moves the link to the
    // terminal `deleted` state and purges bulky content while keeping the
    // url_hash so a re-import can never resurrect it.
    const at = new Date()
    let deleted = 0
    for (const id of ids) {
      const outcome = await this.applyEvent(id, { type: 'DELETE', at: at.toISOString() })
      if (outcome.ok) deleted += 1
    }
    return deleted
  }

  async setEnrichment(id: number, enrichment: Enrichment, updatedAt?: Date): Promise<number> {
    // FSM: the enrichment payload is written together with the ENRICHED
    // transition. Illegal moves (e.g. from deleted) leave the row untouched.
    const at = updatedAt ?? new Date()
    const link = await this.getLink(id)
    if (!link || isTerminal(parseLinkState(link.state, link.stateData))) return 0
    const tx = this.sqlite.transaction(() => {
      this.db
        .update(links)
        .set({
          enrichment,
          category: enrichment.category,
          priority: enrichment.priority,
          action: enrichment.action,
          confidence: enrichment.confidence,
          readMinutes: enrichment.read_minutes,
          expiresAt: enrichment.expires_at ? new Date(enrichment.expires_at) : null,
          expiryReason: enrichment.expiry_reason,
          updatedAt: at,
        })
        .where(eq(links.id, id))
        .run()
    })
    tx()
    return 1
  }

  async setExpiry(
    id: number,
    expiresAt: Date | null,
    expiryReason: string | null,
    updatedAt?: Date,
  ): Promise<number> {
    const r = this.db
      .update(links)
      .set({ expiresAt, expiryReason, updatedAt: updatedAt ?? new Date() })
      .where(eq(links.id, id))
      .run()
    return r.changes
  }

  async setExtractedContent(
    id: number,
    content: string,
    needsBrowser: boolean,
    extractedAt?: Date,
  ): Promise<number> {
    // FSM: content is written together with the EXTRACTED transition.
    const at = extractedAt ?? new Date()
    const link = await this.getLink(id)
    if (!link) return 0
    const tx = this.sqlite.transaction(() => {
      this.db
        .update(links)
        .set({
          extractedContent: content,
          needsBrowser,
          extractedAt: at,
          updatedAt: at,
        })
        .where(eq(links.id, id))
        .run()
    })
    tx()
    return 1
  }

  async updateTitle(id: number, title: string, updatedAt?: Date): Promise<number> {
    const r = this.db
      .update(links)
      .set({ title, updatedAt: updatedAt ?? new Date() })
      .where(eq(links.id, id))
      .run()
    return r.changes
  }

  async markCaptured(id: number, capturedAt: Date, updatedAt?: Date): Promise<number> {
    const r = this.db
      .update(links)
      .set({ captured: true, capturedAt, updatedAt: updatedAt ?? new Date() })
      .where(eq(links.id, id))
      .run()
    return r.changes
  }

  async setMediaReport(id: number, report: MediaReport, updatedAt?: Date): Promise<number> {
    const r = this.db
      .update(links)
      .set({ mediaReport: report, updatedAt: updatedAt ?? new Date() })
      .where(eq(links.id, id))
      .run()
    return r.changes
  }

  /**
   * Atomically patch link columns: one UPDATE statement, so the whole patch
   * commits or none of it does. For writes that belong to an FSM event use
   * `applyEvent(..., patch)` instead — it lands in the same transaction as
   * the transition.
   */
  async patchLink(id: number, patch: LinkPatch, updatedAt?: Date): Promise<number> {
    const set = patchColumns(patch)
    if (Object.keys(set).length === 0) return 0
    const r = this.db
      .update(links)
      .set({ ...set, updatedAt: updatedAt ?? new Date() })
      .where(eq(links.id, id))
      .run()
    return r.changes
  }

  async getMediaBudget(
    day: string,
  ): Promise<{ total: number; byTier: Record<string, number> }> {
    const row = this.db.select().from(mediaBudget).where(eq(mediaBudget.day, day)).get()
    return { total: row?.total ?? 0, byTier: { ...(row?.byTier ?? {}) } }
  }

  async saveMediaBudget(
    day: string,
    budget: { total: number; byTier: Record<string, number> },
  ): Promise<void> {
    this.db
      .insert(mediaBudget)
      .values({ day, total: budget.total, byTier: budget.byTier })
      .onConflictDoUpdate({
        target: mediaBudget.day,
        set: { total: budget.total, byTier: budget.byTier },
      })
      .run()
  }

  /**
   * FSM: apply one event atomically. The state change is a compare-and-set
   * (`WHERE id = ? AND state = ?`), so two concurrent runners can never take
   * the same link. The event history row — and any `patch` column writes —
   * are written in the same transaction: a result and its FSM event commit
   * together or not at all.
   */
  async applyEvent(
    linkId: number,
    event: LinkEvent,
    expected?: LinkStateName,
    patch?: LinkPatch,
  ): Promise<TransitionOutcome> {
    const now = new Date()
    // The event carries its own clock, so the recorded lease start (and the
    // history timestamp) reflect when the event happened, not when the write
    // landed.
    const at = new Date(event.at)
    const row = this.db.select().from(links).where(eq(links.id, linkId)).get()
    if (!row) {
      return {
        ok: false,
        error: {
          code: 'STALE_STATE',
          from: 'created',
          expected,
          message: `link ${linkId} does not exist`,
        },
      }
    }
    const currentName = row.state as LinkStateName
    if (expected !== undefined && expected !== currentName) {
      return {
        ok: false,
        error: {
          code: 'STALE_STATE',
          from: currentName,
          expected,
          message: `link ${linkId} is in state ${currentName}, expected ${expected}`,
        },
      }
    }
    const current = parseLinkState(currentName, row.stateData)
    const result = transition(current, event, at)
    if (!result.ok) {
      return {
        ok: false,
        error: {
          code: 'ILLEGAL_TRANSITION',
          from: result.error.from,
          event: result.error.event,
          message: result.error.message,
        },
      }
    }
    const next = result.state
    const payload = { ...next } as Record<string, unknown>
    delete payload['state']
    const tx = this.sqlite.transaction(() => {
      const updated = this.db
        .update(links)
        .set({
          state: next.state,
          stateData: payload,
          status: legacyStatus(next),
          updatedAt: now,
          // The patch lands before the tombstone purge so a DELETE can never
          // be talked into keeping bulky content: purge wins on `deleted`.
          ...patchColumns(patch),
          ...purgeForState(next, row),
        })
        .where(and(eq(links.id, linkId), eq(links.state, currentName)))
        .run()
      if (updated.changes !== 1) {
        throw new LostRace(linkId, currentName)
      }
      this.db
        .insert(linkEvents)
        .values({
          linkId,
          fromState: currentName,
          toState: next.state,
          event: event.type,
          data: event as unknown as Record<string, unknown>,
          at,
        })
        .run()
    })
    try {
      tx()
    } catch (err) {
      if (err instanceof LostRace) {
        return {
          ok: false,
          error: {
            code: 'STALE_STATE',
            from: currentName,
            expected,
            message: `link ${linkId} changed concurrently`,
          },
        }
      }
      throw err
    }
    return { ok: true, state: next, from: currentName }
  }

  /** Append-only history for one link, oldest first. */
  async getHistory(linkId: number): Promise<LinkHistoryEntry[]> {
    return this.db
      .select()
      .from(linkEvents)
      .where(eq(linkEvents.linkId, linkId))
      .orderBy(sql`${linkEvents.id} ASC`)
      .all()
      .map((r) => ({
        id: r.id,
        linkId: r.linkId,
        fromState: r.fromState,
        toState: r.toState,
        event: r.event,
        data: (r.data as Record<string, unknown> | null) ?? null,
        at: r.at,
      }))
  }

  /** State histogram: how many links sit in each state. */
  async countByState(): Promise<Record<LinkStateName, number>> {
    const rows = this.db
      .select({ state: links.state, n: sql<number>`count(*)` })
      .from(links)
      .groupBy(links.state)
      .all()
    const out = {} as Record<LinkStateName, number>
    for (const name of LINK_STATES) out[name] = 0
    for (const r of rows) out[r.state as LinkStateName] = Number(r.n)
    return out
  }

  /** Links currently in one of the given FSM states. */
  async listByStates(states: LinkStateName[], limit?: number): Promise<Link[]> {
    if (states.length === 0) return []
    const q = this.db.select().from(links).where(inArray(links.state, states))
    const ordered = q.orderBy(sql`${links.createdAt} ASC, ${links.id} ASC`)
    const paged = limit !== undefined ? ordered.limit(limit) : ordered
    return paged.all().map(fromRow)
  }

  /**
   * Return every leased link whose lease expired before `cutoff` to its queue
   * state. A killed process never strands a link: the next run picks it up.
   */
  async reclaimExpiredLeases(cutoff: Date): Promise<number> {
    const rows = this.db
      .select({ id: links.id })
      .from(links)
      .where(inArray(links.state, LEASED_STATES))
      .all()
    let reclaimed = 0
    for (const row of rows) {
      const state = await this.getState(row.id)
      if (!state || (state.state !== 'extracting' && state.state !== 'enriching')) continue
      if (new Date(state.startedAt).getTime() >= cutoff.getTime()) continue
      const outcome = await this.applyEvent(row.id, {
        type: 'LEASE_EXPIRED',
        at: new Date().toISOString(),
      })
      if (outcome.ok) reclaimed += 1
    }
    return reclaimed
  }

  /**
   * Return every leased link owned by one of `runIds` to its queue state.
   * The lease owner lives in the FSM payload (`state_data.runId`), written
   * by the stage's STARTED event, so the reclaim goes through the same
   * compare-and-set path as every other transition.
   */
  async reclaimLeasesForRuns(runIds: number[], at?: Date): Promise<number> {
    if (runIds.length === 0) return 0
    const wanted = new Set(runIds)
    const rows = this.db
      .select({ id: links.id })
      .from(links)
      .where(inArray(links.state, LEASED_STATES))
      .all()
    let reclaimed = 0
    for (const row of rows) {
      const state = await this.getState(row.id)
      if (!state || (state.state !== 'extracting' && state.state !== 'enriching')) continue
      const owner = state.runId
      if (owner === undefined || !wanted.has(owner)) continue
      const outcome = await this.applyEvent(row.id, {
        type: 'LEASE_EXPIRED',
        at: (at ?? new Date()).toISOString(),
      })
      if (outcome.ok) reclaimed += 1
    }
    return reclaimed
  }

  /**
   * Single-writer lock for one stage. The check-and-insert runs in one
   * `BEGIN IMMEDIATE` transaction (better-sqlite3 `.immediate()`), so two
   * processes can never both observe "no running row" and both insert.
   */
  async acquireRun(
    stage: string,
    opts: { pid?: number; now?: Date } = {},
  ): Promise<AcquireRunResult> {
    const now = opts.now ?? new Date()
    const pid = opts.pid ?? process.pid
    const acquire = this.sqlite.transaction(() => {
      const holder = this.db
        .select()
        .from(runs)
        .where(and(eq(runs.stage, stage), eq(runs.status, 'running')))
        .orderBy(sql`${runs.id} ASC`)
        .get()
      if (holder) return { ok: false as const, busy: journalFromRow(holder) }
      const row = this.db
        .insert(runs)
        .values({
          stage,
          status: 'running',
          pid,
          heartbeatAt: now,
          startedAt: now,
          inputCount: 0,
        })
        .returning()
        .get()
      return { ok: true as const, run: journalFromRow(row) }
    })
    return acquire.immediate()
  }

  async heartbeatRun(id: number, at?: Date): Promise<void> {
    this.db
      .update(runs)
      .set({ heartbeatAt: at ?? new Date() })
      .where(and(eq(runs.id, id), eq(runs.status, 'running')))
      .run()
  }

  async listRunningRuns(): Promise<RunJournalEntry[]> {
    return this.db
      .select()
      .from(runs)
      .where(eq(runs.status, 'running'))
      .orderBy(sql`${runs.id} ASC`)
      .all()
      .map(journalFromRow)
  }

  /**
   * Mark `running` journal rows `crashed` when their owner is gone: the pid
   * is dead or the heartbeat is stale. A row with no pid and no heartbeat
   * falls back to its `started_at` for the staleness check.
   */
  async reclaimDeadRuns(
    opts: {
      now?: Date
      heartbeatStaleMs?: number
      pidAlive?: (pid: number) => boolean
    } = {},
  ): Promise<RunJournalEntry[]> {
    const now = opts.now ?? new Date()
    const staleMs = opts.heartbeatStaleMs ?? RUN_STALE_MS
    const alive = opts.pidAlive ?? pidAlive
    const running = await this.listRunningRuns()
    const crashed: RunJournalEntry[] = []
    for (const entry of running) {
      const pidDead = entry.pid !== null && !alive(entry.pid)
      const stale = heartbeatStale(entry, now, staleMs)
      if (!pidDead && !stale) continue
      this.db
        .update(runs)
        .set({ status: 'crashed', finishedAt: now })
        .where(and(eq(runs.id, entry.id), eq(runs.status, 'running')))
        .run()
      crashed.push({ ...entry, status: 'crashed', finishedAt: now })
    }
    return crashed
  }

  // ---- ingest jobs ----

  async createIngestJob(job: NewIngestJob): Promise<IngestJob> {
    const now = new Date()
    const row = this.db
      .insert(ingestJobs)
      .values({
        id: job.id,
        source: job.source,
        status: 'pending',
        total: job.total ?? 0,
        done: 0,
        cursor: 0,
        spoolPath: job.spoolPath ?? null,
        runId: null,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get()
    return jobFromRow(row)
  }

  async getIngestJob(id: string): Promise<IngestJob | null> {
    const row = this.db.select().from(ingestJobs).where(eq(ingestJobs.id, id)).get()
    return row ? jobFromRow(row) : null
  }

  async updateIngestJob(
    id: string,
    patch: {
      status?: IngestJobStatus
      total?: number
      done?: number
      cursor?: number
      spoolPath?: string | null
      runId?: number | null
      error?: string | null
      finishedAt?: Date | null
      updatedAt?: Date
    },
  ): Promise<void> {
    const set: Partial<typeof ingestJobs.$inferInsert> = {
      updatedAt: patch.updatedAt ?? new Date(),
    }
    if (patch.status !== undefined) set.status = patch.status
    if (patch.total !== undefined) set.total = patch.total
    if (patch.done !== undefined) set.done = patch.done
    if (patch.cursor !== undefined) set.cursor = patch.cursor
    if (patch.spoolPath !== undefined) set.spoolPath = patch.spoolPath
    if (patch.runId !== undefined) set.runId = patch.runId
    if (patch.error !== undefined) set.error = patch.error
    if (patch.finishedAt !== undefined) set.finishedAt = patch.finishedAt
    this.db.update(ingestJobs).set(set).where(eq(ingestJobs.id, id)).run()
  }

  async listIngestJobs(filter?: {
    status?: IngestJobStatus | IngestJobStatus[]
    limit?: number
  }): Promise<IngestJob[]> {
    const conds = []
    if (filter?.status !== undefined) {
      const statuses = Array.isArray(filter.status) ? filter.status : [filter.status]
      conds.push(inArray(ingestJobs.status, statuses))
    }
    const q = this.db.select().from(ingestJobs)
    const filtered = conds.length ? q.where(and(...conds)) : q
    const ordered = filtered.orderBy(sql`${ingestJobs.createdAt} ASC, ${ingestJobs.id} ASC`)
    const paged = filter?.limit !== undefined ? ordered.limit(filter.limit) : ordered
    return paged.all().map(jobFromRow)
  }

  /**
   * Commit one chunk of spooled input atomically: every link upsert AND the
   * job's cursor/done advance happen in one BEGIN IMMEDIATE transaction, so
   * a crash can never leave links written past the recorded cursor. Per-item
   * failures are captured in the result — the chunk still commits.
   */
  async commitIngestChunk(
    jobId: string,
    raws: RawLink[],
    opts: { now?: Date } = {},
  ): Promise<IngestChunkCommit> {
    const now = opts.now ?? new Date()
    const commit = this.sqlite.transaction((): IngestChunkCommit => {
      const job = this.db
        .select()
        .from(ingestJobs)
        .where(eq(ingestJobs.id, jobId))
        .get()
      if (!job) {
        throw new Error(`ingest job ${jobId} does not exist`)
      }
      const items: IngestItemResult[] = []
      let inserted = 0
      let updated = 0
      for (const raw of raws) {
        try {
          const { url, hash } = normalizeUrl(raw.url)
          const existing = this.db
            .select({ id: links.id })
            .from(links)
            .where(eq(links.urlHash, hash))
            .get()
          const link = this.upsertLinkSync(
            {
              urlHash: hash,
              url,
              title: raw.title ?? null,
              source: raw.source,
              addedAt: raw.addedAt ?? null,
              note: raw.note ?? null,
              tags: raw.tags ?? null,
              status: 'inbox',
              needsBrowser: false,
              captured: false,
              capturedAt: null,
              // FSM: a freshly ingested link starts in the `created` state.
              state: 'created',
              stateData: {},
            },
            now,
          )
          if (existing) {
            updated += 1
            items.push({ linkId: link.id, url, ok: true, duplicate: true })
          } else {
            inserted += 1
            items.push({ linkId: link.id, url, ok: true, duplicate: false })
          }
        } catch (err) {
          items.push({
            linkId: -1,
            url: raw.url,
            ok: false,
            duplicate: false,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }
      const cursor = job.cursor + raws.length
      const done = job.done + raws.length
      this.db
        .update(ingestJobs)
        .set({ cursor, done, updatedAt: now })
        .where(eq(ingestJobs.id, jobId))
        .run()
      return { cursor, done, inserted, updated, items }
    })
    return commit.immediate()
  }

  /** FSM state of one link, zod-validated. */
  async getState(id: number): Promise<LinkState | null> {
    const row = this.db
      .select({ state: links.state, stateData: links.stateData })
      .from(links)
      .where(eq(links.id, id))
      .get()
    if (!row) return null
    return parseLinkState(row.state, row.stateData)
  }

  /**
   * Rewrite the state payload without changing the state. The payload is
   * validated against the state schema, so a bad payload is rejected before
   * it reaches the row.
   */
  async setStateData(id: number, data: Record<string, unknown>): Promise<number> {
    const row = this.db
      .select({ state: links.state, stateData: links.stateData })
      .from(links)
      .where(eq(links.id, id))
      .get()
    if (!row) return 0
    const merged = { ...((row.stateData as Record<string, unknown> | null) ?? {}), ...data }
    // Validate the payload against the state schema before writing it.
    parseLinkState(row.state, merged)
    const r = this.db
      .update(links)
      .set({ stateData: merged, updatedAt: new Date() })
      .where(eq(links.id, id))
      .run()
    return r.changes
  }

  /**
   * Legacy metrics row: NOT a journal lock. The row is inserted already
   * `done`-ish (non-'running') so it can never be mistaken for an
   * `acquireRun` holder, reclaimed as crashed, or block a stage. Stage
   * work must go through `acquireRun` + `heartbeatRun` instead — a
   * 'running' row without heartbeat refresh would be reclaimed while
   * still alive.
   */
  async startRun(stage: string, inputCount: number, startedAt?: Date): Promise<Run> {
    const at = startedAt ?? new Date()
    const row = this.db
      .insert(runs)
      .values({
        stage,
        // Non-locking status: the journal only guards 'running' rows.
        status: 'done',
        pid: process.pid,
        heartbeatAt: at,
        startedAt: at,
        inputCount,
      })
      .returning()
      .get()
    return {
      id: row.id,
      stage: row.stage,
      startedAt: row.startedAt,
      finishedAt: row.finishedAt ?? null,
      inputCount: row.inputCount,
      okCount: row.okCount,
      errorCount: row.errorCount,
      durationMs: row.durationMs ?? null,
      tokensIn: row.tokensIn ?? null,
      tokensOut: row.tokensOut ?? null,
      costUsd: row.costUsd ?? null,
    }
  }

  async finishRun(
    id: number,
    result: {
      finishedAt?: Date
      okCount?: number
      errorCount?: number
      durationMs?: number
      tokensIn?: number | null
      tokensOut?: number | null
      costUsd?: number | null
      inputCount?: number
      status?: 'done' | 'failed'
    },
  ): Promise<void> {
    this.db
      .update(runs)
      .set({
        finishedAt: result.finishedAt ?? new Date(),
        status: result.status ?? 'done',
        ...(result.inputCount !== undefined ? { inputCount: result.inputCount } : {}),
        okCount: result.okCount,
        errorCount: result.errorCount,
        durationMs: result.durationMs,
        tokensIn: result.tokensIn ?? null,
        tokensOut: result.tokensOut ?? null,
        costUsd: result.costUsd ?? null,
      })
      .where(eq(runs.id, id))
      .run()
  }

  async addMetric(metric: Metric): Promise<void> {
    this.db.insert(metrics).values({
      timestamp: metric.timestamp,
      stage: metric.stage,
      key: metric.key,
      value: metric.value,
      tags: metric.tags,
    }).run()
  }

  async listMetrics(filter?: MetricFilter): Promise<Metric[]> {
    const conds = []
    if (filter?.stage) conds.push(eq(metrics.stage, filter.stage))
    if (filter?.since) conds.push(gte(metrics.timestamp, filter.since))
    if (filter?.until) conds.push(lte(metrics.timestamp, filter.until))
    const q = this.db.select().from(metrics)
    const filtered = conds.length ? q.where(and(...conds)) : q
    const ordered = filtered.orderBy(sql`${metrics.timestamp} DESC`)
    const paged = filter?.limit !== undefined ? ordered.limit(filter.limit) : ordered
    return paged.all().map((r) => ({
      timestamp: r.timestamp,
      stage: r.stage,
      key: r.key,
      value: r.value,
      tags: r.tags ?? null,
    }))
  }

  async listProfiles(): Promise<Profile[]> {
    return this.db
      .select()
      .from(profiles)
      .orderBy(profiles.host)
      .all()
      .map((r) => ({ host: r.host, path: r.path, createdAt: r.createdAt, updatedAt: r.updatedAt }))
  }

  async getProfile(host: string): Promise<Profile | null> {
    const r = this.db.select().from(profiles).where(eq(profiles.host, host)).get()
    return r ? { host: r.host, path: r.path, createdAt: r.createdAt, updatedAt: r.updatedAt } : null
  }

  async upsertProfile(input: ProfileInput): Promise<Profile> {
    const now = new Date()
    const row = this.db
      .insert(profiles)
      .values({ host: input.host, path: input.path, createdAt: input.createdAt ?? now, updatedAt: input.updatedAt ?? now })
      .onConflictDoUpdate({
        target: profiles.host,
        set: { path: input.path, updatedAt: now },
      })
      .returning()
      .get()
    return { host: row.host, path: row.path, createdAt: row.createdAt, updatedAt: row.updatedAt }
  }

  async deleteProfile(host: string): Promise<number> {
    return this.db.delete(profiles).where(eq(profiles.host, host)).run().changes
  }

  async getHostState(key: string): Promise<HostState | null> {
    const row = this.db.select().from(hostState).where(eq(hostState.key, key)).get()
    return row ? hostStateFromRow(row) : null
  }

  async saveHostState(state: HostState): Promise<void> {
    const values = {
      key: state.key,
      lastRequestAt: state.lastRequestAt,
      windowStart: state.windowStart,
      windowCount: state.windowCount,
      consecutiveFailures: state.consecutiveFailures,
      breakerState: state.breakerState,
      openedUntil: state.openedUntil,
      cooldownLevel: state.cooldownLevel,
      lastError: state.lastError,
      trialState: state.trialState,
      trialReason: state.trialReason,
      trialAt: state.trialAt,
      loginGated: state.loginGated,
      rateLimitedUntil: state.rateLimitedUntil,
      pagesSinceBreak: state.pagesSinceBreak ?? null,
      breakEvery: state.breakEvery ?? null,
    }
    this.db
      .insert(hostState)
      .values(values)
      .onConflictDoUpdate({ target: hostState.key, set: values })
      .run()
  }

  async listHostStates(): Promise<HostState[]> {
    return this.db.select().from(hostState).orderBy(hostState.key).all().map(hostStateFromRow)
  }

  async getMeta(key: string): Promise<string | null> {
    const row = this.db.select().from(meta).where(eq(meta.key, key)).get()
    return row?.value ?? null
  }

  async setMeta(key: string, value: string): Promise<void> {
    this.setMetaSync(key, value)
  }

  private setMetaSync(key: string, value: string): void {
    this.db
      .insert(meta)
      .values({ key, value })
      .onConflictDoUpdate({ target: meta.key, set: { value } })
      .run()
  }
}

// ---- FSM helpers ----

// ---- run journal helpers ----

/** Map an ingest_jobs row to the domain job. */
function jobFromRow(row: IngestJobRow): IngestJob {
  return {
    id: row.id,
    source: row.source,
    status: row.status as IngestJobStatus,
    total: row.total,
    done: row.done,
    cursor: row.cursor,
    spoolPath: row.spoolPath ?? null,
    runId: row.runId ?? null,
    error: row.error ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    finishedAt: row.finishedAt ?? null,
  }
}

/** Map a runs row to the journal view (status/pid/heartbeat included). */
function journalFromRow(row: {
  id: number
  stage: string
  status: string | null
  pid: number | null
  heartbeatAt: Date | null
  startedAt: Date
  finishedAt: Date | null
}): RunJournalEntry {
  return {
    id: row.id,
    stage: row.stage,
    status: (row.status as RunJournalStatus | null) ?? 'done',
    pid: row.pid ?? null,
    startedAt: row.startedAt,
    heartbeatAt: row.heartbeatAt ?? null,
    finishedAt: row.finishedAt ?? null,
  }
}

// ---- host state helpers ----

/** Map a host_state row to the core HostState record. */
function hostStateFromRow(row: {
  key: string
  lastRequestAt: number | null
  windowStart: number | null
  windowCount: number
  consecutiveFailures: number
  breakerState: string
  openedUntil: number | null
  cooldownLevel: number
  lastError: string | null
  trialState?: string | null
  trialReason?: string | null
  trialAt?: number | null
  loginGated?: boolean | number | null
  rateLimitedUntil?: number | null
  pagesSinceBreak?: number | null
  breakEvery?: number | null
}): HostState {
  return {
    key: row.key,
    lastRequestAt: row.lastRequestAt,
    windowStart: row.windowStart,
    windowCount: row.windowCount,
    consecutiveFailures: row.consecutiveFailures,
    breakerState: row.breakerState as HostState['breakerState'],
    openedUntil: row.openedUntil,
    cooldownLevel: row.cooldownLevel,
    lastError: row.lastError,
    trialState: (row.trialState as HostState['trialState'] | null | undefined) ?? 'unknown',
    trialReason: row.trialReason ?? null,
    trialAt: row.trialAt ?? null,
    loginGated: row.loginGated === true || row.loginGated === 1,
    rateLimitedUntil: row.rateLimitedUntil ?? null,
    pagesSinceBreak: row.pagesSinceBreak ?? undefined,
    breakEvery: row.breakEvery ?? undefined,
  }
}

/** The FSM state a legacy status column maps to. */
function stateForLegacyStatus(status: string): string {
  switch (status) {
    case 'archived': return 'archived'
    case 'discarded': return 'discarded'
    case 'scheduled': return 'scheduled'
    // A fresh link with no explicit state starts at the extraction queue.
    default: return 'created'
  }
}

function dataForLegacyStatus(
  status: string,
  row: Partial<LinkRow>,
  now: Date,
): Record<string, unknown> | null {
  switch (status) {
    case 'archived':
      return { archivedAt: new Date(row.updatedAt ?? now).toISOString(), reason: 'manual' }
    case 'discarded':
      return { discardedAt: new Date(row.updatedAt ?? now).toISOString() }
    case 'scheduled':
      return { scheduledFor: null }
    case 'inbox':
      return { enriched: row.enrichment !== null || row.category !== null }
    default:
      return {}
  }
}

/**
 * Map a LinkPatch to drizzle column values. `undefined` leaves a column
 * alone; `null` clears it. When `enrichment` is present the denormalized
 * columns derive from it (same rules as setEnrichment) and expiresAt /
 * expiryReason default to the enrichment's own values unless the patch
 * overrides them explicitly.
 */
function patchColumns(patch: LinkPatch | undefined): Partial<typeof links.$inferInsert> {
  if (patch === undefined) return {}
  const set: Partial<typeof links.$inferInsert> = {}
  if (patch.title !== undefined) set.title = patch.title
  if (patch.extractedContent !== undefined) set.extractedContent = patch.extractedContent
  if (patch.extractedAt !== undefined) set.extractedAt = patch.extractedAt
  if (patch.needsBrowser !== undefined) set.needsBrowser = patch.needsBrowser
  if (patch.captured !== undefined) set.captured = patch.captured
  if (patch.capturedAt !== undefined) set.capturedAt = patch.capturedAt
  if (patch.mediaReport !== undefined) set.mediaReport = patch.mediaReport
  if (patch.enrichment !== undefined) {
    const e = patch.enrichment
    set.enrichment = e
    set.category = e?.category ?? null
    set.priority = e?.priority ?? null
    set.action = e?.action ?? null
    set.confidence = e?.confidence ?? null
    set.readMinutes = e?.read_minutes ?? null
    if (patch.expiresAt === undefined) {
      set.expiresAt = e?.expires_at ? new Date(e.expires_at) : null
    }
    if (patch.expiryReason === undefined) {
      set.expiryReason = e?.expiry_reason ?? null
    }
  }
  if (patch.expiresAt !== undefined) set.expiresAt = patch.expiresAt
  if (patch.expiryReason !== undefined) set.expiryReason = patch.expiryReason
  return set
}

class LostRace extends Error {
  constructor(
    readonly linkId: number,
    readonly from: string,
  ) {
    super(`lost race on link ${linkId} (was ${from})`)
    this.name = 'LostRace'
  }
}

/**
 * Side effects that belong to a state change. Moving to `deleted` purges the
 * bulky content (the tombstone keeps the url_hash so re-import is a no-op).
 */
function purgeForState(
  next: LinkState,
  row: LinkRow,
): Partial<typeof links.$inferInsert> {
  if (next.state !== 'deleted') return {}
  return {
    extractedContent: null,
    extractedAt: null,
    enrichment: null,
    needsBrowser: false,
    category: null,
    priority: null,
    action: null,
    confidence: null,
    readMinutes: null,
  }
}

// ---- row <-> domain mapping ----

function toRow(input: LinkInput, now: Date): typeof links.$inferInsert {
  return {
    urlHash: input.urlHash,
    url: input.url,
    title: input.title ?? null,
    source: input.source,
    addedAt: input.addedAt ?? null,
    note: input.note ?? null,
    tags: input.tags ?? null,
    extractedContent: input.extractedContent ?? null,
    extractedAt: input.extractedAt ?? null,
    enrichment: input.enrichment ?? null,
    expiresAt: input.expiresAt ?? null,
    expiryReason: input.expiryReason ?? null,
    status: input.status ?? 'inbox',
    readMinutes: input.enrichment?.read_minutes ?? null,
    category: input.enrichment?.category ?? null,
    priority: input.enrichment?.priority ?? null,
    action: input.enrichment?.action ?? null,
    confidence: input.enrichment?.confidence ?? null,
    needsBrowser: input.needsBrowser ?? false,
    captured: input.captured ?? false,
    capturedAt: input.capturedAt ?? null,
    mediaReport: input.mediaReport ?? null,
    state: input.state ?? 'created',
    stateData: input.stateData ?? null,
    createdAt: input.createdAt ?? now,
    updatedAt: input.updatedAt ?? now,
  }
}

function fromRow(row: LinkRow): Link {
  return {
    id: row.id,
    urlHash: row.urlHash,
    url: row.url,
    title: row.title ?? null,
    source: row.source,
    addedAt: row.addedAt ?? null,
    note: row.note ?? null,
    tags: row.tags ?? null,
    extractedContent: row.extractedContent ?? null,
    extractedAt: row.extractedAt ?? null,
    enrichment: (row.enrichment as Enrichment | null) ?? null,
    expiresAt: row.expiresAt ?? null,
    expiryReason: row.expiryReason ?? null,
    status: row.status as Status,
    category: row.category ?? null,
    priority: (row.priority as Enrichment['priority'] | null) ?? null,
    action: (row.action as Enrichment['action'] | null) ?? null,
    confidence: row.confidence ?? null,
    readMinutes: row.readMinutes ?? null,
    needsBrowser: row.needsBrowser,
    captured: row.captured,
    capturedAt: row.capturedAt ?? null,
    mediaReport: (row.mediaReport as MediaReport | null) ?? null,
    state: row.state,
    stateData: (row.stateData as Record<string, unknown> | null) ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

// exec() on better-sqlite3 handles multiple statements; keep the DDL as a
// plain string so migrate() stays driver-simple.

// ---- FSM event application ----

const FSM_MUTATOR = Symbol('fsm')

/**
 * Map a legacy status onto the event that reaches it. `inbox` is the
 * "send it back to the inbox" projection, which the FSM models as RESTORE
 * from a parked state or ENRICHED from an enriched one.
 */
function eventForStatus(status: Status, at: Date): LinkEvent {
  switch (status) {
    case 'archived':
      return { type: 'EXPIRE', at: at.toISOString() }
    case 'discarded':
      return { type: 'TRIAGE', action: 'discard', at: at.toISOString() }
    case 'scheduled':
      return { type: 'TRIAGE', action: 'schedule', at: at.toISOString() }
    case 'inbox':
    default:
      return { type: 'RESTORE', at: at.toISOString() }
  }
}
