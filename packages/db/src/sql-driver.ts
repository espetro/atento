/**
 * Synchronous SQL driver seam. `SqlStore` (sql-store.ts) is written against
 * this interface only, so the same Store runs on better-sqlite3 (Node) and on
 * @cutils/sqlite (scriptc native builds). A driver is a thin adapter: it
 * executes statements with positional parameters and hands back plain rows.
 * Transactions are built on top with `runInTransaction` (BEGIN / SAVEPOINT),
 * which needs nothing from the driver beyond `exec` and `inTransaction`.
 */

/** Values a statement parameter can carry. Booleans and Dates are mapped by the store. */
export type SqlValue = string | number | bigint | null | Uint8Array

/** One result row, keyed by column name. */
export type SqlRow = Record<string, unknown>

export interface SqlRunResult {
  changes: number
  lastInsertRowid: number
}

export interface SqlDriver {
  /** Execute one or more statements without parameters (DDL, BEGIN, COMMIT). */
  exec(sql: string): void
  /** Execute one statement with positional `?` parameters. */
  run(sql: string, params?: SqlValue[]): SqlRunResult
  /** First row of a query, or undefined. */
  get(sql: string, params?: SqlValue[]): SqlRow | undefined
  /** All rows of a query. */
  all(sql: string, params?: SqlValue[]): SqlRow[]
  /**
   * Run a PRAGMA (`journal_mode = WAL`, `busy_timeout`). With `simple` the
   * first column of the first row is returned as a scalar.
   */
  pragma(source: string, simple?: boolean): unknown
  /** True while a BEGIN or SAVEPOINT is open on this connection. */
  readonly inTransaction: boolean
  close(): void
}

export type TransactionMode = 'deferred' | 'immediate'

let savepointCounter = 0

/**
 * Run `fn` atomically: BEGIN (or BEGIN IMMEDIATE) on the outermost call, a
 * SAVEPOINT when already inside a transaction. A throw rolls back and
 * rethrows; the return value of `fn` is passed through.
 */
export function runInTransaction<T>(
  db: SqlDriver,
  fn: () => T,
  mode: TransactionMode = 'deferred',
): T {
  if (db.inTransaction) {
    savepointCounter += 1
    const name = 'sp_' + savepointCounter
    db.exec('SAVEPOINT ' + name)
    let result: T
    try {
      result = fn()
    } catch (err) {
      db.exec('ROLLBACK TO ' + name)
      db.exec('RELEASE ' + name)
      throw err
    }
    db.exec('RELEASE ' + name)
    return result
  }
  db.exec(mode === 'immediate' ? 'BEGIN IMMEDIATE' : 'BEGIN')
  let result: T
  try {
    result = fn()
  } catch (err) {
    if (db.inTransaction) db.exec('ROLLBACK')
    throw err
  }
  db.exec('COMMIT')
  return result
}
