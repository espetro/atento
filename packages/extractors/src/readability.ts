import { Extractor, ExtractResult, FetchLike } from "./types.js";
import type { ParseHtml } from "./defuddle.js";

export interface ReadabilityExtractorOptions {
  fetch: FetchLike;
  parseHtml?: ParseHtml;
}

/**
 * Fallback extractor: @mozilla/readability for article selection, turndown
 * for HTML -> markdown. Same contract as defuddle; never throws. Errors or
 * empty output surface as needsBrowser=true so the router can escalate.
 */
export function createReadabilityExtractor(options: ReadabilityExtractorOptions): Extractor {
  return {
    name: "readability",
    async extract(url: string): Promise<ExtractResult> {
      let body: string;
      try {
        const res = await options.fetch(url);
        if (res.status >= 400) return { markdown: "", needsBrowser: true };
        body = res.body;
      } catch {
        return { markdown: "", needsBrowser: true };
      }

      try {
        const [{ JSDOM }, readabilityMod, { default: TurndownService }] = await Promise.all([
          import("jsdom"),
          import("@mozilla/readability"),
          import("turndown"),
        ]);
        const dom = new JSDOM(body, { url });
        const article = new readabilityMod.Readability(dom.window.document).parse();
        if (!article || !article.textContent?.trim()) {
          return { markdown: "", needsBrowser: true };
        }
        const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
        const markdown = turndown
          .turndown(article.content ?? "")
          .trim();
        if (!markdown) return { markdown: "", needsBrowser: true };
        return {
          markdown,
          title: article.title || undefined,
          meta: {
            excerpt: article.excerpt || undefined,
            byline: article.byline || undefined,
            lang: article.lang || undefined,
          },
        };
      } catch {
        return { markdown: "", needsBrowser: true };
      }
    },
  };
}
