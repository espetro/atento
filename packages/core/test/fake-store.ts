import type {
  Enrichment,
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
  LinkEvent,
  LinkStateName,
  TransitionOutcome,
  LinkHistoryEntry,
} from '../src/index.js'
import {
  normalizeUrl,
  transition,
  parseLinkState,
  legacyStatus,
  isTerminal,
  LINK_STATES,
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
  private nextLinkId = 1
  private nextRunId = 1
  private nextProfileId = 1
  history: LinkHistoryEntry[] = []
  private nextHistoryId = 1

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
    if (filter?.status) out = out.filter((l) => l.status === filter.status)
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
    const updated: Link = {
      ...link,
      state: next.state,
      stateData: payload,
      status: legacyStatus(next),
      updatedAt: at,
      ...(purge
        ? {
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
        : {}),
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

  async getState(id: number): Promise<import('../src/index.js').LinkState | null> {
    const link = this.links.find((l) => l.id === id)
    if (!link) return null
    return parseLinkState(link.state, link.stateData)
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

  async startRun(stage: string, inputCount: number, startedAt?: Date): Promise<Run> {
    const run: Run = {
      id: this.nextRunId++,
      stage,
      startedAt: startedAt ?? new Date(),
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
    return run
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
    const run = this.runs.find((r) => r.id === id)
    if (!run) return
    run.finishedAt = result.finishedAt ?? new Date()
    run.okCount = result.okCount ?? run.okCount
    run.errorCount = result.errorCount ?? run.errorCount
    run.durationMs = result.durationMs ?? run.durationMs
    run.tokensIn = result.tokensIn ?? run.tokensIn
    run.tokensOut = result.tokensOut ?? run.tokensOut
    run.costUsd = result.costUsd ?? run.costUsd
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
