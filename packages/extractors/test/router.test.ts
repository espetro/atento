import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { createRouter, routeFor, type RouteChoice } from "../src/router.js";
import type { Extractor, ExtractResult, FetchLike } from "../src/types.js";

function fakeExtractor(name: string, result: ExtractResult | ((url: string) => ExtractResult)): Extractor {
  return {
    name,
    async extract(url) {
      return typeof result === "function" ? result(url) : result;
    },
  };
}

const ok = (chars = 500): ExtractResult => ({ markdown: "x".repeat(chars) });
const low = (): ExtractResult => ({ markdown: "tiny" });
const needsBrowser = (): ExtractResult => ({ markdown: "", needsBrowser: true });

function routerWith(
  overrides: Partial<Record<RouteChoice, Extractor>>,
  opts: { minChars?: number; hostPolicy?: (host: string) => { browser?: boolean; skipped?: boolean } } = {},
) {
  return createRouter({
    minChars: opts.minChars,
    hostPolicy: opts.hostPolicy,
    extractors: {
      defuddle: overrides.defuddle ?? fakeExtractor("defuddle", ok()),
      readability: overrides.readability ?? fakeExtractor("readability", ok()),
      browser: overrides.browser ?? fakeExtractor("browser", ok()),
      ytdlp: overrides.ytdlp ?? fakeExtractor("ytdlp", ok()),
      pdf: overrides.pdf ?? fakeExtractor("pdf", ok()),
    },
  });
}

describe("routeFor (spec table)", () => {
  it("routes youtube and youtu.be to ytdlp", () => {
    expect(routeFor("https://www.youtube.com/watch?v=abc")).toBe("ytdlp");
    expect(routeFor("https://youtu.be/abc")).toBe("ytdlp");
  });

  it("routes .pdf URLs to pdf", () => {
    expect(routeFor("https://arxiv.org/pdf/2401.12345.pdf")).toBe("pdf");
    expect(routeFor("https://example.dev/paper.PDF")).toBe("pdf");
  });

  it("routes policy-gated hosts to browser (injected policy)", async () => {
    const { createRouter } = await import("../src/router.js");
    const router = createRouter({
      hostPolicy: (host) => (host === "x.com" ? { browser: true } : {}),
      extractors: {
        defuddle: fakeExtractor("defuddle", ok()),
        readability: fakeExtractor("readability", ok()),
        browser: fakeExtractor("browser", ok()),
        ytdlp: fakeExtractor("ytdlp", ok()),
        pdf: fakeExtractor("pdf", ok()),
      },
    });
    expect(await router.routeForWithPolicy("https://x.com/user/status/1")).toBe("browser");
    expect(await router.routeForWithPolicy("https://example.com/post")).toBe("defuddle");
    // Without a policy the bare rule-based route applies.
    expect(routeFor("https://x.com/user/status/1")).toBe("defuddle");
  });

  it("routes everything else to defuddle", () => {
    expect(routeFor("https://example.dev/blog/post")).toBe("defuddle");
    expect(routeFor("https://docs.example.dev/guide")).toBe("defuddle");
  });

  it("falls back to defuddle on malformed URLs", () => {
    expect(routeFor("not a url")).toBe("defuddle");
  });
});

describe("router low-yield fallback chain", () => {
  it("uses defuddle result when yield is above threshold", async () => {
    const router = routerWith({});
    const result = await router.extract("https://example.dev/post");
    expect(result.route).toBe("defuddle");
    expect(result.attempts).toHaveLength(1);
  });

  it("escalates defuddle -> readability on low yield", async () => {
    const router = routerWith({ defuddle: fakeExtractor("defuddle", low()) });
    const result = await router.extract("https://example.dev/post");
    expect(result.route).toBe("readability");
    expect(result.attempts.map((a) => a.route)).toEqual(["defuddle", "readability"]);
  });

  it("escalates defuddle -> readability -> browser when both are low yield", async () => {
    const router = routerWith({
      defuddle: fakeExtractor("defuddle", low()),
      readability: fakeExtractor("readability", low()),
    });
    const result = await router.extract("https://example.dev/post");
    expect(result.route).toBe("browser");
    expect(result.attempts.map((a) => a.route)).toEqual(["defuddle", "readability", "browser"]);
  });

  it("returns needsBrowser result when the full chain fails", async () => {
    const router = routerWith({
      defuddle: fakeExtractor("defuddle", needsBrowser()),
      readability: fakeExtractor("readability", needsBrowser()),
      browser: fakeExtractor("browser", needsBrowser()),
    });
    const result = await router.extract("https://example.dev/post");
    expect(result.route).toBe("browser");
    expect(result.needsBrowser).toBe(true);
    expect(result.markdown).toBe("");
    expect(result.attempts.map((a) => a.route)).toEqual(["defuddle", "readability", "browser"]);
  });

  it("respects a custom minChars threshold", async () => {
    // 250 chars passes the default (200) threshold but fails a 1000-char one,
    // so the router escalates to readability (which returns 1500 chars).
    const router = routerWith(
      {
        defuddle: fakeExtractor("defuddle", ok(250)),
        readability: fakeExtractor("readability", ok(1500)),
      },
      { minChars: 1000 },
    );
    const result = await router.extract("https://example.dev/post");
    expect(result.route).toBe("readability");
  });

  it("policy-gated route goes straight to browser without defuddle fallback", async () => {
    const calls: string[] = [];
    const router = createRouter({
      hostPolicy: () => ({ browser: true }),
      extractors: {
        browser: fakeExtractor("browser", () => {
          calls.push("browser");
          return ok();
        }),
        defuddle: fakeExtractor("defuddle", () => {
          calls.push("defuddle");
          return ok();
        }),
        readability: fakeExtractor("readability", ok()),
        ytdlp: fakeExtractor("ytdlp", ok()),
        pdf: fakeExtractor("pdf", ok()),
      },
    });
    const result = await router.extract("https://x.com/user/status/123");
    expect(result.route).toBe("browser");
    expect(calls).toEqual(["browser"]);
  });

  it("browser needsBrowser (no profile) is terminal, not escalated", async () => {
    const router = routerWith({
      browser: fakeExtractor("browser", needsBrowser()),
    }, { hostPolicy: () => ({ browser: true }) });
    const result = await router.extract("https://instagram.com/p/xyz");
    expect(result.route).toBe("browser");
    expect(result.needsBrowser).toBe(true);
  });
});

describe("router with real extractors (offline)", () => {
  it("routes a video URL to ytdlp and uses its result", async () => {
    const router = routerWith({ ytdlp: fakeExtractor("ytdlp", ok(900)) });
    const result = await router.extract("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    expect(result.route).toBe("ytdlp");
    expect(result.markdown).toHaveLength(900);
  });
});

describe("profileDirForHost", () => {
  it("maps host to ~/.linkinbox/profiles/<host>/<adapterId>", async () => {
    const { profileDirForHost } = await import("../src/browser.js");
    const { homedir } = await import("node:os");
    const dir = profileDirForHost("https://x.com/user/status/1");
    expect(dir).toBe(join(homedir(), ".linkinbox", "profiles", "x.com", "headless"));
  });

  it("honours an explicit profiles dir and adapter id", async () => {
    const { profileDirForHost } = await import("../src/browser.js");
    const dir = profileDirForHost("https://example.dev/x", "/custom/profiles", "stealth");
    expect(dir).toBe(join("/custom/profiles", "example.dev", "stealth"));
  });
});

describe("createRouter gone pages", () => {
  it("stops at a 404/410 instead of escalating to readability and the browser", async () => {
    const calls: string[] = [];
    const track = (name: string, r: ExtractResult) =>
      fakeExtractor(name, () => {
        calls.push(name);
        return r;
      });
    const router = routerWith({
      defuddle: track("defuddle", { markdown: "", gone: 404 }),
      readability: track("readability", ok()),
      browser: track("browser", ok()),
    });
    const result = await router.extract("https://example.com/missing");
    expect(result.gone).toBe(404);
    expect(result.needsBrowser).toBeUndefined();
    expect(calls).toEqual(["defuddle"]);
  });
});
