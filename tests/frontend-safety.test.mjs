// Static checks on the frontend source. These guard invariants that are easy to
// break by accident and expensive to notice: an inline handler creeping back in,
// or a data-action with no registered handler (which fails silently at runtime,
// on a click, in production).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const pub = join(here, '../public');

const FILES = ['app.js', 'courses.js', 'scorecard.js', 'actions.js'];
/** Strip comments so the scanners read code, not the prose explaining it. */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
}

const sources = Object.fromEntries(
  FILES.map((f) => [f, stripComments(readFileSync(join(pub, f), 'utf8'))]),
);
const allSource = Object.values(sources).join('\n');
const html = readFileSync(join(pub, 'index.html'), 'utf8');

// ── The inline-handler ban ────────────────────────────────────

test('no inline event handler attributes anywhere in the frontend', () => {
  // An inline handler's attribute value is HTML-entity-decoded and THEN compiled
  // as JavaScript, so escaping a value interpolated into one does not contain
  // it: &#39; arrives at the JS compiler as a working quote. The only safe rule
  // is not to generate them at all.
  const pattern = /\bon(?:click|input|change|keydown|keyup|submit|focus|blur|mouseover|load|error)\s*=\s*["']/gi;
  for (const [file, src] of Object.entries(sources)) {
    const hits = [...src.matchAll(pattern)].map((m) => m[0]);
    assert.deepEqual(hits, [], `${file} contains inline handler(s): ${hits.join(', ')}`);
  }
  assert.equal(
    [...html.matchAll(pattern)].length,
    0,
    'index.html contains an inline handler',
  );
});

test('the entity-decoding hazard is real, so the ban is load-bearing', () => {
  // Documents why the rule above exists rather than asserting a preference.
  const escapeHtml = (s) =>
    String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');

  const payload = "a'-PWNED-'b";
  const attrValue = `pick('${escapeHtml(payload)}')`;
  // What the HTML parser hands to the JS compiler:
  const decoded = attrValue.replace(/&#39;/g, "'").replace(/&quot;/g, '"');

  let escaped = false;
  try {
    new Function('pick', 'PWNED', decoded);
    escaped = true;
  } catch {
    escaped = false;
  }
  assert.equal(escaped, true, 'HTML-escaping does not protect a JS string literal');
});

// ── data-action wiring ────────────────────────────────────────

/** Every data-action name that appears in generated markup. */
function declaredActions() {
  const names = new Set();
  for (const src of Object.values(sources)) {
    for (const m of src.matchAll(/data-action="([a-z-]+)"/g)) names.add(m[1]);
  }
  return names;
}

/** Every action registered via Object.assign(ACTIONS, { … }). */
function registeredActions() {
  const names = new Set();
  for (const block of allSource.matchAll(/Object\.assign\(ACTIONS,\s*\{([\s\S]*?)\n\}\);/g)) {
    for (const m of block[1].matchAll(/^\s{2}'?([a-zA-Z-]+)'?\s*:/gm)) names.add(m[1]);
  }
  return names;
}

test('every data-action in the markup has a registered handler', () => {
  const declared = declaredActions();
  const registered = registeredActions();
  assert.ok(declared.size >= 15, `expected many actions, found ${declared.size}`);

  const missing = [...declared].filter((a) => !registered.has(a));
  assert.deepEqual(missing, [], `data-action with no handler: ${missing.join(', ')}`);
});

test('no handler is registered that nothing uses', () => {
  const declared = declaredActions();
  const registered = registeredActions();
  const unused = [...registered].filter((a) => !declared.has(a));
  assert.deepEqual(unused, [], `handler registered but never referenced: ${unused.join(', ')}`);
});

test('actions.js loads before the files that register into it', () => {
  const order = ['actions.js', 'courses.js', 'scorecard.js', 'app.js'].map((f) =>
    html.indexOf(`src="${f}"`),
  );
  assert.ok(order.every((i) => i !== -1), 'every script is referenced in index.html');
  for (let i = 1; i < order.length; i++) {
    assert.ok(order[i] > order[i - 1], 'script order must match the dependency order');
  }
});

// ── Escaping discipline ───────────────────────────────────────

test('interpolated values in data attributes are escaped', () => {
  // data-* is safe from the JS-context problem, but still needs HTML escaping so
  // a value containing a quote cannot close the attribute early.
  const unescaped = [];
  for (const [file, src] of Object.entries(sources)) {
    for (const m of src.matchAll(/data-(?:id|username|route|hole|mode|delta)="\$\{([^}]+)\}"/g)) {
      const expr = m[1];
      const safe = /escapeHtml\(/.test(expr) || /^[a-zA-Z0-9_.[\]]+\.number$/.test(expr) || /^[a-z]+\.number$/.test(expr);
      if (!safe) unescaped.push(`${file}: ${m[0]}`);
    }
  }
  assert.deepEqual(unescaped, [], `unescaped data attribute value(s): ${unescaped.join('; ')}`);
});

test('user-supplied text is escaped wherever it reaches innerHTML', () => {
  // A spot check on the fields most likely to carry hostile input.
  const risky = [];
  for (const [file, src] of Object.entries(sources)) {
    for (const m of src.matchAll(/\$\{((?:[a-z]\w*\.)*(?:username|display_name|course|notes|name))\}/g)) {
      risky.push(`${file}: \${${m[1]}}`);
    }
  }
  assert.deepEqual(risky, [], `unescaped interpolation: ${risky.join('; ')}`);
});

// ── CSP compatibility ─────────────────────────────────────────
// The policy in public/_headers forbids inline scripts AND inline styles. Both
// are only enforceable because the source generates neither, so these are the
// tests that keep the policy shippable.

const headers = readFileSync(join(pub, '_headers'), 'utf8');

test('the CSP forbids inline script and inline style', () => {
  const csp = headers.match(/Content-Security-Policy:\s*(.+)/)[1];
  assert.match(csp, /script-src 'self'/);
  assert.ok(!/script-src[^;]*unsafe-inline/.test(csp), "script-src must not allow 'unsafe-inline'");
  assert.ok(!/unsafe-eval/.test(csp));
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /base-uri 'self'/);
});

test('no inline style attributes, which the CSP would block', () => {
  for (const [file, src] of Object.entries(sources)) {
    const hits = [...src.matchAll(/\sstyle\s*=\s*["']/g)].map(() => 'style=');
    assert.deepEqual(hits, [], `${file} emits an inline style attribute`);
  }
  assert.ok(!/\sstyle\s*=\s*["']/.test(html), 'index.html has an inline style attribute');
});

test('every external origin the page loads is allowed by the CSP', () => {
  const csp = headers.match(/Content-Security-Policy:\s*(.+)/)[1];
  const origins = [...html.matchAll(/(?:src|href)="(https?:\/\/[^/"]+)/g)].map((m) => m[1]);
  for (const origin of new Set(origins)) {
    assert.ok(csp.includes(origin), `${origin} is loaded but not permitted by the CSP`);
  }
  // Google Fonts serves CSS from one origin and font files from another; both
  // have to be listed or the typeface silently falls back.
  if (origins.some((o) => o.includes('fonts.googleapis.com'))) {
    assert.match(csp, /font-src[^;]*fonts\.gstatic\.com/);
  }
});

test('API responses are marked no-store', () => {
  assert.match(headers, /\/api\/\*/);
  assert.match(headers, /Cache-Control: no-store/);
});
