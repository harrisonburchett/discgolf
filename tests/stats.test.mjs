import { test } from 'node:test';
import assert from 'node:assert/strict';

import { FakeD1 } from './helpers/d1-shim.mjs';
import { signJwt } from '../functions/lib/auth.js';
import { onRequestGet as stats } from '../functions/api/stats.js';

const JWT_SECRET = 'test-secret-not-a-real-one';
const USER_ID = 'u-harrison';

async function setup() {
  const DB = new FakeD1();
  DB.db
    .prepare('INSERT INTO users (id, username, email, password_hash) VALUES (?,?,?,?)')
    .run(USER_ID, 'harrison', 'h@x.test', 'x');
  const token = await signJwt(
    { sub: USER_ID, username: 'harrison', exp: Math.floor(Date.now() / 1000) + 3600 },
    JWT_SECRET,
  );
  return { env: { DB, JWT_SECRET }, token, DB };
}

async function call(env, token) {
  const res = await stats({
    request: new Request('https://x.test/api/stats', {
      headers: { Authorization: `Bearer ${token}` },
    }),
    env,
    data: {},
  });
  return JSON.parse(await res.text());
}

/** A course + layout with a known par, so rounds can attach to it. */
function seedLayout(DB, { courseId, layoutId, name, par, holes = [] }) {
  DB.db
    .prepare('INSERT INTO courses (id,name,lat,lng,source) VALUES (?,?,?,?,?)')
    .run(courseId, name, 36.1, -115.1, 'user');
  DB.db
    .prepare(
      'INSERT INTO layouts (id,course_id,name,hole_count,total_par,is_default,source) VALUES (?,?,?,?,?,1,?)',
    )
    .run(layoutId, courseId, `${name} main`, holes.length || 18, par, 'user');
  for (const h of holes) {
    DB.db
      .prepare('INSERT INTO holes (id,layout_id,number,par) VALUES (?,?,?,?)')
      .run(`${layoutId}-h${h.number}`, layoutId, h.number, h.par);
  }
}

let dayCounter = 1;
function addRound(DB, { id, courseId = null, layoutId = null, course, score, par = null, holeScores = null }) {
  const date = `2026-01-${String(dayCounter++).padStart(2, '0')}`;
  DB.db
    .prepare(
      `INSERT INTO rounds (id,user_id,course_id,layout_id,course,date_played,total_score,par)
       VALUES (?,?,?,?,?,?,?,?)`,
    )
    .run(id, USER_ID, courseId, layoutId, course, date, score, par);
  for (const h of holeScores || []) {
    DB.db
      .prepare(
        'INSERT INTO hole_scores (round_id,hole_id,hole_number,par,strokes) VALUES (?,?,?,?,?)',
      )
      .run(id, layoutId ? `${layoutId}-h${h.number}` : null, h.number, h.par, h.strokes);
  }
}

// ── Empty state ───────────────────────────────────────────────

test('no rounds returns a fully-formed empty shape', async () => {
  const { env, token } = await setup();
  const s = await call(env, token);
  assert.equal(s.totalRounds, 0);
  assert.equal(s.basis, 'none');
  assert.deepEqual(s.trend, []);
  assert.deepEqual(s.perCourse, []);
  assert.equal(s.toPar, null);
  assert.equal(s.holeStats, null);
  assert.equal(s.improvement, null);
});

// ── The core fix ──────────────────────────────────────────────

test('improvement is measured relative to par, not raw totals', async () => {
  const { env, token, DB } = await setup();
  dayCounter = 1;
  seedLayout(DB, { courseId: 'c-hard', layoutId: 'l-hard', name: 'Hard Hill', par: 72 });
  seedLayout(DB, { courseId: 'c-easy', layoutId: 'l-easy', name: 'Easy Park', par: 54 });

  // Six rounds on the hard course at +6, then six on the easy course at +6.
  // Raw totals plunge from 78 to 60. Actual performance is identical.
  for (let i = 0; i < 6; i++) {
    addRound(DB, { id: `h${i}`, courseId: 'c-hard', layoutId: 'l-hard', course: 'Hard Hill', score: 78 });
  }
  for (let i = 0; i < 6; i++) {
    addRound(DB, { id: `e${i}`, courseId: 'c-easy', layoutId: 'l-easy', course: 'Easy Park', score: 60 });
  }

  const s = await call(env, token);
  assert.equal(s.basis, 'toPar');
  assert.equal(s.toPar.improvement, 0, 'no real improvement, and the stats say so');
  assert.equal(s.improvement, 0, 'headline improvement uses the par basis');

  // The raw basis is still reported, and still shows the misleading number —
  // which is exactly why it is not the headline.
  assert.equal(s.recentAverage, 60);
  assert.equal(s.previousAverage, 78);
  assert.equal(s.toPar.average, 6);
  assert.equal(s.toPar.best, 6);
});

test('comparison windows are equal sized', async () => {
  const { env, token, DB } = await setup();
  dayCounter = 1;
  seedLayout(DB, { courseId: 'c1', layoutId: 'l1', name: 'Course One', par: 54 });
  // 15 rounds: the old code compared the last 10 against the previous 5.
  for (let i = 0; i < 15; i++) {
    addRound(DB, { id: `r${i}`, courseId: 'c1', layoutId: 'l1', course: 'Course One', score: 60 });
  }
  const s = await call(env, token);
  assert.equal(s.comparisonWindow, 7, 'floor(15/2), so both windows are the same size');
});

test('improvement stays null until there are enough rounds to compare', async () => {
  const { env, token, DB } = await setup();
  dayCounter = 1;
  seedLayout(DB, { courseId: 'c1', layoutId: 'l1', name: 'Course One', par: 54 });
  for (let i = 0; i < 5; i++) {
    addRound(DB, { id: `r${i}`, courseId: 'c1', layoutId: 'l1', course: 'Course One', score: 58 });
  }
  const s = await call(env, token);
  assert.equal(s.totalRounds, 5);
  assert.equal(s.comparisonWindow, null, 'floor(5/2)=2 is below the 3-round minimum');
  assert.equal(s.improvement, null);
  assert.equal(s.toPar.average, 4, 'averages still reported; only the comparison is withheld');
});

test('a genuine improvement is reported on the par basis', async () => {
  const { env, token, DB } = await setup();
  dayCounter = 1;
  seedLayout(DB, { courseId: 'c1', layoutId: 'l1', name: 'Course One', par: 54 });
  for (let i = 0; i < 4; i++) {
    addRound(DB, { id: `old${i}`, courseId: 'c1', layoutId: 'l1', course: 'Course One', score: 62 });
  }
  for (let i = 0; i < 4; i++) {
    addRound(DB, { id: `new${i}`, courseId: 'c1', layoutId: 'l1', course: 'Course One', score: 57 });
  }
  const s = await call(env, token);
  assert.equal(s.basis, 'toPar');
  assert.equal(s.toPar.previousAverage, 8);
  assert.equal(s.toPar.recentAverage, 3);
  assert.equal(s.improvement, 5, 'positive means improving');
});

// ── Par coverage and basis selection ──────────────────────────

test('mostly par-less rounds fall back to the raw basis', async () => {
  const { env, token, DB } = await setup();
  dayCounter = 1;
  seedLayout(DB, { courseId: 'c1', layoutId: 'l1', name: 'Course One', par: 54 });
  addRound(DB, { id: 'withpar', courseId: 'c1', layoutId: 'l1', course: 'Course One', score: 58 });
  for (let i = 0; i < 9; i++) {
    addRound(DB, { id: `bare${i}`, course: 'Some Field', score: 55 });
  }
  const s = await call(env, token);
  assert.equal(s.basis, 'raw', 'one par-tagged round must not flip the basis');
  assert.equal(s.parCoverage.withPar, 1);
  assert.equal(s.parCoverage.total, 10);
  assert.equal(s.parCoverage.fraction, 10);
});

test('a round with a par snapshot but no layout still counts toward par stats', async () => {
  const { env, token, DB } = await setup();
  dayCounter = 1;
  for (let i = 0; i < 8; i++) {
    addRound(DB, { id: `legacy${i}`, course: 'Legacy Course', score: 58, par: 54 });
  }
  const s = await call(env, token);
  assert.equal(s.basis, 'toPar');
  assert.equal(s.parCoverage.withPar, 8, 'COALESCE picks up the round-level par');
  assert.equal(s.toPar.average, 4);
});

test('an average of zero is reported as zero, not null', async () => {
  const { env, token, DB } = await setup();
  dayCounter = 1;
  seedLayout(DB, { courseId: 'c1', layoutId: 'l1', name: 'Course One', par: 54 });
  // Exactly par every round: to-par averages are 0 on both sides.
  for (let i = 0; i < 8; i++) {
    addRound(DB, { id: `r${i}`, courseId: 'c1', layoutId: 'l1', course: 'Course One', score: 54 });
  }
  const s = await call(env, token);
  assert.equal(s.toPar.previousAverage, 0);
  assert.equal(s.toPar.recentAverage, 0);
  assert.notEqual(s.toPar.previousAverage, null, 'the old truthiness bug would null this out');
});

// ── Per-course grouping ───────────────────────────────────────

test('per-course groups on course_id, not on the display name', async () => {
  const { env, token, DB } = await setup();
  dayCounter = 1;
  seedLayout(DB, { courseId: 'c1', layoutId: 'l1', name: 'Maple Hill', par: 54 });
  // Same catalog course, different free-text names on the rounds.
  addRound(DB, { id: 'a', courseId: 'c1', layoutId: 'l1', course: 'Maple Hill', score: 58 });
  addRound(DB, { id: 'b', courseId: 'c1', layoutId: 'l1', course: 'maple hill', score: 56 });
  addRound(DB, { id: 'c', course: 'Somewhere Else', score: 60, par: 54 });

  const s = await call(env, token);
  assert.equal(s.perCourse.length, 2, 'two catalog spellings collapse into one row');
  const maple = s.perCourse.find((c) => c.course_id === 'c1');
  assert.equal(maple.rounds, 2);
  assert.equal(maple.best, 56);
  assert.equal(maple.bestToPar, 2);
  assert.equal(maple.averageToPar, 3);
});

// ── Hole-level insights ───────────────────────────────────────

test('hole stats break down outcomes, par types, and per-hole difficulty', async () => {
  const { env, token, DB } = await setup();
  dayCounter = 1;
  const holes = [
    { number: 1, par: 3 },
    { number: 2, par: 3 },
    { number: 3, par: 4 },
    { number: 4, par: 5 },
  ];
  seedLayout(DB, { courseId: 'c1', layoutId: 'l1', name: 'Course One', par: 15, holes });

  // Hole 2 is consistently a disaster; hole 4 is consistently a birdie.
  for (let i = 0; i < 4; i++) {
    addRound(DB, {
      id: `r${i}`,
      courseId: 'c1',
      layoutId: 'l1',
      course: 'Course One',
      score: 17,
      holeScores: [
        { number: 1, par: 3, strokes: 3 }, // par
        { number: 2, par: 3, strokes: 5 }, // double
        { number: 3, par: 4, strokes: 5 }, // bogey
        { number: 4, par: 5, strokes: 4 }, // birdie
      ],
    });
  }

  const s = await call(env, token);
  const h = s.holeStats;
  assert.ok(h);
  assert.equal(h.holesScored, 16);
  assert.deepEqual(h.outcomes, {
    eagleOrBetter: 0,
    birdie: 4,
    par: 4,
    bogey: 4,
    doubleBogeyOrWorse: 4,
  });
  assert.equal(h.outcomeRates.birdie, 25);

  assert.deepEqual(
    h.byPar.map((p) => [p.par, p.averageToPar]),
    [[3, 1], [4, 1], [5, -1]],
    'par-3 play averages +1 (two holes: 0 and +2), par-5 play averages -1',
  );

  assert.equal(h.toughestHoles[0].hole_number, 2);
  assert.equal(h.toughestHoles[0].averageToPar, 2);
  assert.equal(h.bestHoles[0].hole_number, 4);
  assert.equal(h.bestHoles[0].averageToPar, -1);
  assert.equal(h.toughestHoles[0].plays, 4);
});

test('holes played fewer than the minimum are excluded from rankings', async () => {
  const { env, token, DB } = await setup();
  dayCounter = 1;
  seedLayout(DB, {
    courseId: 'c1',
    layoutId: 'l1',
    name: 'Course One',
    par: 6,
    holes: [{ number: 1, par: 3 }, { number: 2, par: 3 }],
  });
  // Hole 1 played 3 times; hole 2 played once with a terrible score.
  for (let i = 0; i < 3; i++) {
    addRound(DB, {
      id: `r${i}`,
      courseId: 'c1',
      layoutId: 'l1',
      course: 'Course One',
      score: 7,
      holeScores: [{ number: 1, par: 3, strokes: 4 }],
    });
  }
  addRound(DB, {
    id: 'one-off',
    courseId: 'c1',
    layoutId: 'l1',
    course: 'Course One',
    score: 12,
    holeScores: [{ number: 2, par: 3, strokes: 9 }],
  });

  const s = await call(env, token);
  assert.equal(s.holeStats.minPlaysForHoleRanking, 3);
  const ranked = s.holeStats.toughestHoles.map((x) => x.hole_number);
  assert.deepEqual(ranked, [1], 'a single catastrophic hole is not "your toughest hole"');
});

test('rounds without a scorecard leave holeStats null', async () => {
  const { env, token, DB } = await setup();
  dayCounter = 1;
  addRound(DB, { id: 'a', course: 'Somewhere', score: 58, par: 54 });
  const s = await call(env, token);
  assert.equal(s.holeStats, null);
});

test('another user\'s rounds never leak into your stats', async () => {
  const { env, token, DB } = await setup();
  dayCounter = 1;
  DB.db
    .prepare('INSERT INTO users (id,username,email,password_hash) VALUES (?,?,?,?)')
    .run('u-other', 'other', 'o@x.test', 'x');
  DB.db
    .prepare(
      `INSERT INTO rounds (id,user_id,course,date_played,total_score,par)
       VALUES ('theirs','u-other','Their Course','2026-05-05',40,54)`,
    )
    .run();
  addRound(DB, { id: 'mine', course: 'My Course', score: 58, par: 54 });

  const s = await call(env, token);
  assert.equal(s.totalRounds, 1);
  assert.equal(s.bestScore, 58, "their 40 is not my best score");
});

test('stats requires authentication', async () => {
  const { env } = await setup();
  const res = await stats({ request: new Request('https://x.test/api/stats'), env, data: {} });
  assert.equal(res.status, 401);
});

test('par-known rounds use the to-par basis even when no comparison is possible', async () => {
  const { env, token, DB } = await setup();
  dayCounter = 1;
  seedLayout(DB, { courseId: 'c1', layoutId: 'l1', name: 'Course One', par: 54 });
  // Five rounds: enough to report to-par averages, not enough for two equal
  // comparison windows. Those are separate questions, and the basis should
  // follow par coverage rather than being dragged to 'raw' by the missing
  // comparison.
  for (let i = 0; i < 5; i++) {
    addRound(DB, { id: `r${i}`, courseId: 'c1', layoutId: 'l1', course: 'Course One', score: 58 });
  }
  const s = await call(env, token);
  assert.equal(s.basis, 'toPar');
  assert.equal(s.parCoverage.fraction, 100);
  assert.equal(s.toPar.average, 4, 'to-par average is available');
  assert.equal(s.improvement, null, 'improvement is withheld separately');
  assert.equal(s.comparisonWindow, null);
});
