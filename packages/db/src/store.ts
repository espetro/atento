import Database from 'better-sqlite3'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { BetterSqliteDriver } from './better-sqlite3-driver.js'
import { SqlStore } from './sql-store.js'

export { toFts5Query } from './sql-store.js'

export interface SqliteStoreOptions {
  /** Path to the sqlite file, or ':memory:'. */
  path: string
  /** WAL is on for file DBs; memory DBs keep it off (WAL is meaningless there). */
  wal?: boolean
  busyTimeoutMs?: number
}

const DEFAULT_BUSY_TIMEOUT_MS = 5000

/**
 * SQLite Store on Node: better-sqlite3 (synchronous) under the portable
 * SqlStore. All pipeline stages consume this through the `Store` interface.
 * The native build uses SqlStore with the @cutils/sqlite driver instead.
 */
export class SqliteStore extends SqlStore {
  private readonly sqlite: Database.Database
  private readonly ownsSqlite: boolean

  constructor(options: SqliteStoreOptions)
  /** Wrap an existing better-sqlite3 handle (does not close it on close()). */
  constructor(sqlite: Database.Database)
  constructor(arg: SqliteStoreOptions | Database.Database) {
    if (typeof arg === 'object' && 'path' in arg === false && 'exec' in arg) {
      const handle = arg as Database.Database
      // Same durability contract as the owned-handle path.
      handle.pragma('synchronous = FULL')
      super(new BetterSqliteDriver(handle))
      this.sqlite = handle
      this.ownsSqlite = false
      return
    }
    const opts = arg as SqliteStoreOptions
    const handle = new Database(opts.path)
    handle.pragma(`busy_timeout = ${opts.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS}`)
    if (opts.wal !== false && opts.path !== ':memory:') {
      handle.pragma('journal_mode = WAL')
    }
    handle.pragma('foreign_keys = ON')
    // Durability: every commit is fsynced before it is acknowledged.
    handle.pragma('synchronous = FULL')
    super(new BetterSqliteDriver(handle))
    this.sqlite = handle
    this.ownsSqlite = true
  }

  /**
   * Consistent online backup of the database to `destPath` (better-sqlite3's
   * backup API). Safe while the store is open and serving: the backup is a
   * snapshot, WAL included. The destination is created/truncated.
   */
  async backup(destPath: string): Promise<void> {
    // better-sqlite3 refuses to create missing directories.
    await mkdir(dirname(destPath), { recursive: true })
    await this.sqlite.backup(destPath)
  }

  override async close(): Promise<void> {
    if (this.ownsSqlite) this.sqlite.close()
  }
}
