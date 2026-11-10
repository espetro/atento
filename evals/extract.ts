import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDefuddleExtractor } from '@atento/extractors'

const dir = path.dirname(fileURLToPath(import.meta.url))
// Works from src (evals/../fixtures) and from dist (evals/dist/../../fixtures).
// Works from src (evals/extract.ts -> repo root) and from dist (one deeper).
const repoRoot = path.basename(dir) === 'dist' ? path.resolve(dir, '../..') : path.resolve(dir, '..')

/**
 * Real extraction over the local extractor fixture page.html files using the
 * defuddle extractor with fetch replaced by local file reads. Returns
 * slug -> markdown, exactly what runEval's extraction checks expect.
 */
export async function extractFixturePages(
  extractorsDir = path.resolve(repoRoot, 'fixtures/extractors'),
): Promise<Record<string, string>> {
  const { readdir } = await import('node:fs/promises')
  const entries = await readdir(extractorsDir, { withFileTypes: true })
  const fetcher = async (url: string) => {
    const slug = url.replace('fixture://', '')
    const body = await readFile(path.join(extractorsDir, slug, 'page.html'), 'utf8')
    return { status: 200, body }
  }
  const extractor = createDefuddleExtractor({ fetch: fetcher })
  const out: Record<string, string> = {}
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const result = await extractor.extract(`fixture://${entry.name}`)
    out[entry.name] = result.markdown
  }
  return out
}
