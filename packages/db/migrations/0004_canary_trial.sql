
-- Canary probing: per-host trial outcome (unknown/open/flagged), why the
-- host was flagged, when the trial ran, whether the host is login gated,
-- and the upstream pacing signal (Retry-After / X-RateLimit-*).
ALTER TABLE host_state ADD COLUMN trial_state TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE host_state ADD COLUMN trial_reason TEXT;
ALTER TABLE host_state ADD COLUMN trial_at INTEGER;
ALTER TABLE host_state ADD COLUMN login_gated INTEGER NOT NULL DEFAULT 0;
ALTER TABLE host_state ADD COLUMN rate_limited_until INTEGER;
