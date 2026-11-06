# @linkinbox/extractors

Content extraction for linkinbox: rule-based router over five extractor
implementations sharing one `Extractor` interface. No LLM calls, no
dependency on other workspace packages.

## Interface

```ts
interface Extractor {
  readonly name: string;
  extract(url: string): Promise<{
    markdown: string;            // empty string signals no content
    title?: string;
    meta?: Record<string, unknown>;
    needsBrowser?: boolean;      // true = a real browser session is required
  }>;
}
```

Every extractor is total: it never throws. Failures surface as
`needsBrowser: true` with empty markdown so the pipeline can flag the link.

## Extractors

| File | Role |
|---|---|
| `defuddle.ts` | Primary. defuddle 0.19.x over linkedom, turndown for markdown. |
| `readability.ts` | Fallback. @mozilla/readability + turndown over linkedom. |
| `browser.ts` | `agent-browser --profile ~/.linkinbox/profiles/<host> read <url>` subprocess. Returns `needsBrowser: true` when the profile is missing or the command fails. Args array only, never a shell string. `executablePath` adds `--executable-path`. |
| `patchright.ts` | Stealth engine (Patchright, a patched Playwright fork) behind the same contract: a persistent context per host at `<profilesDir>/<host>/patchright`. Wired into the router through the injected host policy (`stealth`), selected by `[browser] stealth_hosts` or `engine = "patchright"`. Optional dynamic import: the package builds and the tests pass without it. See `docs/stealth.md`. |
| `ytdlp.ts` | `yt-dlp --write-auto-sub --skip-download --write-info-json`. Prefers the auto-generated transcript, falls back to the description. |
| `pdf.ts` | PDF text extraction via pdfjs-dist over the injected fetch. |

## Router

`routeFor(url)` implements the spec table:

| Condition | Extractor |
|---|---|
| `.pdf` path | `pdf` |
| youtube.com / youtu.be / other video hosts | `ytdlp` |
| x.com, twitter.com, instagram.com, linkedin.com | `browser` |
| host the injected policy marks `browser: true, stealth: true` | `patchright` |
| default | `defuddle` |

Low-yield fallback chain (default route only): `defuddle -> readability ->
browser`. The yield threshold is `minChars` (default 200, configurable via
`createRouter({ minChars })`).

Network fetch (`fetch`) and subprocess execution (`exec`) are injectable on
every extractor, so tests run fully offline.

## Tests

`pnpm test` runs vitest against golden fixtures in
`fixtures/extractors/<slug>/` (saved HTML + `expected.md` + `meta.json` with
char-count ranges and must-not-contain nav-leak phrases). Regenerate golden
files with `node scripts/gen-expected.mjs --write` after editing fixture HTML.
