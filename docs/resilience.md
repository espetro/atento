# Resilience

The pipeline is resilient to peak load and upstream errors: every fetch is
rate limited per host, protected by a circuit breaker, and retried with
backoff. Nothing crashes, nothing hammers an upstream, and nothing is silently
skipped. Deferral is a link FSM state (`deferred` with `nextAttemptAt`,
`attempts`, `reason`), never a column on `links`.

## Components (packages/core/src/resilience)

All primitives are pure: clock and random are injected, so tests run on a
fake clock and never really sleep.

### retry

Exponential backoff with full jitter. The delay for attempt n is uniform in
`[0, min(maxDelayMs, baseDelayMs * factor^(n-1))]`.

Defaults: `maxAttempts: 3`, `baseDelayMs: 1000`, `maxDelayMs: 60000`,
`factor: 2`.

Classifier rules:

| Signal | Retryable | Block |
|---|---|---|
| network errors (ECONNRESET, ENOTFOUND, timeouts, "fetch failed") | yes | no |
| 408, 425, 5xx | yes | no |
| 429 | yes | yes |
| 403, 999 | no | yes |
| 401, 404 and other fatal 4xx | no | no |
| captcha / login wall / "unusual activity" text | no | yes |

A block signal ends the retry loop immediately: the breaker owns the wait.
`Retry-After` (seconds or HTTP date) overrides the computed backoff.

### circuit breaker

Per key (host, or the reserved key `llm` for the enrichment gateway). States:
closed, open, half_open. The breaker opens after 3 consecutive failures or on
any hard block signal (429/403/999, captcha, login wall, "unusual activity",
empty page behind a login).

Cooldown grows exponentially per re-open: flagged (walled-garden) hosts start
at 6 hours and double up to a 48 hour cap; the llm breaker starts at 30
seconds and doubles up to 10 minutes; other hosts start at 60 seconds up to
30 minutes. Half-open admits exactly one probe. A successful probe closes the
breaker and resets the level; a failed probe reopens one level deeper.

### rate limiter

Per-host token bucket plus minimum spacing plus a daily cap. Spacing applies
a jitter of plus or minus 30 percent around the configured interval.

Defaults:

| Host class | Interval | Daily cap | Concurrency |
|---|---|---|---|
| flagged hosts (canary refused, login gated, a saved browser profile, or listed in `walled_gardens`) | 45s | 40 | 1 |
| ordinary hosts | 2s | unlimited | 4 |
| llm | none | unlimited | 3 |

Global in-flight cap: 8. Max links per extract/enrich call (`max_batch`): 20.

Upstream pacing signals extend the host spacing: `Retry-After` (seconds or an
HTTP date), `X-RateLimit-Reset` (unix timestamp or delta, in seconds) and
`X-RateLimit-Remaining: 0` (falls back to the host spacing) set
`host_state.rate_limited_until`; the gate defers requests until it elapses.
The strongest signal wins.

## Pacing (human-like timing for strict hosts)

A strict host (flagged by the canary, login gated, a saved browser profile,
or listed in `walled_gardens`) is not touched with a metronome: a fixed 45
second spacing is machine-shaped and the behaviour that gets an account
flagged. The strict policy uses the `humanPacing` module
(packages/core/src/resilience/human-pacing.ts) instead:

- **Dwell time per page**: log-normal around `dwell_median_s` (default 20),
  capped at `dwell_max_s` (default 90). The browser extractor waits the
  sampled dwell after the page loads and scrolls a small human-like distance
  before reading; both are injected functions, so tests never sleep.
- **Jittered spacing**: consecutive requests are log-normal around the same
  median, times (1 +/- 30 percent). Ordinary open hosts keep the fixed 2s
  token-bucket spacing; nothing changes for them.
- **Occasional longer breaks**: after every 5 to 12 pages (drawn per cycle)
  the host takes a 2 to 6 minute break. The page counter and the drawn cycle
  length persist in `host_state` (`pages_since_break`, `break_every`), so the
  cadence survives restarts.
- **Per-host daily cap**: `daily_cap` (default 40) paced requests per rolling
  calendar day, mirroring the limiter's window. On rollover the budget resets.
- **Working-hours window**: `hours_start` to `hours_end` in LOCAL time
  (default 08:00 to 23:00; overnight windows like 22 to 6 are supported).
  Outside the window the link is deferred with the reason `outside_hours` and
  a `nextAttemptAt` exactly when the window opens. `hours_start = 0` with
  `hours_end = 24` (or `hours_start = hours_end`) means always open.

No host names are hardcoded anywhere: the pacing profile applies to whatever
host `hostPolicy` marks strict, decided by the same shared verdict the router
and the limiter already use.

The gate order in `pacingGate` is: working hours, daily cap, long break,
jittered spacing. Every deferral carries the reason and the wait, so the
pipeline turns it into the usual DEFER event with `nextAttemptAt`.

## Canary probing (no hardcoded walled gardens)

There is no hardcoded list of walled gardens. Rate-limited hosts are
discovered by trial: for each host the FIRST link is the canary. It is
processed alone.

- Canary succeeds: the host is marked `open` (persisted) and the remaining
  links of that host proceed under the ordinary limits.
- Canary is rate limited or blocked (HTTP 429, a 403 challenge, LinkedIn 999,
  a login wall, a breaker trip): the host is marked `flagged`, the strict
  walled-garden limits apply, and the remaining links of that host are
  deferred (state `deferred`, reason `canary_flagged:<signal>`) without
  another request.

The trial state (`trial_state`, `trial_reason`, `trial_at`, `login_gated`)
lives in the `host_state` table (migration `0004_canary_trial`), so it
survives restarts. A flag expires after 24 hours, or with the breaker reopen
time if that is later, and the host is re-trialed on the next link.

`hostPolicy` in packages/core (src/resilience/limiter.ts) is the single
source of truth for a host's policy: skip-listed, strict (browser + limits)
or ordinary. The router receives the same decision injected from the
pipeline, so routing and pacing always agree.

## Login walls

After an extractor returns content, the pipeline treats the page as a login
wall (state `needs_browser`, reason `login_wall`) when the final URL path
matches `/login|signin|sign-in|auth|accounts/`, when the page has a password
input form and little article text, or when the HTTP status is 401/403 on a
host without a saved profile. The host is recorded as login gated and listed
by `listHostsNeedingLogin(store)` for the `login` command.

A 404/410 only means "gone" for an ordinary open host. On a flagged host, a
host with a saved profile or a login-gated host, a 404 is a private page
answering an anonymous request: the link moves to `needs_browser` with the
reason `private_404` (or `private_410`) instead of `errored`.

## Automatic escalation

Before a bot block or a login wall parks a link, the extract-fn adapter
(`packages/cli/src/extract-fn.ts`) retries the URL once through the stealth
engine (patchright), with no user input. The trigger is the first, non-stealth
attempt returning a bot-block page (Cloudflare or captcha markers in the
content, an HTTP 403 or 429) or a login wall; the whole attempt chain is
scanned, because the router's fallback from the static route to the browser
route can hide the challenge page the static route saw.

The retry is not free of the pacing rules: it runs after the normal pacing
gate for that host (the walled-garden human pacing profile for strict hosts,
the host's spacing wait otherwise), so a block never buys a second,
unthrottled fetch. It also never loops: the stealth route itself never
escalates again, at most one retry happens per extraction.

Outcomes:

- The retry succeeded: its content is returned as the result, tagged with
  `extractor: "patchright"`.
- The retry still shows a login wall: the login-wall outcome is returned and
  the pipeline parks the link as before (`needs_browser`, reason
  `login_wall`; run `linkinbox login <host>`).
- The retry is still blocked (captcha, another challenge): the blocked
  outcome is returned, the circuit breaker opens and the host is flagged.
- The stealth engine cannot run (patchright not installed, no browser, no
  profile): the original outcome is returned unchanged, silently.

## Host policy: skip, review only, login allow

Three host lists decide what the pipeline does with a host. All of them use
the same pattern syntax: an exact host (`revolut.com`) or a `*.suffix`
wildcard (`*.revolut.com`), matched against the hostname WITHOUT the port,
so `localhost` matches `http://localhost:3000/x`.

| List | Config | Effect |
|---|---|---|
| skip list | `[limits] skip_hosts` | The host is never fetched. The link is parked as `discarded` with the reason `skip_host`. |
| review list | `[limits] review_hosts` | The host is never fetched either, but the link stays visible: it is parked in `needs_browser` with the reason `review_only`, so the owner reviews it by hand. |
| login allow list | `[login] allow` | The hosts the pipeline may ever log in to. When it is set and non-empty, a login-walled host that is neither allowed nor backed by a saved profile is review-only: it is not listed as a pending login, no browser or profile is ever attempted for it, and its links stay visible in `needs_browser` with the reason `review_only`. |

When `[login] allow` is empty or absent, every login-walled host behaves as
before: it is listed as a pending login and the browser is opened for it. A
host with a saved profile always counts as allowed, whatever the allow list
says: the session exists already.

Loopback hosts are skipped by default, without any config entry: `localhost`,
`127.0.0.1`, `::1` and any `*.localhost` name. A pipeline run can never fetch
the user's own services, so the links are parked as `discarded` like any
other skip-listed host. This is a built-in rule in `hostPolicy`, not a
default entry in the skip list: the configured `skip_hosts` list still ships
empty.

### Reconciling parked links

The config changes over time, so the extract stage reconciles the already
parked links at the start of every run: a link parked for a host that is now
skip-listed moves to `discarded` (through the FSM: `RETRY` back to the queue,
then `TRIAGE` discard), and a link parked for a host that is now review-only
gets the reason `review_only`. The sweep is idempotent: running it twice
changes nothing. When it changed something it writes one `reconciled` metric
row with the `discarded` and `review_only` counts.

### The login walk

`linkinbox login --all` walks the pending-login hosts one by one and is what
a bare `linkinbox login` in a TTY offers too (answer `a` at the picker). For
each host it prints `n of m: <host> (<k> links)` in pending order (most
parked links first; review-only and skip-listed hosts are excluded exactly as
in the pending list), runs that host's engine login flow (agent-browser, or
patchright for the stealth hosts, chosen by the `[browser]` config), requeues
the host's parked links through the RETRY path, and continues to the next
host. At the prompt, Enter proceeds, `s` skips the host for the rest of the
run, and `q` stops the walk. One summary line is printed at the end, followed
by the remaining pending list. The launcher and the prompt are injected in
tests, so the walk itself never touches a browser or the network.

### The parked requeue backfill

`linkinbox requeue --parked [--host <host>]` is a backfill for parked links:
every `needs_browser` link (and every deferred link whose extract-stage
backoff is still pending) moves back to the `created` queue through the
existing RETRY event, so the next extract run's auto-escalation reprocesses
them with the stealth engine. Hosts the policy protects are skipped: the
skip list, the review list, loopback hosts and login-gated hosts the
`[login] allow` list does not cover. With `--host` the backfill is restricted
to one host. It prints one count per host and a total; it never fetches
anything itself.

### The pending login list

`linkinbox login` (and the MCP tool `login_pending`) lists the hosts that
still need a session. The list excludes the hosts the policy excludes on
purpose: skip-listed hosts, review-only hosts and login-gated hosts the
allow list does not cover. To make sure nothing is hidden, the report
carries a `reviewOnly` count of the parked links the pipeline will never
fetch, and the human rendering prints it under the table.

### bounded queue

`createBoundedQueue({ maxSize, concurrency })`: enqueue returns accepted or
deferred (`queue_full` / `queue_closed`). Drain runs at bounded concurrency.
No unbounded memory growth.

## Persistence

CLI processes are short lived, so limiter and breaker state live in the
`host_state` table (migrations 0003 to 0006, schema version 6):

```
key, last_request_at, window_start, window_count, consecutive_failures,
breaker_state, opened_until, cooldown_level, last_error,
trial_state, trial_reason, trial_at, login_gated, rate_limited_until,
pages_since_break, break_every
```

The limiter and breaker load and save through the Store (`getHostState`,
`saveHostState`, `listHostStates`), so budget is shared across CLI runs, the
server and MCP.

## Pipeline integration

The extract stage routes every fetch through limiter + breaker + retry per
host. A rate-limited or breaker-open link gets a DEFER event (nextAttemptAt
from the limiter or breaker, attempts incremented from the DEFER history);
it is never marked failed and never silently skipped. Only links whose
`deferred.nextAttemptAt` has passed are picked up, via a RETRY event. After
max attempts (default 5 DEFER rounds) the link moves to errored through the
FSM.

A hard block signal opens the breaker for the host and defers all remaining
links of that host in the batch.

The enrich stage retries 429/5xx with backoff, uses the llm breaker, and
defers the remaining links when the llm breaker is open.

The browser extractor always runs headless and only with the saved profile
for the host. On a login wall it opens the breaker and the CLI tells the user
to run `linkinbox login <host>`. The browser engine per host (agent-browser
or the patchright stealth engine) is chosen by the `[browser]` config; see
`docs/stealth.md`.

## Batch fairness and --until-empty

Without fairness, `extract` takes the first 20 `created` links by id. One host with many links fills every batch; most of its links get deferred by per-host spacing, so a loop of runs makes no progress and links from other hosts are never attempted.

Batch selection is now round-robin across hosts (`batch-select.ts`): hosts are ordered by their oldest `created` link, links within a host are oldest first, and each host contributes at most 3 links per batch (when several hosts compete; a single-host queue still uses the full batch). Hosts whose persisted `host_state` says they cannot make progress are skipped cheaply, before any fetch: a daily cap hit in the current window, an upstream `rateLimitedUntil` in the future, or an open breaker drops the host from the batch entirely. A host inside a spacing wait only gets a slot when no other host has a pending link, so busy hosts do not crowd out fresh ones.

`linkinbox extract --until-empty` repeats batches until no `created` link is eligible or an iteration makes no progress (every link deferred or skipped), stopping at 100 iterations. It prints one summary line per batch and a final per-state summary, and never sleeps more than the shortest retry-after seen; the CLI process itself never sleeps, so spacing waits are handled by re-running or by an external scheduler.

## Config

All values are overridable in `~/.linkinbox/config.toml`:

```toml
[limits]
global_concurrency = 8
max_batch = 20
llm_concurrency = 3
# Never fetch these hosts. Exact host or *.suffix wildcard. The host is
# matched without the port, so "localhost" covers localhost:3000 too.
# Loopback hosts are skipped by default anyway.
skip_hosts = ["gemini.google.com", "*.duckduckgo.com"]
# Never fetch these hosts either, but keep the links visible: they are
# parked in needs_browser with the reason review_only and the owner reads
# them by hand.
review_hosts = ["revolut.com", "*.revolut.com"]
# Optional manual override: forces the strict limits and browser routing.
# Ships with NO default entries; walled gardens are discovered by canary
# probing.
walled_gardens = []

[limits.hosts."example.com"]
interval_ms = 45000
daily_cap = 40
concurrency = 1

# The hosts the pipeline may log in to. When this table is set and not
# empty, every other login-walled host is review-only: no browser is
# attempted for it and its links stay visible for the owner to read.
# Leave it out (or empty) to keep the old behaviour: every login-walled
# host is listed as a pending login.
[login]
allow = [
  "app.devin.ai",
  "chat.z.ai",
  "*.usebrioso.com",
  "figma.com",
  "docs.google.com",
]

# Human pacing for strict hosts. Additive: a missing table keeps the
# defaults. Set daily_cap very high (or hours_start = 0 / hours_end = 24)
# to disable the profile.
[pacing]
dwell_median_s = 20
dwell_max_s = 90
break_every_min = 5
break_every_max = 12
break_min_s = 120
break_max_s = 360
daily_cap = 40
hours_start = 8
hours_end = 23
```

| `[limits]` key | Default | Meaning |
|---|---|---|
| `skip_hosts` | `[]` | Never fetched. The links are discarded. |
| `review_hosts` | `[]` | Never fetched. The links stay visible for the owner (`review_only`). |
| `walled_gardens` | `[]` | Forced strict limits and browser routing. Discovered by canary probing, never hardcoded. |

| `[login]` key | Default | Meaning |
|---|---|---|
| `allow` | `[]` | The hosts the pipeline may log in to. Empty means no restriction. |

| `[share]` key | Default | Meaning |
|---|---|---|
| `hosts` | `[]` | The hosts another agent may READ through a saved profile (`linkinbox browse`, the MCP `browse_read` tool). Empty means nothing is shared. Same pattern syntax as the skip list. The reads spend the host budget above, and nothing is written to the link store. |

| `[pacing]` key | Default | Meaning |
|---|---|---|
| `dwell_median_s` | 20 | Median dwell per page; also the spacing baseline. |
| `dwell_max_s` | 90 | Hard cap of a single dwell. |
| `break_every_min` | 5 | Minimum pages before a long break. |
| `break_every_max` | 12 | Maximum pages before a long break. |
| `break_min_s` | 120 | Minimum length of a long break. |
| `break_max_s` | 360 | Maximum length of a long break. |
| `daily_cap` | 40 | Paced requests per host per rolling day. |
| `hours_start` | 8 | Working-hours window start (local hour). |
| `hours_end` | 23 | Working-hours window end (local hour). |

## Surfaces

- Pipeline results gain additive `deferredCount` and `retryAfter` fields.
- extract/enrich invoked through server or MCP are capped at `max_batch`
  (default 20 per call) and return structured deferred info
  (`deferredCount`, `retryAfter`) instead of throwing.
- The extract result also carries `reviewOnlyCount` (links parked for the
  owner to review) and `reconciledCount` (links the sweep moved).
- `linkinbox status` lists per-host budget remaining, breaker state and
  reopen time; `--json` for machine consumption.
- `linkinbox browse <url>` reads one page through the saved profile of its
  host, read-only, for the hosts in `[share] hosts`. MCP tools
  `browse_read` and `browse_hosts` expose the same surface. The reads go
  through the same guard, so they spend the same host budget.
- `linkinbox breaker reset <host>` force-closes the breaker (CLI only).
- MCP read-only tool `limits_status` (spec name `limits.status`). Breaker
  reset stays CLI-only and is a documented parity exception.
- Metrics rows per host and stage: `retries`, `throttled`, `deferred`,
  `breaker_open`, `reconciled`.

## Tests

packages/core/test/host-policy.test.ts and
packages/core/test/review-only.test.ts cover: the hostname without the port,
the loopback hosts skipped by default (localhost, 127.0.0.1, ::1 and
*.localhost, with and without a port), the pattern matching, the review_hosts
short-circuit parking links in needs_browser without a fetch, the `[login]`
allow list (an allowed host keeps the login flow, a non-allowed login-gated
host becomes review-only, a saved profile overrides the allow list, an empty
allow list changes nothing), and the reconcile sweep (a now skip-listed host
discarded, a now review-only host re-reasoned, idempotence, the metric row).
All use a fake clock and a fake extract function; nothing sleeps and nothing
touches the network.

packages/cli/test/login-flow.test.ts covers the pending-login list against
the host policy: skip-listed, review-only and non-allowed hosts are left out
of the pending list, the reviewOnly count reports the excluded links, and an
empty policy keeps every host pending as before.

packages/core/test/resilience.test.ts and
packages/core/test/pipeline-resilience.test.ts cover: backoff schedule and
jitter bounds, Retry-After and the X-RateLimit-* pacing signals, breaker
transitions and cooldown doubling, walled-garden spacing and daily cap for a
config-flagged host across two separate process-like store reloads, canary
success then the rest of the host proceeding, a canary 429 then 99 links
deferred with exactly one request, skip-listed hosts parked as discarded
without a fetch, gone-vs-private 404 on a gated host, login-wall detection
fixtures, restart persistence of the flagged host, a block signal deferring
the rest of the batch, deferred links not retried before nextAttemptAt,
queue backpressure past maxSize, an LLM 429 storm resulting in deferral not
failure, a 500-link burst against a strict host making at most the daily cap
of requests, and FSM history DEFER/RETRY events. All use a fake clock and
fake fetch/exec; nothing sleeps and nothing touches the network.

packages/core/test/human-pacing.test.ts and
packages/core/test/pacing-config.test.ts cover: the dwell distribution
bounds and its median, the spacing jitter band, the break cycle length and
break length ranges, the break cadence reset, the pacing daily cap rollover
across a day boundary, the working-hours gate (day, overnight and 0..24
windows), the `outside_hours` deferral and its release when the window
opens, the integration through `guardRun` with a fake clock (spacing defer,
daily cap, ordinary hosts keeping the fixed 2s spacing), and the `[pacing]`
config table parsing including the disabled profile. All use a fake clock
and a deterministic random; nothing sleeps and nothing touches the network.
