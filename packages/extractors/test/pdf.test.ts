import { describe, it, expect } from "vitest";
import { createPdfExtractor } from "../src/pdf.js";
import type { FetchLike } from "../src/types.js";

describe("pdf extractor (offline)", () => {
  it("returns needsBrowser=true on fetch failure", async () => {
    const extractor = createPdfExtractor({
      fetch: (async () => {
        throw new Error("offline");
      }) as unknown as FetchLike,
    });
    const result = await extractor.extract("https://example.dev/paper.pdf");
    expect(result).toEqual({ markdown: "", needsBrowser: true });
  });

  it("returns needsBrowser=true on HTTP error", async () => {
    const extractor = createPdfExtractor({
      fetch: async () => ({ status: 404, body: "" }),
    });
    const result = await extractor.extract("https://example.dev/missing.pdf");
    expect(result).toEqual({ markdown: "", needsBrowser: true });
  });

  it("returns needsBrowser=true when content is not a parsable PDF (no pdfjs in test env)", async () => {
    const extractor = createPdfExtractor({
      fetch: async () => ({ status: 200, body: "not a real pdf", contentType: "application/pdf" }),
    });
    const result = await extractor.extract("https://example.dev/fake.pdf");
    // Either pdfjs parses (unlikely for junk) or the extractor flags it;
    // contract: never throw, never empty-without-flag.
    expect(result.needsBrowser || result.markdown.length > 0).toBe(true);
  });
});
