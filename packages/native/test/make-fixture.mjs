// Deterministic 40-link fixture database for the native parity harness.
// usage: node make-fixture.mjs <out.db>
// Uses the Node store (@atento/db), so the schema and FSM history are the real ones.
import { rmSync } from 'node:fs'
import { SqliteStore } from '@atento/db'
import { normalizeUrl } from '@atento/core'

const out = process.argv[2]
if (!out) throw new Error('usage: make-fixture.mjs <out.db>')
rmSync(out, { force: true })
const store = new SqliteStore({ path: out, wal: false })
await store.migrate()

const DAY = 86_400_000
const base = Date.UTC(2026, 9, 1)
const cats = ['job', 'reading', 'tool', 'news']
const hosts = ['example.com', 'news.example.org', 'blog.example.net', 'tool.example.io', 'docs.example.dev']
const parkReasons = ['login_wall', 'bot_block', 'js_shell', 'http_error', 'timeout', 'review_only']

for (let i = 0; i < 40; i++) {
  const host = hosts[i % hosts.length]
  const { url, hash } = normalizeUrl(`https://${host}/post/${i}?a=${i}`)
  const at = new Date(base + i * 3_600_000)
  const enrichment = (cat, action) => ({
    category: cat,
    priority: i % 3 === 0 ? 'high' : i % 3 === 1 ? 'normal' : 'low',
    why_it_matters: `Matters for item ${i} (${cat})`,
    read_minutes: 3 + (i % 9),
    action,
    expires_at: new Date(base + (i % 2 === 0 ? -10 : 40) * DAY).toISOString(),
    expiry_reason: i % 2 === 0 ? 'time sensitive' : null,
    confidence: 0.5 + (i % 5) / 10,
  })
  const common = {
    urlHash: hash,
    url,
    title: i % 7 === 6 ? null : `Item ${i}: ${cats[i % 4]} notes about ${host}`,
    source: i % 2 === 0 ? 'export.md' : 'reading-list.html',
    addedAt: at,
    note: i % 5 === 0 ? `note for ${i}` : null,
    tags: i % 4 === 0 ? ['alpha', `t${i}`] : null,
    createdAt: at,
    updatedAt: at,
  }
  const kind = i % 8
  if (kind <= 3) {
    // inbox, enriched, some stale
    const e = enrichment(cats[i % 4], i % 3 === 0 ? 'read_now' : 'schedule')
    await store.upsertLink({
      ...common,
      status: 'inbox',
      enrichment: e,
      expiresAt: new Date(e.expires_at),
      expiryReason: e.expiry_reason,
      extractedContent: `Extracted body ${i}. Rust and sqlite and pipelines.`,
      extractedAt: at,
      state: 'inbox',
      stateData: { enriched: true },
    })
  } else if (kind === 4) {
    await store.upsertLink({ ...common, status: 'inbox', state: 'created', stateData: {} })
  } else if (kind === 5) {
    await store.upsertLink({
      ...common,
      status: 'inbox',
      needsBrowser: true,
      state: 'needs_browser',
      stateData: { host, reason: 'login_wall', reasonClass: parkReasons[i % parkReasons.length] },
    })
  } else if (kind === 6) {
    await store.upsertLink({
      ...common,
      status: 'inbox',
      state: 'deferred',
      stateData: {
        stage: 'extract',
        nextAttemptAt: new Date(base + 2 * DAY).toISOString(),
        attempts: 1 + (i % 3),
        reason: 'host cooldown',
        reasonClass: parkReasons[i % parkReasons.length],
      },
    })
  } else {
    await store.upsertLink({
      ...common,
      status: 'archived',
      state: 'archived',
      stateData: { archivedAt: at.toISOString(), reason: 'manual' },
    })
  }
}
// A little history through the FSM so `show` has events to print.
for (const id of [1, 2, 3]) {
  await store.applyEvent(id, { type: 'TRIAGE', action: 'schedule', at: new Date(base + 50 * DAY).toISOString() })
}
await store.setMeta('fixture', 'atento-parity-40')
await store.close()
console.log(`wrote ${out}`)
