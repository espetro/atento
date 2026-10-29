
-- Per-host limiter and circuit breaker state. Shared by every process that
-- touches the same database: the CLI, the server and the MCP server.
CREATE TABLE IF NOT EXISTS host_state (
  key TEXT PRIMARY KEY,
  last_request_at INTEGER,
  window_start INTEGER,
  window_count INTEGER NOT NULL DEFAULT 0,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  breaker_state TEXT NOT NULL DEFAULT 'closed',
  opened_until INTEGER,
  cooldown_level INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);
