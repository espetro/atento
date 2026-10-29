import { Extractor, ExtractResult, FetchLike } from "./types.js";

export interface PdfExtractorOptions {
  fetch: FetchLike;
  /** Max extracted chars to keep (guard against huge PDFs). */
  maxChars?: number;
}

/**
 * PDF extractor. Fetches the PDF bytes via the injected fetcher and extracts
 * text. Parsing is delegated lazily to pdfjs-dist if available; if it is not
 * installed or parsing fails we return needsBrowser=true so the pipeline can
 * flag the link rather than crash.
 */
export function createPdfExtractor(options: PdfExtractorOptions): Extractor {
  return {
    name: "pdf",
    async extract(url: string): Promise<ExtractResult> {
      let buf: Buffer;
      try {
        const res = await options.fetch(url);
        if (res.status >= 400) {
          return { markdown: "", needsBrowser: true };
        }
        buf = Buffer.from(res.body, "binary");
      } catch {
        return { markdown: "", needsBrowser: true };
      }
      if (!buf.length) return { markdown: "", needsBrowser: true };

      try {
        const pdfjs = await loadPdfjs();
        const doc = await pdfjs.getDocument({
          data: new Uint8Array(buf),
          useSystemFonts: true,
        }).promise;

        const pages: string[] = [];
        const max = options.maxChars ?? 500_000;
        let collected = 0;
        for (let i = 1; i <= doc.numPages && collected < max; i++) {
          const page = await doc.getPage(i);
          const content = await page.getTextContent();
          const text = content.items
            .map((item: unknown) => {
              const s = item as { str?: string; hasEOL?: boolean };
              return s.str ?? "";
            })
            .join(" ")
            .replace(/[ \t]+/g, " ")
            .trim();
          pages.push(text);
          collected += text.length;
        }
        await doc.destroy();

        let markdown = pages.filter(Boolean).join("\n\n").trim();
        if (!markdown) return { markdown: "", needsBrowser: true };
        if (markdown.length > max) markdown = markdown.slice(0, max);

        return { markdown, meta: { pages: doc.numPages, sourceUrl: url } };
      } catch {
        return { markdown: "", needsBrowser: true };
      }
    },
  };
}

async function loadPdfjs(): Promise<{
  getDocument: (src: { data: Uint8Array; useSystemFonts?: boolean }) => {
    promise: Promise<PdfDoc>;
  };
}> {
  // pdfjs-dist ships no proper exports map for node ESM; go through its
  // build entry directly.
  const mod = (await import("pdfjs-dist/build/pdf.mjs")) as unknown as {
    getDocument: PdfLoader["getDocument"];
  };
  return {
    getDocument: (src) => mod.getDocument(src) as { promise: Promise<PdfDoc> },
  };
}

type PdfLoader = {
  getDocument: (src: { data: Uint8Array; useSystemFonts?: boolean }) => unknown;
};

type PdfDoc = {
  numPages: number;
  getPage: (n: number) => Promise<{ getTextContent: () => Promise<{ items: unknown[] }> }>;
  destroy: () => Promise<void>;
};
