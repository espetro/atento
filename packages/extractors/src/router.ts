import { Extractor, ExtractResult } from "./types.js";
import { createDefuddleExtractor, DefuddleExtractorOptions } from "./defuddle.js";
import { createReadabilityExtractor, ReadabilityExtractorOptions } from "./readability.js";
import { createBrowserExtractor, BrowserExtractorOptions } from "./browser.js";
import { createYtdlpExtractor, YtdlpExtractorOptions } from "./ytdlp.js";
import { createPdfExtractor, PdfExtractorOptions } from "./pdf.js";

export { createPatchrightExtractor } from "./patchright.js";
export type { PatchrightExtractorOptions } from "./patchright.js";

/** Router selection outcome. */
export type RouteChoice =
  | "ytdlp"
  | "pdf"
  | "browser"
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

/** Walled gardens: content behind auth/anti-bot, agent-browser required. */
const WALLED_GARDENS = new Set([
  "x.com",
  "www.x.com",
  "twitter.com",
  "www.twitter.com",
  "instagram.com",
  "www.instagram.com",
  "linkedin.com",
  "www.linkedin.com",
]);

export interface RouterOptions {
  fetch?: DefuddleExtractorOptions["fetch"] & ReadabilityExtractorOptions["fetch"];
  parseHtml?: DefuddleExtractorOptions["parseHtml"];
  browser?: BrowserExtractorOptions;
  ytdlp?: YtdlpExtractorOptions;
  pdf?: PdfExtractorOptions;
  /** Minimum markdown chars for a "good" extraction. Default 200. */
  minChars?: number;
  /** Overrides, mainly for tests. */
  extractors?: Partial<Record<RouteChoice, Extractor>>;
}

export interface RouterDeps {
  extractors: Record<RouteChoice, Extractor>;
  minChars: number;
}

export function buildRouterDeps(options: RouterOptions = {}): RouterDeps {
  const fetch = options.fetch;
  const parseHtml = options.parseHtml;
  return {
    minChars: options.minChars ?? 200,
    extractors: {
      defuddle: options.extractors?.defuddle ??
        createDefuddleExtractor({ fetch: fetch!, parseHtml: parseHtml! }),
      readability: options.extractors?.readability ??
        createReadabilityExtractor({ fetch: fetch! }),
      browser: options.extractors?.browser ?? createBrowserExtractor(options.browser),
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
  if (WALLED_GARDENS.has(host)) return "browser";
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
    async extract(url: string): Promise<RoutedExtractResult> {
      const attempts: ExtractAttempt[] = [];
      const tryOne = async (route: RouteChoice): Promise<RoutedExtractResult | null> => {
        const extractor: Extractor = deps.extractors[route];
        const result = await extractor.extract(url);
        attempts.push({ route, result });
        const good =
          result.markdown.trim().length >= minChars && !result.needsBrowser;
        if (good) return { route, attempts, ...result };
        // needsBrowser from a walled-garden route is terminal: browser is the
        // right extractor, a missing profile should surface as-is.
        if (result.needsBrowser && route === "browser") {
          return { route, attempts, ...result };
        }
        return null;
      };

      const route = routeFor(url);
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
