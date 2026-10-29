
-- Human pacing for strict hosts: pages served since the last long break and
-- the drawn pages-per-cycle, so the break cadence survives restarts.
ALTER TABLE host_state ADD COLUMN pages_since_break INTEGER;
ALTER TABLE host_state ADD COLUMN break_every INTEGER;
