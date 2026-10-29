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

### bounded queue

`createBoundedQueue({ maxSize, concurrency })`: enqueue returns accepted or
deferred (`queue_full` / `queue_closed`). Drain runs at bounded concurrency.
No unbounded memory growth.

## Persistence

CLI processes are short lived, so limiter and breaker state live in the
`host_state` table (migrations 0003, 0004 and 0005, schema version 5):

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
to run `linkinbox login <host>`.

## Config

All values are overridable in `~/.linkinbox/config.toml`:

```toml
[limits]
global_concurrency = 8
max_batch = 20
llm_concurrency = 3
# Never fetch these hosts. Exact host or *.suffix wildcard.
skip_hosts = ["gemini.google.com", "*.duckduckgo.com"]
# Optional manual override: forces the strict limits and browser routing.
# Ships with NO default entries; walled gardens are discovered by canary
# probing.
walled_gardens = []

[limits.hosts."example.com"]
interval_ms = 45000
daily_cap = 40
concurrency = 1

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
- `linkinbox status` lists per-host budget remaining, breaker state and
  reopen time; `--json` for machine consumption.
- `linkinbox breaker reset <host>` force-closes the breaker (CLI only).
- MCP read-only tool `limits_status` (spec name `limits.status`). Breaker
  reset stays CLI-only and is a documented parity exception.
- Metrics rows per host and stage: `retries`, `throttled`, `deferred`,
  `breaker_open`.

## Tests

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
