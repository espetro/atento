import Database from 'better-sqlite3'
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
  type LinkRow,
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
  Run,
  Status,
  Store,
  Enrichment,
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
    this.db = drizzle(this.sqlite) as unknown as Db
  }

  /** Run a PRAGMA. `simple: true` returns the first row column as a scalar. */
  pragma(source: string, options?: { simple?: boolean }): unknown {
    return this.sqlite.pragma(source, options)
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
    const now = new Date()
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
    if (filter?.status) conds.push(eq(links.status, filter.status))
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
   * the same link. The event history row is written in the same transaction.
   */
  async applyEvent(
    linkId: number,
    event: LinkEvent,
    expected?: LinkStateName,
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

  async startRun(stage: string, inputCount: number, startedAt?: Date): Promise<Run> {
    const row = this.db
      .insert(runs)
      .values({ stage, inputCount, startedAt: startedAt ?? new Date() })
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
    },
  ): Promise<void> {
    this.db
      .update(runs)
      .set({
        finishedAt: result.finishedAt ?? new Date(),
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
