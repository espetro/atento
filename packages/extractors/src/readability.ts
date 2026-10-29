import { Extractor, ExtractResult, FetchLike } from "./types.js";

export interface ReadabilityExtractorOptions {
  fetch: FetchLike;
}

/**
 * Fallback extractor: @mozilla/readability for article selection, turndown
 * for HTML -> markdown. Runs over a linkedom document (no jsdom needed).
 * Same contract as defuddle; never throws. Errors or empty output surface
 * as needsBrowser=true so the router can escalate.
 */
export function createReadabilityExtractor(options: ReadabilityExtractorOptions): Extractor {
  return {
    name: "readability",
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
        const [{ parseHTML }, readabilityMod, { default: TurndownService }] = await Promise.all([
          import("linkedom"),
          import("@mozilla/readability"),
          import("turndown"),
        ]);
        const { document } = parseHTML(body);
        const article = new readabilityMod.Readability(document as never).parse();
        if (!article || !article.textContent?.trim()) {
          return { markdown: "", needsBrowser: true };
        }
        // Turndown needs a document global; scope it to this call.
        const globalDoc = (globalThis as { document?: Document }).document;
        (globalThis as { document?: Document }).document = document;
        let markdown = "";
        try {
          const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
          markdown = turndown.turndown(article.content ?? "").trim();
        } finally {
          (globalThis as { document?: Document }).document = globalDoc;
        }
        if (!markdown) return { markdown: "", needsBrowser: true };
        return {
          markdown,
          title: article.title || undefined,
          meta: {
            excerpt: article.excerpt || undefined,
            byline: article.byline || undefined,
            lang: article.lang || undefined,
          },
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
