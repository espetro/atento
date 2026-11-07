/**
 * Harness run journal: one JSON object per line at
 * <configDir>/harness_runs.jsonl. Durable, append-only, trivially inspectable
 * — the harness owns recurrence, so it owns the record of what each tick did.
 */
import { mkdirSync } from 'node:fs'
import { appendFile, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { configDir } from '@linkinbox/app'
import type { RunResult } from '@linkinbox/app'

export type RunTrigger = 'cron' | 'ingest' | 'manual'

/** One persisted harness run: the app.run result plus harness metadata. */
export interface HarnessRunRecord {
  runId: string
  trigger: RunTrigger
  cursorBefore: number
  cursorAfter: number
  summary: RunResult['summary']
  /** ISO timestamp of when the run finished (or failed). */
  finishedAt: string
  durationMs: number
  /** Set when app.run threw; summary/cursors are then absent-ish (zeroed). */
  error?: string
}

export function harnessRunsPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(configDir(env), 'harness_runs.jsonl')
}

export interface RunStore {
  append(record: HarnessRunRecord): Promise<void>
  /** Newest-first listing, capped at `limit` (default all). */
  list(limit?: number): Promise<HarnessRunRecord[]>
}

/** JSONL-backed run store. Corrupt lines are skipped, never fatal. */
export function createJsonlRunStore(path: string): RunStore {
  mkdirSync(dirname(path), { recursive: true })
  return {
    async append(record) {
      await appendFile(path, JSON.stringify(record) + '\n')
    },
    async list(limit) {
      let text: string
      try {
        text = await readFile(path, 'utf8')
      } catch {
        return []
      }
      const out: HarnessRunRecord[] = []
      for (const line of text.split('\n')) {
        if (line.trim() === '') continue
        try {
          out.push(JSON.parse(line) as HarnessRunRecord)
        } catch {
          // skip corrupt line
        }
      }
      out.reverse()
      return limit !== undefined ? out.slice(0, limit) : out
    },
  }
}

/** In-memory run store for tests. */
export function createMemoryRunStore(): RunStore & { records: HarnessRunRecord[] } {
  const records: HarnessRunRecord[] = []
  return {
    records,
    async append(record) {
      records.push(record)
    },
    async list(limit) {
      const copy = [...records].reverse()
      return limit !== undefined ? copy.slice(0, limit) : copy
    },
  }
}
