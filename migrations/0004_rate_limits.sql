-- ============================================================
-- 0004 — Rate limit counters
--
-- Backs application-level rate limiting for auth endpoints. A fixed-window
-- counter, not a sliding log: one row per (key, window bucket), incremented
-- atomically via ON CONFLICT. Cheap to read (one row) and cheap to write
-- (one upsert), at the cost of the standard fixed-window edge case (a burst
-- spanning a window boundary can briefly allow up to ~2x the limit). That
-- trade-off is fine for slowing down credential stuffing and registration
-- spam; it is not trying to be a precise quota system.
--
-- Considered and rejected: Cloudflare's native Workers Rate Limiting binding
-- (`ratelimits` in wrangler.toml). Cloudflare's own docs describe it as a
-- loose, per-location, eventually-consistent filter — explicitly not suited
-- for strict abuse prevention, which is exactly what login brute-force
-- protection needs. A D1-backed counter gives a real, testable guarantee
-- instead of an approximate one.
-- ============================================================

CREATE TABLE IF NOT EXISTS rate_limit_counters (
  rl_key  TEXT NOT NULL,
  bucket  INTEGER NOT NULL,
  count   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (rl_key, bucket)
);

-- Supports the opportunistic cleanup of stale buckets on write.
CREATE INDEX IF NOT EXISTS idx_rate_limit_bucket ON rate_limit_counters(bucket);
