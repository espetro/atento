import { describe, it, expect } from "vitest";
import { createReadabilityExtractor } from "../src/readability.js";
import type { FetchLike } from "../src/types.js";

const PAGE = `<!doctype html><html lang="en"><head><title>Readable Post</title>
<meta name="description" content="A short article."></head><body>
<nav><a href="/">Home</a><a href="/login">Sign in</a><a href="/subscribe">Subscribe</a></nav>
<article><h1>Readable Post</h1>
<p>This paragraph is the actual article body and it is long enough to be picked as the main content by readability.</p>
<p>A second paragraph adds more prose so the extractor has something substantial to return for the assertions below.</p>
</article>
<footer>Cookie preferences</footer></body></html>`;

describe("readability extractor", () => {
  it("extracts the article body as markdown", async () => {
    const extractor = createReadabilityExtractor({
      fetch: (async () => ({ status: 200, body: PAGE })) as unknown as FetchLike,
    });
    const result = await extractor.extract("https://example.dev/post");
    expect(result.needsBrowser).toBeFalsy();
    expect(result.markdown).toContain("actual article body");
    expect(result.title).toBe("Readable Post");
    expect(result.markdown).not.toMatch(/Sign in|Subscribe|Cookie/i);
  });

  it("returns needsBrowser=true when the fetch fails", async () => {
    const extractor = createReadabilityExtractor({
      fetch: (async () => {
        throw new Error("offline");
      }) as unknown as FetchLike,
    });
    const result = await extractor.extract("https://example.dev/post");
    expect(result).toEqual({ markdown: "", needsBrowser: true });
  });

  it("returns needsBrowser=true when no article content is found", async () => {
    const extractor = createReadabilityExtractor({
      fetch: (async () => ({
        status: 200,
        body: "<!doctype html><html><body><div></div></body></html>",
      })) as unknown as FetchLike,
    });
    const result = await extractor.extract("https://example.dev/empty");
    expect(result).toEqual({ markdown: "", needsBrowser: true });
  });
});
