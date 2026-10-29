import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { Extractor, ExtractResult, ExecLike } from "./types.js";

export interface BrowserExtractorOptions {
  /** agent-browser binary; overridable for tests. */
  command?: string;
  /** Base dir for saved login profiles. */
  profilesDir?: string;
  /** Subprocess runner; inject a fake in tests (offline). */
  exec?: ExecLike;
  /** Subprocess timeout in ms. */
  timeoutMs?: number;
  /** Override profile-existence check (tests). */
  profileExists?: (dir: string) => boolean;
}

const DEFAULT_TIMEOUT_MS = 120_000;

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

/** Profile dir for a host: ~/.linkinbox/profiles/<host> */
export function profileDirForHost(url: string, profilesDir?: string): string {
  const host = new URL(url).hostname;
  const base = profilesDir ?? join(homedir(), ".linkinbox", "profiles");
  return join(base, host);
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

  return {
    name: "browser",
    async extract(url: string): Promise<ExtractResult> {
      const profileDir = profileDirForHost(url, options.profilesDir);
      if (!exists(profileDir)) {
        return { markdown: "", needsBrowser: true, meta: { missingProfile: true } };
      }
      try {
        const result = await exec(
          command,
          ["--headless", "--profile", profileDir, "read", url],
          { timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS },
        );
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
        return { markdown };
      } catch {
        return { markdown: "", needsBrowser: true, meta: { failed: true } };
      }
    },
  };
}
