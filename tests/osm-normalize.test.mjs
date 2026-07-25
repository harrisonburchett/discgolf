import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  normalize,
  buildOverpassQuery,
  parseDistanceM,
  looksLikeHoleLabel,
  haversineM,
  courseId,
} from '../shared/osm-normalize.js';
import { statementsForCourses, renderSql } from '../shared/osm-sql.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(join(here, 'fixtures/overpass-sample.json'), 'utf8'));

const result = normalize(fixture);
const byName = (n) => result.courses.find((c) => c.name === n);
const warnKinds = () => result.warnings.map((w) => w.kind);

// ── Query builder ─────────────────────────────────────────────

test('buildOverpassQuery covers every consumed tag', () => {
  const q = buildOverpassQuery();
  for (const frag of [
    '"leisure"="disc_golf_course"',
    '"disc_golf"="hole"',
    '"disc_golf"="tee"',
    '"disc_golf"="basket"',
    '"type"="disc_golf_layout"',
    'out geom qt;',
  ]) {
    assert.ok(q.includes(frag), `missing ${frag}`);
  }
});

test('buildOverpassQuery supports bbox, ISO area, and incremental filters', () => {
  assert.match(buildOverpassQuery({ bbox: [36, -116, 37, -114] }), /\[bbox:36,-116,37,-114\]/);

  const iso = buildOverpassQuery({ iso: 'US' });
  assert.match(iso, /area\["ISO3166-1"="US"\]/);
  assert.match(iso, /\(area\.searchArea\)/);

  assert.match(buildOverpassQuery({ newerThan: '2026-07-01T00:00:00Z' }), /\(newer:"2026-07-01T00:00:00Z"\)/);
  assert.throws(() => buildOverpassQuery({ bbox: [1, 2, 3, 4], iso: 'US' }), /not both/);
});

// ── Tag parsing ───────────────────────────────────────────────

test('parseDistanceM handles units, decimal commas, and junk', () => {
  assert.equal(parseDistanceM('92'), 92);
  assert.equal(parseDistanceM('92 m'), 92);
  assert.equal(parseDistanceM('91,5'), 92);
  assert.equal(parseDistanceM('410 ft'), 125);
  assert.equal(parseDistanceM('100 yd'), 91);
  assert.equal(parseDistanceM('not-a-number'), null);
  assert.equal(parseDistanceM(''), null);
  assert.equal(parseDistanceM(null), null);
  assert.equal(parseDistanceM('0'), null, 'zero-length hole is nonsense');
  assert.equal(parseDistanceM('50000'), null, 'implausible length rejected, not stored wrong');
});

test('looksLikeHoleLabel catches multilingual hole labels but not real names', () => {
  for (const n of ['3', '#7', 'Hole 1', 'hole 12', 'Hull 1', 'Håll 9', 'Väylä 4', 'Reikä 2', 'Basket 5']) {
    assert.ok(looksLikeHoleLabel(n), `should flag ${n}`);
  }
  for (const n of ['Wildhorse DiscGolfPark', 'Sunset Park', 'Maple Hill', 'Course 18 Holes at Foo', null]) {
    assert.ok(!looksLikeHoleLabel(n), `should not flag ${n}`);
  }
});

test('haversineM is sane', () => {
  assert.equal(Math.round(haversineM(36.15, -115.2, 36.15, -115.2)), 0);
  const d = haversineM(36.15, -115.2, 36.1508, -115.1994);
  assert.ok(d > 80 && d < 120, `expected ~100m, got ${d}`);
});

// ── Layout relations ──────────────────────────────────────────

test('hole number comes from relation member order, not from ref', () => {
  const wildhorse = byName('Wildhorse DiscGolfPark');
  assert.ok(wildhorse);

  const blue = wildhorse.layouts.find((l) => l.name === 'Blue (3)');
  const short = wildhorse.layouts.find((l) => l.name === 'Short 2');
  assert.ok(blue && short, 'both layout relations became layouts');

  assert.deepEqual(
    blue.holes.map((h) => [h.number, h.osm_way_id]),
    [[1, 2001], [2, 2002], [3, 2003]],
  );

  // Same ways, different order -> different hole numbers. This is the whole
  // reason numbering cannot come from ref=*.
  assert.deepEqual(
    short.holes.map((h) => [h.number, h.osm_way_id]),
    [[1, 2003], [2, 2001]],
  );

  assert.equal(blue.hole_order_trusted, true);
  assert.equal(blue.tee_colour, 'blue');
  assert.equal(short.tee_colour, 'white');
});

test('a way shared between layouts gets a distinct hole id per layout', () => {
  const wildhorse = byName('Wildhorse DiscGolfPark');
  const stmts = statementsForCourses([wildhorse]);
  const holeIds = stmts
    .filter((s) => s.sql.startsWith('INSERT INTO holes'))
    .map((s) => s.params[0]);
  assert.equal(new Set(holeIds).size, holeIds.length, 'hole ids must be unique across layouts');
  assert.ok(holeIds.some((id) => id.startsWith('osm-r3001-h')));
  assert.ok(holeIds.some((id) => id.startsWith('osm-r3002-h')));
});

test('the layout with the most holes becomes the default', () => {
  const wildhorse = byName('Wildhorse DiscGolfPark');
  const defaults = wildhorse.layouts.filter((l) => l.is_default);
  assert.equal(defaults.length, 1);
  assert.equal(defaults[0].name, 'Blue (3)');
});

test('declared disc_golf:course wins over inferred hole count', () => {
  assert.equal(byName('Wildhorse DiscGolfPark').hole_count, 18);
});

test('par defaults to 3 and unparseable distances become null, not garbage', () => {
  const blue = byName('Wildhorse DiscGolfPark').layouts.find((l) => l.name === 'Blue (3)');
  const [h1, h2, h3] = blue.holes;
  assert.equal(h1.par, 3);
  assert.equal(h1.distance_m, 92);
  assert.equal(h2.par, 4);
  assert.equal(h2.distance_m, 125, '410 ft converted to metres');
  assert.equal(h3.par, 3, 'untagged par assumed');
  assert.equal(h3.par_is_assumed, true);
  // dist=not-a-number is unusable, so the drawn geometry is measured instead.
  assert.ok(h3.distance_m > 0 && h3.distance_m < 200);
  assert.equal(blue.total_par, 10);
});

// ── Proximity fallback ────────────────────────────────────────

test('a course with no layout relation uses complete ref numbering', () => {
  const sunset = byName('Sunset Park');
  assert.equal(sunset.layouts.length, 1);
  const l = sunset.layouts[0];
  assert.equal(l.hole_order_trusted, true, 'unique complete refs are trustworthy');
  assert.deepEqual(l.holes.map((h) => [h.number, h.osm_way_id]), [[1, 2011], [2, 2010]]);
  assert.equal(l.name, 'Main (2)');
});

test('missing refs fall back to a nearest-neighbour walk and are flagged', () => {
  const craig = byName('Craig Ranch');
  const l = craig.layouts[0];
  assert.equal(l.hole_order_trusted, false);
  // Hole 2021 sits ~30m from the course point, 2020 ~300m; the walk starts near.
  assert.deepEqual(l.holes.map((h) => h.osm_way_id), [2021, 2020]);
  assert.ok(
    result.warnings.some((w) => w.kind === 'inferred_hole_order' && w.name === 'Craig Ranch'),
    'provisional ordering must be reported, not presented as fact',
  );
});

// ── Data-quality handling ─────────────────────────────────────

test('a course named like a hole is skipped', () => {
  assert.equal(byName('Hole 3'), undefined);
  assert.ok(warnKinds().includes('course_name_is_hole_label'));
});

test('the same course mapped twice is deduped, keeping the object with the holes', () => {
  const matches = result.courses.filter((c) => /wildhorse/i.test(c.name));
  assert.equal(matches.length, 1, 'node + way for one venue collapses to one course');
  assert.equal(matches[0].osm_type, 'node');
  const dup = result.warnings.find((w) => w.kind === 'duplicate_course');
  assert.ok(dup);
  assert.equal(dup.osm, 'way/2500');
});

test('a hole with no course nearby is reported, not silently attached', () => {
  const orphan = result.warnings.find((w) => w.kind === 'orphan_holes');
  assert.ok(orphan);
  assert.equal(orphan.count, 1);
  assert.deepEqual(orphan.sample, ['way/2600']);
});

test('an unnamed course is kept with a placeholder and flagged', () => {
  const unnamed = result.courses.find((c) => courseId(c) === 'osm-n1005');
  assert.ok(unnamed, 'unnamed courses are still useful catalog entries');
  assert.equal(unnamed.name, 'Unnamed course');
  assert.equal(unnamed.layouts.length, 0, 'no holes, so no layout');
  assert.ok(warnKinds().includes('course_without_name'));
});

test('stats distinguish catalog entries from mapped courses', () => {
  const s = result.stats;
  assert.equal(s.courses, 4, 'Wildhorse, Sunset, Craig Ranch, unnamed');
  assert.equal(s.coursesWithHoleGeometry, 3);
  assert.equal(s.layoutRelations, 2);
  assert.equal(s.holesInSource, 8);
});

test('normalize tolerates empty and malformed input', () => {
  for (const input of [{}, { elements: [] }, null, undefined, { elements: 'nope' }]) {
    const r = normalize(input);
    assert.deepEqual(r.courses, []);
    assert.equal(r.stats.courses, 0);
  }
});

// ── SQL generation ────────────────────────────────────────────

test('every generated statement has matching placeholders and params', () => {
  for (const { sql, params } of statementsForCourses(result.courses)) {
    assert.equal(
      (sql.match(/\?/g) || []).length,
      params.length,
      `mismatch in: ${sql.slice(0, 80)}`,
    );
  }
});

test('renderSql escapes quotes rather than breaking out of the literal', () => {
  const nasty = {
    osm_type: 'node',
    osm_id: 9,
    osm_version: 1,
    name: "Bob's Park'); DROP TABLE courses;--",
    lat: 1,
    lng: 2,
    city: null,
    region: null,
    country: null,
    hole_count: 9,
    layouts: [],
  };
  const sql = renderSql(statementsForCourses([nasty]));
  assert.ok(sql.includes("'Bob''s Park''); DROP TABLE courses;--'"));
  // One statement per line, and the payload never terminates its literal early.
  assert.equal(sql.split('\n').filter(Boolean).length, 2, 'upsert + layout cleanup');
});

test('renderSql produces a valid decimal for every numeric column', () => {
  const sql = renderSql(statementsForCourses(result.courses));
  assert.ok(!/\bNaN\b|\bInfinity\b|\bundefined\b/.test(sql));
});

test('every write is guarded against clobbering user edits', () => {
  const stmts = statementsForCourses(result.courses);
  const courseUpserts = stmts.filter((s) => s.sql.startsWith('INSERT INTO courses'));
  const layoutUpserts = stmts.filter((s) => s.sql.startsWith('INSERT INTO layouts'));
  assert.ok(courseUpserts.length > 0 && layoutUpserts.length > 0);
  for (const s of [...courseUpserts, ...layoutUpserts]) {
    assert.match(s.sql, /locked = 0/, 'upsert must respect the lock flag');
  }
});
