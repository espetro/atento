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
} from '../src/index.js'
import { normalizeUrl } from '../src/index.js'

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
    let changes = 0
    for (const link of this.links) {
      if (ids.includes(link.id)) {
        link.status = status
        link.updatedAt = updatedAt ?? new Date()
        changes += 1
      }
    }
    return changes
  }

  async deleteLinks(ids: number[]): Promise<number> {
    const before = this.links.length
    this.links = this.links.filter((l) => !ids.includes(l.id))
    return before - this.links.length
  }

  async setEnrichment(id: number, enrichment: Enrichment, updatedAt?: Date): Promise<number> {
    const link = this.links.find((l) => l.id === id)
    if (!link) return 0
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
