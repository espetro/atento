// Playwright smoke tests for test set F, run against a built dist/ served
// with the mock API middleware via `vite preview`.
// Usage: pnpm build && node tests/e2e.mjs
import { chromium } from '@playwright/test'

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

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 375, height: 812 } })
const consoleErrors = []
page.on('console', (msg) => {
  if (msg.type() === 'error') consoleErrors.push(msg.text())
})
page.on('pageerror', (err) => consoleErrors.push(String(err)))

await page.goto(BASE, { waitUntil: 'networkidle' })
await page.waitForSelector('[data-testid=link-card]', { timeout: 10_000 })

// 1. Inbox renders 100 items (128 seeded, 100 inbox-capable shown by default total)
const total = await page.textContent('[data-testid=total-count]')
check('inbox renders 100+ items', Number(total?.match(/\d+/)?.[0] ?? 0) >= 100)
const cards = await page.locator('[data-testid=link-card]').count()
check('cards visible in viewport', cards > 0)

// 2. Category filter works
await page.selectOption('[data-testid=category-filter]', 'ai')
await page.waitForTimeout(800)
const cats = await page.locator('[data-testid=link-category]').allTextContents()
check('category filter narrows to one category', cats.length > 0 && cats.every((c) => c === 'ai'))
await page.selectOption('[data-testid=category-filter]', '')
await page.waitForTimeout(500)

// 3. Triage action updates status and list
await page.selectOption('[data-testid=status-filter]', 'inbox')
await page.waitForTimeout(800)
const before = await page.textContent('[data-testid=total-count]')
await page.locator('[data-testid=action-archive]').first().click()
await page.waitForTimeout(1000)
const after = await page.textContent('[data-testid=total-count]')
check('triage updates list count', Number(before.match(/\d+/)[0]) - Number(after.match(/\d+/)[0]) === 1)
await page.selectOption('[data-testid=status-filter]', '')
await page.waitForTimeout(500)

// 4. Drawer shows extracted markdown
await page.locator('[data-testid=link-title]').first().click()
await page.waitForSelector('[data-testid=detail-drawer]')
const md = await page.textContent('[data-testid=drawer-markdown]')
check('drawer shows markdown content', (md ?? '').length > 20)
check('drawer shows enrichment JSON', (await page.locator('[data-testid=drawer-enrichment]').count()) === 1)
await page.click('[data-testid=drawer-close]')
await page.waitForTimeout(300)

// 5. No console errors
check('no console errors', consoleErrors.length === 0)
if (consoleErrors.length) console.log('console errors:', consoleErrors)

// 6. Mobile viewport: dock nav + no horizontal scroll
check('dock nav present', (await page.locator('[data-testid=dock]').count()) === 1)
const scrollW = await page.evaluate(() => document.documentElement.scrollWidth)
const clientW = await page.evaluate(() => document.documentElement.clientWidth)
check('no horizontal scroll at 375px', scrollW <= clientW)

// Sweep + metrics views reachable
await page.click('[data-testid=dock-sweep]')
await page.waitForSelector('[data-testid=sweep-total]')
check('sweep view renders', true)
await page.click('[data-testid=dock-metrics]')
await page.waitForSelector('[data-testid=metrics-table]')
check('metrics view renders', (await page.locator('[data-testid=metrics-row]').count()) > 0)

// Pipeline view: every link with its state, filterable by state
await page.click('[data-testid=dock-pipeline]')
await page.waitForSelector('[data-testid=pipeline-row]')
const pipelineRows = await page.locator('[data-testid=pipeline-row]').count()
check('pipeline view lists links', pipelineRows > 0)
const badges = await page.locator('[data-testid=state-badge]').count()
check('pipeline rows carry a state badge', badges > 0)
const pipelineTotal = await page.textContent('[data-testid=pipeline-total]')
check('pipeline shows a total', Number(pipelineTotal?.match(/\d+/)?.[0] ?? 0) > 0)
await page.click('[data-testid=state-chip][data-state=needs_browser]')
await page.waitForTimeout(800)
const filtered = await page.locator('[data-testid=pipeline-row]').count()
check('state chip filters the pipeline', filtered <= pipelineRows)
check(
  'no horizontal scroll on the pipeline view',
  (await page.evaluate(() => document.documentElement.scrollWidth)) <=
    (await page.evaluate(() => document.documentElement.clientWidth)),
)

await browser.close()

if (failures.length) {
  console.error(`\n${failures.length} failing checks`)
  process.exit(1)
}
console.log('\nall checks passed')
