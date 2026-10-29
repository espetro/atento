import { describe, it, expect } from "vitest";
import { createYtdlpExtractor, vttToTranscript } from "../src/ytdlp.js";
import type { ExecLike } from "../src/types.js";

const VTT = `WEBVTT

1
00:00:00.000 --> 00:00:03.000
Welcome to the talk.

2
00:00:03.000 --> 00:00:07.500
Today we cover extraction.
<Welcome to the talk.>
`;

const INFO = JSON.stringify({
  title: "Extraction Deep Dive",
  description: "A talk about <b>content extraction</b>.",
  duration: 611,
  uploader: "Example Channel",
  webpage_url: "https://www.youtube.com/watch?v=abc",
});

function execWritingFiles(): ExecLike {
  // The fake exec simulates yt-dlp writing outputs next to -o. The extractor
  // reads whatever the fake wrote via the injected workDir.
  return async () => ({ code: 0, stdout: "youtube abc", stderr: "" });
}

describe("ytdlp extractor", () => {
  it("converts vtt to transcript text", () => {
    const text = vttToTranscript(VTT);
    expect(text).toBe("Welcome to the talk. Today we cover extraction.");
  });

  it("returns transcript and description markdown from subprocess outputs", async () => {
    // Stub exec plus pre-seeded workDir is not enough because the extractor
    // reads files from disk; instead point workDir at a fixture dir we
    // prepare inline with node:fs (still offline).
    const { mkdtemp, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const workDir = await mkdtemp(join(tmpdir(), "ytdlp-test-"));
    await writeFile(join(workDir, "abc.info.json"), INFO, "utf8");
    await writeFile(join(workDir, "abc.en.vtt"), VTT, "utf8");

    const extractor = createYtdlpExtractor({ exec: execWritingFiles(), workDir });
    const result = await extractor.extract("https://www.youtube.com/watch?v=abc");

    expect(result.needsBrowser).toBeFalsy();
    expect(result.title).toBe("Extraction Deep Dive");
    expect(result.markdown).toContain("# Extraction Deep Dive");
    expect(result.markdown).toContain("## Transcript");
    expect(result.markdown).toContain("Today we cover extraction.");
    expect(result.meta).toMatchObject({
      hasTranscript: true,
      duration: 611,
      uploader: "Example Channel",
    });
  });

  it("falls back to description when no subtitles were written", async () => {
    const { mkdtemp, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const workDir = await mkdtemp(join(tmpdir(), "ytdlp-test-"));
    await writeFile(join(workDir, "abc.info.json"), INFO, "utf8");

    const extractor = createYtdlpExtractor({ exec: execWritingFiles(), workDir });
    const result = await extractor.extract("https://www.youtube.com/watch?v=abc");
    expect(result.markdown).toContain("## Description");
    expect(result.markdown).toContain("content extraction");
    expect(result.meta).toMatchObject({ hasTranscript: false });
  });

  it("returns needsBrowser=true when yt-dlp fails", async () => {
    const extractor = createYtdlpExtractor({
      exec: async () => ({ code: 1, stdout: "", stderr: "unsupported" }),
    });
    const result = await extractor.extract("https://www.youtube.com/watch?v=bad");
    expect(result).toEqual({ markdown: "", needsBrowser: true });
  });
});
