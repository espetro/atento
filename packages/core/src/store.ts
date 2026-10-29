import { createHash } from 'node:crypto'
import type { RawLink, Link, LinkInput, Enrichment, Status, Run, Metric } from './types.js'

/**
 * Repository layer. Hides the storage engine (drizzle/sqlite today, maybe pg
 * tomorrow) behind a plain interface. Every pipeline stage is a pure async
 * function over this interface.
 */
export interface Store {
  // links
  upsertLink(link: LinkInput): Promise<Link>
  getLink(id: number): Promise<Link | null>
  getLinkByUrlHash(urlHash: string): Promise<Link | null>
  listLinks(filter?: LinkFilter): Promise<Link[]>
  countLinks(filter?: LinkFilter): Promise<number>
  updateStatus(ids: number[], status: Status, updatedAt?: Date): Promise<number>
  deleteLinks(ids: number[]): Promise<number>
  setEnrichment(id: number, enrichment: Enrichment, updatedAt?: Date): Promise<number>
  setExpiry(
    id: number,
    expiresAt: Date | null,
    expiryReason: string | null,
    updatedAt?: Date,
  ): Promise<number>
  setExtractedContent(
    id: number,
    content: string,
    needsBrowser: boolean,
    extractedAt?: Date,
  ): Promise<number>

  // runs
  startRun(stage: string, inputCount: number, startedAt?: Date): Promise<Run>
  finishRun(
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
  ): Promise<void>

  // metrics
  addMetric(metric: Metric): Promise<void>
  listMetrics(filter?: MetricFilter): Promise<Metric[]>

  // meta / maintenance
  getMeta(key: string): Promise<string | null>
  setMeta(key: string, value: string): Promise<void>
  schemaVersion(): Promise<string>
  migrate(): Promise<void>
  close(): Promise<void>
}

export interface LinkFilter {
  status?: Status
  category?: string
  staleAsOf?: Date
  limit?: number
  offset?: number
}

export interface MetricFilter {
  stage?: string
  since?: Date
  until?: Date
  limit?: number
}

/** Suggested canonical importer identities. Not enforced here. */
export const SOURCES = {
  markdown: 'markdown',
  json: 'json',
  urlList: 'url-list',
  safariReadingList: 'safari-reading-list',
} as const satisfies Record<string, string>

export type { RawLink, Link, Enrichment, Status, Run, Metric }
