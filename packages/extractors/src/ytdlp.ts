import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Extractor, ExtractResult, ExecLike } from "./types.js";

export interface YtdlpExtractorOptions {
  /** yt-dlp binary; overridable for tests. */
  command?: string;
  /** Subprocess runner; inject a fake in tests (offline). */
  exec?: ExecLike;
  timeoutMs?: number;
  /** Pre-created working dir; a temp dir is created when omitted. */
  workDir?: string;
}

const DEFAULT_TIMEOUT_MS = 180_000;

function defaultExec(
  file: string,
  args: string[],
  options?: { timeoutMs?: number },
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    import("node:child_process").then(({ execFile: run }) => {
      run(
        file,
        args,
        { timeout: options?.timeoutMs, maxBuffer: 64 * 1024 * 1024 },
        (error, stdout, stderr) => {
          resolve({
            code: error ? 1 : 0,
            stdout: String(stdout ?? ""),
            stderr: String(stderr ?? ""),
          });
        },
      );
    });
  });
}

/** Convert WebVTT (or SRT-ish) subtitle text to plain transcript lines. */
export function vttToTranscript(vtt: string): string {
  const lines = vtt.split(/\r?\n/);
  const out: string[] = [];
  let last = "";
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (/^WEBVTT/i.test(line)) continue;
    if (/^\d+$/.test(line)) continue;
    if (/-->/.test(line)) continue;
    if (/^(NOTE|STYLE|REGION)\b/i.test(line)) continue;
    const text = line.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
    if (!text) continue;
    if (text === last) continue;
    last = text;
    out.push(text);
  }
  return out.join(" ").trim();
}

function stripHtml(value: string): string {
  return value
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Video extractor via yt-dlp:
 *   yt-dlp --write-auto-sub --skip-download --write-info-json ...
 * Returns markdown built from the auto-subtitle transcript when present,
 * otherwise the video description.
 */
export function createYtdlpExtractor(options: YtdlpExtractorOptions = {}): Extractor {
  const command = options.command ?? "yt-dlp";
  const exec = options.exec ?? defaultExec;

  return {
    name: "ytdlp",
    async extract(url: string): Promise<ExtractResult> {
      const workDir =
        options.workDir ?? (await mkdtemp(join(tmpdir(), "atento-ytdlp-")));
      const args = [
        "--write-auto-sub",
        "--write-sub",
        "--sub-lang",
        "en",
        "--sub-format",
        "vtt",
        "--skip-download",
        "--write-info-json",
        "--no-playlist",
        "--no-warnings",
        "-o",
        join(workDir, "%(id)s.%(ext)s"),
        url,
      ];

      let stdout = "";
      try {
        const result = await exec(command, args, {
          timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        });
        stdout = result.stdout;
        if (result.code !== 0 && !stdout.trim()) {
          return { markdown: "", needsBrowser: true };
        }
      } catch {
        return { markdown: "", needsBrowser: true };
      }

      let files: string[] = [];
      try {
        files = await readdir(workDir);
      } catch {
        files = [];
      }

      const infoFile = files.find((f) => f.endsWith(".info.json"));
      const subFile = files.find((f) => f.endsWith(".vtt") || f.endsWith(".srt"));

      let info: Record<string, unknown> = {};
      if (infoFile) {
        try {
          info = JSON.parse(await readFile(join(workDir, infoFile), "utf8")) as Record<
            string,
            unknown
          >;
        } catch {
          info = {};
        }
      }

      const title = typeof info.title === "string" ? info.title : undefined;
      const description = typeof info.description === "string" ? stripHtml(info.description) : "";

      let transcript = "";
      if (subFile) {
        try {
          const raw = await readFile(join(workDir, subFile), "utf8");
          transcript = vttToTranscript(raw);
        } catch {
          transcript = "";
        }
      }

      const parts: string[] = [];
      if (title) parts.push(`# ${title}`);
      if (transcript) {
        parts.push("## Transcript", "", transcript);
      } else if (description) {
        parts.push("## Description", "", description);
      } else if (!title && stdout.trim()) {
        parts.push(stdout.trim());
      }

      const markdown = parts.join("\n").trim();
      if (!markdown) return { markdown: "", needsBrowser: true };

      const meta: Record<string, unknown> = { extractor: "ytdlp" };
      if (typeof info.duration === "number") meta.duration = info.duration;
      if (typeof info.uploader === "string") meta.uploader = info.uploader;
      if (typeof info.webpage_url === "string") meta.webpageUrl = info.webpage_url;
      if (transcript) meta.hasTranscript = true;
      else meta.hasTranscript = false;

      return { markdown, title, meta };
    },
  };
}
