import Database from 'better-sqlite3'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { eq, inArray, and, gte, lte, sql } from 'drizzle-orm'
import {
  SCHEMA_SQL,
  SCHEMA_VERSION,
  links,
  meta,
  metrics,
  runs,
  type LinkRow,
} from './schema.js'
import type {
  Link,
  LinkFilter,
  LinkInput,
  Metric,
  MetricFilter,
  Run,
  Status,
  Store,
  Enrichment,
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

  async migrate(): Promise<void> {
    this.sqlite.exec(SCHEMA_SQL)
    this.setMetaSync('schema_version', SCHEMA_VERSION)
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
    const row = toRow(input, now)
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
    if (filter?.status) conds.push(eq(links.status, filter.status))
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
    const r = this.db
      .update(links)
      .set({ status, updatedAt: updatedAt ?? new Date() })
      .where(inArray(links.id, ids))
      .run()
    return r.changes
  }

  async deleteLinks(ids: number[]): Promise<number> {
    if (ids.length === 0) return 0
    const r = this.db.delete(links).where(inArray(links.id, ids)).run()
    return r.changes
  }

  async setEnrichment(id: number, enrichment: Enrichment, updatedAt?: Date): Promise<number> {
    const r = this.db
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
        updatedAt: updatedAt ?? new Date(),
      })
      .where(eq(links.id, id))
      .run()
    return r.changes
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
    const r = this.db
      .update(links)
      .set({
        extractedContent: content,
        needsBrowser,
        extractedAt: extractedAt ?? new Date(),
        updatedAt: extractedAt ?? new Date(),
      })
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
    needsBrowser: row.needsBrowser,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

// exec() on better-sqlite3 handles multiple statements; keep the DDL as a
// plain string so migrate() stays driver-simple.
