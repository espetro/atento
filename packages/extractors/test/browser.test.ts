import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { createBrowserExtractor } from "../src/browser.js";
import type { ExecLike } from "../src/types.js";

function execOk(stdout: string): ExecLike {
  return async () => ({ code: 0, stdout, stderr: "" });
}
function execFail(stderr = "boom"): ExecLike {
  return async () => ({ code: 1, stdout: "", stderr });
}

describe("browser extractor", () => {
  it("returns needsBrowser=true with empty markdown when no profile exists", async () => {
    const extractor = createBrowserExtractor({
      exec: execOk("# should not be called"),
      profilesDir: "/nonexistent/linkinbox/profiles",
      profileExists: () => false,
    });
    const result = await extractor.extract("https://x.com/user/status/123");
    expect(result).toEqual({ markdown: "", needsBrowser: true });
  });

  it("spawns agent-browser with an args array (never a shell string)", async () => {
    const calls: { file: string; args: string[] }[] = [];
    const exec: ExecLike = async (file, args) => {
      calls.push({ file, args });
      return { code: 0, stdout: "# extracted\n\ncontent body", stderr: "" };
    };
    const extractor = createBrowserExtractor({
      exec,
      profilesDir: "/tmp/fake-profiles",
      profileExists: () => true,
    });
    const result = await extractor.extract("https://example.dev/article");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.file).toBe("agent-browser");
    expect(calls[0]!.args).toEqual([
      "--profile",
      join("/tmp/fake-profiles", "example.dev"),
      "read",
      "https://example.dev/article",
    ]);
    expect(result.markdown).toBe("# extracted\n\ncontent body");
    expect(result.needsBrowser).toBeFalsy();
  });

  it("returns needsBrowser=true when the command exits non-zero", async () => {
    const extractor = createBrowserExtractor({
      exec: execFail("fingerprinted"),
      profileExists: () => true,
    });
    const result = await extractor.extract("https://x.com/post/1");
    expect(result).toEqual({ markdown: "", needsBrowser: true });
  });

  it("returns needsBrowser=true when the command throws (binary missing)", async () => {
    const extractor = createBrowserExtractor({
      exec: (async () => {
        throw new Error("ENOENT");
      }) as unknown as ExecLike,
      profileExists: () => true,
    });
    const result = await extractor.extract("https://x.com/post/1");
    expect(result).toEqual({ markdown: "", needsBrowser: true });
  });

  it("returns needsBrowser=true on empty stdout", async () => {
    const extractor = createBrowserExtractor({
      exec: execOk(""),
      profileExists: () => true,
    });
    const result = await extractor.extract("https://x.com/post/1");
    expect(result).toEqual({ markdown: "", needsBrowser: true });
  });
});
