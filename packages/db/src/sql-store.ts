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
  type Link,
  type LinkFilter,
  type LinkInput,
  type Metric,
  type MetricFilter,
  type Profile,
  type ProfileInput,
  type RawLink,
  type Run,
  type Status,
  type Store,
  type Enrichment,
  type IngestJob,
  type IngestJobStatus,
  type LinkEvent,
  type LinkState,
  type LinkStateName,
  type TransitionOutcome,
  type LinkHistoryEntry,
  type HostState,
  type MediaReport,
} from '@atento/core'
import { runMigrations, SCHEMA_VERSION } from './migrations.js'
import { runInTransaction, type SqlDriver, type SqlRow, type SqlValue } from './sql-driver.js'

/**
 * The Store over a SqlDriver: raw SQL with column mappers (snake to camel,
 * timestamp_ms to Date, JSON text columns, 0/1 booleans). It has no
 * dependency on better-sqlite3 or an ORM, so it compiles into a scriptc
 * native build with @cutils/sqlite as the driver. Every multi-write
 * operation (FSM transition plus history row, ingest chunks, run locks) runs
 * in a transaction.
 */
export class SqlStore implements Store {
  protected readonly driver: SqlDriver
  /** Cached links_fts existence check; reset by migrate(). */
  private ftsTable: boolean | undefined

  constructor(driver: SqlDriver) {
    this.driver = driver
  }

  /** Run a PRAGMA. `simple: true` returns the first row column as a scalar. */
  pragma(source: string, options?: { simple?: boolean }): unknown {
    return this.driver.pragma(source, options?.simple === true)
  }

  /** All run rows, newest first. Convenience for the metrics CLI. */
  allRuns(): Run[] {
    return this.driver.all(`SELECT * FROM runs ORDER BY started_at DESC, id DESC`).map(runFromRow)
  }

  async migrate(): Promise<void> {
    const applied = runMigrations(this.driver)
    if (applied.length > 0 || (await this.getMeta('schema_version')) === null) {
      this.setMetaSync('schema_version', SCHEMA_VERSION)
    }
    // The FTS table may have just been created: re-check on next use.
    this.ftsTable = undefined
  }

  /** Migration names recorded as applied on this database. */
  appliedMigrations(): string[] {
    return this.driver
      .all(`SELECT key FROM meta WHERE key LIKE 'migration:%'`)
      .map((r) => asStr(r['key']).slice('migration:'.length))
      .sort()
  }

  async schemaVersion(): Promise<string> {
    const row = this.driver.get(`SELECT value FROM meta WHERE key = ?`, ['schema_version'])
    return row === undefined ? '0' : asStr(row['value'])
  }

  async close(): Promise<void> {
    this.driver.close()
  }

  /** Run `fn` in a transaction (savepoint when nested). */
  protected tx<T>(fn: () => T, immediate = false): T {
    return runInTransaction(this.driver, fn, immediate ? 'immediate' : 'deferred')
  }

  async upsertLink(input: LinkInput): Promise<Link> {
    return this.upsertLinkSync(input, new Date())
  }

  /** Synchronous upsert core, callable inside a transaction (commitIngestChunk). */
  private upsertLinkSync(input: LinkInput, now: Date): Link {
    // FSM: a tombstoned url is never resurrected by a re-import.
    const tombstone = this.driver.get(`SELECT * FROM links WHERE url_hash = ? AND state = 'deleted'`, [
      input.urlHash,
    ])
    if (tombstone !== undefined) return linkFromRow(tombstone)
    const row = toLinkValues(input, now)
    // FSM: a freshly stored link starts in the state that matches its
    // legacy status column, so old rows and new rows agree.
    if (!input.state) {
      // Derive the initial state from the actual data, so a link with
      // enrichment content but no explicit state still lands in inbox.
      if (row.enrichment !== null || row.category !== null) {
        row.state = 'inbox'
        row.stateData = { enriched: true }
      } else if (row.extractedContent !== null) {
        row.state = 'extracted'
        row.stateData = { chars: row.extractedContent.length }
      } else {
        row.state = input.status ? stateForLegacyStatus(row.status) : 'created'
        row.stateData = input.status ? dataForLegacyStatus(row.status, row, now) : {}
      }
    }
    const cols = LINK_INSERT_COLS
    const vals: SqlValue[] = [
      row.urlHash,
      row.url,
      row.title,
      row.source,
      msOrNull(row.addedAt),
      row.note,
      jsonOrNull(row.tags),
      row.extractedContent,
      msOrNull(row.extractedAt),
      jsonOrNull(row.enrichment),
      msOrNull(row.expiresAt),
      row.expiryReason,
      row.status,
      row.readMinutes,
      row.category,
      row.priority,
      row.action,
      row.confidence,
      row.needsBrowser ? 1 : 0,
      row.captured ? 1 : 0,
      msOrNull(row.capturedAt),
      row.state,
      jsonOrNull(row.stateData),
      jsonOrNull(row.mediaReport),
      row.createdAt.getTime(),
      row.updatedAt.getTime(),
    ]
    // ingest is idempotent and non-destructive: never clobber downstream
    // fields (enrichment, extraction, status) on re-import.
    this.driver.run(
      `INSERT INTO links (${cols.join(', ')}) VALUES (${placeholders(cols.length)}) ` +
        `ON CONFLICT (url_hash) DO UPDATE SET url = ?, title = ?, source = ?, added_at = ?, note = ?, tags = ?, updated_at = ?`,
      [
        ...vals,
        row.url,
        row.title,
        row.source,
        msOrNull(row.addedAt),
        row.note,
        jsonOrNull(row.tags),
        now.getTime(),
      ],
    )
    const inserted = this.driver.get(`SELECT * FROM links WHERE url_hash = ?`, [input.urlHash])
    return linkFromRow(inserted as SqlRow)
  }

  async getLink(id: number): Promise<Link | null> {
    const row = this.driver.get(`SELECT * FROM links WHERE id = ?`, [id])
    return row === undefined ? null : linkFromRow(row)
  }

  async getLinkByUrlHash(urlHash: string): Promise<Link | null> {
    const row = this.driver.get(`SELECT * FROM links WHERE url_hash = ?`, [urlHash])
    return row === undefined ? null : linkFromRow(row)
  }

  /**
   * Shared WHERE parts for listLinks/countLinks. Returns 'empty' when a
   * `match` filter carries no searchable tokens: the query matches nothing.
   */
  private linkConds(filter?: LinkFilter): LinkConds | 'empty' {
    const conds: string[] = []
    const params: SqlValue[] = []
    if (filter?.status) {
      conds.push(filter.byState === true ? 'state = ?' : 'status = ?')
      params.push(filter.status)
    }
    if (filter?.category) {
      conds.push('category = ?')
      params.push(filter.category)
    }
    if (filter?.staleAsOf) {
      conds.push('expires_at IS NOT NULL AND expires_at < ?')
      params.push(filter.staleAsOf.getTime())
    }
    if (filter?.match !== undefined) {
      const fts = this.matchConds(filter.match)
      if (fts === 'empty') return 'empty'
      conds.push(fts.cond)
      params.push(...fts.condParams)
      if (filter.sort === 'relevance') {
        return { conds, params, rank: fts.rank, rankParams: fts.rankParams }
      }
    }
    return { conds, params, rank: undefined, rankParams: [] }
  }

  /**
   * Translate free-text `match` into a condition over the links row. With
   * the links_fts table (migration 0010) it is an FTS5 MATCH narrowed to
   * rowids, plus a bm25 rank expression for `sort=relevance`. On a database
   * that has not migrated yet it degrades to substring LIKEs.
   */
  private matchConds(match: string): MatchConds | 'empty' {
    const query = toFts5Query(match)
    if (query === null) return 'empty'
    if (!this.hasFtsTable()) {
      const like = `%${escapeLike(match.trim())}%`
      return {
        cond:
          `(title LIKE ? ESCAPE '\\' OR url LIKE ? ESCAPE '\\' OR note LIKE ? ESCAPE '\\' ` +
          `OR tags LIKE ? ESCAPE '\\' OR enrichment LIKE ? ESCAPE '\\')`,
        condParams: [like, like, like, like, like],
        rank: '0',
        rankParams: [],
      }
    }
    return {
      cond: `id IN (SELECT rowid FROM links_fts WHERE links_fts MATCH ?)`,
      condParams: [query],
      // bm25 weights per fts column (title, url, note, tags, summary): the
      // title counts most, the url least. Lower bm25 = better rank.
      rank: `(SELECT bm25(links_fts, 10.0, 1.0, 3.0, 2.0, 5.0) FROM links_fts WHERE links_fts.rowid = links.id AND links_fts MATCH ?)`,
      rankParams: [query],
    }
  }

  /** True when the links_fts virtual table exists (post-0010 migration). */
  private hasFtsTable(): boolean {
    if (this.ftsTable === undefined) {
      this.ftsTable =
        this.driver.get(`SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'links_fts'`) !==
        undefined
    }
    return this.ftsTable
  }

  async listLinks(filter?: LinkFilter): Promise<Link[]> {
    const parts = this.linkConds(filter)
    if (parts === 'empty') return []
    let sql = 'SELECT * FROM links'
    const params: SqlValue[] = [...parts.params]
    if (parts.conds.length > 0) sql += ' WHERE ' + parts.conds.join(' AND ')
    if (parts.rank !== undefined) {
      sql += ` ORDER BY ${parts.rank} ASC, created_at DESC, id DESC`
      params.push(...parts.rankParams)
    } else {
      sql += ' ORDER BY created_at DESC, id DESC'
    }
    if (filter?.limit !== undefined) {
      sql += ' LIMIT ?'
      params.push(filter.limit)
    } else if (filter?.offset !== undefined) {
      sql += ' LIMIT -1'
    }
    if (filter?.offset !== undefined) {
      sql += ' OFFSET ?'
      params.push(filter.offset)
    }
    return this.driver.all(sql, params).map(linkFromRow)
  }

  async countLinks(filter?: LinkFilter): Promise<number> {
    const parts = this.linkConds(filter)
    if (parts === 'empty') return 0
    let sql = 'SELECT count(*) AS n FROM links'
    if (parts.conds.length > 0) sql += ' WHERE ' + parts.conds.join(' AND ')
    const r = this.driver.get(sql, parts.params)
    return r === undefined ? 0 : asNum(r['n'])
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
      const outcome = await this.applyEvent(id, eventForStatus(status, at), link.state as LinkStateName)
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
    this.tx(() => {
      this.driver.run(
        `UPDATE links SET enrichment = ?, category = ?, priority = ?, action = ?, confidence = ?, ` +
          `read_minutes = ?, expires_at = ?, expiry_reason = ?, updated_at = ? WHERE id = ?`,
        [
          jsonOrNull(enrichment),
          enrichment.category,
          enrichment.priority,
          enrichment.action,
          enrichment.confidence,
          enrichment.read_minutes,
          enrichment.expires_at ? new Date(enrichment.expires_at).getTime() : null,
          enrichment.expiry_reason,
          at.getTime(),
          id,
        ],
      )
    })
    return 1
  }

  async setExpiry(
    id: number,
    expiresAt: Date | null,
    expiryReason: string | null,
    updatedAt?: Date,
  ): Promise<number> {
    return this.driver.run(`UPDATE links SET expires_at = ?, expiry_reason = ?, updated_at = ? WHERE id = ?`, [
      msOrNull(expiresAt),
      expiryReason,
      (updatedAt ?? new Date()).getTime(),
      id,
    ]).changes
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
    this.tx(() => {
      this.driver.run(
        `UPDATE links SET extracted_content = ?, needs_browser = ?, extracted_at = ?, updated_at = ? WHERE id = ?`,
        [content, needsBrowser ? 1 : 0, at.getTime(), at.getTime(), id],
      )
    })
    return 1
  }

  async updateTitle(id: number, title: string, updatedAt?: Date): Promise<number> {
    return this.driver.run(`UPDATE links SET title = ?, updated_at = ? WHERE id = ?`, [
      title,
      (updatedAt ?? new Date()).getTime(),
      id,
    ]).changes
  }

  async markCaptured(id: number, capturedAt: Date, updatedAt?: Date): Promise<number> {
    return this.driver.run(`UPDATE links SET captured = 1, captured_at = ?, updated_at = ? WHERE id = ?`, [
      capturedAt.getTime(),
      (updatedAt ?? new Date()).getTime(),
      id,
    ]).changes
  }

  async setMediaReport(id: number, report: MediaReport, updatedAt?: Date): Promise<number> {
    return this.driver.run(`UPDATE links SET media_report = ?, updated_at = ? WHERE id = ?`, [
      jsonOrNull(report),
      (updatedAt ?? new Date()).getTime(),
      id,
    ]).changes
  }

  /**
   * Atomically patch link columns: one UPDATE statement, so the whole patch
   * commits or none of it does. For writes that belong to an FSM event use
   * `applyEvent(..., patch)` instead.
   */
  async patchLink(id: number, patch: LinkPatch, updatedAt?: Date): Promise<number> {
    const set = patchColumns(patch)
    if (set.size === 0) return 0
    set.set('updated_at', (updatedAt ?? new Date()).getTime())
    const { sql, params } = setClause(set)
    return this.driver.run(`UPDATE links SET ${sql} WHERE id = ?`, [...params, id]).changes
  }

  async getMediaBudget(day: string): Promise<{ total: number; byTier: Record<string, number> }> {
    const row = this.driver.get(`SELECT total, by_tier FROM media_budget WHERE day = ?`, [day])
    if (row === undefined) return { total: 0, byTier: {} }
    const byTier = parseJson(row['by_tier']) as Record<string, number> | null
    return { total: asNum(row['total']), byTier: { ...(byTier ?? {}) } }
  }

  async saveMediaBudget(
    day: string,
    budget: { total: number; byTier: Record<string, number> },
  ): Promise<void> {
    const by = jsonOrNull(budget.byTier)
    this.driver.run(
      `INSERT INTO media_budget (day, total, by_tier) VALUES (?, ?, ?) ` +
        `ON CONFLICT (day) DO UPDATE SET total = ?, by_tier = ?`,
      [day, budget.total, by, budget.total, by],
    )
  }

  /**
   * FSM: apply one event atomically. The state change is a compare-and-set
   * (`WHERE id = ? AND state = ?`), so two concurrent runners can never take
   * the same link. The event history row and any `patch` column writes are
   * written in the same transaction: a result and its FSM event commit
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
    const row = this.driver.get(`SELECT * FROM links WHERE id = ?`, [linkId])
    if (row === undefined) {
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
    const currentName = asStr(row['state']) as LinkStateName
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
    const current = parseLinkState(currentName, parseJson(row['state_data']))
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
    try {
      this.tx(() => {
        const set = new Map<string, SqlValue>()
        set.set('state', next.state)
        set.set('state_data', JSON.stringify(payload))
        set.set('status', legacyStatus(next))
        set.set('updated_at', now.getTime())
        // The patch lands before the tombstone purge so a DELETE can never
        // be talked into keeping bulky content: purge wins on `deleted`.
        for (const [k, v] of patchColumns(patch)) set.set(k, v)
        for (const [k, v] of purgeForState(next)) set.set(k, v)
        const { sql, params } = setClause(set)
        const updated = this.driver.run(`UPDATE links SET ${sql} WHERE id = ? AND state = ?`, [
          ...params,
          linkId,
          currentName,
        ])
        if (updated.changes !== 1) throw new LostRace(linkId, currentName)
        this.driver.run(
          `INSERT INTO link_events (link_id, from_state, to_state, event, data, at) VALUES (?, ?, ?, ?, ?, ?)`,
          [linkId, currentName, next.state, event.type, JSON.stringify(event), at.getTime()],
        )
      })
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
    return this.driver
      .all(`SELECT * FROM link_events WHERE link_id = ? ORDER BY id ASC`, [linkId])
      .map(eventFromRow)
  }

  /** High-water mark of link_events.id: the collections delta cursor. */
  async linkEventCursor(): Promise<number> {
    const row = this.driver.get(`SELECT max(id) AS m FROM link_events`)
    return row === undefined ? 0 : asNum(row['m'])
  }

  /**
   * Delta read: links with at least one link_events row newer than `since`.
   * The event id is the cursor, so "changed" means "transitioned (or was
   * ingested, which writes an INGESTED marker row) after the cursor".
   */
  async listChangedLinks(since: number, limit?: number): Promise<Link[]> {
    let sql = `SELECT * FROM links WHERE id IN (SELECT link_id FROM link_events WHERE id > ?) ORDER BY id ASC`
    const params: SqlValue[] = [since]
    if (limit !== undefined) {
      sql += ' LIMIT ?'
      params.push(limit)
    }
    return this.driver.all(sql, params).map(linkFromRow)
  }

  /** Delta read of the event log itself, oldest first. */
  async listLinkEvents(since: number, limit?: number): Promise<LinkHistoryEntry[]> {
    let sql = `SELECT * FROM link_events WHERE id > ? ORDER BY id ASC`
    const params: SqlValue[] = [since]
    if (limit !== undefined) {
      sql += ' LIMIT ?'
      params.push(limit)
    }
    return this.driver.all(sql, params).map(eventFromRow)
  }

  /** State histogram: how many links sit in each state. */
  async countByState(): Promise<Record<LinkStateName, number>> {
    const rows = this.driver.all(`SELECT state, count(*) AS n FROM links GROUP BY state`)
    const out = {} as Record<LinkStateName, number>
    for (const name of LINK_STATES) out[name] = 0
    for (const r of rows) out[asStr(r['state']) as LinkStateName] = asNum(r['n'])
    return out
  }

  /** Links currently in one of the given FSM states. */
  async listByStates(states: LinkStateName[], limit?: number): Promise<Link[]> {
    if (states.length === 0) return []
    let sql = `SELECT * FROM links WHERE state IN (${placeholders(states.length)}) ORDER BY created_at ASC, id ASC`
    const params: SqlValue[] = [...states]
    if (limit !== undefined) {
      sql += ' LIMIT ?'
      params.push(limit)
    }
    return this.driver.all(sql, params).map(linkFromRow)
  }

  private leasedIds(): number[] {
    return this.driver
      .all(`SELECT id FROM links WHERE state IN (${placeholders(LEASED_STATES.length)})`, [...LEASED_STATES])
      .map((r) => asNum(r['id']))
  }

  /**
   * Return every leased link whose lease expired before `cutoff` to its queue
   * state. A killed process never strands a link: the next run picks it up.
   */
  async reclaimExpiredLeases(cutoff: Date): Promise<number> {
    let reclaimed = 0
    for (const id of this.leasedIds()) {
      const state = await this.getState(id)
      if (!state || (state.state !== 'extracting' && state.state !== 'enriching')) continue
      if (new Date(state.startedAt).getTime() >= cutoff.getTime()) continue
      const outcome = await this.applyEvent(id, { type: 'LEASE_EXPIRED', at: new Date().toISOString() })
      if (outcome.ok) reclaimed += 1
    }
    return reclaimed
  }

  /**
   * Return every leased link owned by one of `runIds` to its queue state.
   * The lease owner lives in the FSM payload (`state_data.runId`), so the
   * reclaim goes through the same compare-and-set path as every transition.
   */
  async reclaimLeasesForRuns(runIds: number[], at?: Date): Promise<number> {
    if (runIds.length === 0) return 0
    const wanted = new Set(runIds)
    let reclaimed = 0
    for (const id of this.leasedIds()) {
      const state = await this.getState(id)
      if (!state || (state.state !== 'extracting' && state.state !== 'enriching')) continue
      const owner = state.runId
      if (owner === undefined || !wanted.has(owner)) continue
      const outcome = await this.applyEvent(id, {
        type: 'LEASE_EXPIRED',
        at: (at ?? new Date()).toISOString(),
      })
      if (outcome.ok) reclaimed += 1
    }
    return reclaimed
  }

  /**
   * Single-writer lock for one stage. The check-and-insert runs in one
   * BEGIN IMMEDIATE transaction, so two processes can never both observe
   * "no running row" and both insert.
   */
  async acquireRun(
    stage: string,
    opts: { pid?: number; now?: Date } = {},
  ): Promise<AcquireRunResult> {
    const now = opts.now ?? new Date()
    const pid = opts.pid ?? process.pid
    return this.tx((): AcquireRunResult => {
      const holder = this.driver.get(
        `SELECT * FROM runs WHERE stage = ? AND status = 'running' ORDER BY id ASC`,
        [stage],
      )
      if (holder !== undefined) return { ok: false as const, busy: journalFromRow(holder) }
      const r = this.driver.run(
        `INSERT INTO runs (stage, status, pid, heartbeat_at, started_at, input_count) VALUES (?, 'running', ?, ?, ?, 0)`,
        [stage, pid, now.getTime(), now.getTime()],
      )
      const row = this.driver.get(`SELECT * FROM runs WHERE id = ?`, [r.lastInsertRowid])
      return { ok: true as const, run: journalFromRow(row as SqlRow) }
    }, true)
  }

  async heartbeatRun(id: number, at?: Date): Promise<void> {
    this.driver.run(`UPDATE runs SET heartbeat_at = ? WHERE id = ? AND status = 'running'`, [
      (at ?? new Date()).getTime(),
      id,
    ])
  }

  async listRunningRuns(): Promise<RunJournalEntry[]> {
    return this.driver
      .all(`SELECT * FROM runs WHERE status = 'running' ORDER BY id ASC`)
      .map(journalFromRow)
  }

  async getRun(id: number): Promise<Run | null> {
    const row = this.driver.get(`SELECT * FROM runs WHERE id = ?`, [id])
    return row === undefined ? null : runFromRow(row)
  }

  async listRuns(opts: { since?: Date; limit?: number; afterId?: number } = {}): Promise<Run[]> {
    const conds: string[] = []
    const params: SqlValue[] = []
    if (opts.since !== undefined) {
      conds.push('(started_at > ? OR finished_at > ?)')
      params.push(opts.since.getTime(), opts.since.getTime())
    }
    if (opts.afterId !== undefined) {
      conds.push('id > ?')
      params.push(opts.afterId)
    }
    let sql = 'SELECT * FROM runs'
    if (conds.length > 0) sql += ' WHERE ' + conds.join(' AND ')
    sql += ' ORDER BY id ASC'
    if (opts.limit !== undefined) {
      sql += ' LIMIT ?'
      params.push(opts.limit)
    }
    return this.driver.all(sql, params).map(runFromRow)
  }

  /**
   * Mark `running` journal rows `crashed` when their owner is gone: the pid
   * is dead or the heartbeat is stale.
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
      this.driver.run(`UPDATE runs SET status = 'crashed', finished_at = ? WHERE id = ? AND status = 'running'`, [
        now.getTime(),
        entry.id,
      ])
      crashed.push({ ...entry, status: 'crashed', finishedAt: now })
    }
    return crashed
  }

  // ---- ingest jobs ----

  async createIngestJob(job: NewIngestJob): Promise<IngestJob> {
    const now = new Date().getTime()
    this.driver.run(
      `INSERT INTO ingest_jobs (id, source, status, total, done, cursor, spool_path, run_id, created_at, updated_at) ` +
        `VALUES (?, ?, 'pending', ?, 0, 0, ?, NULL, ?, ?)`,
      [job.id, job.source, job.total ?? 0, job.spoolPath ?? null, now, now],
    )
    return jobFromRow(this.driver.get(`SELECT * FROM ingest_jobs WHERE id = ?`, [job.id]) as SqlRow)
  }

  async getIngestJob(id: string): Promise<IngestJob | null> {
    const row = this.driver.get(`SELECT * FROM ingest_jobs WHERE id = ?`, [id])
    return row === undefined ? null : jobFromRow(row)
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
    const set = new Map<string, SqlValue>()
    set.set('updated_at', (patch.updatedAt ?? new Date()).getTime())
    if (patch.status !== undefined) set.set('status', patch.status)
    if (patch.total !== undefined) set.set('total', patch.total)
    if (patch.done !== undefined) set.set('done', patch.done)
    if (patch.cursor !== undefined) set.set('cursor', patch.cursor)
    if (patch.spoolPath !== undefined) set.set('spool_path', patch.spoolPath)
    if (patch.runId !== undefined) set.set('run_id', patch.runId)
    if (patch.error !== undefined) set.set('error', patch.error)
    if (patch.finishedAt !== undefined) set.set('finished_at', msOrNull(patch.finishedAt))
    const { sql, params } = setClause(set)
    this.driver.run(`UPDATE ingest_jobs SET ${sql} WHERE id = ?`, [...params, id])
  }

  async listIngestJobs(filter?: {
    status?: IngestJobStatus | IngestJobStatus[]
    limit?: number
    finishedAfter?: Date
  }): Promise<IngestJob[]> {
    const conds: string[] = []
    const params: SqlValue[] = []
    if (filter?.status !== undefined) {
      const statuses = Array.isArray(filter.status) ? filter.status : [filter.status]
      conds.push(`status IN (${placeholders(statuses.length)})`)
      params.push(...statuses)
    }
    if (filter?.finishedAfter !== undefined) {
      // Effective finish stamp: finished_at when set, else updated_at: failed
      // jobs are marked failed without a finished_at.
      conds.push('coalesce(finished_at, updated_at) >= ?')
      params.push(filter.finishedAfter.getTime())
    }
    let sql = 'SELECT * FROM ingest_jobs'
    if (conds.length > 0) sql += ' WHERE ' + conds.join(' AND ')
    sql += ' ORDER BY created_at ASC, id ASC'
    if (filter?.limit !== undefined) {
      sql += ' LIMIT ?'
      params.push(filter.limit)
    }
    return this.driver.all(sql, params).map(jobFromRow)
  }

  /**
   * Commit one chunk of spooled input atomically: every link upsert AND the
   * job's cursor/done advance happen in one BEGIN IMMEDIATE transaction, so
   * a crash can never leave links written past the recorded cursor.
   * Per-item failures are captured in the result; the chunk still commits.
   */
  async commitIngestChunk(
    jobId: string,
    raws: RawLink[],
    opts: { now?: Date } = {},
  ): Promise<IngestChunkCommit> {
    const now = opts.now ?? new Date()
    return this.tx((): IngestChunkCommit => {
      const job = this.driver.get(`SELECT * FROM ingest_jobs WHERE id = ?`, [jobId])
      if (job === undefined) {
        throw new Error(`ingest job ${jobId} does not exist`)
      }
      const items: IngestItemResult[] = []
      let inserted = 0
      let updated = 0
      for (const raw of raws) {
        try {
          const { url, hash } = normalizeUrl(raw.url)
          const existing = this.driver.get(`SELECT id FROM links WHERE url_hash = ?`, [hash])
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
          if (existing !== undefined) {
            updated += 1
            items.push({ linkId: link.id, url, ok: true, duplicate: true })
          } else {
            inserted += 1
            // An INGESTED marker row makes the new link visible to the
            // collections delta cursor (link_events.id) before its first
            // FSM transition. It is an audit row, not a transition.
            this.driver.run(
              `INSERT INTO link_events (link_id, from_state, to_state, event, data, at) ` +
                `VALUES (?, 'created', 'created', 'INGESTED', ?, ?)`,
              [link.id, JSON.stringify({ at: now.toISOString(), source: raw.source, jobId }), now.getTime()],
            )
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
      const cursor = asNum(job['cursor']) + raws.length
      const done = asNum(job['done']) + raws.length
      this.driver.run(`UPDATE ingest_jobs SET cursor = ?, done = ?, updated_at = ? WHERE id = ?`, [
        cursor,
        done,
        now.getTime(),
        jobId,
      ])
      return { cursor, done, inserted, updated, items }
    }, true)
  }

  /** FSM state of one link, validated. */
  async getState(id: number): Promise<LinkState | null> {
    const row = this.driver.get(`SELECT state, state_data FROM links WHERE id = ?`, [id])
    if (row === undefined) return null
    return parseLinkState(asStr(row['state']), parseJson(row['state_data']))
  }

  /**
   * Rewrite the state payload without changing the state. The payload is
   * validated against the state schema, so a bad payload is rejected before
   * it reaches the row.
   */
  async setStateData(id: number, data: Record<string, unknown>): Promise<number> {
    const row = this.driver.get(`SELECT state, state_data FROM links WHERE id = ?`, [id])
    if (row === undefined) return 0
    const merged = {
      ...((parseJson(row['state_data']) as Record<string, unknown> | null) ?? {}),
      ...data,
    }
    parseLinkState(asStr(row['state']), merged)
    return this.driver.run(`UPDATE links SET state_data = ?, updated_at = ? WHERE id = ?`, [
      JSON.stringify(merged),
      new Date().getTime(),
      id,
    ]).changes
  }

  /**
   * Legacy metrics row: NOT a journal lock. The row is inserted already
   * `done`-ish (non-'running') so it can never be mistaken for an
   * `acquireRun` holder. Stage work must go through `acquireRun` instead.
   */
  async startRun(stage: string, inputCount: number, startedAt?: Date): Promise<Run> {
    const at = (startedAt ?? new Date()).getTime()
    const r = this.driver.run(
      `INSERT INTO runs (stage, status, pid, heartbeat_at, started_at, input_count) VALUES (?, 'done', ?, ?, ?, ?)`,
      [stage, process.pid, at, at, inputCount],
    )
    const row = this.driver.get(`SELECT * FROM runs WHERE id = ?`, [r.lastInsertRowid]) as SqlRow
    return {
      id: asNum(row['id']),
      stage: asStr(row['stage']),
      startedAt: new Date(asNum(row['started_at'])),
      finishedAt: dateOrNull(row['finished_at']),
      inputCount: asNum(row['input_count']),
      okCount: asNum(row['ok_count']),
      errorCount: asNum(row['error_count']),
      durationMs: numOrNull(row['duration_ms']),
      tokensIn: numOrNull(row['tokens_in']),
      tokensOut: numOrNull(row['tokens_out']),
      costUsd: numOrNull(row['cost_usd']),
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
    const set = new Map<string, SqlValue>()
    set.set('finished_at', (result.finishedAt ?? new Date()).getTime())
    set.set('status', result.status ?? 'done')
    if (result.inputCount !== undefined) set.set('input_count', result.inputCount)
    // drizzle skipped undefined values: keep the column untouched, as before.
    if (result.okCount !== undefined) set.set('ok_count', result.okCount)
    if (result.errorCount !== undefined) set.set('error_count', result.errorCount)
    if (result.durationMs !== undefined) set.set('duration_ms', result.durationMs)
    set.set('tokens_in', result.tokensIn ?? null)
    set.set('tokens_out', result.tokensOut ?? null)
    set.set('cost_usd', result.costUsd ?? null)
    const { sql, params } = setClause(set)
    this.driver.run(`UPDATE runs SET ${sql} WHERE id = ?`, [...params, id])
  }

  async addMetric(metric: Metric): Promise<void> {
    this.driver.run(`INSERT INTO metrics (timestamp, stage, key, value, tags) VALUES (?, ?, ?, ?, ?)`, [
      metric.timestamp.getTime(),
      metric.stage,
      metric.key,
      metric.value,
      jsonOrNull(metric.tags),
    ])
  }

  async listMetrics(filter?: MetricFilter): Promise<Metric[]> {
    const conds: string[] = []
    const params: SqlValue[] = []
    if (filter?.stage) {
      conds.push('stage = ?')
      params.push(filter.stage)
    }
    if (filter?.since) {
      conds.push('timestamp >= ?')
      params.push(filter.since.getTime())
    }
    if (filter?.until) {
      conds.push('timestamp <= ?')
      params.push(filter.until.getTime())
    }
    let sql = 'SELECT * FROM metrics'
    if (conds.length > 0) sql += ' WHERE ' + conds.join(' AND ')
    sql += ' ORDER BY timestamp DESC'
    if (filter?.limit !== undefined) {
      sql += ' LIMIT ?'
      params.push(filter.limit)
    }
    return this.driver.all(sql, params).map((r) => ({
      timestamp: new Date(asNum(r['timestamp'])),
      stage: asStr(r['stage']),
      key: asStr(r['key']),
      value: asNum(r['value']),
      tags: (parseJson(r['tags']) as Record<string, string> | null) ?? null,
    }))
  }

  async listProfiles(): Promise<Profile[]> {
    return this.driver.all(`SELECT * FROM profiles ORDER BY host`).map(profileFromRow)
  }

  async getProfile(host: string): Promise<Profile | null> {
    const r = this.driver.get(`SELECT * FROM profiles WHERE host = ?`, [host])
    return r === undefined ? null : profileFromRow(r)
  }

  async upsertProfile(input: ProfileInput): Promise<Profile> {
    const now = new Date()
    this.driver.run(
      `INSERT INTO profiles (host, path, created_at, updated_at) VALUES (?, ?, ?, ?) ` +
        `ON CONFLICT (host) DO UPDATE SET path = ?, updated_at = ?`,
      [
        input.host,
        input.path,
        (input.createdAt ?? now).getTime(),
        (input.updatedAt ?? now).getTime(),
        input.path,
        now.getTime(),
      ],
    )
    return profileFromRow(this.driver.get(`SELECT * FROM profiles WHERE host = ?`, [input.host]) as SqlRow)
  }

  async deleteProfile(host: string): Promise<number> {
    return this.driver.run(`DELETE FROM profiles WHERE host = ?`, [host]).changes
  }

  async getHostState(key: string): Promise<HostState | null> {
    const row = this.driver.get(`SELECT * FROM host_state WHERE key = ?`, [key])
    return row === undefined ? null : hostStateFromRow(row)
  }

  async saveHostState(state: HostState): Promise<void> {
    const vals: SqlValue[] = [
      state.key,
      state.lastRequestAt,
      state.windowStart,
      state.windowCount,
      state.consecutiveFailures,
      state.breakerState,
      state.openedUntil,
      state.cooldownLevel,
      state.lastError,
      state.trialState,
      state.trialReason,
      state.trialAt,
      state.loginGated ? 1 : 0,
      state.rateLimitedUntil,
      state.pagesSinceBreak ?? null,
      state.breakEvery ?? null,
    ]
    const sets: string[] = []
    for (let i = 1; i < HOST_STATE_COLS.length; i++) sets.push(`${HOST_STATE_COLS[i]} = excluded.${HOST_STATE_COLS[i]}`)
    this.driver.run(
      `INSERT INTO host_state (${HOST_STATE_COLS.join(', ')}) VALUES (${placeholders(HOST_STATE_COLS.length)}) ` +
        `ON CONFLICT (key) DO UPDATE SET ${sets.join(', ')}`,
      vals,
    )
  }

  async listHostStates(): Promise<HostState[]> {
    return this.driver.all(`SELECT * FROM host_state ORDER BY key`).map(hostStateFromRow)
  }

  async getMeta(key: string): Promise<string | null> {
    const row = this.driver.get(`SELECT value FROM meta WHERE key = ?`, [key])
    return row === undefined ? null : asStr(row['value'])
  }

  async setMeta(key: string, value: string): Promise<void> {
    this.setMetaSync(key, value)
  }

  private setMetaSync(key: string, value: string): void {
    this.driver.run(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = ?`, [
      key,
      value,
      value,
    ])
  }
}

interface LinkConds {
  conds: string[]
  params: SqlValue[]
  rank: string | undefined
  rankParams: SqlValue[]
}

interface MatchConds {
  cond: string
  condParams: SqlValue[]
  rank: string
  rankParams: SqlValue[]
}

// ---- FTS helpers ----

/**
 * Sanitize free-text into a safe FTS5 MATCH expression: alphanumeric tokens,
 * each emitted as a quoted prefix term (`"term"*`), ANDed together. The
 * token regex excludes every FTS5 operator and quote character, so raw user
 * input can never break the MATCH syntax. Returns null when the input has
 * no searchable tokens: callers treat that as "match nothing".
 */
export function toFts5Query(text: string): string | null {
  const tokens = text.match(/[\p{L}\p{N}]+/gu) ?? []
  const seen = new Set<string>()
  const terms: string[] = []
  for (const token of tokens) {
    const key = token.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    terms.push(`"${token}"*`)
  }
  return terms.length > 0 ? terms.join(' AND ') : null
}

/** Escape LIKE wildcards for the pre-FTS5 substring fallback. */
function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`)
}

// ---- value helpers ----

function placeholders(n: number): string {
  const out: string[] = []
  for (let i = 0; i < n; i++) out.push('?')
  return out.join(', ')
}

function setClause(set: Map<string, SqlValue>): { sql: string; params: SqlValue[] } {
  const parts: string[] = []
  const params: SqlValue[] = []
  for (const [k, v] of set) {
    parts.push(`${k} = ?`)
    params.push(v)
  }
  return { sql: parts.join(', '), params }
}

function asStr(x: unknown): string {
  return typeof x === 'string' ? x : String(x)
}

function asNum(x: unknown): number {
  if (typeof x === 'number') return x
  if (typeof x === 'bigint') return Number(x)
  if (x === null || x === undefined) return 0
  return Number(x)
}

function strOrNull(x: unknown): string | null {
  return x === null || x === undefined ? null : asStr(x)
}

function numOrNull(x: unknown): number | null {
  return x === null || x === undefined ? null : asNum(x)
}

function dateOrNull(x: unknown): Date | null {
  return x === null || x === undefined ? null : new Date(asNum(x))
}

function msOrNull(d: Date | null | undefined): number | null {
  return d === null || d === undefined ? null : d.getTime()
}

function jsonOrNull(x: unknown): string | null {
  return x === null || x === undefined ? null : JSON.stringify(x)
}

function parseJson(x: unknown): unknown {
  if (x === null || x === undefined) return null
  return JSON.parse(asStr(x))
}

// ---- row <-> domain mapping ----

const LINK_INSERT_COLS = [
  'url_hash',
  'url',
  'title',
  'source',
  'added_at',
  'note',
  'tags',
  'extracted_content',
  'extracted_at',
  'enrichment',
  'expires_at',
  'expiry_reason',
  'status',
  'read_minutes',
  'category',
  'priority',
  'action',
  'confidence',
  'needs_browser',
  'captured',
  'captured_at',
  'state',
  'state_data',
  'media_report',
  'created_at',
  'updated_at',
]

const HOST_STATE_COLS = [
  'key',
  'last_request_at',
  'window_start',
  'window_count',
  'consecutive_failures',
  'breaker_state',
  'opened_until',
  'cooldown_level',
  'last_error',
  'trial_state',
  'trial_reason',
  'trial_at',
  'login_gated',
  'rate_limited_until',
  'pages_since_break',
  'break_every',
]

/** A link about to be inserted: every column resolved to its stored shape. */
interface LinkValues {
  urlHash: string
  url: string
  title: string | null
  source: string
  addedAt: Date | null
  note: string | null
  tags: string[] | null
  extractedContent: string | null
  extractedAt: Date | null
  enrichment: Enrichment | null
  expiresAt: Date | null
  expiryReason: string | null
  status: string
  readMinutes: number | null
  category: string | null
  priority: string | null
  action: string | null
  confidence: number | null
  needsBrowser: boolean
  captured: boolean
  capturedAt: Date | null
  mediaReport: MediaReport | null
  state: string
  stateData: Record<string, unknown> | null
  createdAt: Date
  updatedAt: Date
}

function toLinkValues(input: LinkInput, now: Date): LinkValues {
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

function linkFromRow(row: SqlRow): Link {
  return {
    id: asNum(row['id']),
    urlHash: asStr(row['url_hash']),
    url: asStr(row['url']),
    title: strOrNull(row['title']),
    source: asStr(row['source']),
    addedAt: dateOrNull(row['added_at']),
    note: strOrNull(row['note']),
    tags: (parseJson(row['tags']) as string[] | null) ?? null,
    extractedContent: strOrNull(row['extracted_content']),
    extractedAt: dateOrNull(row['extracted_at']),
    enrichment: (parseJson(row['enrichment']) as Enrichment | null) ?? null,
    expiresAt: dateOrNull(row['expires_at']),
    expiryReason: strOrNull(row['expiry_reason']),
    status: asStr(row['status']) as Status,
    category: strOrNull(row['category']),
    priority: strOrNull(row['priority']) as Enrichment['priority'] | null,
    action: strOrNull(row['action']) as Enrichment['action'] | null,
    confidence: numOrNull(row['confidence']),
    readMinutes: numOrNull(row['read_minutes']),
    needsBrowser: asNum(row['needs_browser']) === 1,
    captured: asNum(row['captured']) === 1,
    capturedAt: dateOrNull(row['captured_at']),
    mediaReport: (parseJson(row['media_report']) as MediaReport | null) ?? null,
    state: asStr(row['state']),
    stateData: (parseJson(row['state_data']) as Record<string, unknown> | null) ?? null,
    createdAt: new Date(asNum(row['created_at'])),
    updatedAt: new Date(asNum(row['updated_at'])),
  }
}

function eventFromRow(r: SqlRow): LinkHistoryEntry {
  return {
    id: asNum(r['id']),
    linkId: asNum(r['link_id']),
    fromState: asStr(r['from_state']),
    toState: asStr(r['to_state']),
    event: asStr(r['event']),
    data: (parseJson(r['data']) as Record<string, unknown> | null) ?? null,
    at: new Date(asNum(r['at'])),
  }
}

function profileFromRow(r: SqlRow): Profile {
  return {
    host: asStr(r['host']),
    path: asStr(r['path']),
    createdAt: new Date(asNum(r['created_at'])),
    updatedAt: new Date(asNum(r['updated_at'])),
  }
}

/** Map an ingest_jobs row to the domain job. */
function jobFromRow(row: SqlRow): IngestJob {
  return {
    id: asStr(row['id']),
    source: asStr(row['source']),
    status: asStr(row['status']) as IngestJobStatus,
    total: asNum(row['total']),
    done: asNum(row['done']),
    cursor: asNum(row['cursor']),
    spoolPath: strOrNull(row['spool_path']),
    runId: numOrNull(row['run_id']),
    error: strOrNull(row['error']),
    createdAt: new Date(asNum(row['created_at'])),
    updatedAt: new Date(asNum(row['updated_at'])),
    finishedAt: dateOrNull(row['finished_at']),
  }
}

/** Map a runs row to the full Run view (journal fields plus counters). */
function runFromRow(r: SqlRow): Run {
  return {
    id: asNum(r['id']),
    stage: asStr(r['stage']),
    status: (strOrNull(r['status']) as RunJournalStatus | null) ?? null,
    pid: numOrNull(r['pid']),
    heartbeatAt: dateOrNull(r['heartbeat_at']),
    startedAt: new Date(asNum(r['started_at'])),
    finishedAt: dateOrNull(r['finished_at']),
    inputCount: asNum(r['input_count']),
    okCount: asNum(r['ok_count']),
    errorCount: asNum(r['error_count']),
    durationMs: numOrNull(r['duration_ms']),
    tokensIn: numOrNull(r['tokens_in']),
    tokensOut: numOrNull(r['tokens_out']),
    costUsd: numOrNull(r['cost_usd']),
  }
}

/** Map a runs row to the journal view (status/pid/heartbeat included). */
function journalFromRow(row: SqlRow): RunJournalEntry {
  return {
    id: asNum(row['id']),
    stage: asStr(row['stage']),
    status: (strOrNull(row['status']) as RunJournalStatus | null) ?? 'done',
    pid: numOrNull(row['pid']),
    startedAt: new Date(asNum(row['started_at'])),
    heartbeatAt: dateOrNull(row['heartbeat_at']),
    finishedAt: dateOrNull(row['finished_at']),
  }
}

/** Map a host_state row to the core HostState record. */
function hostStateFromRow(row: SqlRow): HostState {
  return {
    key: asStr(row['key']),
    lastRequestAt: numOrNull(row['last_request_at']),
    windowStart: numOrNull(row['window_start']),
    windowCount: asNum(row['window_count']),
    consecutiveFailures: asNum(row['consecutive_failures']),
    breakerState: asStr(row['breaker_state']) as HostState['breakerState'],
    openedUntil: numOrNull(row['opened_until']),
    cooldownLevel: asNum(row['cooldown_level']),
    lastError: strOrNull(row['last_error']),
    trialState: (strOrNull(row['trial_state']) as HostState['trialState'] | null) ?? 'unknown',
    trialReason: strOrNull(row['trial_reason']),
    trialAt: numOrNull(row['trial_at']),
    loginGated: asNum(row['login_gated']) === 1,
    rateLimitedUntil: numOrNull(row['rate_limited_until']),
    pagesSinceBreak: numOrNull(row['pages_since_break']) ?? undefined,
    breakEvery: numOrNull(row['break_every']) ?? undefined,
  }
}

/** The FSM state a legacy status column maps to. */
function stateForLegacyStatus(status: string): string {
  switch (status) {
    case 'archived':
      return 'archived'
    case 'discarded':
      return 'discarded'
    case 'scheduled':
      return 'scheduled'
    // A fresh link with no explicit state starts at the extraction queue.
    default:
      return 'created'
  }
}

function dataForLegacyStatus(status: string, row: LinkValues, now: Date): Record<string, unknown> | null {
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
 * Map a LinkPatch to column values. `undefined` leaves a column alone;
 * `null` clears it. When `enrichment` is present the denormalized columns
 * derive from it (same rules as setEnrichment) and expiresAt / expiryReason
 * default to the enrichment's own values unless the patch overrides them.
 */
function patchColumns(patch: LinkPatch | undefined): Map<string, SqlValue> {
  const set = new Map<string, SqlValue>()
  if (patch === undefined) return set
  if (patch.title !== undefined) set.set('title', patch.title)
  if (patch.note !== undefined) set.set('note', patch.note)
  if (patch.tags !== undefined) set.set('tags', jsonOrNull(patch.tags))
  if (patch.extractedContent !== undefined) set.set('extracted_content', patch.extractedContent)
  if (patch.extractedAt !== undefined) set.set('extracted_at', msOrNull(patch.extractedAt))
  if (patch.needsBrowser !== undefined) set.set('needs_browser', patch.needsBrowser ? 1 : 0)
  if (patch.captured !== undefined) set.set('captured', patch.captured ? 1 : 0)
  if (patch.capturedAt !== undefined) set.set('captured_at', msOrNull(patch.capturedAt))
  if (patch.mediaReport !== undefined) set.set('media_report', jsonOrNull(patch.mediaReport))
  if (patch.enrichment !== undefined) {
    const e = patch.enrichment
    set.set('enrichment', jsonOrNull(e))
    set.set('category', e?.category ?? null)
    set.set('priority', e?.priority ?? null)
    set.set('action', e?.action ?? null)
    set.set('confidence', e?.confidence ?? null)
    set.set('read_minutes', e?.read_minutes ?? null)
    if (patch.expiresAt === undefined) {
      set.set('expires_at', e?.expires_at ? new Date(e.expires_at).getTime() : null)
    }
    if (patch.expiryReason === undefined) {
      set.set('expiry_reason', e?.expiry_reason ?? null)
    }
  }
  if (patch.expiresAt !== undefined) set.set('expires_at', msOrNull(patch.expiresAt))
  if (patch.expiryReason !== undefined) set.set('expiry_reason', patch.expiryReason)
  return set
}

class LostRace extends Error {
  readonly linkId: number
  readonly from: string
  constructor(linkId: number, from: string) {
    super(`lost race on link ${linkId} (was ${from})`)
    this.name = 'LostRace'
    this.linkId = linkId
    this.from = from
  }
}

/**
 * Side effects that belong to a state change. Moving to `deleted` purges the
 * bulky content (the tombstone keeps the url_hash so re-import is a no-op).
 */
function purgeForState(next: LinkState): Map<string, SqlValue> {
  const set = new Map<string, SqlValue>()
  if (next.state !== 'deleted') return set
  set.set('extracted_content', null)
  set.set('extracted_at', null)
  set.set('enrichment', null)
  set.set('needs_browser', 0)
  set.set('category', null)
  set.set('priority', null)
  set.set('action', null)
  set.set('confidence', null)
  set.set('read_minutes', null)
  return set
}

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
