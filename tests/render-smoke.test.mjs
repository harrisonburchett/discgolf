// Renders the new pages through their real entry points against stub globals.
// Catches what unit tests miss: a template that throws, an unescaped value, a
// data-action that lost its data, or a page that silently renders nothing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

import { normalize } from '../shared/osm-normalize.js';

const here = dirname(fileURLToPath(import.meta.url));
const pub = join(here, '../public');

const fixture = JSON.parse(readFileSync(join(here, 'fixtures/overpass-sample.json'), 'utf8'));
const wildhorse = normalize(fixture).courses.find((c) => c.name === 'Wildhorse DiscGolfPark');

const coursePayload = {
  course: {
    id: 'osm-n1001',
    name: wildhorse.name,
    city: 'Las Vegas',
    region: 'NV',
    country: null,
    source: 'osm',
    osm_type: 'node',
    osm_id: 1001,
    osm_url: 'https://www.openstreetmap.org/node/1001',
  },
  layouts: wildhorse.layouts.map((l, i) => ({
    id: l.osm_relation_id ? `osm-r${l.osm_relation_id}` : `osm-n1001-l${i + 1}`,
    name: l.name,
    hole_count: l.hole_count,
    total_par: l.total_par,
    total_distance_m: l.total_distance_m,
    tee_colour: l.tee_colour,
    is_default: !!l.is_default,
    source: 'osm',
    holes: l.holes.map((h) => ({
      number: h.number,
      par: h.par,
      distance_m: h.distance_m,
      tee: h.tee,
      basket: h.basket,
      path: h.path,
    })),
  })),
  attribution: 'Course data © OpenStreetMap contributors, ODbL',
};

/**
 * Build a sandbox holding courses.js + scorecard.js with the handful of globals
 * they borrow from app.js stubbed out.
 */
function makeSandbox(apiImpl) {
  const state = { rendered: '', slots: {}, alerts: [], navigated: [] };

  const escapeHtml = (str) => {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  };

  // Minimal element stand-in: records innerHTML so slot rendering is inspectable.
  const makeEl = (id) => ({
    id,
    value: '',
    checked: false,
    dataset: {},
    style: {},
    set innerHTML(v) {
      state.slots[id] = v;
    },
    get innerHTML() {
      return state.slots[id] ?? '';
    },
    focus() {},
    select() {},
    addEventListener() {},
    scrollIntoView() {},
    classList: { add() {}, remove() {} },
    remove() {},
  });

  const elements = new Map();

  const sandbox = {
    ACTIONS: {},
    escapeHtml,
    formatToPar: (v) => (v === null || v === undefined ? '—' : v === 0 ? 'E' : v > 0 ? `+${v}` : String(v)),
    formatDate: (d) => d,
    setContent: (html) => {
      state.rendered = html;
    },
    navigate: (route, params) => state.navigated.push({ route, params }),
    showAlert: (m) => state.alerts.push(m),
    clearAlert: () => {},
    api: apiImpl,
    document: {
      getElementById: (id) => {
        if (!elements.has(id)) elements.set(id, makeEl(id));
        return elements.get(id);
      },
      addEventListener() {},
      readyState: 'complete',
    },
    navigator: {},
    console,
    setTimeout,
    clearTimeout,
    URLSearchParams,
  };

  vm.createContext(sandbox);
  vm.runInContext(readFileSync(join(pub, 'courses.js'), 'utf8'), sandbox);
  vm.runInContext(readFileSync(join(pub, 'scorecard.js'), 'utf8'), sandbox);
  return { sandbox, state, elements };
}

// ── Course detail ─────────────────────────────────────────────

test('course detail renders every section without throwing', async () => {
  const { sandbox, state } = makeSandbox(async () => coursePayload);
  await vm.runInContext("renderCourseDetail({ id: 'osm-n1001' })", sandbox);
  const html = state.rendered;

  assert.match(html, /Wildhorse DiscGolfPark/);
  assert.match(html, /Las Vegas, NV/);
  assert.equal((html.match(/class="layout-tab /g) || []).length, 2);
  assert.match(html, /aria-selected="true"/);
  assert.match(html, /class="course-map"/);
  assert.equal((html.match(/class="hole-card"/g) || []).length, 3);
  assert.match(html, /OpenStreetMap contributors/);
  assert.match(html, /data-action="start-round-here"/);
  assert.ok(!html.includes('${'), 'no unresolved template expression');
  assert.ok(!/NaN|Infinity/.test(html));
});

test('switching layout re-renders with the other layout selected', async () => {
  const { sandbox, state } = makeSandbox(async () => coursePayload);
  await vm.runInContext("renderCourseDetail({ id: 'osm-n1001' })", sandbox);
  vm.runInContext("selectLayout('osm-r3002')", sandbox);

  const html = state.rendered;
  // The Short 2 layout has two holes, so two cards rather than three.
  assert.equal((html.match(/class="hole-card"/g) || []).length, 2);
  assert.match(html, /aria-selected="true"[\s\S]{0,120}Short 2/);
});

// ── Add round ─────────────────────────────────────────────────

test('the round form arriving from a course page opens on a scorecard', async () => {
  const { sandbox, state } = makeSandbox(async () => coursePayload);
  await vm.runInContext(
    "renderAddRound({ courseId: 'osm-n1001', layoutId: 'osm-r3001' })",
    sandbox,
  );

  assert.match(state.rendered, /Log a round/);
  assert.match(state.slots.coursePickerSlot, /Wildhorse DiscGolfPark/);
  assert.match(state.slots.coursePickerSlot, /data-action="clear-round-course"/);

  const card = state.slots.scorecardSlot;
  assert.match(card, /class="scorecard"/);
  assert.equal((card.match(/class="score-row"/g) || []).length, 3, 'one row per hole');
  assert.equal((card.match(/data-action="bump-hole"/g) || []).length, 6, 'a pair of steppers per hole');
  assert.match(card, /data-action="set-hole" data-hole="1" data-on="input"/);
  // Par comes from the layout, so it is shown rather than asked for.
  assert.match(state.slots.parSlot, /class="static-field">10/);
});

test('a partial scorecard reports its running total honestly', async () => {
  const { sandbox, state } = makeSandbox(async () => coursePayload);
  await vm.runInContext("renderAddRound({ courseId: 'osm-n1001', layoutId: 'osm-r3001' })", sandbox);

  vm.runInContext("setHole(1, '4'); setHole(2, '3');", sandbox);
  const total = state.slots.scorecardTotal;
  assert.match(total, /class="scorecard-total-score">7</);
  assert.match(total, /2 of 3 holes — partial round/);
});

test('stepper first press adopts par, then steps from there', async () => {
  const { sandbox } = makeSandbox(async () => coursePayload);
  await vm.runInContext("renderAddRound({ courseId: 'osm-n1001', layoutId: 'osm-r3001' })", sandbox);

  // Hole 2 is par 4 in this layout.
  vm.runInContext("bumpHole(2, 1)", sandbox);
  assert.equal(vm.runInContext('addRound.strokes[2]', sandbox), 4, 'first press takes the par suggestion');
  vm.runInContext("bumpHole(2, 1)", sandbox);
  assert.equal(vm.runInContext('addRound.strokes[2]', sandbox), 5);
  vm.runInContext("bumpHole(2, -1)", sandbox);
  assert.equal(vm.runInContext('addRound.strokes[2]', sandbox), 4);
});

test('strokes are clamped to a sane range', async () => {
  const { sandbox } = makeSandbox(async () => coursePayload);
  await vm.runInContext("renderAddRound({ courseId: 'osm-n1001', layoutId: 'osm-r3001' })", sandbox);

  vm.runInContext("setHole(1, '999')", sandbox);
  assert.equal(vm.runInContext('addRound.strokes[1]', sandbox), 30, 'upper clamp');

  vm.runInContext("setHole(1, '3'); for (let i=0;i<10;i++) bumpHole(1, -1);", sandbox);
  assert.equal(vm.runInContext('addRound.strokes[1]', sandbox), 1, 'never below one stroke');

  vm.runInContext("setHole(1, 'abc')", sandbox);
  assert.equal(vm.runInContext('addRound.strokes[1]', sandbox), undefined, 'junk clears the hole');
});

test('switching to manual entry drops the layout and asks for a total', async () => {
  const { sandbox, state } = makeSandbox(async () => coursePayload);
  await vm.runInContext("renderAddRound({ courseId: 'osm-n1001', layoutId: 'osm-r3001' })", sandbox);
  vm.runInContext("setRoundMode('manual')", sandbox);

  assert.match(state.slots.coursePickerSlot, /id="roundCourse"/);
  assert.match(state.slots.scorecardSlot, /id="roundScore"/);
  assert.ok(!state.slots.scorecardSlot.includes('class="scorecard"'));
  assert.equal(vm.runInContext('addRound.layoutId', sandbox), null);
  // Par becomes an input again, since nothing else can supply it.
  assert.match(state.slots.parSlot, /id="roundPar"/);
});

test('a course with no mapped holes falls back to a total', async () => {
  const bare = {
    course: { id: 'c-bare', name: 'Unmapped Park', source: 'user', osm_url: null },
    layouts: [],
    attribution: null,
  };
  const { sandbox, state } = makeSandbox(async () => bare);
  await vm.runInContext("renderAddRound({ courseId: 'c-bare' })", sandbox);

  assert.match(state.slots.scorecardSlot, /id="roundScore"/);
  assert.ok(!state.slots.scorecardSlot.includes('data-action="toggle-scorecard"'),
    'no offer to score hole by hole when there are no holes');
});

// ── Round detail ──────────────────────────────────────────────

test('round detail renders a saved scorecard', async () => {
  const roundPayload = {
    round: {
      id: 'r1',
      course: 'Wildhorse DiscGolfPark',
      course_name: 'Wildhorse DiscGolfPark',
      course_id: 'osm-n1001',
      layout_name: 'Blue (3)',
      layout_hole_count: 3,
      date_played: '2026-07-20',
      total_score: 11,
      effective_par: 10,
      to_par: 1,
      notes: 'gusty crosswind',
    },
    hole_scores: [
      { number: 1, strokes: 2, par: 3, to_par: -1, distance_m: 92, path: wildhorse.layouts[0].holes[0].path },
      { number: 2, strokes: 4, par: 4, to_par: 0, distance_m: 125, path: null },
      { number: 3, strokes: 5, par: 3, to_par: 2, distance_m: 60, path: null },
    ],
  };
  const { sandbox, state } = makeSandbox(async () => roundPayload);
  await vm.runInContext("renderRoundDetail({ id: 'r1' })", sandbox);
  const html = state.rendered;

  assert.match(html, /class="round-summary-total">11</);
  assert.match(html, /class="round-summary-diff over">\+1</);
  assert.match(html, /gusty crosswind/);
  assert.equal((html.match(/class="hole-card"/g) || []).length, 3);
  assert.match(html, /class="played-diff under">-1</, 'the birdie is marked under par');
  assert.match(html, /class="played-diff even">E</);
  assert.match(html, /No map data/, 'holes without geometry degrade gracefully');
  assert.match(html, /data-action="navigate" data-route="course" data-id="osm-n1001"/);
  assert.ok(!html.includes('${'));
});

test('a total-only round says so instead of showing an empty card grid', async () => {
  const { sandbox, state } = makeSandbox(async () => ({
    round: {
      id: 'r2', course: 'Off Catalog', course_name: null, course_id: null,
      layout_name: null, layout_hole_count: null, date_played: '2026-07-02',
      total_score: 58, effective_par: 54, to_par: 4, notes: '',
    },
    hole_scores: [],
  }));
  await vm.runInContext("renderRoundDetail({ id: 'r2' })", sandbox);
  const html = state.rendered;

  assert.match(html, /No hole-by-hole scores/);
  assert.match(html, /Off Catalog/);
  assert.match(html, /class="round-summary-diff over">\+4</);
  assert.ok(!html.includes('class="hole-card"'));
  assert.ok(!html.includes('View course'), 'no course link when the round has no course_id');
});

// ── Hostile input ─────────────────────────────────────────────

test('a hostile course name cannot inject markup or break an attribute', async () => {
  const hostile = structuredClone(coursePayload);
  hostile.course.id = `x" onmouseover="alert(1)`;
  hostile.course.name = `<img src=x onerror=alert(1)>'"`;

  const { sandbox, state } = makeSandbox(async () => hostile);
  await vm.runInContext("renderCourseDetail({ id: 'evil' })", sandbox);
  const html = state.rendered;

  // No element was created: the angle brackets are entities.
  assert.ok(!/<img/i.test(html), 'no img element injected');
  assert.ok(!/<script/i.test(html), 'no script element injected');
  assert.match(html, /&lt;img/, 'the payload is present but inert, as escaped text');

  // No attribute boundary was created either. Every raw double quote in the
  // output must be a delimiter we emitted, so quotes from the payload have to
  // arrive as &quot;.
  assert.match(html, /&quot;/, 'payload quotes are escaped');
  assert.ok(
    !/data-id="[^"]*"\s+on\w+=/i.test(html),
    'no handler attribute smuggled in after a data attribute',
  );
});

test('a hostile course name in search results is escaped', async () => {
  const { sandbox, state } = makeSandbox(async () => ({
    courses: [
      {
        id: `a" data-x="y`,
        name: `</button><script>alert(1)</script>`,
        city: null,
        region: null,
        hole_count: 9,
        layout_count: 1,
        has_map: true,
      },
    ],
    attribution: null,
  }));

  vm.runInContext("renderCourses()", sandbox);
  sandbox.document.getElementById('courseQuery').value = 'test';
  await vm.runInContext("runCourseSearch()", sandbox);

  const html = state.slots.courseResults;
  assert.ok(!/<script/i.test(html), 'script tag escaped');
  assert.ok(!html.includes('</button><'), 'cannot close the surrounding button early');
  assert.match(html, /&lt;\/button&gt;/);
  // The button markup is still well formed: one open, one close.
  assert.equal((html.match(/<button/g) || []).length, 1);
  assert.equal((html.match(/<\/button>/g) || []).length, 1);
});
