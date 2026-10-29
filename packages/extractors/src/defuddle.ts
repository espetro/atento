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
      let lastStatus: number | undefined;
      try {
        const res = await options.fetch(url);
        lastStatus = res.status;
        if (res.status === 404 || res.status === 410) return { markdown: "", gone: res.status };
        if (res.status >= 400) {
          return { markdown: "", needsBrowser: true, status: res.status, finalUrl: url };
        }
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
          meta: { ...buildMeta(result), ...videoMeta(doc) },
          status: lastStatus,
          finalUrl: url,
          html: body,
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

function metaContent(doc: Document, selectors: string[]): string | undefined {
  for (const selector of selectors) {
    const el = doc.querySelector(selector);
    const content = el?.getAttribute("content");
    if (content && content.trim() !== "") return content.trim();
  }
  return undefined;
}

/**
 * Video signals from the page head: og:type ("video", "video.other", ...),
 * twitter:card player and the schema.org VideoObject marker. The pipeline
 * matches on these names (core.isVideoMeta), no host names involved.
 */
function videoMeta(doc: Document): Record<string, unknown> {
  const meta: Record<string, unknown> = {};
  const ogType = metaContent(doc, [
    "meta[property=\"og:type\"]",
    "meta[name=\"og:type\"]",
  ]);
  if (ogType) meta.ogType = ogType;
  const twitterCard = metaContent(doc, [
    "meta[name=\"twitter:card\"]",
    "meta[property=\"twitter:card\"]",
  ]);
  if (twitterCard) meta.twitterCard = twitterCard;
  if (doc.querySelector("script[type=\"application/ld+json\"]") !== null) {
    for (const el of doc.querySelectorAll("script[type=\"application/ld+json\"]")) {
      try {
        const parsed: unknown = JSON.parse(el.textContent ?? "");
        const types = Array.isArray(parsed) ? parsed : [parsed];
        if (
          types.some(
            (t) =>
              t && typeof t === "object" &&
              String((t as { "@type"?: unknown })["@type"] ?? "").includes("VideoObject"),
          )
        ) {
          meta.videoObject = true;
          break;
        }
      } catch {
        // A malformed ld+json block is not fatal.
      }
    }
  }
  return meta;
}
