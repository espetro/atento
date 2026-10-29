import { describe, it, expect } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createDefuddleExtractor } from "../src/defuddle.js";
import type { FetchLike } from "../src/types.js";

const fixturesDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "fixtures",
  "extractors",
);

function htmlFetcher(pages: Record<string, string>): FetchLike {
  return async (url) => {
    const body = pages[url];
    if (body === undefined) return { status: 404, body: "" };
    return { status: 200, body, contentType: "text/html" };
  };
}

async function loadFixtures() {
  const slugs = (await readdir(fixturesDir, { withFileTypes: true }))
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
  const out: {
    slug: string;
    url: string;
    html: string;
    expected: string;
    meta: {
      expectedTitle: string;
      charRange: { min: number; max: number };
      mustContain: string[];
      mustNotContain: string[];
    };
  }[] = [];
  for (const slug of slugs) {
    const dir = join(fixturesDir, slug);
    out.push({
      slug,
      url: JSON.parse(await readFile(join(dir, "meta.json"), "utf8")).url,
      html: await readFile(join(dir, "page.html"), "utf8"),
      expected: (await readFile(join(dir, "expected.md"), "utf8")).trim(),
      meta: JSON.parse(await readFile(join(dir, "meta.json"), "utf8")),
    });
  }
  return out;
}

describe("defuddle extractor (test set B)", () => {
  it("extracts every fixture within char range, without nav leaks", async () => {
    const fixtures = await loadFixtures();
    expect(fixtures.length).toBeGreaterThanOrEqual(4);
    const pages = Object.fromEntries(fixtures.map((f) => [f.url, f.html]));
    const extractor = createDefuddleExtractor({ fetch: htmlFetcher(pages) });

    for (const f of fixtures) {
      const result = await extractor.extract(f.url);
      expect(result.needsBrowser, `${f.slug} unexpectedly needsBrowser`).toBeFalsy();
      expect(
        result.markdown.length,
        `${f.slug} char count ${result.markdown.length} outside ${f.meta.charRange.min}-${f.meta.charRange.max}`,
      ).toBeGreaterThanOrEqual(f.meta.charRange.min);
      expect(result.markdown.length).toBeLessThanOrEqual(f.meta.charRange.max);
      for (const phrase of f.meta.mustNotContain) {
        expect(
          new RegExp(phrase, "i").test(result.markdown),
          `${f.slug} leaked nav phrase: ${phrase}`,
        ).toBe(false);
      }
      for (const phrase of f.meta.mustContain ?? []) {
        expect(
          result.markdown.includes(phrase),
          `${f.slug} missing expected phrase: ${phrase}`,
        ).toBe(true);
      }
      expect(result.title).toBe(f.meta.expectedTitle);
    }
  });

  it("matches the golden expected.md output exactly", async () => {
    const fixtures = await loadFixtures();
    const pages = Object.fromEntries(fixtures.map((f) => [f.url, f.html]));
    const extractor = createDefuddleExtractor({ fetch: htmlFetcher(pages) });
    for (const f of fixtures) {
      const result = await extractor.extract(f.url);
      expect(result.markdown.trim()).toBe(f.expected);
    }
  });

  it("returns needsBrowser=true on fetch failure instead of throwing", async () => {
    const extractor = createDefuddleExtractor({
      fetch: async () => {
        throw new Error("offline");
      },
    });
    const result = await extractor.extract("https://offline.example.dev/post");
    expect(result).toEqual({ markdown: "", needsBrowser: true });
  });

  it("returns needsBrowser=true on HTTP error status", async () => {
    const extractor = createDefuddleExtractor({
      fetch: async () => ({ status: 403, body: "forbidden" }),
    });
    const result = await extractor.extract("https://paywalled.example.dev/post");
    // The status travels along so the pipeline can detect a login wall.
    expect(result).toEqual({
      markdown: "",
      needsBrowser: true,
      status: 403,
      finalUrl: "https://paywalled.example.dev/post",
    });
  });
});
