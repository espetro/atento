# @linkinbox/cli

The `linkinbox` command line interface. Thin by design: every command
resolves its dependencies from a context and then calls a core ops or
pipeline function. No business logic lives here.

## Commands

```
linkinbox import <file...>          import links (markdown, json, url list, safari reading list)
linkinbox extract [--limit N]       extract content for inbox links that lack it
linkinbox enrich [--limit N]        one structured-output call per link lacking enrichment
linkinbox run [files...]             ingest+extract+enrich in one pass (idempotent)
linkinbox list [--status X] [--state X] [--category X] [--stale] [--json] [--fields a,b]
linkinbox overview [--json]         every link by pipeline state and host
linkinbox show <id> [--json]        the full record incl. extracted markdown
linkinbox triage <id> --action read_now|schedule|archive|discard
linkinbox triage --batch --filter 'status:inbox category:job' --action archive
linkinbox sweep [--apply]           dry-run proposal of expired items, grouped by category
linkinbox prune [--apply]           hard-delete past delete_after_days (confirmation prompt)
linkinbox login <host>              agent-browser headed login, profile saved for reuse
linkinbox login list                saved browser profiles
linkinbox login clear <host>        delete a saved profile
linkinbox metrics [--last 7d]       per-stage counts, durations, tokens, cost
linkinbox eval                      run the golden-set evals
linkinbox serve                     serve the web ui (needs @linkinbox/server)
```

## Config

`~/.linkinbox/config.toml`:

```toml
[db]
path = "~/.linkinbox/links.db"

[ttl]
default_days = 30
by_category = { job = 45, event = 7 }
archive_after_days = 90
delete_after_days = 365
```

Environment overrides:

| Variable | Meaning |
|---|---|
| `LINKINBOX_DB` | database file path |
| `LINKINBOX_CONFIG_DIR` | config directory (default `~/.linkinbox`) |
| `LINKINBOX_LOG_FILE` | log file path (default `~/.linkinbox/log.jsonl`) |
| `OPENAI_COMPAT_BASE_URL`, `OPENAI_COMPAT_API_KEY`, `LINKINBOX_MODEL` | model access, read by `@linkinbox/enrich` |

## Logging

LogTape writes JSON lines to the log file (one JSON object per line, one line
per pipeline step per link) and human readable lines to stderr. Command
output stays on stdout so `--json` is machine readable.

## Tests

- `test/set-d-sweep-prune.test.ts`: test set D (sweep/prune over seeded sqlite)
- `test/set-g-run.test.ts`: test set G (full run over the fixture corpus)
- `test/commands.test.ts`, `test/program.test.ts`: command and program level
- `test/enrich-fn.test.ts`: the seam with `@linkinbox/enrich`
