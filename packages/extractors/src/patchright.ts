import { Extractor, ExtractResult, ExecLike } from "./types.js";

export interface PatchrightExtractorOptions {
  exec?: ExecLike;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;

function defaultExec(
  file: string,
  args: string[],
  options?: { timeoutMs?: number },
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    // Lazy import so the runtime dep stays optional until Patchright is wired.
    import("node:child_process").then(({ execFile: run }) => {
      run(
        file,
        args,
        { timeout: options?.timeoutMs, maxBuffer: 32 * 1024 * 1024 },
        (error, stdout, stderr) => {
          const code = error ? 1 : 0;
          resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
        },
      );
    });
  });
}

/**
 * Stealth-browser extractor driven by a Patchright script. NOT wired into the
 * default router; activate only when agent-browser is fingerprint-blocked.
 * Same contract as browser.ts: never throws, empty markdown + needsBrowser
 * on any failure.
 */
export function createPatchrightExtractor(options: PatchrightExtractorOptions = {}): Extractor {
  const exec = options.exec ?? defaultExec;
  return {
    name: "patchright",
    async extract(url: string): Promise<ExtractResult> {
      try {
        const result = await exec("uvx", ["patchright", "read", url], {
          timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        });
        if (result.code !== 0) return { markdown: "", needsBrowser: true };
        const markdown = result.stdout.trim();
        if (!markdown) return { markdown: "", needsBrowser: true };
        return { markdown };
      } catch {
        return { markdown: "", needsBrowser: true };
      }
    },
  };
}
