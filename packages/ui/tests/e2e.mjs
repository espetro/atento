// Playwright smoke tests for the M4b UI, run against a built dist/ served
// with the mock API middleware via `vite preview` (VITE_MOCK=1).
// Usage: pnpm build && node tests/e2e.mjs
import { chromium } from '@playwright/test'
import { spawn } from 'node:child_process'

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:4174'
const failures = []
const check = (name, cond) => {
  if (cond) {
    console.log(`ok - ${name}`)
  } else {
    failures.push(name)
    console.log(`FAIL - ${name}`)
  }
}

// Self-contained: start `vite preview` with the mock API unless E2E_BASE_URL
// points at an already-running server.
let server
if (!process.env.E2E_BASE_URL) {
  server = spawn('pnpm', ['exec', 'vite', 'preview', '--port', '4174', '--strictPort'], {
    env: { ...process.env, VITE_MOCK: '1' },
    stdio: 'ignore',
  })
  await new Promise((r) => setTimeout(r, 1500))
}

const browser = await chromium.launch()

async function newPage(width, height) {
  const page = await browser.newPage({ viewport: { width, height } })
  const consoleErrors = []
  page.on('console', (msg) => {
    if (msg.type() === 'error' || msg.type() === 'warning') consoleErrors.push(`${msg.type()}: ${msg.text()}`)
  })
  page.on('pageerror', (err) => consoleErrors.push(String(err)))
  return { page, consoleErrors }
}

// ---------- desktop triage ----------------------------------------------------
{
  const { page, consoleErrors } = await newPage(1440, 900)
  await page.goto(BASE, { waitUntil: 'networkidle' })
  await page.waitForSelector('[data-testid=triage-shell]', { timeout: 15_000 })
  await page.waitForSelector('[data-testid=link-row]', { timeout: 15_000 })

  check('triage shell renders rail + list + preview', (await page.locator('[data-testid=collections-rail]').count()) === 1)

  // Rail shows collections with counts.
  const railCounts = await page.locator('[data-testid^=collection-] .count').allTextContents()
  check('rail collection counts render', railCounts.length >= 7 && railCounts.some((c) => Number(c) > 0))

  // List shows rows; total count present.
  const rows = await page.locator('[data-testid=link-row]').count()
  check('link rows render', rows > 0)
  check('total count shown', /\d+ items/.test((await page.textContent('[data-testid=total-count]')) ?? ''))

  // j/k moves selection (URL ?selected= changes).
  await page.keyboard.press('j')
  await page.waitForTimeout(300)
  const selected1 = page.url()
  check('j selects a link', selected1.includes('selected='))
  await page.keyboard.press('k')
  await page.keyboard.press('j')
  await page.waitForTimeout(200)

  // Preview pane shows the selected link's reader markdown.
  await page.waitForSelector('[data-testid=preview-body]', { timeout: 10_000 })
  const md = await page.locator('[data-testid=reader-markdown]').count()
  check('reader tab shows markdown', md === 1)

  // Tab switching via keys 1-4.
  await page.keyboard.press('2')
  await page.waitForSelector('[data-testid=metadata-pane]', { timeout: 5_000 })
  check('metadata tab renders', (await page.locator('[data-testid=edit-title]').count()) === 1)
  await page.keyboard.press('3')
  await page.waitForTimeout(300)
  check('snapshot tab renders (img or empty notice)', (await page.locator('[data-testid=snapshot-img],[data-testid=snapshot-empty]').count()) >= 1)
  await page.keyboard.press('4')
  await page.waitForTimeout(300)
  check('live tab renders fallback', (await page.locator('[data-testid=live-fallback],[data-testid=live-frame]').count()) >= 1)
  await page.keyboard.press('1')

  // Search narrows the list.
  await page.click('[data-testid=search-input]')
  await page.fill('[data-testid=search-input]', 'zzz-no-such-link-xyz')
  await page.waitForTimeout(700)
  check('search filters to empty', (await page.locator('[data-testid=link-row]').count()) === 0)
  await page.fill('[data-testid=search-input]', '')
  await page.waitForTimeout(700)
  // Blur the search field so single-key shortcuts leave the input.
  await page.evaluate(() => document.activeElement?.blur())
  await page.waitForTimeout(200)

  // Archive the cursor link -> total drops by one, undo toast appears.
  // (Virtualized DOM row count is unstable; the collection total is not.)
  const totalBefore = Number((await page.textContent('[data-testid=total-count]'))?.match(/\d+/)?.[0] ?? 0)
  await page.keyboard.press('a')
  await page.waitForTimeout(1200)
  const totalAfter = Number((await page.textContent('[data-testid=total-count]'))?.match(/\d+/)?.[0] ?? 0)
  check('archive removes link from collection', totalBefore - totalAfter === 1)
  check('undo toast appears', (await page.locator('[data-testid=undo-toast]').count()) === 1)
  await page.click('[data-testid=undo-toast] .btn')
  await page.waitForTimeout(1200)
  const totalRestored = Number((await page.textContent('[data-testid=total-count]'))?.match(/\d+/)?.[0] ?? 0)
  check('undo restores link', totalRestored === totalBefore)

  // Ingest dialog via rail.
  await page.click('[data-testid=nav-ingest]')
  await page.waitForSelector('[data-testid=ingest-dialog]', { timeout: 5_000 })
  check('ingest dialog opens', true)
  await page.fill('[data-testid=ingest-textarea]', 'https://example.com/a\nhttps://example.com/b')
  await page.waitForTimeout(300)
  check('url count detected', /2 urls detected/.test((await page.textContent('[data-testid=ingest-dialog]')) ?? ''))
  await page.click('[data-testid=ingest-submit]')
  await page.waitForSelector('[data-testid=ingest-summary],[data-testid=ingest-counters]', { timeout: 8_000 })
  check('ingest completes with summary', (await page.locator('[data-testid=ingest-summary]').count()) === 1)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)
  check('esc closes dialog', (await page.locator('[data-testid=ingest-dialog]').count()) === 0)

  // Attention view.
  await page.click('[data-testid=collection-needs_login]')
  await page.waitForTimeout(800)
  check('attention switcher shows', (await page.locator('[data-testid=attention-needs_login]').count()) === 1)
  await page.click('[data-testid=attention-blocked]')
  await page.waitForTimeout(500)
  check('attention collection switches', page.url().includes('collection=blocked'))

  // Run view.
  await page.click('[data-testid=nav-run]')
  await page.waitForSelector('[data-testid=run-view]', { timeout: 8_000 })
  check('run view renders', true)
  await page.click('[data-testid=run-now]')
  await page.waitForSelector('[data-testid=run-verdict]', { timeout: 15_000 })
  check('run verdict banner shows exit code', /exit [0-3]/.test((await page.textContent('[data-testid=run-verdict]')) ?? ''))

  // Settings view (secondary surfaces have no rail — navigate by URL).
  await page.goto(`${BASE}/?view=settings`, { waitUntil: 'networkidle' })
  await page.waitForSelector('[data-testid=settings-view]', { timeout: 8_000 })
  check('settings renders', (await page.locator('[data-testid=settings-browsers]').count()) === 1)

  // Metrics still reachable via footer link on run view? navigate directly.
  await page.goto(`${BASE}/?view=metrics`, { waitUntil: 'networkidle' })
  await page.waitForSelector('[data-testid=metrics-table]', { timeout: 8_000 })
  check('metrics view renders', true)

  check('no console errors/warnings (desktop)', consoleErrors.length === 0)
  if (consoleErrors.length) console.log('console issues:', consoleErrors.slice(0, 10))
  await page.close()
}

// ---------- medium viewport (collapsed rail) -----------------------------------
{
  const { page, consoleErrors } = await newPage(900, 800)
  await page.goto(BASE, { waitUntil: 'networkidle' })
  await page.waitForSelector('[data-testid=link-row]', { timeout: 15_000 })
  const railWidth = await page.locator('[data-testid=collections-rail]').evaluate((el) => el.getBoundingClientRect().width)
  check('rail collapses to icon strip at 900px', railWidth <= 60)
  check('no console errors (medium)', consoleErrors.length === 0)
  await page.close()
}

// ---------- mobile viewport ----------------------------------------------------
{
  const { page, consoleErrors } = await newPage(390, 844)
  await page.goto(BASE, { waitUntil: 'networkidle' })
  await page.waitForSelector('[data-testid=triage-shell]', { timeout: 15_000 })
  await page.waitForSelector('[data-testid=link-row]', { timeout: 15_000 })
  check('mobile rail hidden', (await page.locator('[data-testid=collections-rail]:visible').count()) === 0)
  check('mobile top bar present', (await page.locator('[data-testid=rail-toggle]').count()) === 1)

  // Tap a row -> preview overlay opens.
  await page.locator('[data-testid=link-row]').first().click()
  await page.waitForTimeout(600)
  check('mobile preview overlay opens', (await page.locator('[data-testid=preview-col].mobile-overlay').count()) === 1)
  await page.click('.preview-back')
  await page.waitForTimeout(300)
  check('back returns to list', (await page.locator('[data-testid=preview-col].mobile-overlay').count()) === 0)

  // Rail sheet.
  await page.click('[data-testid=rail-toggle]')
  await page.waitForTimeout(300)
  check('mobile rail sheet opens', (await page.locator('[data-testid=collections-rail]:visible').count()) === 1)
  await page.click('[data-testid=collection-pending]')
  await page.waitForTimeout(600)
  check('sheet navigates and closes', (await page.locator('[data-testid=collections-rail]:visible').count()) === 0)

  const scrollW = await page.evaluate(() => document.documentElement.scrollWidth)
  const clientW = await page.evaluate(() => document.documentElement.clientWidth)
  check('no horizontal scroll at 390px', scrollW <= clientW)
  check('no console errors (mobile)', consoleErrors.length === 0)
  if (consoleErrors.length) console.log('console issues:', consoleErrors.slice(0, 10))
  await page.close()
}

await browser.close()
server?.kill()

if (failures.length) {
  console.error(`\n${failures.length} failing checks`)
  process.exit(1)
}
console.log('\nall checks passed')
