-- ============================================================
-- Disc Golf Tracker — D1 Schema
-- Run: npx wrangler d1 execute disc-golf-tracker-db --file=schema.sql
-- ============================================================

-- ── Users ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id           TEXT PRIMARY KEY,
  username     TEXT UNIQUE NOT NULL,
  email        TEXT UNIQUE NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── Rounds (score entries) ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS rounds (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id),
  course     TEXT NOT NULL,
  date_played TEXT NOT NULL,          -- ISO date: YYYY-MM-DD
  total_score INTEGER NOT NULL,
  par        INTEGER,                  -- optional course par
  notes      TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_rounds_user_date ON rounds(user_id, date_played DESC);

-- ── Friendships ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS friendships (
  id          TEXT PRIMARY KEY,
  requester_id TEXT NOT NULL REFERENCES users(id),
  receiver_id TEXT NOT NULL REFERENCES users(id),
  status      TEXT NOT NULL DEFAULT 'pending',  -- pending | accepted
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_friendships_pair ON friendships(
  requester_id, receiver_id
);
