#!/usr/bin/env node
// atento-browserd: the browser boundary for the native binary.
//
// A native (scriptc) build cannot load patchright, so it spawns this script instead. The protocol is
// JSON lines: one request object per stdin line, one response object per stdout line, matched by id.
// Nothing else is written to stdout. The process exits at stdin EOF, so a caller can send one request
// with spawnSync(input) or keep it open and stream requests.
//
//   {"id":1,"op":"ping"}
//     -> {"id":1,"ok":true,"driver":"patchright","version":1}
//   {"id":2,"op":"capture","url":"https://...","profileDir":"/path","executablePath":"/path/chrome",
//    "headless":true,"timeoutMs":30000,"dwellMs":0,"scrollPx":0}
//     -> {"id":2,"ok":true,"status":200,"finalUrl":"...","title":"...","html":"<html>..."}
//     -> {"id":2,"ok":false,"error":"..."}
//
// ATENTO_BROWSERD_DRIVER=fake answers capture from the file in request.fixture (used by tests and the
// native end-to-end check). Chrome path can also come from ATENTO_BROWSER_EXECUTABLE.
import { createInterface } from 'node:readline'
import { readFileSync } from 'node:fs'

const VERSION = 1

function reply(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n')
}

async function loadChromium() {
  const specifier = 'patchright'
  const mod = await import(specifier)
  const chromium = mod.chromium ?? mod.default?.chromium
  if (!chromium) throw new Error('patchright: no chromium browser type')
  return chromium
}

async function capture(req) {
  if (process.env.ATENTO_BROWSERD_DRIVER === 'fake') {
    const html = readFileSync(req.fixture, 'utf8')
    return { status: 200, finalUrl: req.url, title: '', html }
  }
  const chromium = await loadChromium()
  const executablePath = req.executablePath || process.env.ATENTO_BROWSER_EXECUTABLE || undefined
  const timeout = req.timeoutMs ?? 30000
  const opts = { headless: req.headless !== false, ...(executablePath ? { executablePath } : {}) }
  let browser = null
  let context
  if (req.profileDir) {
    context = await chromium.launchPersistentContext(req.profileDir, opts)
  } else {
    browser = await chromium.launch(opts)
    context = await browser.newContext()
  }
  try {
    const page = context.pages()[0] ?? (await context.newPage())
    const response = await page.goto(req.url, { timeout, waitUntil: 'domcontentloaded' })
    if (req.dwellMs > 0) await page.waitForTimeout(req.dwellMs)
    if (req.scrollPx > 0) await page.mouse.wheel(0, req.scrollPx)
    const html = await page.content()
    return { status: response ? response.status() : 0, finalUrl: page.url(), title: await page.title(), html }
  } finally {
    await context.close().catch(() => {})
    if (browser) await browser.close().catch(() => {})
  }
}

const rl = createInterface({ input: process.stdin })
let chain = Promise.resolve()
rl.on('line', (line) => {
  if (line.trim() === '') return
  chain = chain.then(async () => {
    let req
    try {
      req = JSON.parse(line)
    } catch {
      reply({ id: null, ok: false, error: 'bad json' })
      return
    }
    try {
      if (req.op === 'ping') reply({ id: req.id, ok: true, driver: process.env.ATENTO_BROWSERD_DRIVER ?? 'patchright', version: VERSION })
      else if (req.op === 'capture') reply({ id: req.id, ok: true, ...(await capture(req)) })
      else reply({ id: req.id, ok: false, error: `unknown op ${String(req.op)}` })
    } catch (err) {
      reply({ id: req.id, ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  })
})
rl.on('close', () => {
  chain.then(() => process.exit(0))
})
