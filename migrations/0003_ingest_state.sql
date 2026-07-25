-- ============================================================
-- 0003 — Ingest bookkeeping
--
-- The scheduled refresh works through regions one at a time rather than
-- pulling the planet on every tick: a Worker has a CPU and memory budget,
-- and Overpass is a donated public service with usage etiquette. This table
-- records where the rotation is up to and what the last run did, so a run
-- can be incremental (`newer:` since the last success) and so failures are
-- visible instead of silent.
-- ============================================================

CREATE TABLE IF NOT EXISTS ingest_regions (
  iso            TEXT PRIMARY KEY,           -- ISO 3166-1 alpha-2
  label          TEXT NOT NULL,
  priority       INTEGER NOT NULL DEFAULT 100, -- lower runs more often
  last_run_at    TEXT,
  last_success_at TEXT,
  last_status    TEXT,                        -- 'ok' | 'error' | 'skipped'
  last_error     TEXT,
  courses_seen   INTEGER,
  consecutive_failures INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_ingest_regions_due
  ON ingest_regions(priority, last_run_at);

CREATE TABLE IF NOT EXISTS ingest_runs (
  id            TEXT PRIMARY KEY,
  iso           TEXT,
  started_at    TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at   TEXT,
  status        TEXT,
  incremental   INTEGER NOT NULL DEFAULT 0,
  elements      INTEGER,
  courses       INTEGER,
  layouts       INTEGER,
  holes         INTEGER,
  warnings      INTEGER,
  warning_json  TEXT,                         -- capped sample, for triage
  error         TEXT
);

CREATE INDEX IF NOT EXISTS idx_ingest_runs_started ON ingest_runs(started_at DESC);

-- Seed the rotation with the countries that actually hold the data. Per the
-- July 2026 OSM snapshot the top five (US, FI, SE, CA, NO) are ~79% of all
-- mapped courses, so they get the lowest priority number and come round most
-- often. Add rows to extend coverage; nothing in the Worker is hardcoded.
INSERT INTO ingest_regions (iso, label, priority) VALUES
  ('US', 'United States', 10),
  ('FI', 'Finland',       10),
  ('SE', 'Sweden',        10),
  ('CA', 'Canada',        10),
  ('NO', 'Norway',        10),
  ('DE', 'Germany',       20),
  ('EE', 'Estonia',       20),
  ('CZ', 'Czechia',       20),
  ('AU', 'Australia',     30),
  ('DK', 'Denmark',       30),
  ('FR', 'France',        30),
  ('AT', 'Austria',       40),
  ('NZ', 'New Zealand',   40),
  ('NL', 'Netherlands',   40),
  ('CH', 'Switzerland',   40),
  ('GB', 'United Kingdom',40),
  ('JP', 'Japan',         50)
ON CONFLICT(iso) DO NOTHING;
