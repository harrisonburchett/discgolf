import { test } from 'node:test';
import assert from 'node:assert/strict';

import { FakeD1, ctx } from './helpers/d1-shim.mjs';
import { checkRateLimit, getClientIp, rateLimited } from '../functions/lib/rate-limit.js';
import { onRequestPost as login } from '../functions/api/auth/login.js';
import { onRequestPost as register } from '../functions/api/auth/register.js';
import { hashPassword } from '../functions/lib/auth.js';

const body = async (res) => JSON.parse(await res.text());

function reqCtx({ body: b, ip = '203.0.113.5' }) {
  const c = ctx({ method: 'POST', url: 'https://x.test/api/auth/login', body: b, token: null });
  c.request = new Request(c.request.url, {
    method: 'POST',
    headers: { 'CF-Connecting-IP': ip },
  });
  return c;
}

// ── checkRateLimit itself ──────────────────────────────────────

test('allows requests under the limit and blocks the one that crosses it', async () => {
  const DB = new FakeD1();
  const opts = { limit: 3, windowSeconds: 60 };

  for (let i = 1; i <= 3; i++) {
    const r = await checkRateLimit(DB, 'k', opts);
    assert.equal(r.allowed, true, `attempt ${i} should be allowed`);
    assert.equal(r.count, i);
  }
  const fourth = await checkRateLimit(DB, 'k', opts);
  assert.equal(fourth.allowed, false);
  assert.equal(fourth.count, 4);
  assert.ok(fourth.retryAfterSeconds > 0 && fourth.retryAfterSeconds <= 60);
});

test('different keys have independent counters', async () => {
  const DB = new FakeD1();
  const opts = { limit: 1, windowSeconds: 60 };
  const a1 = await checkRateLimit(DB, 'a', opts);
  const a2 = await checkRateLimit(DB, 'a', opts);
  const b1 = await checkRateLimit(DB, 'b', opts);
  assert.equal(a1.allowed, true);
  assert.equal(a2.allowed, false, 'second hit on the same key is blocked');
  assert.equal(b1.allowed, true, 'a different key is unaffected');
});

test('a fresh window resets the count', async () => {
  const DB = new FakeD1();
  const shortWindow = { limit: 1, windowSeconds: 1 };
  const first = await checkRateLimit(DB, 'k', shortWindow);
  assert.equal(first.allowed, true);
  const blocked = await checkRateLimit(DB, 'k', shortWindow);
  assert.equal(blocked.allowed, false);

  await new Promise((r) => setTimeout(r, 1100));
  const afterWindow = await checkRateLimit(DB, 'k', shortWindow);
  assert.equal(afterWindow.allowed, true, 'a new window bucket starts a fresh count');
});

test('stale buckets for a key are cleaned up opportunistically', async () => {
  const DB = new FakeD1();
  const shortWindow = { limit: 5, windowSeconds: 1 };
  await checkRateLimit(DB, 'k', shortWindow);
  await new Promise((r) => setTimeout(r, 1100));
  await checkRateLimit(DB, 'k', shortWindow);
  const rows = DB.db.prepare("SELECT count(*) AS n FROM rate_limit_counters WHERE rl_key = 'k'").get().n;
  assert.ok(rows <= 2, `expected old buckets pruned, found ${rows} rows for one key`);
});

test('a rate limit table failure fails OPEN, not closed', async () => {
  const DB = new FakeD1();
  // Simulate the table being unreachable — the interesting case is D1 being
  // transiently unavailable, not a missing table, but the effect on the
  // caller is the same: the query throws.
  DB.db.exec('DROP TABLE rate_limit_counters');
  const result = await checkRateLimit(DB, 'k', { limit: 1, windowSeconds: 60 });
  assert.equal(result.allowed, true, 'must not lock everyone out over an infra hiccup');
  assert.equal(result.degraded, true);
});

test('getClientIp prefers CF-Connecting-IP, then X-Forwarded-For, then a constant', () => {
  const withCf = new Request('https://x.test', {
    headers: { 'CF-Connecting-IP': '1.2.3.4', 'X-Forwarded-For': '9.9.9.9' },
  });
  assert.equal(getClientIp(withCf), '1.2.3.4');

  const withXff = new Request('https://x.test', { headers: { 'X-Forwarded-For': '5.6.7.8, 10.0.0.1' } });
  assert.equal(getClientIp(withXff), '5.6.7.8');

  const withNeither = new Request('https://x.test');
  assert.equal(getClientIp(withNeither), 'unknown');
});

test('rateLimited sets a spec-correct Retry-After header', async () => {
  const res = rateLimited(42, 'slow down');
  assert.equal(res.status, 429);
  assert.equal(res.headers.get('Retry-After'), '42');
  assert.equal((await body(res)).error, 'slow down');
});

test('rateLimited floors Retry-After at 1 so a client never gets told to retry in 0 seconds', () => {
  const res = rateLimited(0, 'x');
  assert.equal(res.headers.get('Retry-After'), '1');
});

// ── Wired into /api/auth/login ──────────────────────────────────

async function seedUser(DB, { id = 'u1', username = 'harrison', email = 'h@x.test', password = 'correcthorse' } = {}) {
  const hash = await hashPassword(password);
  DB.db
    .prepare('INSERT INTO users (id, username, email, password_hash) VALUES (?,?,?,?)')
    .run(id, username, email, hash);
}

test('login is blocked by email after too many wrong-password attempts', async () => {
  const DB = new FakeD1();
  await seedUser(DB);
  const env = { DB, JWT_SECRET: 'test-secret' };

  let last;
  for (let i = 0; i < 8; i++) {
    last = await login({
      ...reqCtx({ body: { email: 'h@x.test', password: 'wrong' } }),
      env,
    });
    assert.equal(last.status, 401, `attempt ${i + 1} should be a normal wrong-password 401`);
  }

  const ninth = await login({ ...reqCtx({ body: { email: 'h@x.test', password: 'wrong' } }), env });
  assert.equal(ninth.status, 429);
  assert.ok(ninth.headers.get('Retry-After'));
  assert.match((await body(ninth)).error, /Too many attempts/);
});

test('the email-based lock does not block a login for a different account', async () => {
  const DB = new FakeD1();
  await seedUser(DB, { id: 'u1', username: 'victim', email: 'victim@x.test' });
  await seedUser(DB, { id: 'u2', username: 'someone-else', email: 'someone-else@x.test' });
  const env = { DB, JWT_SECRET: 'test-secret' };

  for (let i = 0; i < 9; i++) {
    await login({ ...reqCtx({ body: { email: 'victim@x.test', password: 'wrong' } }), env });
  }
  const other = await login({
    ...reqCtx({ body: { email: 'someone-else@x.test', password: 'correcthorse' } }),
    env,
  });
  assert.equal(other.status, 200, 'a different account is unaffected by another account being locked out');
});

test('a correct password still succeeds while under the rate limit', async () => {
  const DB = new FakeD1();
  await seedUser(DB);
  const env = { DB, JWT_SECRET: 'test-secret' };
  const res = await login({ ...reqCtx({ body: { email: 'h@x.test', password: 'correcthorse' } }), env });
  assert.equal(res.status, 200);
  assert.ok((await body(res)).token);
});

test('login is blocked by IP once enough distinct emails are tried from it', async () => {
  const DB = new FakeD1();
  await seedUser(DB);
  const env = { DB, JWT_SECRET: 'test-secret' };

  // 30 attempts against 30 different (nonexistent) emails from one IP should
  // trip the IP limit before any single email's counter ever could.
  for (let i = 0; i < 30; i++) {
    const res = await login({
      ...reqCtx({ body: { email: `nobody${i}@x.test`, password: 'x' }, ip: '198.51.100.9' }),
      env,
    });
    assert.equal(res.status, 401);
  }
  const blocked = await login({
    ...reqCtx({ body: { email: 'yet-another@x.test', password: 'x' }, ip: '198.51.100.9' }),
    env,
  });
  assert.equal(blocked.status, 429);
});

// ── Wired into /api/auth/register ────────────────────────────────

function registerBody(n) {
  return { username: `user${n}`, email: `user${n}@x.test`, password: 'correcthorse' };
}

test('registration is blocked by IP after too many accounts', async () => {
  const DB = new FakeD1();
  const env = { DB, JWT_SECRET: 'test-secret' };

  for (let i = 0; i < 6; i++) {
    const res = await register({ ...reqCtx({ body: registerBody(i), ip: '203.0.113.9' }), env });
    assert.equal(res.status, 201, `registration ${i + 1} should succeed`);
  }
  const seventh = await register({ ...reqCtx({ body: registerBody(99), ip: '203.0.113.9' }), env });
  assert.equal(seventh.status, 429);
  assert.match((await body(seventh)).error, /Too many accounts/);
});

test('registration from a different IP is unaffected by another IP being blocked', async () => {
  const DB = new FakeD1();
  const env = { DB, JWT_SECRET: 'test-secret' };

  for (let i = 0; i < 7; i++) {
    await register({ ...reqCtx({ body: registerBody(i), ip: '203.0.113.9' }), env });
  }
  const fromElsewhere = await register({
    ...reqCtx({ body: registerBody(500), ip: '198.51.100.1' }),
    env,
  });
  assert.equal(fromElsewhere.status, 201);
});
