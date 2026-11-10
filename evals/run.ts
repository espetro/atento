/**
 * Custom golden-set eval runner for atento enrichment (test set C) plus
 * deterministic extraction checks (test set B metrics feeding eval part G).
 *
 * Metrics computed:
 *  - schemaValidity: % of enrichment outputs that parse against EnrichmentSchema
 *  - categoryMatch: % exact-match on category vs golden labels
 *  - expiresInRange: % of outputs whose expires_at falls in the expected range
 *  - confidencePresent: % with a confidence in [0,1]
 *  - actionConsistency: % agreement on action across N runs
 *  - extractionCharInRange / extractionNavLeak: deterministic extraction checks
 *
 * Thresholds (spec): >=90, >=80, >=70, 100, >=85.
 * Compares against a stored baseline JSON; exits non-zero on regression.
 */
import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { EnrichmentSchema, type Enrichment } from '@atento/core'

export interface EnrichmentFixture {
  slug: string
  url: string
  title?: string
  content: string
  expected: {
    category: string
    priority?: Enrichment['priority']
    action?: Enrichment['action']
    expires_at_days: { min: number | null; max: number | null }
  }
}

export interface ExtractionFixture {
  slug: string
  charRange: { min: number; max: number }
  mustNotContain: string[]
}

export type EnrichFn = (input: {
  slug: string
  url: string
  title?: string
  content: string
}) => Promise<
  | { ok: true; enrichment: Enrichment }
  | { ok: false; error: string }
>

export interface EvalReport {
  counts: {
    fixtures: number
    extractionFixtures: number
    runs: number
  }
  schemaValidity: number
  categoryMatch: number
  expiresInRange: number
  confidencePresent: number
  actionConsistency: number
  extractionCharInRange: number
  extractionNavLeak: number
  items: Array<{
    slug: string
    schemaValid: boolean
    categoryMatch: boolean
    expiresInRange: boolean
    actions: string[]
    consistent: boolean
  }>
  passed: boolean
  regressions: string[]
  comparedToBaseline: boolean
}

export interface RunEvalOptions {
  enrichFn: EnrichFn
  fixturesDir?: string
  baselinePath?: string
  runs?: number
  now?: Date
  /** Injected extraction outputs for the deterministic checks. */
  extractionOutputs?: Record<string, string>
}

const THRESHOLDS = {
  schemaValidity: 90,
  categoryMatch: 80,
  expiresInRange: 70,
  confidencePresent: 100,
  actionConsistency: 85,
  extractionCharInRange: 100,
  extractionNavLeak: 100,
}

const HERE = path.dirname(fileURLToPath(import.meta.url))
// Works from src (evals/fixtures) and from dist (evals/dist/../fixtures).
const PKG_ROOT = path.basename(HERE) === 'dist' ? path.resolve(HERE, '..') : HERE
const DEFAULT_FIXTURES_DIR = path.resolve(PKG_ROOT, '../fixtures/enrichment')
const DEFAULT_EXTRACTION_FIXTURES_DIR = path.resolve(PKG_ROOT, '../fixtures/extractors')
export const DEFAULT_BASELINE_PATH = path.resolve(PKG_ROOT, 'fixtures/baseline.json')
const NAV_LEAK_RE = /Sign in|Subscribe|Cookie/i

async function loadJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, 'utf8')) as T
}

export async function loadEnrichmentFixtures(dir: string): Promise<EnrichmentFixture[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.json')).sort()
  return Promise.all(files.map((f) => loadJson<EnrichmentFixture>(path.join(dir, f))))
}

async function loadExtractionFixtures(dir: string): Promise<Array<ExtractionFixture & { slug: string }>> {
  const entries = await readdir(dir, { withFileTypes: true })
  const out: Array<ExtractionFixture & { slug: string }> = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const metaPath = path.join(dir, entry.name, 'meta.json')
    try {
      const meta = await loadJson<ExtractionFixture>(metaPath)
      out.push({ ...meta, slug: entry.name })
    } catch {
      // no meta.json, skip
    }
  }
  return out
}

function inRange(days: number | null, range: { min: number | null; max: number | null }): boolean {
  if (range.min === null && range.max === null) return days === null
  if (days === null) return false
  if (range.min !== null && days < range.min) return false
  if (range.max !== null && days > range.max) return false
  return true
}

function daysUntil(iso: string | null, now: Date): number | null {
  if (!iso) return null
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return null
  return Math.round((t - now.getTime()) / 86_400_000)
}

export async function runEval(opts: RunEvalOptions): Promise<EvalReport> {
  const {
    enrichFn,
    fixturesDir = DEFAULT_FIXTURES_DIR,
    baselinePath = DEFAULT_BASELINE_PATH,
    runs = 3,
    now = new Date(),
    extractionOutputs,
  } = opts

  const fixtures = await loadEnrichmentFixtures(fixturesDir)
  const items: EvalReport['items'] = []
  let schemaValidCount = 0
  let categoryMatchCount = 0
  let expiresInRangeCount = 0
  let confidencePresentCount = 0
  let consistentCount = 0

  for (const fixture of fixtures) {
    const actions: string[] = []
    let lastResult: Awaited<ReturnType<EnrichFn>> | null = null
    for (let i = 0; i < runs; i++) {
      lastResult = await enrichFn(fixture)
      if (lastResult.ok) actions.push(lastResult.enrichment.action)
    }
    const result = lastResult
    const schemaValid = result?.ok === true && EnrichmentSchema.safeParse(result.enrichment).success
    const categoryMatch =
      result?.ok === true && result.enrichment.category === fixture.expected.category
    const expiresInRange =
      result?.ok === true &&
      inRange(daysUntil(result.enrichment.expires_at, now), fixture.expected.expires_at_days)
    const confidencePresent =
      result?.ok === true &&
      typeof result.enrichment.confidence === 'number' &&
      result.enrichment.confidence >= 0 &&
      result.enrichment.confidence <= 1
    const unique = [...new Set(actions)]
    const consistent = actions.length === runs && unique.length === 1

    if (schemaValid) schemaValidCount += 1
    if (categoryMatch) categoryMatchCount += 1
    if (expiresInRange) expiresInRangeCount += 1
    if (confidencePresent) confidencePresentCount += 1
    if (consistent) consistentCount += 1

    items.push({
      slug: fixture.slug,
      schemaValid: Boolean(schemaValid),
      categoryMatch: Boolean(categoryMatch),
      expiresInRange: Boolean(expiresInRange),
      actions,
      consistent,
    })
  }

  // Deterministic extraction checks over fixtures/extractors meta.json.
  const extractionFixtures = await loadExtractionFixtures(DEFAULT_EXTRACTION_FIXTURES_DIR)
  let charInRangeCount = 0
  let noNavLeakCount = 0
  const extractionOutputsResolved = extractionOutputs ?? (await loadExtractionOutputs(DEFAULT_EXTRACTION_FIXTURES_DIR))
  for (const meta of extractionFixtures) {
    const output = extractionOutputsResolved[meta.slug]
    if (typeof output !== 'string') continue
    const inCharRange =
      output.length >= meta.charRange.min && output.length <= meta.charRange.max
    const navLeak = meta.mustNotContain.some((phrase) => new RegExp(phrase, 'i').test(output))
    if (inCharRange) charInRangeCount += 1
    if (!navLeak) noNavLeakCount += 1
  }
  const extractionTotal = Math.max(extractionFixtures.length, 1)

  const pct = (n: number, d: number) => (d === 0 ? 100 : (n / d) * 100)

  const report: EvalReport = {
    counts: {
      fixtures: fixtures.length,
      extractionFixtures: extractionFixtures.length,
      runs,
    },
    schemaValidity: pct(schemaValidCount, fixtures.length),
    categoryMatch: pct(categoryMatchCount, fixtures.length),
    expiresInRange: pct(expiresInRangeCount, fixtures.length),
    confidencePresent: pct(confidencePresentCount, fixtures.length),
    actionConsistency: pct(consistentCount, fixtures.length),
    extractionCharInRange: pct(charInRangeCount, extractionTotal),
    extractionNavLeak: pct(noNavLeakCount, extractionTotal),
    items,
    passed: true,
    regressions: [],
    comparedToBaseline: false,
  }

  // Threshold gates.
  const gates: Array<[keyof typeof THRESHOLDS, number]> = [
    ['schemaValidity', report.schemaValidity],
    ['categoryMatch', report.categoryMatch],
    ['expiresInRange', report.expiresInRange],
    ['confidencePresent', report.confidencePresent],
    ['actionConsistency', report.actionConsistency],
    ['extractionCharInRange', report.extractionCharInRange],
    ['extractionNavLeak', report.extractionNavLeak],
  ]
  for (const [key, value] of gates) {
    if (value < THRESHOLDS[key]) {
      report.regressions.push(`${key}: ${value.toFixed(1)}% < threshold ${THRESHOLDS[key]}%`)
    }
  }

  // Baseline comparison: non-zero on regression vs stored baseline.
  let baseline: Partial<EvalReport> | null = null
  try {
    baseline = await loadJson<Partial<EvalReport>>(baselinePath)
    report.comparedToBaseline = true
  } catch {
    baseline = null
  }
  if (baseline) {
    const baselineKeys: Array<keyof typeof THRESHOLDS> = [
      'schemaValidity',
      'categoryMatch',
      'expiresInRange',
      'confidencePresent',
      'actionConsistency',
      'extractionCharInRange',
      'extractionNavLeak',
    ]
    for (const key of baselineKeys) {
      const prev = baseline[key]
      if (typeof prev === 'number' && report[key] < prev) {
        report.regressions.push(
          `${key}: ${report[key].toFixed(1)}% regressed below baseline ${prev.toFixed(1)}%`,
        )
      }
    }
  }

  report.passed = report.regressions.length === 0
  return report
}

async function loadExtractionOutputs(dir: string): Promise<Record<string, string>> {
  const entries = await readdir(dir, { withFileTypes: true })
  const out: Record<string, string> = {}
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    try {
      out[entry.name] = await readFile(path.join(dir, entry.name, 'expected.md'), 'utf8')
    } catch {
      // missing expected.md, skip
    }
  }
  return out
}

/** Persist a report as the new baseline. */
export async function saveBaseline(report: EvalReport, baselinePath = DEFAULT_BASELINE_PATH): Promise<void> {
  const { counts, schemaValidity, categoryMatch, expiresInRange, confidencePresent, actionConsistency, extractionCharInRange, extractionNavLeak } = report
  await mkdir(path.dirname(baselinePath), { recursive: true })
  await writeFile(
    baselinePath,
    JSON.stringify(
      {
        counts,
        schemaValidity,
        categoryMatch,
        expiresInRange,
        confidencePresent,
        actionConsistency,
        extractionCharInRange,
        extractionNavLeak,
      },
      null,
      2,
    ) + '\n',
  )
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const { createMockEnrichFn } = await import('./mock.js')
  const report = await runEval({ enrichFn: createMockEnrichFn() })
  console.log(JSON.stringify(report, null, 2))
  process.exit(report.passed ? 0 : 1)
}
