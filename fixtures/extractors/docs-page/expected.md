## Configuration

LinkInbox reads a single TOML file at `~/.atento/config.toml`. Every value has a working default, so the file is optional until you want to change behaviour.

## TTL section

The `ttl` section controls how long content stays fresh before it is proposed for archiving.

```
[ttl]
default_days = 30
archive_after_days = 90
delete_after_days = 365

[ttl.by_category]
job = 45
event = 7
guide = 90
```

Category-specific values override `default_days`. Anything not listed falls back to the default.

## Extractor section

The `extractors` section names the binaries used for browser-backed and video extraction.

```
[extractors]
browser_command = "agent-browser"
ytdlp_command = "yt-dlp"
```

## Enrichment section

Enrichment calls one structured-output endpoint. The provider is selected by environment variable so no provider name is hardcoded.

```
[enrich]
model = "bifrost/structured"
base_url = "${ENRICH_BASE_URL}"
```

Session state is read from the browser profile, never from the config file.

## Notes

*   Precedence is section key, then environment variable, then default.
*   Relative paths in the config file resolve against the config file directory.
*   Restart is not required; config is re-read on each run.
