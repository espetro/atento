/**
 * Tiny bin for the eval runner. The CLI (another slice) calls runEval
 * directly; this bin exists for standalone runs: `pnpm eval` in evals/.
 * Uses the deterministic mock enrich function by default; set
 * LINKINBOX_EVAL_LIVE=1 to use a real env-configured model.
 * Exit code 0 = pass, non-zero = regression/threshold failure.
 */
import { runEval, saveBaseline, DEFAULT_BASELINE_PATH } from './run.js'
import { createMockEnrichFn } from './mock.js'
import { extractFixturePages } from './extract.js'
import type { EnrichFn, EvalReport } from './run.js'

const args = process.argv.slice(2)
const saveBaselineFlag = args.includes('--save-baseline')
const live = process.env.LINKINBOX_EVAL_LIVE === '1'

let enrichFn: EnrichFn = createMockEnrichFn()
if (live) {
  const { createModelFromEnv, enrichLink } = await import('@linkinbox/enrich')
  enrichFn = async (input) => {
    const link = {
      id: 0,
      urlHash: input.slug,
      url: input.url,
      title: input.title ?? null,
      source: 'fixture',
      addedAt: null,
      note: null,
      tags: null,
      extractedContent: input.content,
      extractedAt: null,
      enrichment: null,
      expiresAt: null,
      expiryReason: null,
      status: 'inbox' as const,
      state: 'created',
      stateData: null,
      category: null,
      priority: null,
      action: null,
      confidence: null,
      readMinutes: null,
      needsBrowser: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    }
    return enrichLink(link, { model: createModelFromEnv() })
  }
}

const extractionOutputs = await extractFixturePages()
const report: EvalReport = await runEval({ enrichFn, extractionOutputs })

const pct = (n: number) => `${n.toFixed(1)}%`
console.log(`linkinbox eval: ${report.counts.fixtures} enrichment fixtures, ${report.counts.extractionFixtures} extraction fixtures, ${report.counts.runs} runs`)
console.log(`  schema validity:    ${pct(report.schemaValidity)} (>=90)`)
console.log(`  category match:     ${pct(report.categoryMatch)} (>=80)`)
console.log(`  expires in range:   ${pct(report.expiresInRange)} (>=70)`)
console.log(`  confidence present: ${pct(report.confidencePresent)} (=100)`)
console.log(`  action consistency: ${pct(report.actionConsistency)} (>=85)`)
console.log(`  extraction char:    ${pct(report.extractionCharInRange)} (=100)`)
console.log(`  extraction navleak: ${pct(report.extractionNavLeak)} (=100)`)
if (report.comparedToBaseline) console.log('  compared against stored baseline')
for (const r of report.regressions) console.log(`  REGRESSION: ${r}`)
console.log(report.passed ? 'PASS' : 'FAIL')

if (saveBaselineFlag) {
  await saveBaseline(report)
  console.log(`baseline saved to ${DEFAULT_BASELINE_PATH}`)
}

process.exit(report.passed ? 0 : 1)
