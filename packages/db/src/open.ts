import { SqliteStore, type SqliteStoreOptions } from './store.js'

export interface OpenStoreOptions extends SqliteStoreOptions {
  /** Run migrations on open. Default true. */
  migrate?: boolean
}

/**
 * Open a SQLite store, creating the file (and schema) if needed.
 * Default location follows the XDG-ish convention used by the CLI.
 */
export async function openStore(options: OpenStoreOptions): Promise<SqliteStore> {
  const store = new SqliteStore(options)
  if (options.migrate !== false) await store.migrate()
  return store
}
