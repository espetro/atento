import type {
  Enrichment,
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
  LinkEvent,
  LinkStateName,
  TransitionOutcome,
  LinkHistoryEntry,
  HostState,
  MediaReport,
  RunJournalEntry,
  RunJournalStatus,
  AcquireRunResult,
  NewIngestJob,
  IngestChunkCommit,
  IngestItemResult,
  IngestJob,
  IngestJobStatus,
  LinkPatch,
} from '../src/index.js'
import {
  normalizeUrl,
  transition,
  parseLinkState,
  legacyStatus,
  isTerminal,
  LINK_STATES,
  pidAlive,
  heartbeatStale,
  RUN_STALE_MS,
} from '../src/index.js'

/**
 * In-memory Store used by the core tests. The core package cannot depend on
 * @linkinbox/db (the dependency points the other way), so the pipeline tests
 * run against this fake. The db package proves the same behaviour against
 * real SQLite.
 */
export class FakeStore implements Store {
  links: Link[] = []
  runs: Run[] = []
  metrics: Metric[] = []
  profiles: Profile[] = []
  meta = new Map<string, string>()
  /** Per-host limiter and breaker state, like the host_state table. */
  hostStates = new Map<string, HostState>()
  private nextLinkId = 1
  private nextRunId = 1
  private nextProfileId = 1
  history: LinkHistoryEntry[] = []
  private nextHistoryId = 1
  /** Journal fields for each runs row, keyed by run id. */
  private journal = new Map<
    number,
    { status: RunJournalStatus; pid: number | null; heartbeatAt: Date | null }
  >()
  /** Ingest jobs, keyed by job id (the ingest_jobs table). */
  ingestJobRows = new Map<string, IngestJob>()

  async upsertLink(input: LinkInput): Promise<Link> {
    const now = new Date()
    const existing = this.links.find((l) => l.urlHash === input.urlHash)
    if (existing) {
      const updated: Link = {
        ...existing,
        url: input.url,
        title: input.title ?? existing.title,
        source: input.source,
        addedAt: input.addedAt ?? existing.addedAt,
        note: input.note ?? existing.note,
        tags: input.tags ?? existing.tags,
        updatedAt: now,
      }
      this.links[this.links.indexOf(existing)] = updated
      return updated
    }
    const link: Link = {
      id: this.nextLinkId++,
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
      category: input.category ?? null,
      priority: input.priority ?? null,
      action: input.action ?? null,
      confidence: input.confidence ?? null,
      readMinutes: input.readMinutes ?? null,
      needsBrowser: input.needsBrowser ?? false,
      captured: input.captured ?? false,
      capturedAt: input.capturedAt ?? null,
      mediaReport: input.mediaReport ?? null,
      createdAt: input.createdAt ?? now,
      updatedAt: input.updatedAt ?? now,
    }
    // FSM: derive the initial state from the actual data.
    if (input.state) {
      link.state = input.state
      link.stateData = input.stateData ?? null
    } else if (link.enrichment !== null || link.category !== null) {
      link.state = 'inbox'
      link.stateData = { enriched: true }
    } else if (link.extractedContent !== null) {
      link.state = 'extracted'
      link.stateData = { chars: link.extractedContent.length }
    } else {
      link.state = stateForLegacyStatus(link.status)
      link.stateData = dataForLegacyStatus(link.status, link, now)
    }
    this.links.push(link)
    return link
  }

  async getLink(id: number): Promise<Link | null> {
    return this.links.find((l) => l.id === id) ?? null
  }

  async getLinkByUrlHash(urlHash: string): Promise<Link | null> {
    return this.links.find((l) => l.urlHash === urlHash) ?? null
  }

  async listLinks(filter?: LinkFilter): Promise<Link[]> {
    let out = [...this.links]
    if (filter?.status) {
      // `byState` filters on the FSM discriminant, the legacy column otherwise.
      out = out.filter((l) =>
        filter.byState === true ? l.state === filter.status : l.status === filter.status,
      )
    }
    if (filter?.category) out = out.filter((l) => l.category === filter.category)
    if (filter?.staleAsOf) {
      out = out.filter(
        (l) => l.expiresAt !== null && l.expiresAt.getTime() < filter.staleAsOf!.getTime(),
      )
    }
    out.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id - a.id)
    if (filter?.offset !== undefined) out = out.slice(filter.offset)
    if (filter?.limit !== undefined) out = out.slice(0, filter.limit)
    return out
  }

  async countLinks(filter?: LinkFilter): Promise<number> {
    return (await this.listLinks(filter)).length
  }
  async updateStatus(ids: number[], status: Status, updatedAt?: Date): Promise<number> {
    const at = updatedAt ?? new Date()
    let updated = 0
    for (const id of ids) {
      const link = this.links.find((l) => l.id === id)
      if (!link) continue
      const outcome = await this.applyEvent(id, eventForStatus(status, at), link.state as LinkStateName)
      if (outcome.ok) updated += 1
    }
    return updated
  }

  async applyEvent(
    linkId: number,
    event: LinkEvent,
    expected?: LinkStateName,
    patch?: LinkPatch,
  ): Promise<TransitionOutcome> {
    const at = new Date()
    const link = this.links.find((l) => l.id === linkId)
    if (!link) {
      return {
        ok: false,
        error: { code: 'STALE_STATE', from: 'created', expected, message: `link ${linkId} missing` },
      }
    }
    const currentName = link.state as LinkStateName
    if (expected !== undefined && expected !== currentName) {
      return {
        ok: false,
        error: {
          code: 'STALE_STATE',
          from: currentName,
          expected,
          message: `link ${linkId} is in ${currentName}, expected ${expected}`,
        },
      }
    }
    const current = parseLinkState(currentName, link.stateData)
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
    const purge = next.state === 'deleted'
    // The patch lands before the tombstone purge (mirroring SqliteStore): a
    // DELETE can never be talked into keeping bulky content.
    let updated: Link = applyLinkPatch(
      {
        ...link,
        state: next.state,
        stateData: payload,
        status: legacyStatus(next),
        updatedAt: at,
      },
      patch ?? {},
    )
    if (purge) {
      updated = {
        ...updated,
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
    this.links[this.links.indexOf(link)] = updated
    this.history.push({
      id: this.nextHistoryId++,
      linkId,
      fromState: currentName,
      toState: next.state,
      event: event.type,
      data: event as unknown as Record<string, unknown>,
      at,
    })
    return { ok: true, state: next, from: currentName }
  }

  async getHistory(linkId: number): Promise<LinkHistoryEntry[]> {
    return this.history.filter((h) => h.linkId === linkId)
  }

  async linkEventCursor(): Promise<number> {
    let max = 0
    for (const h of this.history) if (h.id > max) max = h.id
    return max
  }

  async listChangedLinks(since: number, limit?: number): Promise<Link[]> {
    const ids = new Set<number>()
    for (const h of this.history) {
      if (h.id > since) ids.add(h.linkId)
    }
    let out = this.links
      .filter((l) => ids.has(l.id))
      .sort((a, b) => a.id - b.id)
    if (limit !== undefined) out = out.slice(0, limit)
    return out
  }

  async listLinkEvents(since: number, limit?: number): Promise<LinkHistoryEntry[]> {
    let out = this.history.filter((h) => h.id > since).sort((a, b) => a.id - b.id)
    if (limit !== undefined) out = out.slice(0, limit)
    return out.map((h) => ({ ...h }))
  }

  async countByState(): Promise<Record<LinkStateName, number>> {
    const out = {} as Record<LinkStateName, number>
    for (const name of LINK_STATES) out[name] = 0
    for (const l of this.links) out[l.state as LinkStateName] = (out[l.state as LinkStateName] ?? 0) + 1
    return out
  }

  async listByStates(states: LinkStateName[], limit?: number): Promise<Link[]> {
    let out = this.links.filter((l) => states.includes(l.state as LinkStateName))
    out = out.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id - b.id)
    if (limit !== undefined) out = out.slice(0, limit)
    return out
  }

  async reclaimExpiredLeases(cutoff: Date): Promise<number> {
    let reclaimed = 0
    for (const link of this.links) {
      if (link.state !== 'extracting' && link.state !== 'enriching') continue
      const state = parseLinkState(link.state, link.stateData)
      if (state.state !== 'extracting' && state.state !== 'enriching') continue
      if (new Date(state.startedAt).getTime() >= cutoff.getTime()) continue
      const outcome = await this.applyEvent(link.id, {
        type: 'LEASE_EXPIRED',
        at: new Date().toISOString(),
      })
      if (outcome.ok) reclaimed += 1
    }
    return reclaimed
  }

  async reclaimLeasesForRuns(runIds: number[], at?: Date): Promise<number> {
    const wanted = new Set(runIds)
    let reclaimed = 0
    for (const link of this.links) {
      if (link.state !== 'extracting' && link.state !== 'enriching') continue
      const state = parseLinkState(link.state, link.stateData)
      if (state.state !== 'extracting' && state.state !== 'enriching') continue
      if (state.runId === undefined || !wanted.has(state.runId)) continue
      const outcome = await this.applyEvent(link.id, {
        type: 'LEASE_EXPIRED',
        at: (at ?? new Date()).toISOString(),
      })
      if (outcome.ok) reclaimed += 1
    }
    return reclaimed
  }

  async getState(id: number): Promise<import('../src/index.js').LinkState | null> {
    const link = this.links.find((l) => l.id === id)
    if (!link) return null
    return parseLinkState(link.state, link.stateData)
  }

  async setStateData(id: number, data: Record<string, unknown>): Promise<number> {
    const link = this.links.find((l) => l.id === id)
    if (!link) return 0
    const merged = { ...(link.stateData ?? {}), ...data }
    parseLinkState(link.state, merged)
    link.stateData = merged
    link.updatedAt = new Date()
    return 1
  }

  async deleteLinks(ids: number[]): Promise<number> {
    const at = new Date()
    let deleted = 0
    for (const id of ids) {
      const outcome = await this.applyEvent(id, { type: 'DELETE', at: at.toISOString() })
      if (outcome.ok) deleted += 1
    }
    return deleted
  }

  async setEnrichment(id: number, enrichment: Enrichment, updatedAt?: Date): Promise<number> {
    const link = this.links.find((l) => l.id === id)
    if (!link || isTerminal(parseLinkState(link.state, link.stateData))) return 0
    link.enrichment = enrichment
    link.category = enrichment.category
    link.priority = enrichment.priority
    link.action = enrichment.action
    link.confidence = enrichment.confidence
    link.readMinutes = enrichment.read_minutes
    link.expiresAt = enrichment.expires_at ? new Date(enrichment.expires_at) : null
    link.expiryReason = enrichment.expiry_reason
    link.updatedAt = updatedAt ?? new Date()
    return 1
  }

  async setExpiry(
    id: number,
    expiresAt: Date | null,
    expiryReason: string | null,
    updatedAt?: Date,
  ): Promise<number> {
    const link = this.links.find((l) => l.id === id)
    if (!link) return 0
    link.expiresAt = expiresAt
    link.expiryReason = expiryReason
    link.updatedAt = updatedAt ?? new Date()
    return 1
  }

  async setExtractedContent(
    id: number,
    content: string,
    needsBrowser: boolean,
    extractedAt?: Date,
  ): Promise<number> {
    const link = this.links.find((l) => l.id === id)
    if (!link) return 0
    link.extractedContent = content
    link.needsBrowser = needsBrowser
    link.extractedAt = extractedAt ?? new Date()
    link.updatedAt = extractedAt ?? new Date()
    return 1
  }

  async updateTitle(id: number, title: string, updatedAt?: Date): Promise<number> {
    const link = this.links.find((l) => l.id === id)
    if (!link) return 0
    link.title = title
    link.updatedAt = updatedAt ?? new Date()
    return 1
  }

  async markCaptured(id: number, capturedAt: Date, updatedAt?: Date): Promise<number> {
    const link = this.links.find((l) => l.id === id)
    if (!link) return 0
    link.captured = true
    link.capturedAt = capturedAt
    link.updatedAt = updatedAt ?? new Date()
    return 1
  }

  mediaBudgets = new Map<string, { total: number; byTier: Record<string, number> }>()

  async setMediaReport(id: number, report: MediaReport, updatedAt?: Date): Promise<number> {
    const link = this.links.find((l) => l.id === id)
    if (!link) return 0
    link.mediaReport = report
    link.updatedAt = updatedAt ?? new Date()
    return 1
  }

  async patchLink(id: number, patch: LinkPatch, updatedAt?: Date): Promise<number> {
    const index = this.links.findIndex((l) => l.id === id)
    if (index === -1) return 0
    this.links[index] = applyLinkPatch(this.links[index]!, patch)
    this.links[index]!.updatedAt = updatedAt ?? new Date()
    return 1
  }

  async getMediaBudget(day: string): Promise<{ total: number; byTier: Record<string, number> }> {
    return this.mediaBudgets.get(day) ?? { total: 0, byTier: {} }
  }

  async saveMediaBudget(
    day: string,
    budget: { total: number; byTier: Record<string, number> },
  ): Promise<void> {
    this.mediaBudgets.set(day, budget)
  }

  async startRun(stage: string, inputCount: number, startedAt?: Date): Promise<Run> {
    const at = startedAt ?? new Date()
    const run: Run = {
      id: this.nextRunId++,
      stage,
      startedAt: at,
      finishedAt: null,
      inputCount,
      okCount: 0,
      errorCount: 0,
      durationMs: null,
      tokensIn: null,
      tokensOut: null,
      costUsd: null,
    }
    this.runs.push(run)
    // Mirrors SqliteStore.startRun: a legacy metrics row, NOT a journal
    // lock — non-'running' so it is never a holder or reclaimable.
    this.journal.set(run.id, { status: 'done', pid: process.pid, heartbeatAt: at })
    return run
  }

  async acquireRun(
    stage: string,
    opts: { pid?: number; now?: Date } = {},
  ): Promise<AcquireRunResult> {
    const at = opts.now ?? new Date()
    const pid = opts.pid ?? process.pid
    const holder = this.runs.find(
      (r) => r.stage === stage && this.journal.get(r.id)?.status === 'running',
    )
    if (holder) return { ok: false, busy: this.journalEntry(holder.id) }
    const run = await this.startRun(stage, 0, at)
    const j = this.journal.get(run.id)!
    j.status = 'running'
    j.pid = pid
    j.heartbeatAt = at
    return { ok: true, run: this.journalEntry(run.id) }
  }

  private journalEntry(id: number): RunJournalEntry {
    const run = this.runs.find((r) => r.id === id)!
    const j = this.journal.get(id) ?? {
      status: 'done' as RunJournalStatus,
      pid: null,
      heartbeatAt: null,
    }
    return {
      id: run.id,
      stage: run.stage,
      status: j.status,
      pid: j.pid,
      startedAt: run.startedAt,
      heartbeatAt: j.heartbeatAt,
      finishedAt: run.finishedAt,
    }
  }

  async heartbeatRun(id: number, at?: Date): Promise<void> {
    const j = this.journal.get(id)
    if (!j || j.status !== 'running') return
    j.heartbeatAt = at ?? new Date()
  }

  async listRunningRuns(): Promise<RunJournalEntry[]> {
    return this.runs
      .filter((r) => this.journal.get(r.id)?.status === 'running')
      .map((r) => this.journalEntry(r.id))
  }

  async getRun(id: number): Promise<Run | null> {
    return this.runs.find((r) => r.id === id) ?? null
  }

  async listRuns(opts: { since?: Date; limit?: number; afterId?: number } = {}): Promise<Run[]> {
    let out = [...this.runs].sort((a, b) => a.id - b.id)
    if (opts.afterId !== undefined) out = out.filter((r) => r.id > opts.afterId!)
    if (opts.since !== undefined) {
      out = out.filter(
        (r) =>
          r.startedAt > opts.since! ||
          (r.finishedAt !== null && r.finishedAt > opts.since!),
      )
    }
    if (opts.limit !== undefined) out = out.slice(0, opts.limit)
    return out.map((r) => ({ ...r }))
  }

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
    const crashed: RunJournalEntry[] = []
    for (const run of this.runs) {
      const j = this.journal.get(run.id)
      if (!j || j.status !== 'running') continue
      const entry = this.journalEntry(run.id)
      const pidDead = entry.pid !== null && !alive(entry.pid)
      const stale = heartbeatStale(entry, now, staleMs)
      if (!pidDead && !stale) continue
      j.status = 'crashed'
      run.finishedAt = now
      crashed.push(this.journalEntry(run.id))
    }
    return crashed
  }

  // ---- ingest jobs ----

  async createIngestJob(job: NewIngestJob): Promise<IngestJob> {
    const now = new Date()
    const row: IngestJob = {
      id: job.id,
      source: job.source,
      status: 'pending',
      total: job.total ?? 0,
      done: 0,
      cursor: 0,
      spoolPath: job.spoolPath ?? null,
      runId: null,
      error: null,
      createdAt: now,
      updatedAt: now,
      finishedAt: null,
    }
    this.ingestJobRows.set(job.id, row)
    return { ...row }
  }

  async getIngestJob(id: string): Promise<IngestJob | null> {
    const row = this.ingestJobRows.get(id)
    return row ? { ...row } : null
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
    const row = this.ingestJobRows.get(id)
    if (!row) return
    if (patch.status !== undefined) row.status = patch.status
    if (patch.total !== undefined) row.total = patch.total
    if (patch.done !== undefined) row.done = patch.done
    if (patch.cursor !== undefined) row.cursor = patch.cursor
    if (patch.spoolPath !== undefined) row.spoolPath = patch.spoolPath
    if (patch.runId !== undefined) row.runId = patch.runId
    if (patch.error !== undefined) row.error = patch.error
    if (patch.finishedAt !== undefined) row.finishedAt = patch.finishedAt
    row.updatedAt = patch.updatedAt ?? new Date()
  }

  async listIngestJobs(filter?: {
    status?: IngestJobStatus | IngestJobStatus[]
    limit?: number
    finishedAfter?: Date
  }): Promise<IngestJob[]> {
    let out = [...this.ingestJobRows.values()]
    if (filter?.status !== undefined) {
      const statuses = Array.isArray(filter.status) ? filter.status : [filter.status]
      out = out.filter((j) => statuses.includes(j.status))
    }
    if (filter?.finishedAfter !== undefined) {
      const after = filter.finishedAfter.getTime()
      out = out.filter(
        (j) => (j.finishedAt ?? j.updatedAt).getTime() >= after,
      )
    }
    out.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id))
    if (filter?.limit !== undefined) out = out.slice(0, filter.limit)
    return out.map((j) => ({ ...j }))
  }

  async commitIngestChunk(
    jobId: string,
    raws: RawLink[],
    opts: { now?: Date } = {},
  ): Promise<IngestChunkCommit> {
    const job = this.ingestJobRows.get(jobId)
    if (!job) throw new Error(`ingest job ${jobId} does not exist`)
    const now = opts.now ?? new Date()
    const items: IngestItemResult[] = []
    let inserted = 0
    let updated = 0
    for (const raw of raws) {
      try {
        const { url, hash } = normalizeUrl(raw.url)
        const existing = await this.getLinkByUrlHash(hash)
        const link = await this.upsertLink({
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
          state: 'created',
          stateData: {},
        })
        if (existing) {
          updated += 1
          items.push({ linkId: link.id, url, ok: true, duplicate: true })
        } else {
          inserted += 1
          // Mirror SqliteStore: an INGESTED marker row so the collections
          // delta cursor sees the new link before its first transition.
          this.history.push({
            id: this.nextHistoryId++,
            linkId: link.id,
            fromState: 'created',
            toState: 'created',
            event: 'INGESTED',
            data: { at: now.toISOString(), source: raw.source, jobId },
            at: now,
          })
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
    job.cursor = cursor
    job.done = done
    job.updatedAt = now
    return { cursor, done, inserted, updated, items }
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
    const run = this.runs.find((r) => r.id === id)
    if (!run) return
    run.finishedAt = result.finishedAt ?? new Date()
    if (result.inputCount !== undefined) run.inputCount = result.inputCount
    run.okCount = result.okCount ?? run.okCount
    run.errorCount = result.errorCount ?? run.errorCount
    run.durationMs = result.durationMs ?? run.durationMs
    run.tokensIn = result.tokensIn ?? run.tokensIn
    run.tokensOut = result.tokensOut ?? run.tokensOut
    run.costUsd = result.costUsd ?? run.costUsd
    const j = this.journal.get(id)
    if (j) j.status = result.status ?? 'done'
  }

  async addMetric(metric: Metric): Promise<void> {
    this.metrics.push({ tags: null, ...metric })
  }

  async listMetrics(filter?: MetricFilter): Promise<Metric[]> {
    let out = [...this.metrics]
    if (filter?.stage) out = out.filter((m) => m.stage === filter.stage)
    if (filter?.since) out = out.filter((m) => m.timestamp >= filter.since!)
    if (filter?.until) out = out.filter((m) => m.timestamp <= filter.until!)
    out.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
    if (filter?.limit !== undefined) out = out.slice(0, filter.limit)
    return out
  }

  async listProfiles(): Promise<Profile[]> {
    return [...this.profiles].sort((a, b) => a.host.localeCompare(b.host))
  }

  async getProfile(host: string): Promise<Profile | null> {
    return this.profiles.find((p) => p.host === host) ?? null
  }

  async upsertProfile(input: ProfileInput): Promise<Profile> {
    const now = new Date()
    const existing = this.profiles.find((p) => p.host === input.host)
    if (existing) {
      existing.path = input.path
      existing.updatedAt = now
      return existing
    }
    const profile: Profile = {
      host: input.host,
      path: input.path,
      createdAt: input.createdAt ?? now,
      updatedAt: input.updatedAt ?? now,
    }
    this.profiles.push(profile)
    void this.nextProfileId
    return profile
  }

  async deleteProfile(host: string): Promise<number> {
    const before = this.profiles.length
    this.profiles = this.profiles.filter((p) => p.host !== host)
    return before - this.profiles.length
  }

  async getHostState(key: string): Promise<HostState | null> {
    return this.hostStates.get(key) ?? null
  }

  async saveHostState(state: HostState): Promise<void> {
    this.hostStates.set(state.key, { ...state })
  }

  async listHostStates(): Promise<HostState[]> {
    return [...this.hostStates.values()].map((s) => ({ ...s }))
  }

  async getMeta(key: string): Promise<string | null> {
    return this.meta.get(key) ?? null
  }

  async setMeta(key: string, value: string): Promise<void> {
    this.meta.set(key, value)
  }

  async schemaVersion(): Promise<string> {
    return this.meta.get('schema_version') ?? '1'
  }

  async migrate(): Promise<void> {
    this.meta.set('schema_version', '1')
  }

  async close(): Promise<void> {}
}

/** Convenience: normalize then upsert a raw link into the fake store. */
function stateForLegacyStatus(status: Status): string {
  switch (status) {
    case 'archived': return 'archived'
    case 'discarded': return 'discarded'
    case 'scheduled': return 'scheduled'
    // A fresh link with no explicit state starts at the extraction queue.
    default: return 'created'
  }
}

function dataForLegacyStatus(status: Status, link: Link, now: Date): Record<string, unknown> | null {
  switch (status) {
    case 'archived':
      return { archivedAt: now.toISOString(), reason: 'manual' }
    case 'discarded':
      return { discardedAt: now.toISOString() }
    case 'scheduled':
      return { scheduledFor: null }
    case 'inbox':
      return { enriched: link.enrichment !== null || link.category !== null }
    default:
      return {}
  }
}

export async function seedLink(store: FakeStore, url: string, overrides: Partial<Link> = {}): Promise<Link> {
  const { url: normalized, hash } = normalizeUrl(url)
  return store.upsertLink({
    urlHash: hash,
    url: normalized,
    source: 'test',
    status: 'inbox',
    needsBrowser: false,
    ...overrides,
  } as LinkInput)
}

/**
 * Apply a LinkPatch to an in-memory link, mirroring SqliteStore.patchColumns:
 * `undefined` leaves a field alone, `null` clears it, and `enrichment`
 * derives the denormalized columns (expiresAt/expiryReason default to the
 * enrichment's own values unless overridden).
 */
function applyLinkPatch(link: Link, patch: LinkPatch): Link {
  const out = { ...link }
  if (patch.title !== undefined) out.title = patch.title
  if (patch.note !== undefined) out.note = patch.note
  if (patch.tags !== undefined) out.tags = patch.tags
  if (patch.extractedContent !== undefined) out.extractedContent = patch.extractedContent
  if (patch.extractedAt !== undefined) out.extractedAt = patch.extractedAt
  if (patch.needsBrowser !== undefined) out.needsBrowser = patch.needsBrowser
  if (patch.captured !== undefined) out.captured = patch.captured
  if (patch.capturedAt !== undefined) out.capturedAt = patch.capturedAt
  if (patch.mediaReport !== undefined) out.mediaReport = patch.mediaReport
  if (patch.enrichment !== undefined) {
    const e = patch.enrichment
    out.enrichment = e
    out.category = e?.category ?? null
    out.priority = e?.priority ?? null
    out.action = e?.action ?? null
    out.confidence = e?.confidence ?? null
    out.readMinutes = e?.read_minutes ?? null
    if (patch.expiresAt === undefined) {
      out.expiresAt = e?.expires_at ? new Date(e.expires_at) : null
    }
    if (patch.expiryReason === undefined) {
      out.expiryReason = e?.expiry_reason ?? null
    }
  }
  if (patch.expiresAt !== undefined) out.expiresAt = patch.expiresAt
  if (patch.expiryReason !== undefined) out.expiryReason = patch.expiryReason
  return out
}

function eventForStatus(status: Status, at: Date): import('../src/index.js').LinkEvent {
  switch (status) {
    case 'archived':
      return { type: 'EXPIRE', at: at.toISOString() }
    case 'discarded':
      return { type: 'TRIAGE', action: 'discard', at: at.toISOString() }
    case 'scheduled':
      return { type: 'TRIAGE', action: 'schedule', at: at.toISOString() }
    default:
      return { type: 'RESTORE', at: at.toISOString() }
  }
}
