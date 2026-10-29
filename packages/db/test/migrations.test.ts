import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MIGRATIONS } from '../src/migrations.js'

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
})
