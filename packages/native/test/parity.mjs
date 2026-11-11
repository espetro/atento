// Parity harness: the Node CLI/MCP against the native binary on the same fixture database.
//
//   node test/parity.mjs --native <bin> --db <fixture.db> [--node <cli bin.js>] [--only <substr>] [--verbose]
//
// Read cases run on one shared copy and are compared byte for byte (stdout and exit code).
// Write cases run on two separate copies (one per implementation); stdout is compared after
// masking "now" timestamps, then the resulting database state is dumped and compared the same way.
import { spawn, spawnSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, rmSync, mkdirSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CASES, MCP_CASES } from './cases.mjs'

const args = process.argv.slice(2)
function opt(name, dflt) {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : dflt
}
const verbose = args.includes('--verbose')
const only = opt('--only', '')
const nativeBin = resolve(opt('--native', ''))
const dbSrc = resolve(opt('--db', ''))
const here = fileURLToPath(new URL('.', import.meta.url))
const nodeCli = resolve(opt('--node', join(here, '../../cli/dist/bin.js')))
if (!existsSync(nativeBin) || !existsSync(dbSrc) || !existsSync(nodeCli)) {
  console.error('usage: parity.mjs --native <bin> --db <db> [--node <bin.js>]')
  process.exit(2)
}

const work = mkdtempSync(join(tmpdir(), 'atento-parity-'))
const START = Date.now()

function env(dbPath, home) {
  return { ...process.env, ATENTO_DB: dbPath, ATENTO_HOME: home, ATENTO_LOG_FILE: join(home, 'log'), NO_COLOR: '1' }
}
function freshDb(tag) {
  const dir = join(work, tag)
  mkdirSync(dir, { recursive: true })
  mkdirSync(join(dir, 'home'), { recursive: true })
  const db = join(dir, 'links.db')
  copyFileSync(dbSrc, db)
  for (const sfx of ['-wal', '-shm']) if (existsSync(dbSrc + sfx)) copyFileSync(dbSrc + sfx, db + sfx)
  return { db, home: join(dir, 'home'), dir }
}
function runCli(impl, argv, fx, stdin) {
  const cmd = impl === 'node' ? process.execPath : nativeBin
  const full = impl === 'node' ? [nodeCli, ...argv] : argv
  const r = spawnSync(cmd, full, { env: env(fx.db, fx.home), encoding: 'utf8', input: stdin ?? '', timeout: 120_000 })
  return { out: r.stdout ?? '', err: r.stderr ?? '', code: r.status }
}

const NOW_ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g
function maskNow(text) {
  return text.replace(/("(?:since|until)\\*": *\\*")[^"\\]+/g, '$1<ts>').replace(NOW_ISO, (m) => (Date.parse(m) >= START - 60_000 ? '<now>' : m))
}
function maskDeep(v, key) {
  if (typeof v === 'string') return maskNow(v)
  if (typeof v === 'number') return v >= START - 60_000 && v <= Date.now() + 60_000 && v > 1e12 ? '<now-ms>' : v
  if (Array.isArray(v)) return v.map((x) => maskDeep(x, key))
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, maskDeep(x, k)]))
  return v
}
function dumpDb(dbPath) {
  const tables = ['links', 'link_events', 'ingest_jobs', 'runs', 'metrics', 'host_state', 'meta', 'profiles']
  const out = {}
  for (const t of tables) {
    const r = spawnSync('sqlite3', ['-json', dbPath, `select * from ${t} order by 1,2`], { encoding: 'utf8', maxBuffer: 1 << 30 })
    const text = (r.stdout ?? '').trim()
    let rows = text === '' ? [] : JSON.parse(text)
    if (t === 'ingest_jobs') rows = rows.map((x) => ({ ...x, id: '<job>', spool_path: '<spool>' }))
    if (t === 'meta') rows = rows.filter((x) => !String(x.key).startsWith('migration:'))
    out[t] = maskDeep(rows)
  }
  return JSON.stringify(out, null, 1)
}

const results = []
function record(kind, name, ok, detail) {
  results.push({ kind, name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${kind.padEnd(5)} ${name}`)
  if (!ok && detail) console.log(detail.split('\n').slice(0, verbose ? 60 : 12).map((l) => '      ' + l).join('\n'))
}
function firstDiff(a, b) {
  const al = a.split('\n')
  const bl = b.split('\n')
  for (let i = 0; i < Math.max(al.length, bl.length); i++) {
    if (al[i] !== bl[i]) return `line ${i + 1}\n  node:   ${al[i] ?? '<eof>'}\n  native: ${bl[i] ?? '<eof>'}`
  }
  return 'no diff'
}

// ---- CLI cases ----
const sharedRead = freshDb('read')
for (const c of CASES) {
  if (only && !c.name.includes(only)) continue
  if (c.write) {
    const a = freshDb('w-node-' + c.name.replace(/\W+/g, '_'))
    const b = freshDb('w-nat-' + c.name.replace(/\W+/g, '_'))
    const ra = runCli('node', c.cli, a, c.stdin)
    const rb = runCli('native', c.cli, b, c.stdin)
    const oa = maskNow(ra.out)
    const ob = maskNow(rb.out)
    const da = dumpDb(a.db)
    const db_ = dumpDb(b.db)
    const ok = oa === ob && ra.code === rb.code && da === db_
    let detail = ''
    if (oa !== ob) detail += 'stdout ' + firstDiff(oa, ob) + '\n'
    if (ra.code !== rb.code) detail += `exit node=${ra.code} native=${rb.code}\n  node stderr: ${ra.err.slice(0, 200)}\n  native stderr: ${rb.err.slice(0, 200)}\n`
    if (da !== db_) detail += 'db state ' + firstDiff(da, db_)
    record('cli-w', c.name, ok, detail)
  } else {
    const ra = runCli('node', c.cli, sharedRead, c.stdin)
    const rb = runCli('native', c.cli, sharedRead, c.stdin)
    const ok = maskNow(ra.out) === maskNow(rb.out) && ra.code === rb.code
    let detail = ''
    if (ra.out !== rb.out) detail += 'stdout ' + firstDiff(ra.out, rb.out) + '\n'
    if (ra.code !== rb.code) detail += `exit node=${ra.code} native=${rb.code}\n  node stderr: ${ra.err.slice(0, 200)}\n  native stderr: ${rb.err.slice(0, 200)}\n`
    record('cli', c.name, ok, detail)
  }
}

// ---- MCP ----
function mcpSession(impl, fx, calls) {
  return new Promise((resolveP) => {
    const cmd = impl === 'node' ? process.execPath : nativeBin
    const argv = impl === 'node' ? [nodeCli, 'mcp'] : ['mcp']
    const child = spawn(cmd, argv, { env: env(fx.db, fx.home), stdio: ['pipe', 'pipe', 'pipe'] })
    let buf = ''
    const replies = new Map()
    const waiters = new Map()
    child.stdout.on('data', (d) => {
      buf += d.toString()
      let nl
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        if (line.trim() === '') continue
        try {
          const m = JSON.parse(line)
          replies.set(m.id, line)
          waiters.get(m.id)?.(line)
        } catch {}
      }
    })
    const send = (obj) => child.stdin.write(JSON.stringify(obj) + '\n')
    const ask = (obj) =>
      new Promise((res) => {
        const t = setTimeout(() => res('<timeout>'), 60_000)
        waiters.set(obj.id, (l) => {
          clearTimeout(t)
          res(l)
        })
        send(obj)
      })
    ;(async () => {
      const out = {}
      await ask({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'parity', version: '0' } } })
      send({ jsonrpc: '2.0', method: 'notifications/initialized' })
      let id = 10
      for (const c of calls) {
        id++
        out[c.name] = await ask(
          c.method === 'tools/list'
            ? { jsonrpc: '2.0', id, method: 'tools/list', params: {} }
            : { jsonrpc: '2.0', id, method: 'tools/call', params: { name: c.tool, arguments: c.args ?? {} } },
        )
      }
      child.kill()
      resolveP(out)
    })()
  })
}
function normMcp(line, write) {
  let s = line
  try {
    const m = JSON.parse(line)
    delete m.id
    const sortKeys = (o) => (o && typeof o === 'object' && !Array.isArray(o) ? Object.fromEntries(Object.keys(o).sort().map((k) => [k, sortKeys(o[k])])) : Array.isArray(o) ? o.map(sortKeys) : o)
    s = JSON.stringify(sortKeys(m))
  } catch {}
  return maskNow(s)
}
const readCalls = MCP_CASES.filter((c) => !c.write && (!only || c.name.includes(only)))
if (readCalls.length > 0) {
  const [ra, rb] = await Promise.all([mcpSession('node', sharedRead, readCalls), mcpSession('native', sharedRead, readCalls)])
  for (const c of readCalls) {
    const a = normMcp(ra[c.name], false)
    const b = normMcp(rb[c.name], false)
    record('mcp', c.name, a === b, a === b ? '' : firstDiff(a, b))
  }
}
for (const c of MCP_CASES.filter((x) => x.write && (!only || x.name.includes(only)))) {
  const a = freshDb('mw-node-' + c.name.replace(/\W+/g, '_'))
  const b = freshDb('mw-nat-' + c.name.replace(/\W+/g, '_'))
  const [ra, rb] = await Promise.all([mcpSession('node', a, [c]), mcpSession('native', b, [c])])
  const oa = normMcp(ra[c.name], true).replace(/job-[\w-]+/g, '<job>')
  const ob = normMcp(rb[c.name], true).replace(/job-[\w-]+/g, '<job>')
  const da = dumpDb(a.db)
  const db_ = dumpDb(b.db)
  const ok = oa === ob && da === db_
  record('mcp-w', c.name, ok, (oa !== ob ? 'reply ' + firstDiff(oa, ob) + '\n' : '') + (da !== db_ ? 'db state ' + firstDiff(da, db_) : ''))
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} identical`)
if (!process.env.KEEP_WORK) rmSync(work, { recursive: true, force: true })
process.exit(failed.length === 0 ? 0 : 1)
