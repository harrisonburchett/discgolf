-- ============================================================
-- 0002 — Course catalog, layouts, hole geometry, hole-by-hole scoring
--
-- Adds the data model behind course maps and hole layouts, and moves
-- rounds off a free-text course name onto a real layout reference.
--
-- Also fixes integrity gaps carried over from 0001:
--   * case-insensitive uniqueness on username/email
--   * symmetric uniqueness on friendships (blocks reverse-direction dupes)
--   * ON DELETE behaviour on every foreign key
-- ============================================================

-- ── Courses ────────────────────────────────────────────────────
-- One row per physical course. `source` records provenance so the OSM
-- ingest can refresh its own rows without ever touching user-authored
-- ones; `locked` lets a user claim an OSM-seeded course and stop the
-- ingest from overwriting their corrections.
CREATE TABLE IF NOT EXISTS courses (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  lat           REAL NOT NULL,
  lng           REAL NOT NULL,
  city          TEXT,
  region        TEXT,                        -- state / province / county
  country       TEXT,                        -- ISO 3166-1 alpha-2 where known
  hole_count    INTEGER,
  source        TEXT NOT NULL DEFAULT 'user'
                  CHECK (source IN ('osm', 'user')),
  osm_type      TEXT CHECK (osm_type IN ('node', 'way', 'relation')),
  osm_id        INTEGER,
  osm_version   INTEGER,                     -- lets the ingest skip unchanged objects
  locked        INTEGER NOT NULL DEFAULT 0
                  CHECK (locked IN (0, 1)),  -- 1 = user-corrected, ingest must not overwrite
  created_by    TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One row per OSM object; partial index so user-created courses (NULL osm_id)
-- are exempt. This is what makes the ingest idempotent.
CREATE UNIQUE INDEX IF NOT EXISTS idx_courses_osm
  ON courses(osm_type, osm_id) WHERE osm_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_courses_name ON courses(name COLLATE NOCASE);

-- D1 has no spatial extension, so proximity search is a bounding-box scan
-- over this index followed by an exact haversine sort in the handler.
CREATE INDEX IF NOT EXISTS idx_courses_lat_lng ON courses(lat, lng);

-- ── Layouts ────────────────────────────────────────────────────
-- A playable configuration of a course: short 9 vs. full 18, a tee-colour
-- variant, a seasonal setup. Corresponds to OSM's type=disc_golf_layout
-- relation; courses mapped without one get a single synthesised layout.
CREATE TABLE IF NOT EXISTS layouts (
  id                TEXT PRIMARY KEY,
  course_id         TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  name              TEXT NOT NULL DEFAULT 'Main',
  hole_count        INTEGER NOT NULL,
  total_par         INTEGER,
  total_distance_m  INTEGER,
  tee_colour        TEXT,                    -- 'white', 'blue', 'white;blue', …
  is_default        INTEGER NOT NULL DEFAULT 0
                      CHECK (is_default IN (0, 1)),
  source            TEXT NOT NULL DEFAULT 'user'
                      CHECK (source IN ('osm', 'user')),
  osm_relation_id   INTEGER,
  locked            INTEGER NOT NULL DEFAULT 0
                      CHECK (locked IN (0, 1)),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_layouts_course ON layouts(course_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_layouts_osm
  ON layouts(osm_relation_id) WHERE osm_relation_id IS NOT NULL;

-- ── Holes ──────────────────────────────────────────────────────
-- `path_json` is the tee→basket way geometry as [[lat,lng], …]. Storing it
-- denormalised on the hole keeps the whole layout renderable in one query,
-- which is what the hole-map view needs.
CREATE TABLE IF NOT EXISTS holes (
  id           TEXT PRIMARY KEY,
  layout_id    TEXT NOT NULL REFERENCES layouts(id) ON DELETE CASCADE,
  number       INTEGER NOT NULL,
  par          INTEGER NOT NULL DEFAULT 3,
  distance_m   INTEGER,
  tee_lat      REAL,
  tee_lng      REAL,
  basket_lat   REAL,
  basket_lng   REAL,
  path_json    TEXT,
  osm_way_id   INTEGER,
  UNIQUE (layout_id, number)
);

CREATE INDEX IF NOT EXISTS idx_holes_layout ON holes(layout_id, number);

-- ── Rounds: rebuilt ────────────────────────────────────────────
-- SQLite cannot alter a foreign key in place, so the table is rebuilt to
-- add course_id/layout_id and proper ON DELETE behaviour. `course` is kept
-- as free text: it is the fallback for a course not in the catalog, and it
-- preserves every existing row.
CREATE TABLE IF NOT EXISTS rounds_new (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  course_id     TEXT REFERENCES courses(id) ON DELETE SET NULL,
  layout_id     TEXT REFERENCES layouts(id) ON DELETE SET NULL,
  course        TEXT NOT NULL,               -- display name / fallback for off-catalog courses
  date_played   TEXT NOT NULL,               -- ISO date: YYYY-MM-DD
  total_score   INTEGER NOT NULL,
  par           INTEGER,                     -- snapshot of par at time of play
  notes         TEXT DEFAULT '',
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO rounds_new (id, user_id, course, date_played, total_score, par, notes, created_at)
  SELECT id, user_id, course, date_played, total_score, par, notes, created_at FROM rounds;

DROP TABLE rounds;
ALTER TABLE rounds_new RENAME TO rounds;

CREATE INDEX IF NOT EXISTS idx_rounds_user_date ON rounds(user_id, date_played DESC);
CREATE INDEX IF NOT EXISTS idx_rounds_course ON rounds(course_id);

-- ── Hole scores ────────────────────────────────────────────────
-- hole_number is denormalised alongside hole_id so a scorecard stays
-- readable after a layout is edited or a hole row is replaced.
CREATE TABLE IF NOT EXISTS hole_scores (
  round_id     TEXT NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
  hole_id      TEXT REFERENCES holes(id) ON DELETE SET NULL,
  hole_number  INTEGER NOT NULL,
  par          INTEGER,                      -- snapshot; layouts change, scorecards shouldn't
  strokes      INTEGER NOT NULL CHECK (strokes > 0),
  PRIMARY KEY (round_id, hole_number)
);

-- ── Integrity fixes carried over from 0001 ─────────────────────

-- Case-insensitive uniqueness: without these, `Harrison` and `harrison`
-- are two accounts, which makes username impersonation trivial.
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_ci ON users(lower(username));
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_ci ON users(lower(email));

-- Friendships: rebuilt. In 0001 the user_id foreign keys had no ON DELETE
-- action, which meant deleting a user with any friendship failed outright —
-- account deletion was impossible. The rebuild also constrains `status`.
DROP INDEX IF EXISTS idx_friendships_pair;

CREATE TABLE IF NOT EXISTS friendships_new (
  id            TEXT PRIMARY KEY,
  requester_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  receiver_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'accepted')),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (requester_id <> receiver_id)
);

INSERT INTO friendships_new (id, requester_id, receiver_id, status, created_at)
  SELECT id, requester_id, receiver_id, status, created_at
  FROM friendships
  WHERE status IN ('pending', 'accepted')
    AND requester_id <> receiver_id;

DROP TABLE friendships;
ALTER TABLE friendships_new RENAME TO friendships;

-- Symmetric uniqueness. The old index only covered
-- (requester_id, receiver_id), so the reverse pair could be inserted
-- concurrently and slip past the application-level check.
CREATE UNIQUE INDEX IF NOT EXISTS idx_friendships_pair_sym ON friendships(
  min(requester_id, receiver_id),
  max(requester_id, receiver_id)
);

CREATE INDEX IF NOT EXISTS idx_friendships_receiver
  ON friendships(receiver_id, status);
