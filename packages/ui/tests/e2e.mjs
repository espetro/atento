// Playwright smoke tests for the UI, run against a built dist/ served
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
  const linkRequests = []
  page.on('request', (req) => {
    if (req.url().includes('/api/links?')) linkRequests.push(req.url())
  })
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

  // A4: filter button + centered search; selects live in the dropdown.
  check('filter button present', (await page.locator('[data-testid=filter-button]').count()) === 1)
  check('no always-visible selects', (await page.locator('select.filter-select').count()) === 0)
  await page.click('[data-testid=filter-button]')
  await page.waitForSelector('[data-testid=filter-menu]', { timeout: 5_000 })
  check('filter menu opens with controls', (await page.locator('[data-testid=state-filter]').count()) === 1)
  check('host filter present', (await page.locator('[data-testid=host-filter] option').count()) > 1)
  // Pick a state filter -> URL gains ?state=, chip appears.
  await page.selectOption('[data-testid=state-filter]', 'inbox')
  await page.waitForTimeout(400)
  check('state filter writes URL param', page.url().includes('state=inbox'))
  check('active filter chip renders', (await page.locator('.filter-chips .chip-button').count()) >= 1)
  // Layout options live in the same dropdown.
  await page.selectOption('[data-testid=layout-select]', 'bottom')
  await page.waitForTimeout(300)
  check('layout param writes URL', page.url().includes('layout=bottom'))
  await page.selectOption('[data-testid=layout-select]', 'right')
  await page.waitForTimeout(300)
  // Reset clears filters (state chip gone, state param gone).
  await page.click('[data-testid=filter-reset]')
  await page.waitForTimeout(300)
  check('reset clears state param', !page.url().includes('state='))
  // Close the menu with Escape.
  await page.keyboard.press('Escape')
  await page.waitForTimeout(200)
  check('escape closes filter menu', (await page.locator('[data-testid=filter-menu]').count()) === 0)

  // A2: density toggle persists to localStorage.
  await page.click('[data-testid=filter-button]')
  await page.click('[data-testid=density-comfortable]')
  await page.waitForTimeout(200)
  const storedDensity = await page.evaluate(() => localStorage.getItem('linkinbox:density'))
  check('density persists to localStorage', storedDensity === 'comfortable')
  check('comfortable density removes compact class', (await page.locator('.listpane.density-compact').count()) === 0)
  await page.click('[data-testid=density-compact]')
  await page.waitForTimeout(200)
  check('compact density restores class', (await page.locator('.listpane.density-compact').count()) === 1)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(200)

  // j/k moves selection (URL ?selected= changes).
  await page.keyboard.press('j')
  await page.waitForTimeout(300)
  const selected1 = page.url()
  check('j selects a link', selected1.includes('selected='))
  await page.keyboard.press('k')
  await page.keyboard.press('j')
  await page.waitForTimeout(200)

  // A2: one scrollable panel — preview, metadata and actions sections all
  // render inside preview-body; there is no tab bar anymore.
  await page.waitForSelector('[data-testid=preview-body]', { timeout: 10_000 })
  check('reader markdown renders', (await page.locator('[data-testid=reader-markdown]').count()) === 1)
  check('metadata section renders', (await page.locator('[data-testid=metadata-pane]').count()) === 1)
  check('actions overflow renders', (await page.locator('[data-testid=overflow-actions]').count()) === 1)
  check('preview section renders', (await page.locator('[data-testid=section-preview]').count()) === 1)
  check('tab bar is gone', (await page.locator('.tabbar').count()) === 0)
  check('live iframe is gone', (await page.locator('[data-testid=live-frame]').count()) === 0)
  // Metadata editing still works inside the panel.
  check('metadata edit field present', (await page.locator('[data-testid=edit-title]').count()) === 1)
  await page.click('[data-testid=overflow-actions]')
  check('action menu opens', (await page.locator('[data-testid=overflow-menu]').count()) === 1)
  check('action archive item present', (await page.locator('[data-testid=action-archive]').count()) === 1)
  await page.keyboard.press('Escape')
  check('action menu closes', (await page.locator('[data-testid=overflow-menu]').count()) === 0)

  // A3: infinite scroll — scroll the list to the bottom and the next page
  // is fetched automatically (limit grows 50 -> 100).
  const requestsBefore = linkRequests.length
  await page.locator('[data-testid=link-list]').evaluate((el) => {
    el.scrollTop = el.scrollHeight
  })
  await page.waitForTimeout(1500)
  const grew = linkRequests.slice(requestsBefore).some((u) => u.includes('limit=100'))
  check('scrolling bottom auto-fetches next page', grew)

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
  // The undo must go through /api/links/restore (FSM-legal), not a fake
  // read_now triage — no error banner may appear.
  check('undo surfaces no error', (await page.locator('.triage-error, [class*=error-banner]').count()) === 0)

  // A2: layout=bottom docks the preview below the list.
  await page.goto(`${BASE}/?layout=bottom&selected=1`, { waitUntil: 'networkidle' })
  await page.waitForSelector('[data-testid=preview-col]', { timeout: 10_000 })
  const listBox = await page.locator('.list-col').boundingBox()
  const prevBox = await page.locator('[data-testid=preview-col]').boundingBox()
  check('bottom layout docks preview below list', prevBox != null && listBox != null && prevBox.y >= listBox.y + listBox.height - 2)
  // A2: layout=hidden removes the preview column.
  await page.goto(`${BASE}/?layout=hidden&selected=1`, { waitUntil: 'networkidle' })
  await page.waitForSelector('[data-testid=link-list-pane]', { timeout: 10_000 })
  check('hidden layout drops preview column', (await page.locator('[data-testid=preview-col]').count()) === 0)
  await page.goto(BASE, { waitUntil: 'networkidle' })
  await page.waitForSelector('[data-testid=link-row]', { timeout: 15_000 })

  // A5: ? shortcut opens the help dialog; state is in URL.
  await page.keyboard.press('?')
  await page.waitForSelector('.dialog-card', { timeout: 5_000 })
  check('help dialog opens via ? key', page.url().includes('dialog=help'))
  check('help dialog shows keymap', (await page.textContent('.dialog-card')).includes('Keyboard'))
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)
  check('escape closes help and clears param', !page.url().includes('dialog='))
  await page.keyboard.press('?')
  await page.waitForTimeout(300)
  check('? shortcut opens help', page.url().includes('dialog=help'))
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)

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
  check('rail still visible on attention view', (await page.locator('[data-testid=collections-rail]:visible').count()) === 1)
  await page.click('[data-testid=attention-blocked]')
  await page.waitForTimeout(500)
  check('attention collection switches', page.url().includes('collection=blocked'))

  // Run view.
  await page.click('[data-testid=nav-run]')
  await page.waitForSelector('[data-testid=run-view]', { timeout: 8_000 })
  check('run view renders', true)
  check('rail still visible on run view', (await page.locator('[data-testid=collections-rail]:visible').count()) === 1)
  await page.click('[data-testid=run-now]')
  await page.waitForSelector('[data-testid=run-verdict]', { timeout: 15_000 })
  check('run verdict banner shows exit code', /exit [0-3]/.test((await page.textContent('[data-testid=run-verdict]')) ?? ''))

  // Settings + metrics now render next to the persistent rail (A1).
  await page.goto(`${BASE}/?view=settings`, { waitUntil: 'networkidle' })
  await page.waitForSelector('[data-testid=settings-view]', { timeout: 8_000 })
  check('settings renders', (await page.locator('[data-testid=settings-browsers]').count()) === 1)
  check('rail visible on settings view', (await page.locator('[data-testid=collections-rail]:visible').count()) === 1)

  await page.goto(`${BASE}/?view=metrics`, { waitUntil: 'networkidle' })
  await page.waitForSelector('[data-testid=metrics-table]', { timeout: 8_000 })
  check('metrics view renders', true)
  check('rail visible on metrics view', (await page.locator('[data-testid=collections-rail]:visible').count()) === 1)

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
  check('mobile sidebar trigger present', (await page.locator('[data-testid=rail-toggle]:visible').count()) === 1)

  // Tap a row -> preview overlay opens.
  await page.locator('[data-testid=link-row]').first().click()
  await page.waitForTimeout(600)
  check('mobile preview overlay opens', (await page.locator('[data-testid=preview-col].mobile-overlay').count()) === 1)
  check('mobile preview shows actions overflow', (await page.locator('[data-testid=overflow-actions]').count()) === 1)
  await page.click('.preview-back')
  await page.waitForTimeout(300)
  check('back returns to list', (await page.locator('[data-testid=preview-col].mobile-overlay').count()) === 0)

  // Rail sheet.
  await page.click('[data-testid=rail-toggle]')
  await page.waitForTimeout(300)
  check('mobile rail sheet opens', (await page.locator('[data-testid=collections-rail]:visible').count()) === 1)
  // Scope to the sheet overlay — the desktop rail also renders the same
  // testid but is display:none below 760px, so an unscoped locator resolves
  // to the hidden element first.
  await page.locator('.sheet-overlay [data-testid=collection-pending]').click()
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
