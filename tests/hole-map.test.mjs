// courses.js is a plain script, not a module — it has to be, since the frontend
// has no build step. Loading it in a vm context with stub globals lets the pure
// geometry be tested without pulling in jsdom or a bundler.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '../public/courses.js'), 'utf8');

const sandbox = {
  // courses.js registers delegated handlers at the end of the file.
  ACTIONS: {},
  // Only what the geometry paths actually touch.
  escapeHtml: (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`),
  api: async () => ({ courses: [] }),
  setContent: () => {},
  navigate: () => {},
  showAlert: () => {},
  document: { getElementById: () => null },
  navigator: {},
  console,
};
vm.createContext(sandbox);
vm.runInContext(src, sandbox);

const { toLocalMetres, fitToBox, holeDiagram, courseDiagram } = sandbox;

// ── Projection ────────────────────────────────────────────────

test('toLocalMetres centres on the input and scales longitude by latitude', () => {
  // Two points 0.001 deg apart in latitude ≈ 110.6m.
  const pts = toLocalMetres([
    [36.0, -115.0],
    [36.001, -115.0],
  ]);
  assert.equal(pts.length, 2);
  const dy = pts[1].y - pts[0].y;
  assert.ok(Math.abs(dy - 110.57) < 0.5, `expected ~110.6m, got ${dy}`);

  // Centred: the mean of the projected points is the origin.
  const meanY = (pts[0].y + pts[1].y) / 2;
  assert.ok(Math.abs(meanY) < 1e-9);

  // At latitude 36 a degree of longitude is ~90km, not ~111km.
  const lng = toLocalMetres([
    [36.0, -115.0],
    [36.0, -114.999],
  ]);
  const dx = lng[1].x - lng[0].x;
  assert.ok(Math.abs(dx - 90.1) < 1.0, `expected ~90m, got ${dx}`);
});

test('toLocalMetres tolerates empty and single-point input', () => {
  // Arrays built inside the vm realm don't satisfy deepEqual's prototype check,
  // so assert on shape rather than identity.
  assert.equal(toLocalMetres([]).length, 0);
  assert.equal(toLocalMetres(null).length, 0);
  assert.equal(toLocalMetres(undefined).length, 0);
  const one = toLocalMetres([[36, -115]]);
  assert.equal(one.length, 1);
  assert.ok(Math.abs(one[0].x) < 1e-9 && Math.abs(one[0].y) < 1e-9);
});

// ── Box fitting ───────────────────────────────────────────────

test('fitToBox keeps points inside the box with padding', () => {
  const local = toLocalMetres([
    [36.0, -115.0],
    [36.0008, -115.0004],
    [36.0015, -115.0002],
  ]);
  const { points } = fitToBox(local, 200, 150, 20);
  for (const p of points) {
    assert.ok(p.x >= 19 && p.x <= 181, `x out of box: ${p.x}`);
    assert.ok(p.y >= 19 && p.y <= 131, `y out of box: ${p.y}`);
  }
});

test('fitToBox survives a perfectly straight hole without dividing by zero', () => {
  // Zero longitude span — the naive scale computation would be Infinity.
  const local = toLocalMetres([
    [36.0, -115.0],
    [36.001, -115.0],
  ]);
  const { points, scale } = fitToBox(local, 200, 150);
  assert.ok(Number.isFinite(scale) && scale > 0);
  for (const p of points) {
    assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y));
  }
  // Both points sit on the vertical centre line.
  assert.ok(Math.abs(points[0].x - 100) < 0.01);
  assert.ok(Math.abs(points[1].x - 100) < 0.01);
});

test('fitToBox handles a degenerate single-location path', () => {
  const local = toLocalMetres([
    [36.0, -115.0],
    [36.0, -115.0],
  ]);
  const { points, scale } = fitToBox(local, 200, 150);
  assert.ok(Number.isFinite(scale));
  assert.ok(points.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)));
});

// ── Single-hole diagram ───────────────────────────────────────

function parseTranslate(svg, cls) {
  const re = new RegExp(`class="${cls}" transform="translate\\(([-\\d.]+) ([-\\d.]+)\\)"`);
  const m = svg.match(re);
  assert.ok(m, `no ${cls} found in svg`);
  return { x: parseFloat(m[1]), y: parseFloat(m[2]) };
}

test('the basket is drawn above the tee regardless of real-world bearing', () => {
  // Four holes pointing north, south, east and west. All must render with the
  // basket above the tee, because that is the orientation you play from.
  const bearings = [
    [[36.0, -115.0], [36.0009, -115.0]],   // north
    [[36.0, -115.0], [35.9991, -115.0]],   // south
    [[36.0, -115.0], [36.0, -114.9989]],   // east
    [[36.0, -115.0], [36.0, -115.0011]],   // west
  ];
  for (const path of bearings) {
    const svg = holeDiagram({ number: 1, par: 3, distance_m: 100, path });
    const tee = parseTranslate(svg, 'tee-marker');
    const basket = parseTranslate(svg, 'basket-marker');
    assert.ok(basket.y < tee.y, `basket should be above tee (got ${basket.y} vs ${tee.y})`);
  }
});

test('a dogleg keeps its middle vertex, so the shape is not straightened', () => {
  const svg = holeDiagram({
    number: 4,
    par: 4,
    path: [
      [36.0, -115.0],
      [36.0005, -115.0],
      [36.0005, -115.0008],
    ],
  });
  const d = svg.match(/class="fairway" d="([^"]+)"/)[1];
  assert.equal(d.split('L').length, 3, 'M + two L segments');
});

test('a hole with no geometry renders a labelled placeholder, not a broken svg', () => {
  for (const hole of [
    { number: 1, par: 3, path: null },
    { number: 1, par: 3, path: [] },
    { number: 1, par: 3, path: [[36, -115]] },
    { number: 1, par: 3 },
  ]) {
    const html = holeDiagram(hole);
    assert.match(html, /No map data/);
    assert.ok(!html.includes('<svg'), 'no empty svg element');
  }
});

test('the diagram carries an accessible label with par and distance', () => {
  const svg = holeDiagram({
    number: 7,
    par: 4,
    distance_m: 137,
    path: [[36.0, -115.0], [36.0009, -115.0002]],
  });
  assert.match(svg, /aria-label="Hole 7, par 4, 137 metres"/);
  assert.match(svg, /role="img"/);
});

test('a scale bar is drawn with a round number of metres', () => {
  const svg = holeDiagram({
    number: 1,
    par: 3,
    path: [[36.0, -115.0], [36.0009, -115.0]],
  });
  const m = svg.match(/<text x="[\d.]+" y="-6">(\d+) m<\/text>/);
  assert.ok(m, 'scale bar present');
  assert.ok([10, 20, 25, 50, 100, 200].includes(Number(m[1])), `unround scale: ${m[1]}`);
});

test('no NaN reaches the rendered output', () => {
  const svg = holeDiagram({
    number: 1,
    par: 3,
    path: [[36.0, -115.0], [36.0, -115.0], [36.0009, -115.0003]],
  });
  assert.ok(!/NaN|Infinity|undefined/.test(svg), svg.match(/NaN|Infinity|undefined/)?.[0]);
});

// ── Course overview ───────────────────────────────────────────

test('course map assigns the right geometry to each hole', () => {
  // Three holes with different vertex counts — the flatMap/slice pairing is
  // exactly where an off-by-one would silently draw hole 2 with hole 3's shape.
  const layout = {
    name: 'Main',
    holes: [
      { number: 1, par: 3, path: [[36.0000, -115.0000], [36.0004, -115.0000]] },
      { number: 2, par: 4, path: [[36.0010, -115.0000], [36.0012, -115.0004], [36.0016, -115.0004]] },
      { number: 3, par: 3, path: [[36.0020, -115.0000], [36.0024, -115.0002]] },
    ],
  };
  const html = courseDiagram(layout);

  const segCounts = [...html.matchAll(/class="fairway" d="([^"]+)"/g)].map(
    (m) => m[1].split(/[ML]/).filter(Boolean).length,
  );
  assert.equal(segCounts.join(','), '2,3,2', 'each hole keeps its own vertex count');

  // Hole numbers are labelled once each.
  const numbers = [...html.matchAll(/class="hole-number"[^>]*>(\d+)</g)].map((m) => Number(m[1]));
  assert.equal(numbers.sort().join(','), '1,2,3');

  // North-up: no rotation is applied, so hole 3 (northernmost) sits above hole 1.
  const ys = [...html.matchAll(/class="tee-hit" cx="[-\d.]+" cy="([-\d.]+)"/g)].map((m) =>
    parseFloat(m[1]),
  );
  assert.ok(ys[2] < ys[0], 'northern hole drawn higher on the map');
});

test('course map skips holes with no geometry rather than dropping the whole map', () => {
  const layout = {
    name: 'Main',
    holes: [
      { number: 1, par: 3, path: [[36.0, -115.0], [36.0004, -115.0]] },
      { number: 2, par: 3, path: null },
    ],
  };
  const html = courseDiagram(layout);
  assert.match(html, /class="course-map"/);
  const numbers = [...html.matchAll(/class="hole-number"[^>]*>(\d+)</g)].map((m) => m[1]);
  assert.equal(numbers.join(','), '1');
});

test('a layout with no mapped holes produces no map at all', () => {
  assert.equal(courseDiagram({ name: 'Main', holes: [] }), '');
  assert.equal(courseDiagram({ name: 'Main', holes: [{ number: 1, par: 3, path: null }] }), '');
});

test('the course map is keyboard reachable', () => {
  const layout = {
    name: 'Main',
    holes: [{ number: 1, par: 3, path: [[36.0, -115.0], [36.0004, -115.0]] }],
  };
  const html = courseDiagram(layout);
  // Key handling itself lives in actions.js — one delegated keydown listener
  // activates anything with role="button" on Enter or Space — so the markup
  // only has to declare that it is focusable and button-like.
  assert.match(html, /tabindex="0"/);
  assert.match(html, /role="button"/);
  assert.match(html, /data-action="focus-hole"/);
  assert.match(html, /data-hole="1"/);
  assert.ok(!/onkeydown|onclick/.test(html), 'no inline handlers in generated svg');
});

test('a course name with quotes cannot break out of the aria-label', () => {
  const layout = {
    name: 'Bob\'s "Big" Course',
    holes: [{ number: 1, par: 3, path: [[36.0, -115.0], [36.0004, -115.0]] }],
  };
  const html = courseDiagram(layout);
  assert.ok(!html.includes('aria-label="Map of Bob\'s "Big"'), 'quotes must be escaped');
  assert.match(html, /&#39;|&#34;/);
});
