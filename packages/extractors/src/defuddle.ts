import { Extractor, FetchLike, ExtractResult } from "./types.js";

/**
 * DOM factory abstraction. Defuddle needs a `Document`; production and tests
 * both use linkedom (fast, spec-lite, works headlessly). Injected for tests.
 */
export type ParseHtml = (html: string, url: string) => Document;

export interface DefuddleExtractorOptions {
  fetch: FetchLike;
  parseHtml?: ParseHtml;
}

/**
 * Primary extractor: defuddle 0.19.x over locally fetched HTML. Network fetch
 * is injected so tests run offline. Output is converted to markdown with
 * turndown (defuddle's bundled converter needs a global document; turndown
 * against the same linkedom document is deterministic and dependency-light).
 *
 * Never throws: fetch failure or empty extraction yields needsBrowser=true
 * with empty markdown so the router can escalate.
 */
export function createDefuddleExtractor(options: DefuddleExtractorOptions): Extractor {
  return {
    name: "defuddle",
    async extract(url: string): Promise<ExtractResult> {
      let body: string;
      try {
        const res = await options.fetch(url);
        if (res.status === 404 || res.status === 410) return { markdown: "", gone: res.status };
        if (res.status >= 400) return { markdown: "", needsBrowser: true };
        body = res.body;
      } catch {
        return { markdown: "", needsBrowser: true };
      }

      try {
        const [{ default: Defuddle }, { default: TurndownService }, { parseHTML }] =
          await Promise.all([import("defuddle"), import("turndown"), import("linkedom")]);

        const parse = options.parseHtml ?? ((html: string) => parseHTML(html).document);
        const doc = parse(body, url);
        const result = new Defuddle(doc as never, { url }).parse();

        const contentHtml = (result as { content?: string }).content ?? "";
        if (!contentHtml.trim()) {
          return { markdown: "", needsBrowser: true };
        }

        // Turndown needs a document global; scope it to this call.
        const globalDoc = (globalThis as { document?: Document }).document;
        (globalThis as { document?: Document }).document = doc;
        let markdown = "";
        try {
          const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
          markdown = turndown.turndown(contentHtml).trim();
        } finally {
          (globalThis as { document?: Document }).document = globalDoc;
        }

        if (!markdown) {
          return { markdown: "", needsBrowser: true };
        }
        return {
          markdown,
          title: result.title || undefined,
          meta: buildMeta(result),
        };
      } catch {
        return { markdown: "", needsBrowser: true };
      }
    },
  };
}

type DefuddleResponseLike = {
  title?: string;
  description?: string;
  author?: string;
  published?: string;
  site?: string;
  language?: string;
  wordCount?: number;
  schemaOrgData?: unknown;
};

function buildMeta(r: DefuddleResponseLike): Record<string, unknown> {
  const meta: Record<string, unknown> = {};
  for (const [key, value] of Object.entries({
    description: r.description,
    author: r.author,
    published: r.published,
    site: r.site,
    language: r.language,
    wordCount: r.wordCount,
  })) {
    if (value !== undefined && value !== null && value !== "") meta[key] = value;
  }
  return meta;
}
