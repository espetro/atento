import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanBrowserMarkdown } from "../src/clean.js";

const FIXTURES = join(__dirname, "fixtures");

function fixture(name: string): string {
  return readFileSync(join(FIXTURES, name), "utf8");
}

describe("cleanBrowserMarkdown", () => {
  it("strips x.com keyboard-shortcut boilerplate and sidebars", () => {
    const out = cleanBrowserMarkdown(
      "https://x.com/search?q=claude&src=typed_query",
      fixture("x.md"),
    );
    expect(out).not.toContain("To view keyboard shortcuts");
    expect(out).not.toContain("View keyboard shortcuts");
    expect(out).not.toContain("Search filters");
    expect(out).not.toContain("Who to follow");
    expect(out).not.toContain("© 2026 X Corp.");
    expect(out).toContain("# Search timeline");
    expect(out).toContain("Malte Ubl");
    expect(out).toContain("@cramforce");
    expect(out).toContain("Lightpanda");
  });

  it("strips linkedin viewer chrome and footer, keeps the post", () => {
    const out = cleanBrowserMarkdown(
      "https://www.linkedin.com/feed/update/urn:li:activity:123/",
      fixture("linkedin.md"),
    );
    expect(out).not.toContain("Viewer Name");
    expect(out).not.toContain("Activate Premium for $0");
    expect(out).not.toContain("Skip to search");
    expect(out).not.toContain("Ad Options");
    expect(out).not.toContain("LinkedIn Corporation © 2026");
    expect(out).toContain("## Feed post");
    expect(out).toContain("Giulia de Oliveira Camargo");
    expect(out).toContain("1mo");
    expect(out).toContain("The homepage is dying.");
    expect(out).toContain("Supersonik");
  });

  it("strips instagram nav, footer and language list, keeps the caption", () => {
    const out = cleanBrowserMarkdown(
      "https://www.instagram.com/reel/DJExample/",
      fixture("instagram.md"),
    );
    expect(out).not.toContain("Notifications");
    expect(out).not.toContain("Also from Meta");
    expect(out).not.toContain("Privacy");
    expect(out).not.toContain("Afrikaans");
    expect(out).not.toContain("© 2026 Instagram from Meta");
    expect(out).not.toContain("## Caption");
    expect(out).toContain("designerhandle");
    expect(out).toContain("#earlycyber");
    expect(out).toContain("143");
    expect(out).toContain("October 9");
  });

  it("passes unknown hosts through unchanged", () => {
    const input = "# Title\n\nSome body\n";
    expect(cleanBrowserMarkdown("https://example.com/post", input)).toBe(input);
    expect(cleanBrowserMarkdown("not a url", input)).toBe(input);
  });

  it("passes through when a site anchor is missing", () => {
    const linkedin = "## Feed post\n\nNothing to trim here.\n";
    expect(
      cleanBrowserMarkdown("https://www.linkedin.com/feed/update/urn:li:activity:1/", linkedin),
    ).toBe(linkedin);

    const x = "# Just a heading\n\nBody only.\n";
    expect(cleanBrowserMarkdown("https://x.com/home", x)).toBe(x);

    const ig = "Some caption text\n";
    expect(cleanBrowserMarkdown("https://www.instagram.com/p/abc/", ig)).toBe(ig);
  });

  it("never returns empty output for non-empty input", () => {
    for (const [url, name] of [
      ["https://x.com/home", "x.md"],
      ["https://www.linkedin.com/feed/", "linkedin.md"],
      ["https://www.instagram.com/p/abc/", "instagram.md"],
    ] as const) {
      const out = cleanBrowserMarkdown(url, fixture(name));
      expect(out.trim().length).toBeGreaterThan(0);
    }
  });
});
