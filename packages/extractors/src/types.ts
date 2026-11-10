/**
 * Extractor interface for atento. Self-contained: no dependency on other
 * workspace packages.
 */

export interface ExtractResult {
  /** Extracted content as markdown. Empty string signals no content. */
  markdown: string;
  title?: string;
  /** Arbitrary site metadata (author, published, description, ...). */
  meta?: Record<string, unknown>;
  /**
   * True when the extractor could not run locally (missing browser profile,
   * auth wall, blocked page) and a real browser session is required. The
   * router surfaces this instead of treating it as a hard failure.
   */
  needsBrowser?: boolean;
  /**
   * HTTP status when the page is permanently gone (404 or 410). A browser
   * cannot fix this, so the router stops escalating and the caller errors.
   */
  gone?: number;
  /** The HTTP status of the final response, for login-wall detection. */
  status?: number;
  /** The final URL after redirects, for login-wall detection. */
  finalUrl?: string;
  /** The raw HTML, so the caller can detect a password form. */
  html?: string;
}

export interface Extractor {
  /** Stable extractor name for routing and metrics. */
  readonly name: string;
  extract(url: string): Promise<ExtractResult>;
}

/**
 * A fetch of a URL returning raw HTML (status + body). Injected into
 * extractors so tests run offline and the pipeline controls timeouts,
 * headers, and caching.
 */
export interface Fetcher {
  fetch(url: string): Promise<{
    status: number
    body: string
    contentType?: string
    /** Response headers (Retry-After, X-RateLimit-*), when available. */
    headers?: Record<string, string | undefined>
    /** The final URL after redirects. */
    finalUrl?: string
  }>
}

export type FetchLike = Fetcher["fetch"];

/** Subprocess runner abstraction so tests never spawn real processes. */
export type ExecLike = (
  file: string,
  args: string[],
  options?: { timeoutMs?: number; env?: Record<string, string> },
) => Promise<{ code: number; stdout: string; stderr: string }>;
