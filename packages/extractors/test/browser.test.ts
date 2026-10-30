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
    expect(result.markdown).toBe("");
    expect(result.needsBrowser).toBe(true);
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
    const profile = join("/tmp/fake-profiles", "example.dev");
    expect(calls.map((c) => c.file)).toEqual(["agent-browser", "agent-browser"]);
    expect(calls[0]!.args).toEqual(["--profile", profile, "open", "https://example.dev/article"]);
    expect(calls[1]!.args).toEqual(["--profile", profile, "read"]);
    expect(result.markdown).toBe("# extracted\n\ncontent body");
    expect(result.needsBrowser).toBeFalsy();
  });

  it("returns needsBrowser=true when the command exits non-zero", async () => {
    const extractor = createBrowserExtractor({
      exec: execFail("fingerprinted"),
      profileExists: () => true,
    });
    const result = await extractor.extract("https://x.com/post/1");
    expect(result.markdown).toBe("");
    expect(result.needsBrowser).toBe(true);
  });

  it("returns needsBrowser=true when the command throws (binary missing)", async () => {
    const extractor = createBrowserExtractor({
      exec: (async () => {
        throw new Error("ENOENT");
      }) as unknown as ExecLike,
      profileExists: () => true,
    });
    const result = await extractor.extract("https://x.com/post/1");
    expect(result.markdown).toBe("");
    expect(result.needsBrowser).toBe(true);
  });

  it("returns needsBrowser=true on empty stdout", async () => {
    const extractor = createBrowserExtractor({
      exec: execOk(""),
      profileExists: () => true,
    });
    const result = await extractor.extract("https://x.com/post/1");
    expect(result.markdown).toBe("");
    expect(result.needsBrowser).toBe(true);
  });
});

describe("browser extractor: login wall detection", () => {
  it("flags a login wall as a block so the caller can open the breaker", async () => {
    const extractor = createBrowserExtractor({
      exec: execOk("Sign in to continue to see this post"),
      profileExists: () => true,
    });
    const result = await extractor.extract("https://x.com/post/1");
    expect(result.needsBrowser).toBe(true);
    expect(result.markdown).toBe("");
    expect(result.meta?.["blocked"]).toBe(true);
    expect(result.meta?.["reason"]).toBe("login_wall");
  });

  it("flags an empty page as a block", async () => {
    const extractor = createBrowserExtractor({
      exec: execOk("   "),
      profileExists: () => true,
    });
    const result = await extractor.extract("https://x.com/post/2");
    expect(result.needsBrowser).toBe(true);
    expect(result.meta?.["emptyPage"]).toBe(true);
  });
});

describe("browser extractor: human pacing", () => {
  it("waits the dwell time and scrolls before reading, in order", async () => {
    const events: string[] = [];
    let scrolls: number[] = [];
    const exec: ExecLike = async (_file, args) => {
      events.push(args.includes("open") ? "open" : "read");
      return { code: 0, stdout: "# page\n\ncontent", stderr: "" };
    };
    const extractor = createBrowserExtractor({
      exec,
      profileExists: () => true,
      dwellMs: 20_000,
      scrollPx: 350,
      sleep: async (ms) => {
        events.push(`dwell:${ms}`);
      },
      scroll: async (px) => {
        scrolls.push(px);
        events.push("scroll");
      },
    });
    const result = await extractor.extract("https://x.com/post/3");
    expect(result.markdown).toBe("# page\n\ncontent");
    expect(events).toEqual(["open", "dwell:20000", "scroll", "read"]);
    expect(scrolls).toEqual([350]);
  });

  it("does not sleep or scroll when the functions are not injected", async () => {
    const calls: string[][] = [];
    const exec: ExecLike = async (_file, args) => {
      calls.push(args);
      return { code: 0, stdout: "content", stderr: "" };
    };
    const extractor = createBrowserExtractor({ exec, profileExists: () => true });
    await extractor.extract("https://x.com/post/4");
    expect(calls).toHaveLength(2);
  });

  it("does not dwell when the profile is missing", async () => {
    let slept = false;
    const extractor = createBrowserExtractor({
      exec: execOk("unreachable"),
      profileExists: () => false,
      sleep: async () => {
        slept = true;
      },
      scroll: async () => {
        slept = true;
      },
    });
    const result = await extractor.extract("https://x.com/post/5");
    expect(result.meta?.["missingProfile"]).toBe(true);
    expect(slept).toBe(false);
  });
});
