import { Extractor, ExtractResult } from "./types.js";
import { createDefuddleExtractor, DefuddleExtractorOptions } from "./defuddle.js";
import { createReadabilityExtractor, ReadabilityExtractorOptions } from "./readability.js";
import { createBrowserExtractor, BrowserExtractorOptions } from "./browser.js";
import { createPatchrightExtractor, PatchrightExtractorOptions } from "./patchright.js";
import { createYtdlpExtractor, YtdlpExtractorOptions } from "./ytdlp.js";
import { createPdfExtractor, PdfExtractorOptions } from "./pdf.js";

export { createPatchrightExtractor } from "./patchright.js";
export type { PatchrightExtractorOptions } from "./patchright.js";

/** Router selection outcome. */
export type RouteChoice =
  | "ytdlp"
  | "pdf"
  | "browser"
  | "patchright"
  | "defuddle"
  | "readability";

const VIDEO_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtu.be",
  "vimeo.com",
  "www.vimeo.com",
  "dailymotion.com",
  "www.dailymotion.com",
]);

/**
 * The routing decision for one host.
 *
 * The router has no hardcoded list of walled gardens: the host policy is
 * injected by the caller (the pipeline reads it from the core host policy
 * function, which knows about saved profiles, flagged canaries and the
 * config skip-list).
 */
export interface HostRoutePolicy {
  /** True when the host must be fetched with a browser extractor. */
  browser?: boolean;
  /**
   * True when the browser extractor is the stealth one (Patchright): the
   * host is in `[browser] stealth_hosts` or the config engine is patchright.
   * Only meaningful together with `browser`.
   */
  stealth?: boolean;
  /** True when the host is skip-listed: its links are never fetched. */
  skipped?: boolean;
}

export interface RouterOptions {
  fetch?: DefuddleExtractorOptions["fetch"] & ReadabilityExtractorOptions["fetch"];
  parseHtml?: DefuddleExtractorOptions["parseHtml"];
  browser?: BrowserExtractorOptions;
  patchright?: PatchrightExtractorOptions;
  ytdlp?: YtdlpExtractorOptions;
  pdf?: PdfExtractorOptions;
  /** Minimum markdown chars for a "good" extraction. Default 200. */
  minChars?: number;
  /** Overrides, mainly for tests. */
  extractors?: Partial<Record<RouteChoice, Extractor>>;
  /**
   * The host policy, injected from the core package: the single source of
   * truth shared with the rate limiter.
   */
  hostPolicy?: (host: string) => HostRoutePolicy | Promise<HostRoutePolicy>;
}

export interface RouterDeps {
  extractors: Record<RouteChoice, Extractor>;
  minChars: number;
  hostPolicy?: RouterOptions["hostPolicy"];
}

export function buildRouterDeps(options: RouterOptions = {}): RouterDeps {
  const fetch = options.fetch;
  const parseHtml = options.parseHtml;
  return {
    minChars: options.minChars ?? 200,
    hostPolicy: options.hostPolicy,
    extractors: {
      defuddle: options.extractors?.defuddle ??
        createDefuddleExtractor({ fetch: fetch!, parseHtml: parseHtml! }),
      readability: options.extractors?.readability ??
        createReadabilityExtractor({ fetch: fetch! }),
      browser: options.extractors?.browser ?? createBrowserExtractor(options.browser),
      patchright: options.extractors?.patchright ??
        createPatchrightExtractor(options.patchright),
      ytdlp: options.extractors?.ytdlp ?? createYtdlpExtractor(options.ytdlp),
      pdf: options.extractors?.pdf ?? createPdfExtractor({ fetch: fetch!, ...options.pdf }),
    },
  };
}

/** Rule-based route selection, exactly per the pipeline spec table. */
export function routeFor(url: string): RouteChoice {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "defuddle";
  }
  const host = parsed.hostname.toLowerCase();
  const pathname = parsed.pathname.toLowerCase();

  if (pathname.endsWith(".pdf")) return "pdf";
  if (VIDEO_HOSTS.has(host)) return "ytdlp";
  return "defuddle";
}

export type ExtractAttempt = {
  route: RouteChoice;
  result: ExtractResult;
};

export interface RoutedExtractResult extends ExtractResult {
  /** The extractor that produced the final result. */
  route: RouteChoice;
  /** Ordered attempts made (route -> result). */
  attempts: ExtractAttempt[];
}

/**
 * Route and extract. Low-yield fallback chain:
 *   defuddle -> readability -> browser
 * Yield threshold is `minChars` (configurable).
 */
export function createRouter(options: RouterOptions = {}) {
  const deps = buildRouterDeps(options);
  const minChars = deps.minChars;

  return {
    routeFor,
    /**
     * Route a URL. When a host policy is injected, a host that must use the
     * browser (a saved profile, a flagged canary, a login gate or a manual
     * config override) routes to the browser extractor.
     */
    async routeForWithPolicy(url: string): Promise<RouteChoice> {
      const base = routeFor(url);
      if (!deps.hostPolicy) return base;
      let host: string;
      try {
        host = new URL(url).hostname.toLowerCase();
      } catch {
        return base;
      }
      const policy = await deps.hostPolicy(host);
      if (policy?.skipped) return base;
      if (policy?.browser) return policy.stealth ? "patchright" : "browser";
      return base;
    },
    async extract(url: string): Promise<RoutedExtractResult> {
      const attempts: ExtractAttempt[] = [];
      const tryOne = async (route: RouteChoice): Promise<RoutedExtractResult | null> => {
        const extractor: Extractor = deps.extractors[route];
        const result = await extractor.extract(url);
        attempts.push({ route, result });
        // A 404/410 is final: no other extractor will find the page.
        if (result.gone !== undefined) return { route, attempts, ...result };
        const good =
          result.markdown.trim().length >= minChars && !result.needsBrowser;
        if (good) return { route, attempts, ...result };
        // needsBrowser from a walled-garden route is terminal: the browser
        // engine chosen by the policy is the right extractor, a missing
        // profile should surface as-is.
        if (result.needsBrowser && (route === "browser" || route === "patchright")) {
          return { route, attempts, ...result };
        }
        return null;
      };

      const route = await this.routeForWithPolicy(url);
      const first = await tryOne(route);
      if (first) return first;

      // Low-yield fallback chain. Only the default (defuddle) route
      // escalates through the full chain per the spec.
      if (route === "defuddle") {
        const second = await tryOne("readability");
        if (second) return second;
        const third = await tryOne("browser");
        if (third) return third;
      } else if (route === "pdf") {
        // pdf failed; try browser as a rendering fallback.
        const alt = await tryOne("browser");
        if (alt) return alt;
      } else if (route === "ytdlp") {
        const alt = await tryOne("browser");
        if (alt) return alt;
      }

      // Everything failed: surface the last (most escalated) attempt so the
      // caller sees why the browser step was needed.
      const last = attempts[attempts.length - 1]!;
      return { route: last.route, attempts, ...last.result };
    },
  };
}
