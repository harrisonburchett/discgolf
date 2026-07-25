// Runs the real Pages Function handlers against a SQLite-backed D1 shim.
// Auth is stubbed by seeding a user and monkey-patching nothing: the handlers
// call getUser(), which does a real DB lookup on the JWT `sub`, so we sign a
// real token with a known secret instead of faking the auth layer.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { FakeD1, ctx } from './helpers/d1-shim.mjs';
import { normalize } from '../shared/osm-normalize.js';
import { statementsForCourses } from '../shared/osm-sql.js';
import { signJwt } from '../functions/lib/auth.js';

import { onRequestGet as coursesList } from '../functions/api/courses/index.js';
import { onRequestGet as courseDetail } from '../functions/api/courses/[id].js';
import { onRequestGet as roundsList, onRequestPost as roundsCreate } from '../functions/api/rounds/index.js';
import { onRequestPut as roundUpdate } from '../functions/api/rounds/[id].js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(join(here, 'fixtures/overpass-sample.json'), 'utf8'));
const { courses } = normalize(fixture);

const JWT_SECRET = 'test-secret-not-a-real-one';
const USER_ID = 'u-harrison';

async function setup() {
  const DB = new FakeD1();
  DB.db
    .prepare(
      'INSERT INTO users (id, username, email, display_name, password_hash) VALUES (?,?,?,?,?)',
    )
    .run(USER_ID, 'harrison', 'h@x.test', 'Harrison', 'x');

  for (const { sql, params } of statementsForCourses(courses)) {
    DB.db.prepare(sql).run(...params.map((p) => p ?? null));
  }

  const token = await signJwt(
    { sub: USER_ID, username: 'harrison', exp: Math.floor(Date.now() / 1000) + 3600 },
    JWT_SECRET,
  );
  return { env: { DB, JWT_SECRET }, token, DB };
}

const body = async (res) => JSON.parse(await res.text());

// ── Auth ──────────────────────────────────────────────────────

test('course endpoints reject an unauthenticated request', async () => {
  const { env } = await setup();
  const res = await coursesList(ctx({ url: 'https://x.test/api/courses?q=wild', token: null }));
  assert.equal(res.status, 401);
});

test('a token signed with the wrong secret is rejected', async () => {
  const { env } = await setup();
  const bad = await signJwt({ sub: USER_ID, exp: Math.floor(Date.now() / 1000) + 60 }, 'wrong');
  const req = new Request('https://x.test/api/courses?q=wild', {
    headers: { Authorization: `Bearer ${bad}` },
  });
  const res = await coursesList({ request: req, env, data: {} });
  assert.equal(res.status, 401);
});

// ── Course search ─────────────────────────────────────────────

test('name search is case-insensitive and reports map availability', async () => {
  const { env, token } = await setup();
  const res = await coursesList({
    ...ctx({ url: 'https://x.test/api/courses?q=WILDHORSE', token }),
    env,
  });
  assert.equal(res.status, 200);
  const { courses: found, attribution } = await body(res);
  assert.equal(found.length, 1);
  assert.equal(found[0].name, 'Wildhorse DiscGolfPark');
  assert.equal(found[0].layout_count, 2);
  assert.equal(found[0].has_map, true);
  assert.match(attribution, /OpenStreetMap/);
});

test('LIKE wildcards in the query are escaped, not honoured', async () => {
  const { env, token } = await setup();
  const res = await coursesList({
    ...ctx({ url: 'https://x.test/api/courses?q=%25', token }),
    env,
  });
  const { courses: found } = await body(res);
  assert.equal(found.length, 0, 'a bare % must not match every course');
});

test('proximity search sorts by real distance and honours the radius', async () => {
  const { env, token } = await setup();
  const res = await coursesList({
    ...ctx({ url: 'https://x.test/api/courses?lat=36.15&lng=-115.2&radius=20', token }),
    env,
  });
  const { courses: found } = await body(res);
  assert.ok(found.length >= 2);
  assert.equal(found[0].name, 'Wildhorse DiscGolfPark');
  assert.equal(found[0].distance_km, 0);
  const distances = found.map((c) => c.distance_km);
  assert.deepEqual(distances, [...distances].sort((a, b) => a - b), 'sorted nearest first');
  assert.ok(distances.every((d) => d <= 20), 'nothing beyond the radius');
});

test('withMaps filters out catalog-only courses', async () => {
  const { env, token } = await setup();
  const all = await body(
    await coursesList({ ...ctx({ url: 'https://x.test/api/courses?lat=40&lng=-100&radius=500', token }), env }),
  );
  const mapped = await body(
    await coursesList({
      ...ctx({ url: 'https://x.test/api/courses?lat=40&lng=-100&radius=500&withMaps=1', token }),
      env,
    }),
  );
  assert.ok(all.courses.some((c) => c.name === 'Unnamed course'));
  assert.ok(!mapped.courses.some((c) => c.name === 'Unnamed course'));
});

test('a search with neither q nor coordinates is a 400, not a full table scan', async () => {
  const { env, token } = await setup();
  const res = await coursesList({ ...ctx({ url: 'https://x.test/api/courses', token }), env });
  assert.equal(res.status, 400);
});

// ── Course detail ─────────────────────────────────────────────

test('course detail returns every layout with drawable geometry and bounds', async () => {
  const { env, token } = await setup();
  const res = await courseDetail({
    ...ctx({ url: 'https://x.test/api/courses/osm-n1001', token, params: { id: 'osm-n1001' } }),
    env,
  });
  assert.equal(res.status, 200);
  const { course, layouts, bounds } = await body(res);

  assert.equal(course.name, 'Wildhorse DiscGolfPark');
  assert.equal(course.osm_url, 'https://www.openstreetmap.org/node/1001');
  assert.equal(layouts.length, 2);
  assert.equal(layouts[0].is_default, true, 'default layout comes first');

  const hole1 = layouts.find((l) => l.name === 'Blue (3)').holes[0];
  assert.equal(hole1.number, 1);
  assert.equal(hole1.par, 3);
  assert.equal(hole1.distance_m, 92);
  assert.equal(hole1.path.length, 3);
  assert.deepEqual(hole1.tee, { lat: 36.15, lng: -115.2 });

  assert.ok(bounds && bounds.south <= bounds.north && bounds.west <= bounds.east);
});

test('a malformed path_json degrades to no geometry instead of a 500', async () => {
  const { env, token, DB } = await setup();
  DB.db.prepare("UPDATE holes SET path_json = '{not json' WHERE layout_id = 'osm-r3001'").run();
  const res = await courseDetail({
    ...ctx({ token, params: { id: 'osm-n1001' }, url: 'https://x.test/api/courses/osm-n1001' }),
    env,
  });
  assert.equal(res.status, 200);
  const { layouts } = await body(res);
  assert.equal(layouts.find((l) => l.name === 'Blue (3)').holes[0].path, null);
});

test('an unknown course id is a 404', async () => {
  const { env, token } = await setup();
  const res = await courseDetail({
    ...ctx({ token, params: { id: 'nope' }, url: 'https://x.test/api/courses/nope' }),
    env,
  });
  assert.equal(res.status, 404);
});

// ── Creating rounds ───────────────────────────────────────────

test('a hole-by-hole scorecard derives total and par from the layout', async () => {
  const { env, token } = await setup();
  const res = await roundsCreate({
    ...ctx({
      method: 'POST',
      url: 'https://x.test/api/rounds',
      token,
      body: {
        layout_id: 'osm-r3001',
        date_played: '2026-07-20',
        hole_scores: [
          { number: 1, strokes: 4 },
          { number: 2, strokes: 4 },
          { number: 3, strokes: 3 },
        ],
      },
    }),
    env,
  });
  assert.equal(res.status, 201);
  const { round, hole_scores } = await body(res);

  assert.equal(round.total_score, 11, 'summed from the scorecard, not trusted from the client');
  assert.equal(round.par, 10, 'taken from the layout');
  assert.equal(round.to_par, 1);
  assert.equal(round.course, 'Wildhorse DiscGolfPark', 'name denormalised from the catalog');
  assert.equal(round.course_id, 'osm-n1001', 'course inferred from the layout');
  assert.equal(hole_scores.length, 3);
});

test('a client-supplied total is ignored when a scorecard is present', async () => {
  const { env, token } = await setup();
  const res = await roundsCreate({
    ...ctx({
      method: 'POST',
      token,
      url: 'https://x.test/api/rounds',
      body: {
        layout_id: 'osm-r3001',
        date_played: '2026-07-20',
        total_score: 1,
        hole_scores: [
          { number: 1, strokes: 4 },
          { number: 2, strokes: 4 },
          { number: 3, strokes: 4 },
        ],
      },
    }),
    env,
  });
  assert.equal((await body(res)).round.total_score, 12);
});

test('invalid scorecards are rejected with a useful message', async () => {
  const { env, token } = await setup();
  const base = { layout_id: 'osm-r3001', date_played: '2026-07-20' };
  const cases = [
    [{ ...base, hole_scores: [{ number: 99, strokes: 3 }] }, /not part of that layout/],
    [{ ...base, hole_scores: [{ number: 1, strokes: 3 }, { number: 1, strokes: 4 }] }, /Duplicate score/],
    [{ ...base, hole_scores: [{ number: 1, strokes: 0 }] }, /between 1 and 30/],
    [{ ...base, hole_scores: [{ number: 1, strokes: 'four' }] }, /integer number and strokes/],
    [{ ...base, hole_scores: [] }, /non-empty array/],
    [{ date_played: '2026-07-20', hole_scores: [{ number: 1, strokes: 3 }] }, /requires a layout_id/],
  ];
  for (const [payload, expected] of cases) {
    const res = await roundsCreate({
      ...ctx({ method: 'POST', token, url: 'https://x.test/api/rounds', body: payload }),
      env,
    });
    assert.equal(res.status, 400, JSON.stringify(payload));
    assert.match((await body(res)).error, expected);
  }
});

test('a rejected scorecard leaves no partial round behind', async () => {
  const { env, token, DB } = await setup();
  const before = DB.db.prepare('SELECT count(*) AS n FROM rounds').get().n;
  await roundsCreate({
    ...ctx({
      method: 'POST',
      token,
      url: 'https://x.test/api/rounds',
      body: {
        layout_id: 'osm-r3001',
        date_played: '2026-07-20',
        hole_scores: [{ number: 1, strokes: 3 }, { number: 42, strokes: 3 }],
      },
    }),
    env,
  });
  assert.equal(DB.db.prepare('SELECT count(*) AS n FROM rounds').get().n, before);
  assert.equal(DB.db.prepare('SELECT count(*) AS n FROM hole_scores').get().n, 0);
});

test('nonsense dates are rejected', async () => {
  const { env, token } = await setup();
  for (const d of ['2026-02-30', 'yesterday', '2026-7-4', '', null, '2026-13-01']) {
    const res = await roundsCreate({
      ...ctx({
        method: 'POST',
        token,
        url: 'https://x.test/api/rounds',
        body: { course: 'Somewhere', date_played: d, total_score: 54 },
      }),
      env,
    });
    assert.equal(res.status, 400, `should reject ${JSON.stringify(d)}`);
  }
});

test('an off-catalog course still logs a round by name', async () => {
  const { env, token } = await setup();
  const res = await roundsCreate({
    ...ctx({
      method: 'POST',
      token,
      url: 'https://x.test/api/rounds',
      body: { course: 'Someone Backyard Course', date_played: '2026-07-21', total_score: 58, par: 54 },
    }),
    env,
  });
  assert.equal(res.status, 201);
  const { round } = await body(res);
  assert.equal(round.course_id, null);
  assert.equal(round.layout_id, null);
  assert.equal(round.to_par, 4, 'to-par still works off the round par snapshot');
});

test('an unknown layout is a 404, not a silent free-text round', async () => {
  const { env, token } = await setup();
  const res = await roundsCreate({
    ...ctx({
      method: 'POST',
      token,
      url: 'https://x.test/api/rounds',
      body: { layout_id: 'osm-r9999', date_played: '2026-07-21', total_score: 54 },
    }),
    env,
  });
  assert.equal(res.status, 404);
});

// ── Listing and updating ──────────────────────────────────────

test('the list endpoint exposes to_par and caps limit', async () => {
  const { env, token } = await setup();
  await roundsCreate({
    ...ctx({
      method: 'POST',
      token,
      url: 'https://x.test/api/rounds',
      body: {
        layout_id: 'osm-r3001',
        date_played: '2026-07-20',
        hole_scores: [{ number: 1, strokes: 4 }, { number: 2, strokes: 4 }, { number: 3, strokes: 4 }],
      },
    }),
    env,
  });

  const res = await roundsList({
    ...ctx({ url: 'https://x.test/api/rounds?limit=99999', token }),
    env,
  });
  const { rounds, limit } = await body(res);
  assert.equal(limit, 200, 'limit clamped rather than passed through');
  assert.equal(rounds[0].to_par, 2);
  assert.equal(rounds[0].hole_score_count, 3);
  assert.equal(rounds[0].layout_name, 'Blue (3)');
});

test('PUT is a validated partial update', async () => {
  const { env, token } = await setup();
  const created = await body(
    await roundsCreate({
      ...ctx({
        method: 'POST',
        token,
        url: 'https://x.test/api/rounds',
        body: { course: 'Maple Hill', date_played: '2026-07-01', total_score: 58, par: 54 },
      }),
      env,
    }),
  );
  const id = created.round.id;

  // Notes only. Previously this threw because `course` bound as undefined.
  const res = await roundUpdate({
    ...ctx({
      method: 'PUT',
      token,
      url: `https://x.test/api/rounds/${id}`,
      params: { id },
      body: { notes: 'headwind all day' },
    }),
    env,
  });
  assert.equal(res.status, 200);
  const { round } = await body(res);
  assert.equal(round.notes, 'headwind all day');
  assert.equal(round.course, 'Maple Hill', 'untouched fields are preserved');
  assert.equal(round.total_score, 58);

  // Empty body is a 400, not a no-op wipe.
  const empty = await roundUpdate({
    ...ctx({ method: 'PUT', token, url: `https://x.test/api/rounds/${id}`, params: { id }, body: {} }),
    env,
  });
  assert.equal(empty.status, 400);

  // Bad value rejected without touching the row.
  const bad = await roundUpdate({
    ...ctx({
      method: 'PUT',
      token,
      url: `https://x.test/api/rounds/${id}`,
      params: { id },
      body: { total_score: 'lots' },
    }),
    env,
  });
  assert.equal(bad.status, 400);
  assert.match((await body(bad)).error, /integer between 1 and 500/);
});

test("another user's round cannot be updated", async () => {
  const { env, token, DB } = await setup();
  DB.db
    .prepare('INSERT INTO users (id, username, email, password_hash) VALUES (?,?,?,?)')
    .run('u-other', 'other', 'o@x.test', 'x');
  DB.db
    .prepare(
      `INSERT INTO rounds (id, user_id, course, date_played, total_score)
       VALUES ('r-other','u-other','Their Course','2026-07-01',50)`,
    )
    .run();

  const res = await roundUpdate({
    ...ctx({
      method: 'PUT',
      token,
      url: 'https://x.test/api/rounds/r-other',
      params: { id: 'r-other' },
      body: { notes: 'hijacked' },
    }),
    env,
  });
  assert.equal(res.status, 403);
  assert.equal(DB.db.prepare("SELECT notes FROM rounds WHERE id='r-other'").get().notes, '');
});

// ── Regressions found in review ───────────────────────────────

import { onRequestGet as roundDetail } from '../functions/api/rounds/[id].js';

test('proximity search returns the nearest course even when results are truncated', async () => {
  const { env, token, DB } = await setup();

  // 200 courses inside the search window, named so they sort late, plus one
  // very close course named 'Zzz Nearby' — which sorts last of all.
  //
  // The bug: the query ordered by name and truncated to the SQL limit, and only
  // then sorted the survivors by distance. In a dense region the closest course
  // was cut before the distance sort ever saw it.
  for (let i = 0; i < 200; i++) {
    DB.db
      .prepare('INSERT INTO courses (id,name,lat,lng,source) VALUES (?,?,?,?,?)')
      .run(`bulk-${i}`, `Aaa Course ${String(i).padStart(3, '0')}`, 36.1 + (i + 1) * 0.002, -115.1, 'user');
  }
  DB.db
    .prepare('INSERT INTO courses (id,name,lat,lng,source) VALUES (?,?,?,?,?)')
    .run('nearest', 'Zzz Nearby', 36.1001, -115.1001, 'user');

  const res = await coursesList({
    ...ctx({ url: 'https://x.test/api/courses?lat=36.1&lng=-115.1&radius=60&limit=5', token }),
    env,
  });
  const { courses: found } = await body(res);
  assert.equal(found[0].id, 'nearest', 'the closest course must come back first');
  assert.equal(found.length, 5);
  // And the ordering is genuinely by distance, not by name.
  const d = found.map((c) => c.distance_km);
  assert.deepEqual(d, [...d].sort((a, b) => a - b));
});

test('a longitude window crossing the antimeridian still returns results', async () => {
  const { env, token, DB } = await setup();
  DB.db
    .prepare('INSERT INTO courses (id,name,lat,lng,source) VALUES (?,?,?,?,?)')
    .run('fiji', 'Suva Disc Golf', -18.14, 178.44, 'user');

  const res = await coursesList({
    ...ctx({ url: 'https://x.test/api/courses?lat=-18.14&lng=179.9&radius=200', token }),
    env,
  });
  assert.equal(res.status, 200);
  const { courses: found } = await body(res);
  // A naive `lng BETWEEN 179.9-d AND 179.9+d` produces an upper bound past 180
  // and matches nothing; dropping the bound near the wrap keeps it correct.
  assert.ok(found.some((c) => c.id === 'fiji'), 'course across the wrap should be found');
});

test('GET /api/rounds/:id returns the saved scorecard', async () => {
  const { env, token } = await setup();
  const created = await body(
    await roundsCreate({
      ...ctx({
        method: 'POST',
        token,
        url: 'https://x.test/api/rounds',
        body: {
          layout_id: 'osm-r3001',
          date_played: '2026-07-20',
          notes: 'gusty',
          hole_scores: [
            { number: 1, strokes: 2 },
            { number: 2, strokes: 4 },
            { number: 3, strokes: 5 },
          ],
        },
      }),
      env,
    }),
  );
  const id = created.round.id;

  const res = await roundDetail({
    ...ctx({ token, url: `https://x.test/api/rounds/${id}`, params: { id } }),
    env,
  });
  assert.equal(res.status, 200);
  const { round, hole_scores } = await body(res);

  assert.equal(round.total_score, 11);
  assert.equal(round.to_par, 1);
  assert.equal(round.layout_name, 'Blue (3)');
  assert.equal(round.layout_hole_count, 3);
  assert.equal(round.notes, 'gusty');

  assert.equal(hole_scores.length, 3);
  assert.equal(hole_scores[0].number, 1);
  assert.equal(hole_scores[0].strokes, 2);
  assert.equal(hole_scores[0].par, 3);
  assert.equal(hole_scores[0].to_par, -1, 'a birdie');
  assert.equal(hole_scores[0].distance_m, 92, 'hole geometry joined in');
  assert.ok(Array.isArray(hole_scores[0].path), 'path available for the diagram');
});

test('a round detail request for someone else\'s round is refused', async () => {
  const { env, token, DB } = await setup();
  DB.db
    .prepare('INSERT INTO users (id,username,email,password_hash) VALUES (?,?,?,?)')
    .run('u-other', 'other', 'o@x.test', 'x');
  DB.db
    .prepare(
      `INSERT INTO rounds (id,user_id,course,date_played,total_score)
       VALUES ('r-other','u-other','Their Course','2026-07-01',50)`,
    )
    .run();

  const res = await roundDetail({
    ...ctx({ token, url: 'https://x.test/api/rounds/r-other', params: { id: 'r-other' } }),
    env,
  });
  assert.equal(res.status, 403);

  const missing = await roundDetail({
    ...ctx({ token, url: 'https://x.test/api/rounds/nope', params: { id: 'nope' } }),
    env,
  });
  assert.equal(missing.status, 404);
});

test('a round with no scorecard returns an empty hole_scores array', async () => {
  const { env, token } = await setup();
  const created = await body(
    await roundsCreate({
      ...ctx({
        method: 'POST',
        token,
        url: 'https://x.test/api/rounds',
        body: { course: 'Off Catalog', date_played: '2026-07-02', total_score: 58, par: 54 },
      }),
      env,
    }),
  );
  const id = created.round.id;
  const { hole_scores, round } = await body(
    await roundDetail({ ...ctx({ token, url: `https://x.test/api/rounds/${id}`, params: { id } }), env }),
  );
  assert.equal(hole_scores.length, 0);
  assert.equal(round.to_par, 4);
});

test('a missing JWT_SECRET fails closed with a clear error, not a silent weak key', async () => {
  // Verified behavior, not an assumption: with env.JWT_SECRET undefined,
  // encoder.encode(undefined) produces zero bytes (encode()'s argument
  // defaults to "" per spec), and crypto.subtle.importKey rejects a
  // zero-length HMAC key outright. This confirms the failure is loud (every
  // auth request 500s) rather than quiet (tokens signed with a guessable
  // default), which is the property that actually matters for deploy safety.
  const { signJwt } = await import('../functions/lib/auth.js');
  await assert.rejects(
    () => signJwt({ sub: 'x', exp: Math.floor(Date.now() / 1000) + 60 }, undefined),
    /Zero-length key is not supported/,
  );
});
