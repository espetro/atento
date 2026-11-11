import type { Database } from 'better-sqlite3'
import type { SqlDriver, SqlRow, SqlRunResult, SqlValue } from './sql-driver.js'

/**
 * SqlDriver over a better-sqlite3 handle (the Node path). The handle is
 * opened by the caller (SqliteStore); this adapter only imports the type, so
 * nothing here pulls the native addon into a scriptc build.
 */
export class BetterSqliteDriver implements SqlDriver {
  constructor(readonly handle: Database) {}

  get inTransaction(): boolean {
    return this.handle.inTransaction
  }

  exec(sql: string): void {
    this.handle.exec(sql)
  }

  run(sql: string, params: SqlValue[] = []): SqlRunResult {
    const r = this.handle.prepare(sql).run(...params)
    return { changes: r.changes, lastInsertRowid: Number(r.lastInsertRowid) }
  }

  get(sql: string, params: SqlValue[] = []): SqlRow | undefined {
    return this.handle.prepare(sql).get(...params) as SqlRow | undefined
  }

  all(sql: string, params: SqlValue[] = []): SqlRow[] {
    return this.handle.prepare(sql).all(...params) as SqlRow[]
  }

  pragma(source: string, simple = false): unknown {
    return this.handle.pragma(source, { simple })
  }

  close(): void {
    this.handle.close()
  }
}

/** True for a raw better-sqlite3 handle (as opposed to a SqlDriver). */
export function isBetterSqliteHandle(x: unknown): x is Database {
  const o = x as { prepare?: unknown; transaction?: unknown; run?: unknown }
  return typeof o.prepare === 'function' && typeof o.transaction === 'function' && typeof o.run !== 'function'
}
