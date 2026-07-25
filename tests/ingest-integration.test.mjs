// Applies the real migrations and the real generated SQL to a throwaway
// SQLite database. This is the test that catches things unit tests can't:
// SQLite accepting the upsert syntax at all, idempotency across re-ingest,
// and whether the lock flag genuinely protects user edits.
//
// Uses node:sqlite (Node 22+). Skips cleanly if unavailable.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { normalize, courseId } from '../shared/osm-normalize.js';
import { statementsForCourses } from '../shared/osm-sql.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

let DatabaseSync;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch {
  DatabaseSync = null;
}

const fixture = JSON.parse(readFileSync(join(here, 'fixtures/overpass-sample.json'), 'utf8'));
const { courses } = normalize(fixture);

function freshDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  for (const f of ['migrations/0001_baseline.sql', 'migrations/0002_courses_layouts_holes.sql']) {
    db.exec(readFileSync(join(root, f), 'utf8'));
  }
  return db;
}

function ingest(db, list = courses) {
  for (const { sql, params } of statementsForCourses(list)) {
    db.prepare(sql).run(...params.map((p) => (p === undefined ? null : p)));
  }
}

const counts = (db) =>
  Object.fromEntries(
    ['courses', 'layouts', 'holes'].map((t) => [
      t,
      db.prepare(`SELECT count(*) AS n FROM ${t}`).get().n,
    ]),
  );

test('node:sqlite is available for integration tests', { skip: !DatabaseSync }, () => {
  assert.ok(DatabaseSync);
});

test('generated SQL applies against the migrated schema', { skip: !DatabaseSync }, () => {
  const db = freshDb();
  ingest(db);
  const c = counts(db);
  assert.equal(c.courses, 4);
  assert.equal(c.layouts, 4, 'Wildhorse x2 relations, Sunset x1, Craig Ranch x1');
  // 9 hole rows from 8 source ways: Wildhorse's two layouts share ways 2001
  // and 2003, and each layout needs its own row because the same way is a
  // different hole number in each.
  assert.equal(c.holes, 9);
  // Seven distinct upstream ways reach the database: the fixture has eight
  // hole ways, and way/2600 is the orphan with no course nearby — it is
  // reported as a warning and deliberately not inserted.
  assert.equal(
    db.prepare('SELECT count(DISTINCT osm_way_id) AS n FROM holes').get().n,
    7,
  );

  const wh = db.prepare("SELECT * FROM courses WHERE id = 'osm-n1001'").get();
  assert.equal(wh.name, 'Wildhorse DiscGolfPark');
  assert.equal(wh.hole_count, 18);
  assert.equal(wh.source, 'osm');
  assert.equal(wh.city, 'Las Vegas');
  assert.equal(wh.locked, 0);
  db.close();
});

test('re-ingesting the same data changes nothing', { skip: !DatabaseSync }, () => {
  const db = freshDb();
  ingest(db);
  const first = counts(db);
  const firstHoles = db
    .prepare('SELECT id, layout_id, number, par, distance_m FROM holes ORDER BY id')
    .all();

  ingest(db);
  ingest(db);

  assert.deepEqual(counts(db), first, 'row counts stable across three ingests');
  assert.deepEqual(
    db.prepare('SELECT id, layout_id, number, par, distance_m FROM holes ORDER BY id').all(),
    firstHoles,
    'hole rows byte-identical after re-ingest',
  );
  db.close();
});

test('path_json round-trips as usable geometry', { skip: !DatabaseSync }, () => {
  const db = freshDb();
  ingest(db);
  const hole = db
    .prepare("SELECT * FROM holes WHERE layout_id = 'osm-r3001' AND number = 1")
    .get();
  const path = JSON.parse(hole.path_json);
  assert.equal(path.length, 3, 'the mid-way vertex survives — this is what makes a dogleg drawable');
  assert.deepEqual(path[0], [36.15, -115.2]);
  assert.equal(hole.tee_lat, 36.15);
  assert.equal(hole.basket_lat, 36.1508);
  db.close();
});

test('a locked course is not overwritten by the ingest', { skip: !DatabaseSync }, () => {
  const db = freshDb();
  ingest(db);

  // Simulate a user correcting an OSM-seeded course and claiming it.
  db.prepare("UPDATE courses SET name = 'Wildhorse (corrected)', locked = 1 WHERE id = 'osm-n1001'").run();
  db.prepare("UPDATE layouts SET name = 'My Blue', locked = 1 WHERE id = 'osm-r3001'").run();
  db.prepare("UPDATE holes SET par = 5 WHERE layout_id = 'osm-r3001' AND number = 1").run();

  ingest(db);

  assert.equal(
    db.prepare("SELECT name FROM courses WHERE id = 'osm-n1001'").get().name,
    'Wildhorse (corrected)',
    'user course name survives re-ingest',
  );
  assert.equal(
    db.prepare("SELECT name FROM layouts WHERE id = 'osm-r3001'").get().name,
    'My Blue',
  );
  assert.equal(
    db.prepare("SELECT par FROM holes WHERE layout_id = 'osm-r3001' AND number = 1").get().par,
    5,
    'holes under a locked layout are not replaced',
  );

  // An unlocked sibling layout still refreshes normally.
  assert.equal(
    db.prepare("SELECT locked FROM layouts WHERE id = 'osm-r3002'").get().locked,
    0,
  );
  db.close();
});

test('upstream hole removal is reflected, and stale holes do not linger', { skip: !DatabaseSync }, () => {
  const db = freshDb();
  ingest(db);
  assert.equal(
    db.prepare("SELECT count(*) AS n FROM holes WHERE layout_id = 'osm-r3001'").get().n,
    3,
  );

  // Next import: the blue layout lost a hole upstream.
  const trimmed = structuredClone(courses);
  const wh = trimmed.find((c) => courseId(c) === 'osm-n1001');
  const blue = wh.layouts.find((l) => l.osm_relation_id === 3001);
  blue.holes = blue.holes.slice(0, 2);
  blue.hole_count = 2;

  ingest(db, trimmed);
  assert.equal(
    db.prepare("SELECT count(*) AS n FROM holes WHERE layout_id = 'osm-r3001'").get().n,
    2,
    'removed hole is gone, not orphaned',
  );
  db.close();
});

test('a layout referenced by a round is never deleted', { skip: !DatabaseSync }, () => {
  const db = freshDb();
  ingest(db);

  db.prepare(
    "INSERT INTO users (id, username, email, display_name, password_hash) VALUES ('u1','harrison','h@x.com','Harrison','x')",
  ).run();
  db.prepare(
    `INSERT INTO rounds (id, user_id, course_id, layout_id, course, date_played, total_score, par)
     VALUES ('r1','u1','osm-n1001','osm-r3002','Wildhorse DiscGolfPark','2026-07-20',57,54)`,
  ).run();

  // Upstream deletes that layout relation entirely.
  const trimmed = structuredClone(courses);
  const wh = trimmed.find((c) => courseId(c) === 'osm-n1001');
  wh.layouts = wh.layouts.filter((l) => l.osm_relation_id !== 3002);

  ingest(db, trimmed);

  assert.ok(
    db.prepare("SELECT 1 FROM layouts WHERE id = 'osm-r3002'").get(),
    "a scorecard's layout must survive upstream deletion",
  );
  assert.equal(
    db.prepare("SELECT layout_id FROM rounds WHERE id = 'r1'").get().layout_id,
    'osm-r3002',
  );
  db.close();
});

test('an unreferenced layout that vanishes upstream is cleaned up', { skip: !DatabaseSync }, () => {
  const db = freshDb();
  ingest(db);
  const trimmed = structuredClone(courses);
  const wh = trimmed.find((c) => courseId(c) === 'osm-n1001');
  wh.layouts = wh.layouts.filter((l) => l.osm_relation_id !== 3002);

  ingest(db, trimmed);
  assert.equal(
    db.prepare("SELECT count(*) AS n FROM layouts WHERE id = 'osm-r3002'").get().n,
    0,
  );
  db.close();
});

test('relative-to-par analytics work off the joined data', { skip: !DatabaseSync }, () => {
  const db = freshDb();
  ingest(db);
  db.prepare(
    "INSERT INTO users (id, username, email, display_name, password_hash) VALUES ('u1','harrison','h@x.com','Harrison','x')",
  ).run();
  // Two rounds on layouts with different pars — the exact case raw totals get wrong.
  const parOf = (id) => db.prepare('SELECT total_par FROM layouts WHERE id = ?').get(id).total_par;
  const hardPar = parOf('osm-r3001'); // 3-hole layout, par 10
  const easyPar = parOf('osm-r3002'); // 2-hole layout, par 6
  assert.equal(hardPar, 10);
  assert.equal(easyPar, 6);

  // Played the harder layout 3 over, then the easier one 3 over: no real
  // improvement. Raw totals claim a 4-stroke gain.
  db.prepare(
    `INSERT INTO rounds (id,user_id,course_id,layout_id,course,date_played,total_score,par)
     VALUES ('r1','u1','osm-n1001','osm-r3001','Wildhorse','2026-07-01',?,?),
            ('r2','u1','osm-n1001','osm-r3002','Wildhorse','2026-07-10',?,?)`,
  ).run(hardPar + 3, hardPar, easyPar + 3, easyPar);

  const rows = db
    .prepare(
      `SELECT r.id, r.total_score, COALESCE(l.total_par, r.par) AS par,
              r.total_score - COALESCE(l.total_par, r.par) AS to_par
       FROM rounds r LEFT JOIN layouts l ON l.id = r.layout_id
       WHERE r.user_id = 'u1' ORDER BY r.date_played`,
    )
    .all();

  assert.deepEqual(rows.map((r) => r.to_par), [3, 3], 'relative to par: flat, which is the truth');
  assert.equal(
    rows[0].total_score - rows[1].total_score,
    4,
    'raw totals would report a 4-stroke improvement that did not happen',
  );

  // And a legacy round with no layout still resolves via its own par snapshot.
  db.prepare(
    `INSERT INTO rounds (id,user_id,course,date_played,total_score,par)
     VALUES ('r3','u1','Some Off-Catalog Course','2026-07-15',58,54)`,
  ).run();
  assert.equal(
    db
      .prepare(
        `SELECT r.total_score - COALESCE(l.total_par, r.par) AS to_par
         FROM rounds r LEFT JOIN layouts l ON l.id = r.layout_id WHERE r.id = 'r3'`,
      )
      .get().to_par,
    4,
  );
  db.close();
});
