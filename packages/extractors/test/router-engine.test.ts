/**
 * The engine routing: a stealth host extracts with the patchright
 * extractor, every other host keeps the agent-browser one.
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
  policy?: (host: string) => { browser?: boolean; stealth?: boolean; skipped?: boolean },
) {
  return createRouter({
    hostPolicy: policy,
    extractors: {
      defuddle: fakeExtractor("defuddle", ok),
      readability: fakeExtractor("readability", ok),
      browser: fakeExtractor("browser", ok),
      patchright: fakeExtractor("patchright", ok),
      ytdlp: fakeExtractor("ytdlp", ok),
      pdf: fakeExtractor("pdf", ok),
      ...overrides,
    },
  });
}

describe("engine routing", () => {
  it("routes a stealth host to the patchright extractor", async () => {
    const router = routerWith({}, (host) =>
      host === "app.devin.ai" ? { browser: true, stealth: true } : {},
    );
    expect(await router.routeForWithPolicy("https://app.devin.ai/x")).toBe("patchright");
    expect(await router.routeForWithPolicy("https://example.com/x")).toBe("defuddle");
  });

  it("routes a non-stealth browser host to the browser extractor", async () => {
    const router = routerWith({}, () => ({ browser: true, stealth: false }));
    expect(await router.routeForWithPolicy("https://example.com/x")).toBe("browser");
  });

  it("extracts through the patchright extractor for a stealth host", async () => {
    const router = routerWith(
      {
        patchright: fakeExtractor("patchright", { markdown: "x".repeat(500), meta: { engine: "patchright" } }),
        browser: fakeExtractor("browser", { markdown: "y".repeat(500) }),
      },
      () => ({ browser: true, stealth: true }),
    );
    const result = await router.extract("https://app.devin.ai/x");
    expect(result.route).toBe("patchright");
    expect(result.meta?.["engine"]).toBe("patchright");
  });

  it("surfaces a missing profile as needsBrowser from the patchright route", async () => {
    const router = routerWith(
      {
        patchright: fakeExtractor("patchright", {
          markdown: "",
          needsBrowser: true,
          meta: { missingProfile: true },
        }),
      },
      () => ({ browser: true, stealth: true }),
    );
    const result = await router.extract("https://app.devin.ai/x");
    expect(result.route).toBe("patchright");
    expect(result.needsBrowser).toBe(true);
    // Terminal: no fallback to another engine.
    expect(result.attempts.map((a) => a.route)).toEqual(["patchright"]);
  });

  it("never routes a skipped host to a browser engine", async () => {
    const router = routerWith({}, () => ({ skipped: true, browser: true, stealth: true }));
    expect(await router.routeForWithPolicy("https://example.com/x")).toBe("defuddle");
  });
});
