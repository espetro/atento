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

Cooldown grows exponentially per re-open: walled gardens start at 6 hours and
double up to a 48 hour cap; the llm breaker starts at 30 seconds and doubles
up to 10 minutes; other hosts start at 60 seconds up to 30 minutes. Half-open
admits exactly one probe. A successful probe closes the breaker and resets
the level; a failed probe reopens one level deeper.

### rate limiter

Per-host token bucket plus minimum spacing plus a daily cap. Spacing applies
a jitter of plus or minus 30 percent around the configured interval.

Defaults:

| Host class | Interval | Daily cap | Concurrency |
|---|---|---|---|
| walled gardens (x.com, twitter.com, instagram.com, linkedin.com, and any host with a saved browser profile) | 45s | 40 | 1 |
| ordinary hosts | 2s | unlimited | 4 |
| llm | none | unlimited | 3 |

Global in-flight cap: 8. Max links per extract/enrich call (`max_batch`): 20.

### bounded queue

`createBoundedQueue({ maxSize, concurrency })`: enqueue returns accepted or
deferred (`queue_full` / `queue_closed`). Drain runs at bounded concurrency.
No unbounded memory growth.

## Persistence

CLI processes are short lived, so limiter and breaker state live in the
`host_state` table (migration 0003, schema version 3):

```
key, last_request_at, window_start, window_count, consecutive_failures,
breaker_state, opened_until, cooldown_level, last_error
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

[limits.hosts."x.com"]
interval_ms = 45000
daily_cap = 40
concurrency = 1
```

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
jitter bounds, Retry-After, breaker transitions and cooldown doubling,
walled-garden spacing and daily cap across two separate process-like store
reloads, a block signal deferring the rest of the batch, deferred links not
retried before nextAttemptAt, queue backpressure past maxSize, an LLM 429
storm resulting in deferral not failure, a 500-link burst against x.com
making at most the daily cap of requests, and FSM history DEFER/RETRY
events. All use a fake clock and fake fetch/exec; nothing sleeps.
