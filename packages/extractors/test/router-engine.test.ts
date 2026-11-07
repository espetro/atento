/**
 * The merged browser route: every browser-routed host takes the single
 * `browser` route. WHICH adapter reads the page is the app layer's
 * composite browser extractor (`meta.adapter`); the extractors router only
 * guarantees there is one browser route and that its needsBrowser outcome
 * is terminal.
 *
 * Fakes only: the extractors are stubbed, so no browser and no network.
 */
import { describe, expect, it } from "vitest";
import { createRouter, type RouteChoice } from "../src/router.js";
import type { Extractor, ExtractResult } from "../src/types.js";

function fakeExtractor(name: string, result: ExtractResult): Extractor {
  return {
    name,
    async extract() {
      return result;
    },
  };
}

const ok: ExtractResult = { markdown: "x".repeat(500) };

function routerWith(
  overrides: Partial<Record<RouteChoice, Extractor>>,
  policy?: (host: string) => { browser?: boolean; skipped?: boolean },
) {
  return createRouter({
    hostPolicy: policy,
    extractors: {
      defuddle: fakeExtractor("defuddle", ok),
      readability: fakeExtractor("readability", ok),
      browser: fakeExtractor("browser", ok),
      ytdlp: fakeExtractor("ytdlp", ok),
      pdf: fakeExtractor("pdf", ok),
      ...overrides,
    },
  });
}

describe("browser route consolidation", () => {
  it("routes a policy-gated host to the single browser route", async () => {
    const router = routerWith({}, (host) =>
      host === "app.devin.ai" ? { browser: true } : {},
    );
    expect(await router.routeForWithPolicy("https://app.devin.ai/x")).toBe("browser");
    expect(await router.routeForWithPolicy("https://example.com/x")).toBe("defuddle");
  });

  it("keeps adapter identity in meta: the browser extractor stamps it", async () => {
    const router = routerWith(
      {
        browser: fakeExtractor("browser", {
          markdown: "x".repeat(500),
          meta: { adapter: "stealth", engine: "patchright" },
        }),
      },
      () => ({ browser: true }),
    );
    const result = await router.extract("https://app.devin.ai/x");
    expect(result.route).toBe("browser");
    expect(result.meta?.["adapter"]).toBe("stealth");
  });

  it("surfaces a missing profile as needsBrowser from the browser route", async () => {
    const router = routerWith(
      {
        browser: fakeExtractor("browser", {
          markdown: "",
          needsBrowser: true,
          meta: { missingProfile: true, adapter: "headless" },
        }),
      },
      () => ({ browser: true }),
    );
    const result = await router.extract("https://app.devin.ai/x");
    expect(result.route).toBe("browser");
    expect(result.needsBrowser).toBe(true);
    // Terminal: no fallback to another extractor.
    expect(result.attempts.map((a) => a.route)).toEqual(["browser"]);
  });

  it("never routes a skipped host to the browser route", async () => {
    const router = routerWith({}, () => ({ skipped: true, browser: true }));
    expect(await router.routeForWithPolicy("https://example.com/x")).toBe("defuddle");
  });
});
