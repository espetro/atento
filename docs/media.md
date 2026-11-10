# Media stage

The media stage turns video and audio links (reels and similar yt-dlp-able
media) into text. It is a standalone library (`@atento/media`) plus a CLI
command, and the pipeline now calls it: after a successful extraction the
extract stage detects video links and runs the media stage, appending
`renderMedia(report)` to the extracted content before the link moves to
enrich. It does not change the FSM or the extractor router.

## Tiers

Every tier is tracked and reported per link. The report shows what worked, what
was empty, and what is not built yet.

| Tier | What it does | Status |
| --- | --- | --- |
| `caption` | Caption, hashtags, author, audio track name, like/comment/view counts from metadata already extracted for the link. Nothing is fetched. | Works |
| `transcript` | Downloads the audio with yt-dlp, converts it to 16 kHz mono wav with ffmpeg, transcribes locally with audio.cpp (audiocpp_cli), deletes the media and keeps only the text. | Works |
| `frames` | On-screen text (OCR) and a visual description of N keyframes. | Not implemented |

The frames tier exists in the code, the types and every report with status
`unsupported` and reason `frame analysis not implemented`, so the gap is
visible in `atento media` output, in the JSON result and here.

Planned frames interface: `ffmpeg -i input.mp4 -vf "fps=1/30" -frames:v N
frame-%02d.jpg`, then the frames go to a local vision provider (one call, OCR
plus a short visual description). A `VisionFn` port would live in
`packages/enrich` next to the ASR port, the same way: the media package stays
model-free.

### Per-tier statuses

`ok` (the tier produced content), `empty` (nothing to report), `failed` (error
string in the report), `unsupported` (not implemented yet), `skipped` (budget
exhausted or the media is over the configured duration limit).

## CLI

```
atento media <id|url> [--tiers caption,transcript,frames] [--json]
```

The link must already be in the store (by numeric id or URL); the caption tier
uses its stored extracted content. Output is a per-tier table: tier, status,
seconds, chars, reason. `--json` emits the full report.

```
$ atento media 42
tier        status  seconds  chars  reason
---------   ------  -------  -----  ------
caption     ok      0.00     54
transcript  ok      9.87     88
frames      unsupported  0.00  0  frame analysis not implemented
```

## Config

Add a `[media]` section to `~/.atento/config.toml`:

```toml
[media]
enabled_tiers = ["caption", "transcript"]
daily_cap = 20
max_duration_seconds = 600
cookies_from_browser = false

[media.daily_caps]
transcript = 10
```

- `enabled_tiers`: tiers the stage runs when `--tiers` is not given. Frames is
  not in the default because it is not implemented.
- `daily_cap`: media runs per day, all tiers together.
- `daily_caps`: per-tier overrides.
- `max_duration_seconds`: the transcript tier skips media longer than this.
- `cookies_from_browser`: pass browser cookies to yt-dlp. Off by default.

The transcript download is routed through the same host guard as every other
fetch, so a walled garden (x.com, instagram.com, linkedin.com) uses its strict
spacing (45 s +/- 30 percent, 40/day, concurrency 1) and shares the breaker.

## ASR setup

The transcript tier uses audio.cpp (`audiocpp_cli`) running fully local on
Metal. Install an ASR model package with its package manager:

```
audiocpp_model_manager install parakeet_tdt_q8_0    # Parakeet-TDT 0.6B v3, ~874 MB gguf
audiocpp_model_manager install nemotron_asr_q8_0    # alternative
```

The provider is configured entirely through environment variables, so no
provider or model is hardcoded:

| Env var | Default | Meaning |
| --- | --- | --- |
| `ATENTO_ASR_BIN` | `audiocpp_cli` | The CLI binary. |
| `ATENTO_ASR_FAMILY` | `parakeet_tdt` | Model family passed to `--family`. |
| `ATENTO_ASR_MODEL` | (none, required) | Model gguf file or package directory. |
| `ATENTO_ASR_BACKEND` | `metal` | Compute backend. |

Example:

```
export ATENTO_ASR_MODEL=~/.atento/models/parakeet-tdt-0.6b-v3-q8_0.gguf
atento media <id>
```

Note: a bare gguf from Hugging Face does not always load (audio.cpp wants a
config.json next to it); the packages installed by `audiocpp_model_manager`
include the right metadata.

Measured on this machine (M-series, Metal): a 5.9 s wav transcribes in about
0.2 s of model wall time, real-time factor 0.04 (roughly 25x faster than
realtime), peak RSS about 2.7 GB while the model is loaded.

## Architecture

- `packages/media`: orchestration only. Download (yt-dlp + ffmpeg), caption
  parsing, budget, report types (zod), `renderMedia` markdown renderer. No
  model code.
- `packages/enrich/src/asr`: the `AsrFn` port implementation (audiocpp
  adapter), env-configured. The port type itself lives in
  `packages/core/src/asr.ts`; `packages/media` depends only on the port.
- `packages/cli`: `atento media`, the `[media]` config wiring and the
  guard-routed `mediaFn` adapter.

`renderMedia(report)` is a pure function that renders the ok tiers as `##
Caption` and `## Transcript` markdown sections. The pipeline calls it: the
extract stage appends the rendered sections to the link's extracted content.

## Pipeline wiring

The extract stage runs the media stage for a link when its extracted metadata
or its URL marks it as video. Detection is metadata-driven and names no host:

- the extractor's own flag (`isVideo` in the extraction meta),
- `og:type` matching video or movie,
- `twitter:card` being a player or video card,
- a schema.org `VideoObject` marker in the page head,
- a URL path or query pattern that points at a media page or file
  (`/reel/`, `/watch`, `/videos/`, `/clip/`, `?v=`, a media file extension).

The stage is injected into the extract stage as a `MediaFn`, so core stays
free of download and transcription code. The CLI builds it from the router
metadata, the `[media]` config, the guard and the store.

A media failure never fails the link. The per-tier report is stored on the
link (`links.media_report`, migration `0007_media`), the extracted content is
kept, and the frames tier always surfaces as `unsupported`.

A captured link (its content came from the user's own session) skips the
download: only the caption tier runs, which fetches nothing.

## Per-day budget

The daily cap is store-backed: the counters live in the `media_budget` table
(one row per UTC day), so the cap survives restarts and is shared by every
process on the same database. The media package still ships an in-memory
budget for a single CLI invocation.

## What works and what does not

Works:

- video detection from the extraction metadata and the URL,
- the media stage inside the extract stage, with the report on the link and
  the rendered markdown appended to the extracted content,
- the per-tier report in `atento show <id>` and in `atento media`,
- the store-backed per-day cap,
- the guard-routed download (strict pacing for walled hosts).

Does not work yet:

- the frames tier (OCR and visual description of keyframes): always
  `unsupported`,
- the duration limit is only applied when the duration is known before the
  download, so a long video is downloaded and then skipped,
- the media stage does not run for links whose extraction needed a browser
  (the link is parked in `needs_browser` first),
- no MCP tool exposes the media report yet.
