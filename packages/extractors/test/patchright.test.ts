/**
 * Patchright extractor tests: fakes only, no Patchright install needed and
 * no network. The launcher, the sleep and the scroll are all injected.
 */
import { describe, expect, it, vi } from "vitest";
import {
  createPatchrightExtractor,
  htmlToMarkdown,
  patchrightProfileDir,
  textToMarkdown,
  type PatchrightContext,
  type PatchrightLaunch,
  type PatchrightPage,
} from "../src/patchright.js";

function fakePage(html: string, text: string): PatchrightPage {
  return {
    goto: async () => undefined,
    content: async () => html,
    evaluate: async () => text,
  };
}

function fakeContext(page: PatchrightPage, log: string[]): PatchrightContext {
  return {
    pages: () => [],
    newPage: async () => {
      log.push("newPage");
      return page;
    },
    close: async () => {
      log.push("close");
    },
  };
}

const launchCalls: { dir: string; headless: boolean; executablePath?: string }[] = [];

function fakeLaunch(page: PatchrightPage, log: string[]): PatchrightLaunch {
  return async (dir, options) => {
    launchCalls.push({ dir, headless: options.headless, executablePath: options.executablePath });
    log.push("launch");
    return fakeContext(page, log);
  };
}

const noProfile = () => false;
const yesProfile = () => true;
const noSleep = async () => undefined;

describe("patchrightProfileDir", () => {
  it("nests the patchright profile under the host dir", () => {
    expect(patchrightProfileDir("https://app.devin.ai/x")).toBe(
      patchrightProfileDir("https://app.devin.ai/x").replace(/patchright$/, "patchright"),
    );
    expect(patchrightProfileDir("https://app.devin.ai/x").endsWith("app.devin.ai/patchright")).toBe(
      true,
    );
  });

  it("honours the profiles dir override", () => {
    expect(patchrightProfileDir("https://chat.z.ai/", "/tmp/profiles")).toBe(
      "/tmp/profiles/chat.z.ai/patchright",
    );
  });
});

describe("textToMarkdown", () => {
  it("keeps heading lines as headings", () => {
    expect(textToMarkdown("# Title\n\nbody")).toBe("# Title\n\nbody");
  });

  it("collapses triple blank lines", () => {
    expect(textToMarkdown("a\n\n\n\nb")).toBe("a\n\nb");
  });
});

describe("htmlToMarkdown", () => {
  it("converts simple html", async () => {
    const md = await htmlToMarkdown("<h1>Hi</h1><p>Some body text</p>");
    expect(md).toContain("# Hi");
    expect(md).toContain("Some body text");
  });

  it("returns empty for empty input", async () => {
    expect(await htmlToMarkdown("")).toBe("");
  });
});

describe("createPatchrightExtractor", () => {
  it("is named patchright", () => {
    const extractor = createPatchrightExtractor({ profileExists: yesProfile, launch: fakeLaunch(fakePage("<p>x</p>", ""), []), sleep: noSleep });
    expect(extractor.name).toBe("patchright");
  });

  it("reports a missing profile without launching", async () => {
    let launched = 0;
    const extractor = createPatchrightExtractor({
      profileExists: noProfile,
      launch: async () => {
        launched += 1;
        throw new Error("must not launch");
      },
      sleep: noSleep,
    });
    const result = await extractor.extract("https://app.devin.ai/thread");
    expect(launched).toBe(0);
    expect(result.needsBrowser).toBe(true);
    expect(result.meta?.["missingProfile"]).toBe(true);
  });

  it("reads the page, dwells, converts to markdown and closes the context", async () => {
    const log: string[] = [];
    const extractor = createPatchrightExtractor({
      profileExists: yesProfile,
      launch: fakeLaunch(fakePage("<h1>Devin</h1><p>Session body</p>", ""), log),
      sleep: async (ms) => {
        log.push(`sleep:${ms}`);
      },
      scroll: async (px) => {
        log.push(`scroll:${px}`);
      },
      profilesDir: "/tmp/profiles",
    });
    const result = await extractor.extract("https://app.devin.ai/thread");
    expect(log[0]).toBe("launch");
    expect(log).toContain("sleep:20000");
    expect(log).toContain("scroll:420");
    expect(log[log.length - 1]).toBe("close");
    expect(result.markdown).toContain("# Devin");
    expect(result.markdown).toContain("Session body");
    expect(result.needsBrowser).toBeUndefined();
    expect(result.meta?.["engine"]).toBe("patchright");
    expect(launchCalls[0]?.dir).toBe("/tmp/profiles/app.devin.ai/patchright");
    expect(launchCalls[0]?.headless).toBe(true);
  });

  it("falls back to innerText when turndown yields nothing", async () => {
    const extractor = createPatchrightExtractor({
      profileExists: yesProfile,
      launch: fakeLaunch(fakePage("", "## Heading\n\nplain text"), []),
      sleep: noSleep,
      profilesDir: "/tmp/profiles",
    });
    const result = await extractor.extract("https://chat.z.ai/c/1");
    expect(result.markdown).toContain("## Heading");
    expect(result.markdown).toContain("plain text");
  });

  it("flags a login wall instead of returning its text", async () => {
    const extractor = createPatchrightExtractor({
      profileExists: yesProfile,
      launch: fakeLaunch(fakePage("<p>Please log in to continue</p>", ""), []),
      sleep: noSleep,
      profilesDir: "/tmp/profiles",
    });
    const result = await extractor.extract("https://beta.usebrioso.com/app");
    expect(result.markdown).toBe("");
    expect(result.needsBrowser).toBe(true);
    expect(result.meta?.["blocked"]).toBe(true);
    expect(result.meta?.["reason"]).toBe("login_wall");
  });

  it("never throws when the launch fails", async () => {
    const extractor = createPatchrightExtractor({
      profileExists: yesProfile,
      launch: async () => {
        throw new Error("Executable doesn't exist");
      },
      sleep: noSleep,
      profilesDir: "/tmp/profiles",
    });
    const result = await extractor.extract("https://www.figma.com/file/x");
    expect(result.needsBrowser).toBe(true);
    expect(result.meta?.["failed"]).toBe(true);
    expect(String(result.meta?.["error"])).toContain("Executable doesn't exist");
  });

  it("closes the context even when the navigation fails", async () => {
    const log: string[] = [];
    const badPage: PatchrightPage = {
      goto: async () => {
        throw new Error("net::ERR_CONNECTION_REFUSED");
      },
      content: async () => "",
      evaluate: async () => "",
    };
    const extractor = createPatchrightExtractor({
      profileExists: yesProfile,
      launch: fakeLaunch(badPage, log),
      sleep: noSleep,
      profilesDir: "/tmp/profiles",
    });
    const result = await extractor.extract("https://docs.google.com/doc");
    expect(log).toContain("close");
    expect(result.needsBrowser).toBe(true);
    expect(result.meta?.["failed"]).toBe(true);
  });

  it("passes the configured executable path to the launcher", async () => {
    launchCalls.length = 0;
    const extractor = createPatchrightExtractor({
      profileExists: yesProfile,
      launch: fakeLaunch(fakePage("<p>x</p>", ""), []),
      sleep: noSleep,
      executablePath: "/Applications/BrowserOS.app/Contents/MacOS/browseros",
      profilesDir: "/tmp/profiles",
    });
    await extractor.extract("https://app.devin.ai/x");
    expect(launchCalls[0]?.executablePath).toBe("/Applications/BrowserOS.app/Contents/MacOS/browseros");
  });

  it("opens a headed context when headless is false", async () => {
    launchCalls.length = 0;
    const extractor = createPatchrightExtractor({
      profileExists: yesProfile,
      launch: fakeLaunch(fakePage("<p>x</p>", ""), []),
      sleep: noSleep,
      headless: false,
      profilesDir: "/tmp/profiles",
    });
    await extractor.extract("https://app.devin.ai/x");
    expect(launchCalls[0]?.headless).toBe(false);
  });
});

describe("defaultPatchrightLaunch fingerprint", () => {
  it("uses the Chrome channel first and falls back to the bundled Chromium", async () => {
    const calls: { userDataDir: string; options: Record<string, unknown> }[] = [];
    const context: PatchrightContext = {
      pages: () => [],
      newPage: async () => fakePage("<p>x</p>", ""),
      close: async () => undefined,
    };
    const launchPersistentContext = async (dir: string, options: Record<string, unknown>) => {
      calls.push({ userDataDir: dir, options });
      if (options.channel === "chrome") throw new Error("chrome not installed");
      return context;
    };
    vi.doMock("patchright", () => ({ chromium: { launchPersistentContext } }));
    vi.resetModules();
    const { defaultPatchrightLaunch } = await import("../src/patchright.js");
    const ctx = await defaultPatchrightLaunch("/tmp/p", { headless: true });
    expect(ctx).toBe(context);
    expect(calls.length).toBe(2);
    // First: the installed Chrome (no HeadlessChrome token in the UA).
    expect(calls[0]!.options.channel).toBe("chrome");
    // Fallback: the bundled Chromium, no channel and no explicit binary.
    expect(calls[1]!.options.channel).toBeUndefined();
    expect(calls[1]!.options.executablePath).toBeUndefined();
    vi.doUnmock("patchright");
    vi.resetModules();
  });

  it("does not use the Chrome channel when an executable path is configured", async () => {
    const calls: { userDataDir: string; options: Record<string, unknown> }[] = [];
    const context: PatchrightContext = {
      pages: () => [],
      newPage: async () => fakePage("<p>x</p>", ""),
      close: async () => undefined,
    };
    const launchPersistentContext = async (dir: string, options: Record<string, unknown>) => {
      calls.push({ userDataDir: dir, options });
      return context;
    };
    vi.doMock("patchright", () => ({ chromium: { launchPersistentContext } }));
    vi.resetModules();
    const { defaultPatchrightLaunch } = await import("../src/patchright.js");
    await defaultPatchrightLaunch("/tmp/p", {
      headless: true,
      executablePath: "/Applications/BrowserOS.app/Contents/MacOS/browseros",
    });
    expect(calls.length).toBe(1);
    expect(calls[0]!.options.channel).toBeUndefined();
    expect(calls[0]!.options.executablePath).toBe(
      "/Applications/BrowserOS.app/Contents/MacOS/browseros",
    );
    vi.doUnmock("patchright");
    vi.resetModules();
  });
});
