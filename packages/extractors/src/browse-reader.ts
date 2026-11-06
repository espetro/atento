import { createBrowserExtractor, type BrowserExtractorOptions } from "./browser.js";
import { createPatchrightExtractor, type PatchrightExtractorOptions } from "./patchright.js";
import type { ExecLike } from "./types.js";

/**
 * The read-only reader behind `linkinbox browse` and the MCP browse_read
 * tool.
 *
 * It reuses the two engines the pipeline already has (agent-browser and
 * the stealth Patchright extractor) and exposes NOTHING but a read: the
 * only commands it ever runs are "open the url" and "read the page". No
 * click, no type, no form, no navigation API. The click/type surface of
 * agent-browser is deliberately not reachable from here.
 *
 * The engine is chosen per host: the stealth engine for the hosts the
 * owner listed in `stealth_hosts`, the default engine for the rest. The
 * choice comes from the caller, so no host name is hardcoded here.
 */

export type BrowseReadReason = "no_profile" | "login_wall" | "error";

export interface BrowseReadOutcome {
  /** True when the page was read and the markdown is usable. */
  ok: boolean;
  /** The page as markdown. Empty when the read failed. */
  markdown: string;
  /** The final URL after redirects, when the engine reports one. */
  finalUrl?: string;
  /** Which engine read the page. */
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
  /** True when the host must be read with the stealth engine. */
  stealthHost?: (host: string) => boolean;
  /**
   * Close the agent-browser session after the read (default true). A browse
   * is a one-shot read: leaving the browser open would hold the profile
   * lock for the next reader.
   */
  closeAfterRead?: boolean;
  /** The agent-browser binary, overridable for tests. */
  command?: string;
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

/**
 * Build the reader. The stealth engine is used for the hosts the caller
 * marks as stealth hosts; every other host uses the default engine.
 */
export function createBrowseReader(options: BrowseReaderOptions = {}): BrowseReader {
  const closeAfterRead = options.closeAfterRead !== false;
  const stealth = options.stealthHost ?? (() => false);

  const browserExtractor = createBrowserExtractor({
    command: options.command,
    exec: options.exec,
    profileExists: options.profileExists,
    ...options.browser,
    profilesDir: options.profilesDir ?? options.browser?.profilesDir,
  });
  const patchrightExtractor = createPatchrightExtractor({
    profileExists: options.profileExists,
    ...options.patchright,
    profilesDir: options.profilesDir ?? options.patchright?.profilesDir,
  });

  return async (url: string, host: string): Promise<BrowseReadOutcome> => {
    if (stealth(host)) {
      const result = await patchrightExtractor.extract(url);
      return toBrowseOutcome(result, "patchright");
    }
    const result = await browserExtractor.extract(url);
    if (closeAfterRead && options.exec && options.command) {
      // The session is closed best effort: a failure here must never fail
      // the read that already succeeded.
      await options.exec(
        options.command,
        ["--profile", profileDirFor(options.profilesDir, host), "close"],
        { timeoutMs: 15_000 },
      ).catch(() => undefined);
    }
    return toBrowseOutcome(result, "agent-browser");
  };
}

/** The profile directory of a host: <profilesDir>/<host>. */
export function profileDirFor(profilesDir: string | undefined, host: string): string {
  const base = profilesDir ?? defaultProfilesDir();
  return `${base.replace(/\/+$/, "")}/${host}`;
}

function defaultProfilesDir(): string {
  const home = process.env["HOME"] ?? "";
  return `${home}/.linkinbox/profiles`;
}
