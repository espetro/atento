import { createBrowserExtractor, type BrowserExtractorOptions } from "./browser.js";
import { createPatchrightExtractor, type PatchrightExtractorOptions } from "./patchright.js";
import type { ExecLike, Extractor, ExtractResult } from "./types.js";

/**
 * The read-only reader behind `atento browse` and the MCP browse_read
 * tool.
 *
 * It reuses the browser engines the pipeline already has and exposes
 * NOTHING but a read: the only commands it ever runs are "open the url"
 * and "read the page". No click, no type, no form, no navigation API. The
 * click/type surface of agent-browser is deliberately not reachable from
 * here.
 *
 * The engine is chosen per host through the adapter registry: the caller
 * injects `adapterFor` (host -> adapter id) and `adapterReaders`
 * (adapter id -> extractor). The legacy `stealthHost` callback still works
 * for callers that have not migrated: it maps onto the "stealth"/"headless"
 * adapter ids.
 */

export type BrowseReadReason = "no_profile" | "login_wall" | "error";

export interface BrowseReadOutcome {
  /** True when the page was read and the markdown is usable. */
  ok: boolean;
  /** The page as markdown. Empty when the read failed. */
  markdown: string;
  /** The final URL after redirects, when the engine reports one. */
  finalUrl?: string;
  /** Which adapter read the page. */
  engine: string;
  /** Why the read failed, when it did. */
  reason?: BrowseReadReason;
  /** A short detail for the reason. */
  detail?: string;
}

export interface BrowseReaderOptions {
  /** Base dir for the saved login profiles. */
  profilesDir?: string;
  /** The default (agent-browser) engine options. */
  browser?: BrowserExtractorOptions;
  /** The stealth (Patchright) engine options. */
  patchright?: PatchrightExtractorOptions;
  /**
   * Legacy engine choice: true when the host must be read with the stealth
   * engine. Used only when `adapterFor`/`adapterReaders` do not resolve.
   */
  stealthHost?: (host: string) => boolean;
  /**
   * The adapter id a host reads with (the registry's reader resolution).
   * When it returns an id present in `adapterReaders`, that extractor runs.
   */
  adapterFor?: (host: string) => string | undefined;
  /** Adapter id -> extractor, for adapters beyond the built-in pair. */
  adapterReaders?: Record<string, Extractor>;
  /**
   * Close the agent-browser session after the read (default true). A browse
   * is a one-shot read: leaving the browser open would hold the profile
   * lock for the next reader.
   */
  closeAfterRead?: boolean;
  /** The agent-browser binary, overridable for tests. */
  command?: string;
  /**
   * The environment the binary is resolved from. The env var
   * ATENTO_AGENT_BROWSER wins over the default name, the same way the
   * login command resolves it.
   */
  env?: Record<string, string | undefined>;
  /** Subprocess runner, injected in tests. */
  exec?: ExecLike;
  /** Override the profile-existence check (tests). */
  profileExists?: (dir: string) => boolean;
}

/** The reader: read one page and report what came back. */
export type BrowseReader = (url: string, host: string) => Promise<BrowseReadOutcome>;

/**
 * Map an extractor result onto the browse outcome. A missing profile, a
 * login wall and a failed read are three different reasons, so the caller
 * can tell the owner what to do about it.
 */
export function toBrowseOutcome(
  result: {
    markdown: string;
    needsBrowser?: boolean;
    finalUrl?: string;
    meta?: Record<string, unknown>;
  },
  engine: string,
): BrowseReadOutcome {
  const meta = result.meta ?? {};
  if (result.needsBrowser === true) {
    if (meta["missingProfile"] === true) {
      return { ok: false, markdown: "", engine, reason: "no_profile" };
    }
    if (meta["blocked"] === true) {
      const reason = typeof meta["reason"] === "string" ? meta["reason"] : "login_wall";
      return { ok: false, markdown: "", engine, reason: "login_wall", detail: reason };
    }
    const detail =
      typeof meta["stderr"] === "string"
        ? meta["stderr"]
        : typeof meta["exitCode"] === "number"
          ? `exit code ${meta["exitCode"]}`
          : typeof meta["error"] === "string"
            ? meta["error"]
            : "the browser could not read the page";
    return { ok: false, markdown: "", engine, reason: "error", detail };
  }
  return {
    ok: true,
    markdown: result.markdown,
    finalUrl: result.finalUrl,
    engine,
  };
}

/** The adapter ids the built-in engine pair answers to. */
export const BROWSE_HEADLESS_ADAPTER = "headless";
export const BROWSE_STEALTH_ADAPTER = "stealth";

/**
 * Build the reader. The adapter for a host comes from `adapterFor` (the
 * registry); without it the legacy `stealthHost` callback picks between
 * the built-in "headless" and "stealth" readers.
 */
export function createBrowseReader(options: BrowseReaderOptions = {}): BrowseReader {
  const closeAfterRead = options.closeAfterRead !== false;
  const stealth = options.stealthHost ?? (() => false);
  const env = options.env ?? process.env;
  // The binary comes from the env var first, like the login command, so an
  // operator can point the read at another build without a rebuild.
  const command =
    options.command ?? env["ATENTO_AGENT_BROWSER"] ?? options.browser?.command ?? "agent-browser";

  const browserExtractor = createBrowserExtractor({
    command,
    exec: options.exec,
    profileExists: options.profileExists,
    ...options.browser,
    profilesDir: options.profilesDir ?? options.browser?.profilesDir,
  });
  const patchrightExtractor = createPatchrightExtractor({
    profileExists: options.profileExists,
    ...options.patchright,
    profilesDir: options.profilesDir ?? options.patchright?.profilesDir,
    adapterId: BROWSE_STEALTH_ADAPTER,
  });

  const readers: Record<string, { extractor: Extractor; closeProfile?: boolean }> = {
    [BROWSE_HEADLESS_ADAPTER]: { extractor: browserExtractor, closeProfile: true },
    [BROWSE_STEALTH_ADAPTER]: { extractor: patchrightExtractor },
    ...Object.fromEntries(
      Object.entries(options.adapterReaders ?? {}).map(([id, extractor]) => [
        id,
        { extractor },
      ]),
    ),
  };

  return async (url: string, host: string): Promise<BrowseReadOutcome> => {
    const adapterId = options.adapterFor?.(host);
    const fallbackId = stealth(host) ? BROWSE_STEALTH_ADAPTER : BROWSE_HEADLESS_ADAPTER;
    const adapterIdUsed =
      adapterId !== undefined && readers[adapterId] !== undefined ? adapterId : fallbackId;
    const entry = readers[adapterIdUsed]!;
    const result: ExtractResult = await entry.extractor.extract(url);
    if (closeAfterRead && entry.closeProfile && options.exec) {
      // The session is closed best effort: a failure here must never fail
      // the read that already succeeded.
      await options.exec(
        command,
        ["--profile", profileDirFor(options.profilesDir, host, adapterIdUsed), "close"],
        { timeoutMs: 15_000 },
      ).catch(() => undefined);
    }
    return toBrowseOutcome(result, adapterIdUsed);
  };
}

/** The profile directory of a host on an adapter: <profilesDir>/<host>/<adapterId>. */
export function profileDirFor(
  profilesDir: string | undefined,
  host: string,
  adapterId = BROWSE_HEADLESS_ADAPTER,
): string {
  const base = profilesDir ?? defaultProfilesDir();
  return `${base.replace(/\/+$/, "")}/${host}/${adapterId}`;
}

function defaultProfilesDir(): string {
  const home = process.env["HOME"] ?? "";
  return `${home}/.atento/profiles`;
}
