import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { Extractor, ExtractResult, ExecLike } from "./types.js";
import { cleanBrowserMarkdown } from "./clean.js";

export interface BrowserExtractorOptions {
  /** agent-browser binary; overridable for tests. */
  command?: string;
  /**
   * Chromium binary passed to agent-browser as --executable-path. Unset
   * means: agent-browser resolves it itself (its env var, then its default).
   */
  executablePath?: string;
  /** Base dir for saved login profiles. */
  profilesDir?: string;
  /** Subprocess runner; inject a fake in tests (offline). */
  exec?: ExecLike;
  /** Subprocess timeout in ms. */
  timeoutMs?: number;
  /** Override profile-existence check (tests). */
  profileExists?: (dir: string) => boolean;
  /**
   * Wait before reading the page, so a logged-in session looks human.
   * Injected so tests never really sleep. When absent no dwell happens.
   */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Human-like scroll before reading. Injected so tests need no browser.
   * When absent no scroll happens.
   */
  scroll?: (pixels: number, profileDir: string) => Promise<void>;
  /** Sampled dwell time in ms; defaults to the pacing median (20s). */
  dwellMs?: number;
  /** Sampled scroll distance in px; defaults to a small human-like step. */
  scrollPx?: number;
  /**
   * The adapter id this extractor stands in for; selects the profile
   * subdirectory (<profilesDir>/<host>/<adapterId>). Default "headless".
   */
  adapterId?: string;
}

const DEFAULT_TIMEOUT_MS = 120_000;

/** Default dwell before reading a page: the pacing median. */
const DEFAULT_DWELL_MS = 20_000;

/** Default scroll distance: a small, human-sized step. */
const DEFAULT_SCROLL_PX = 420;

/**
 * Markers of a login wall or a block page. When one of these shows up the
 * extraction is not "low yield": the host is refusing the session, so the
 * caller must stop hammering it.
 */
const LOGIN_WALL_MARKERS = [
  "sign in to continue",
  "log in to continue",
  "please log in",
  "login required",
  "captcha",
  "verify you are human",
  "unusual activity",
  "suspended",
  "account locked",
  "rate limit exceeded",
];

/** True when the text looks like a login wall or a block page. */
export function isLoginWall(text: string): boolean {
  const lower = text.toLowerCase();
  return LOGIN_WALL_MARKERS.some((marker) => lower.includes(marker));
}

function defaultExec(
  file: string,
  args: string[],
  options?: { timeoutMs?: number; env?: Record<string, string> },
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      {
        timeout: options?.timeoutMs,
        env: options?.env ? { ...process.env, ...options.env } : process.env,
        maxBuffer: 32 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        const code =
          error && typeof (error as NodeJS.ErrnoException & { code?: number }).code === "number"
            ? ((error as { code?: number }).code as number)
            : error
              ? 1
              : 0;
        resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
      },
    );
  });
}

/** Profile dir for a host on an adapter: ~/.linkinbox/profiles/<host>/<adapterId> */
export function profileDirForHost(
  url: string,
  profilesDir?: string,
  adapterId = "headless",
): string {
  const host = new URL(url).hostname;
  const base = profilesDir ?? join(homedir(), ".linkinbox", "profiles");
  return join(base, host, adapterId);
}

/**
 * agent-browser subprocess extractor:
 *   agent-browser --profile <dir> read <url>
 *
 * The browser always runs headless and always with the saved profile for the
 * host: an interactive browser would let the account be used by accident and
 * the headless flag keeps the session reproducible.
 *
 * Never throws: missing profile or failing command yields
 * needsBrowser=true with empty markdown so the router can flag the link. A
 * login wall is reported through `meta.blocked` so the pipeline can open the
 * host's circuit breaker instead of retrying.
 */
export function createBrowserExtractor(options: BrowserExtractorOptions = {}): Extractor {
  const command = options.command ?? "agent-browser";
  const exec = options.exec ?? defaultExec;
  const exists =
    options.profileExists ?? ((dir: string) => existsSync(dir));
  const dwellMs = options.dwellMs ?? DEFAULT_DWELL_MS;
  const scrollPx = options.scrollPx ?? DEFAULT_SCROLL_PX;

  return {
    name: "browser",
    async extract(url: string): Promise<ExtractResult> {
      const profileDir = profileDirForHost(url, options.profilesDir, options.adapterId);
      if (!exists(profileDir)) {
        return { markdown: "", needsBrowser: true, meta: { missingProfile: true } };
      }
      try {
        // Load the page first, then dwell and scroll like a person, then
        // read it. Both pacing steps are injected, so tests never sleep and
        // never need a browser. agent-browser runs headless by default.
        const base = ["--profile", profileDir];
        if (options.executablePath) base.push("--executable-path", options.executablePath);
        const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        const opened = await exec(command, [...base, "open", url], { timeoutMs });
        if (opened.code !== 0) {
          return {
            markdown: "",
            needsBrowser: true,
            meta: { exitCode: opened.code, stderr: opened.stderr.slice(0, 200) },
          };
        }
        if (options.sleep) await options.sleep(dwellMs);
        if (options.scroll) await options.scroll(scrollPx, profileDir);
        const result = await exec(command, [...base, "read"], { timeoutMs });
        if (result.code !== 0) {
          return {
            markdown: "",
            needsBrowser: true,
            meta: { exitCode: result.code, stderr: result.stderr.slice(0, 200) },
          };
        }
        const markdown = result.stdout.trim();
        if (!markdown) {
          return { markdown: "", needsBrowser: true, meta: { emptyPage: true } };
        }
        if (isLoginWall(markdown)) {
          // The host refused the session: the caller must stop, not retry.
          return {
            markdown: "",
            needsBrowser: true,
            meta: { blocked: true, reason: "login_wall" },
          };
        }
        return { markdown: cleanBrowserMarkdown(url, markdown) };
      } catch {
        return { markdown: "", needsBrowser: true, meta: { failed: true } };
      }
    },
  };
}
