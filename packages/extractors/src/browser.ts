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
 * Never throws: missing profile or failing command yields
 * needsBrowser=true with empty markdown so the router can flag the link.
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
        return { markdown: "", needsBrowser: true };
      }
      try {
        const result = await exec(
          command,
          ["--profile", profileDir, "read", url],
          { timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS },
        );
        if (result.code !== 0) {
          return { markdown: "", needsBrowser: true };
        }
        const markdown = result.stdout.trim();
        if (!markdown) {
          return { markdown: "", needsBrowser: true };
        }
        return { markdown };
      } catch {
        return { markdown: "", needsBrowser: true };
      }
    },
  };
}
