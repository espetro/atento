/**
 * The client-side extractor seam.
 *
 * The real implementation bundles @mozilla/readability (or defuddle) plus
 * turndown and runs it against the live document in the content script.
 * That bundle is not in this proof of concept: the extractor is injected,
 * so the seam is where the real one is dropped in (milestone M2 in
 * docs/extension.md) and the tests run against a stub.
 *
 * The extractor reads the DOM only. It never reads cookies and never
 * touches the network.
 */

/** The page content an extractor produced. */
export interface ExtractedPage {
  /** The markdown (or plain text) body. */
  body: string
  /** The page title, when the extractor found one. */
  title?: string | undefined
  /** Video signals for the media stage, read from the page head. */
  meta?: Record<string, unknown> | undefined
  /** The user's selection, when the page has one. */
  selection?: string | undefined
}

/** The extractor function signature, injected everywhere. */
export type PageExtractor = (document: Document) => ExtractedPage | Promise<ExtractedPage>

/**
 * The stub extractor: a naive DOM-to-text pass over the article body, the
 * title and the video signals. It exists so the pipeline can be exercised
 * end to end without a 200 KB bundle, and so the real extractor has one
 * obvious place to replace it.
 *
 * This is the shared implementation: the content script runs it against the
 * live document, and the tests run it against a fixture document.
 */
export function extractPage(doc: Document): ExtractedPage {
  const title = doc.querySelector('title')?.textContent?.trim() ?? undefined
  const root = doc.querySelector('article, main, [role="main"]') ?? doc.body
  const body = (root?.textContent ?? '').replace(/\n{3,}/g, '\n\n').trim()
  const meta: Record<string, unknown> = {}
  const ogType = doc
    .querySelector('meta[property="og:type"]')
    ?.getAttribute('content')
    ?.trim()
  if (ogType) meta['ogType'] = ogType
  const twitterCard = doc
    .querySelector('meta[name="twitter:card"]')
    ?.getAttribute('content')
    ?.trim()
  if (twitterCard) meta['twitterCard'] = twitterCard
  const selection = doc.getSelection()?.toString().trim()
  const out: ExtractedPage = { body }
  if (title !== undefined && title !== '') out.title = title
  if (Object.keys(meta).length > 0) out.meta = meta
  if (selection !== undefined && selection !== '') out.selection = selection
  return out
}

/** The extractor as an injectable function. */
export function createStubExtractor(): PageExtractor {
  return (doc: Document): ExtractedPage => extractPage(doc)
}
