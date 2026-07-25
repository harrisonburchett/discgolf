// app.js is a plain script with a top-level init IIFE (checkAuth()/renderAuth()
// on load), so it's loaded into a vm context with just enough stubbed — a fake
// localStorage, a fake fetch, and a minimal document — for that IIFE to run
// without throwing. What matters for these tests is the real api() function,
// not the app shell around it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '../public/app.js'), 'utf8');

function makeSandbox({ fetchImpl }) {
  const store = new Map();
  const elements = new Map();
  const makeEl = () => ({
    innerHTML: '',
    value: '',
    dataset: {},
    style: {},
    addEventListener() {},
    focus() {},
    scrollIntoView() {},
    classList: { add() {}, remove() {} },
    querySelectorAll: () => [],
  });

  const sandbox = {
    ACTIONS: {},
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, v),
      removeItem: (k) => store.delete(k),
    },
    fetch: fetchImpl,
    document: {
      getElementById: (id) => {
        if (!elements.has(id)) elements.set(id, makeEl());
        return elements.get(id);
      },
      addEventListener() {},
      querySelectorAll: () => [],
      readyState: 'complete',
    },
    window: {},
    navigator: {},
    console,
    setTimeout,
    clearTimeout,
    confirm: () => true,
    alert: () => {},
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  // app.js's route table references functions defined in these two files.
  vm.runInContext(readFileSync(join(here, '../public/courses.js'), 'utf8'), sandbox);
  vm.runInContext(readFileSync(join(here, '../public/scorecard.js'), 'utf8'), sandbox);
  vm.runInContext(src, sandbox);
  return sandbox;
}

function fakeResponse({ status, body, headers = {} }) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => headers[name.toLowerCase()] ?? headers[name] ?? null },
    json: async () => body,
  };
}

// ── 429 handling ──────────────────────────────────────────────

test('a 429 under a minute formats Retry-After in seconds', async () => {
  const sandbox = makeSandbox({
    fetchImpl: async () =>
      fakeResponse({
        status: 429,
        body: { error: 'Too many login attempts. Please try again shortly.' },
        headers: { 'retry-after': '45' },
      }),
  });
  await assert.rejects(
    vm.runInContext('api("/auth/login", { method: "POST" })', sandbox),
    /Too many login attempts\. Please try again shortly\. Try again in 45s\./,
  );
});

test('a 429 over a minute formats Retry-After in minutes, rounded up', async () => {
  const sandbox = makeSandbox({
    fetchImpl: async () =>
      fakeResponse({ status: 429, body: { error: 'Slow down.' }, headers: { 'retry-after': '125' } }),
  });
  await assert.rejects(vm.runInContext('api("/x")', sandbox), /Slow down\. Try again in 3m\./);
});

test('a 429 with no Retry-After header still surfaces the server message', async () => {
  const sandbox = makeSandbox({
    fetchImpl: async () => fakeResponse({ status: 429, body: { error: 'Too many requests.' }, headers: {} }),
  });
  await assert.rejects(vm.runInContext('api("/x")', sandbox), /^Error: Too many requests\.$/);
});

test('a 429 with no body at all still throws something sane', async () => {
  const sandbox = makeSandbox({
    fetchImpl: async () => fakeResponse({ status: 429, body: {}, headers: { 'retry-after': '10' } }),
  });
  await assert.rejects(vm.runInContext('api("/x")', sandbox), /Too many requests\. Try again in 10s\./);
});

// ── Existing behavior is preserved ────────────────────────────

test('a normal error response still throws the server error message, unmodified', async () => {
  const sandbox = makeSandbox({
    fetchImpl: async () => fakeResponse({ status: 400, body: { error: 'Bad input' } }),
  });
  await assert.rejects(vm.runInContext('api("/x")', sandbox), /^Error: Bad input$/);
});

test('a 401 returns null rather than throwing', async () => {
  const sandbox = makeSandbox({
    fetchImpl: async () => fakeResponse({ status: 401, body: { error: 'nope' } }),
  });
  const result = await vm.runInContext('api("/x")', sandbox);
  assert.equal(result, null);
});

test('a successful response returns the parsed body', async () => {
  const sandbox = makeSandbox({
    fetchImpl: async () => fakeResponse({ status: 200, body: { ok: true, value: 42 } }),
  });
  const result = await vm.runInContext('api("/x")', sandbox);
  assert.deepEqual(result, { ok: true, value: 42 });
});

// ── formatRetryAfter directly ──────────────────────────────────

test('formatRetryAfter never reports zero and rounds up', () => {
  const sandbox = makeSandbox({ fetchImpl: async () => fakeResponse({ status: 200, body: {} }) });
  assert.equal(vm.runInContext('formatRetryAfter(0)', sandbox), '1s');
  assert.equal(vm.runInContext('formatRetryAfter(0.4)', sandbox), '1s');
  assert.equal(vm.runInContext('formatRetryAfter(59)', sandbox), '59s');
  assert.equal(vm.runInContext('formatRetryAfter(60)', sandbox), '1m');
  assert.equal(vm.runInContext('formatRetryAfter(61)', sandbox), '2m');
  assert.equal(vm.runInContext('formatRetryAfter(900)', sandbox), '15m');
});
