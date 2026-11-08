import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { MIGRATIONS, runMigrations, type Migration } from '../src/migrations.js'

const here = dirname(fileURLToPath(import.meta.url))
const migrationsDir = join(here, '..', 'migrations')

describe('migrations', () => {
  it('keeps the sql files in sync with the code migrations', () => {
    const files = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()
    expect(files).toEqual(MIGRATIONS.map((m) => `${m.name}.sql`))
    for (const migration of MIGRATIONS) {
      const onDisk = readFileSync(join(migrationsDir, `${migration.name}.sql`), 'utf8')
      expect(onDisk).toBe(migration.sql)
    }
  })

  it('names migrations in order', () => {
    const names = MIGRATIONS.map((m) => m.name)
    expect([...names].sort()).toEqual(names)
  })

  it('applies each migration atomically: a mid-migration failure leaves no objects and no meta row', () => {
    const sqlite = new Database(':memory:')
    const good: Migration = {
      name: '0001_good',
      sql: `CREATE TABLE kept (id INTEGER PRIMARY KEY);`,
    }
    // Fails on the last statement, after earlier statements already ran —
    // the exact shape of the 0010 backfill crash the transaction prevents.
    const bad: Migration = {
      name: '0002_bad',
      sql: `
CREATE TABLE partial (id INTEGER PRIMARY KEY);
INSERT INTO partial (id) VALUES (1);
SELECT * FROM definitely_missing_table;
`,
    }
    expect(() => runMigrations(sqlite, [good, bad])).toThrow()

    // The good migration committed; the bad one rolled back entirely —
    // no partial table, and crucially no meta row claiming it applied.
    expect(
      sqlite.prepare(`SELECT name FROM sqlite_master WHERE name = 'kept'`).get(),
    ).toBeDefined()
    expect(
      sqlite.prepare(`SELECT name FROM sqlite_master WHERE name = 'partial'`).get(),
    ).toBeUndefined()
    const keys = (
      sqlite.prepare(`SELECT key FROM meta WHERE key LIKE 'migration:%'`).all() as Array<{
        key: string
      }>
    ).map((r) => r.key)
    expect(keys).toEqual(['migration:0001_good'])
    sqlite.close()
  })
})
