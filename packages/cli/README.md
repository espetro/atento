# @atento/cli

The `atento` command line interface. Thin by design: every command
resolves its dependencies from a context and then calls a core ops or
pipeline function. No business logic lives here.

## Commands

```
atento import <file...>          import links (markdown, json, url list, safari reading list)
atento extract [--limit N]       extract content for inbox links that lack it
atento enrich [--limit N]        one structured-output call per link lacking enrichment
atento run [files...]             ingest+extract+enrich in one pass (idempotent)
atento list [--status X] [--state X] [--category X] [--stale] [--json] [--fields a,b]
atento overview [--json]         every link by pipeline state and host
atento show <id> [--json]        the full record incl. extracted markdown
atento triage <id> --action read_now|schedule|archive|discard
atento triage --batch --filter 'status:inbox category:job' --action archive
atento sweep [--apply]           dry-run proposal of expired items, grouped by category
atento prune [--apply]           hard-delete past delete_after_days (confirmation prompt)
atento login <host>              headed browser login with the host's engine, profile saved for reuse
atento login list                saved browser profiles
atento login clear <host>        delete a saved profile
atento metrics [--last 7d]       per-stage counts, durations, tokens, cost
atento eval                      run the golden-set evals
atento serve                     serve the web ui (needs @atento/server)
```

## Config

`~/.atento/config.toml`:

```toml
[db]
path = "~/.atento/links.db"

[ttl]
default_days = 30
by_category = { job = 45, event = 7 }
archive_after_days = 90
delete_after_days = 365

[browser]
# Which browser engine a host extracts (and logs in) with.
engine = "agent-browser"              # or "patchright"
# Hosts that always use the stealth engine.
stealth_hosts = ["app.devin.ai", "*.usebrioso.com"]
# Chromium binary for either engine.
executable_path = "/Applications/BrowserOS.app/Contents/MacOS/browseros"
```

The `[browser]` table and the stealth engine are documented in
`docs/stealth.md`.

Environment overrides:

| Variable | Meaning |
|---|---|
| `ATENTO_DB` | database file path |
| `ATENTO_CONFIG_DIR` | config directory (default `~/.atento`) |
| `ATENTO_LOG_FILE` | log file path (default `~/.atento/log.jsonl`) |
| `OPENAI_COMPAT_BASE_URL`, `OPENAI_COMPAT_API_KEY`, `ATENTO_MODEL` | model access, read by `@atento/enrich` |

## Logging

LogTape writes JSON lines to the log file (one JSON object per line, one line
per pipeline step per link) and human readable lines to stderr. Command
output stays on stdout so `--json` is machine readable.

## Tests

- `test/set-d-sweep-prune.test.ts`: test set D (sweep/prune over seeded sqlite)
- `test/set-g-run.test.ts`: test set G (full run over the fixture corpus)
- `test/commands.test.ts`, `test/program.test.ts`: command and program level
- `test/enrich-fn.test.ts`: the seam with `@atento/enrich`
