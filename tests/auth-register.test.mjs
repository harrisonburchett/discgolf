import { test } from 'node:test';
import assert from 'node:assert/strict';

import { FakeD1, ctx } from './helpers/d1-shim.mjs';
import { onRequestPost as register } from '../functions/api/auth/register.js';

const body = async (res) => JSON.parse(await res.text());

function reqCtx({ body: b, ip = '203.0.113.5' }) {
  const c = ctx({ method: 'POST', url: 'https://x.test/api/auth/register', body: b, token: null });
  c.request = new Request(c.request.url, { method: 'POST', headers: { 'CF-Connecting-IP': ip } });
  return c;
}

const userCount = (DB) => DB.db.prepare('SELECT count(*) AS n FROM users').get().n;

test('a normal registration succeeds and creates exactly one row', async () => {
  const DB = new FakeD1();
  const env = { DB, JWT_SECRET: 'test-secret' };
  const res = await register({
    ...reqCtx({ body: { username: 'harrison', email: 'h@x.test', password: 'correcthorse' } }),
    env,
  });
  assert.equal(res.status, 201);
  const { token, user } = await body(res);
  assert.ok(token);
  assert.equal(user.username, 'harrison');
  assert.equal(userCount(DB), 1);
});

// ── The ghost-account regression ───────────────────────────────
//
// Previously, INSERT ran before signJwt. A downstream signJwt failure (a
// missing or misconfigured JWT_SECRET, verified elsewhere to throw
// "Zero-length key is not supported") still left the row committed: the
// account existed, fully valid, with nobody able to see it — the response
// never got returned, so the person just saw a failed request and, on
// retrying, hit "username or email already taken" against an account they
// never knew had been created.

test('a signJwt failure during registration leaves no ghost account behind', async () => {
  const DB = new FakeD1();
  // No JWT_SECRET bound — reproduces the exact failure mode this bug came from.
  const env = { DB, JWT_SECRET: undefined };

  await assert.rejects(
    () =>
      register({
        ...reqCtx({ body: { username: 'harrison', email: 'h@x.test', password: 'correcthorse' } }),
        env,
      }),
    /Zero-length key is not supported/,
  );

  assert.equal(userCount(DB), 0, 'the row must not exist after a failed registration');
});

test('after fixing the secret, that same registration can succeed on the next attempt', async () => {
  const DB = new FakeD1();
  const broken = { DB, JWT_SECRET: undefined };
  const body1 = { username: 'harrison', email: 'h@x.test', password: 'correcthorse' };

  await assert.rejects(() => register({ ...reqCtx({ body: body1 }), env: broken }));
  assert.equal(userCount(DB), 0);

  // Same username and email, now with a working secret — must succeed, not
  // 409 "already taken". This is the exact scenario reported: retrying after
  // an apparent failure got a false "already taken" from a ghost row.
  const fixed = { DB, JWT_SECRET: 'test-secret' };
  const res = await register({ ...reqCtx({ body: body1 }), env: fixed });
  assert.equal(res.status, 201);
  assert.equal(userCount(DB), 1);
});

test('a genuinely taken username still gets a clean 409, not a 500', async () => {
  const DB = new FakeD1();
  const env = { DB, JWT_SECRET: 'test-secret' };
  await register({
    ...reqCtx({ body: { username: 'harrison', email: 'first@x.test', password: 'correcthorse' } }),
    env,
  });
  const res = await register({
    ...reqCtx({ body: { username: 'harrison', email: 'second@x.test', password: 'correcthorse' } }),
    env,
  });
  assert.equal(res.status, 409);
  assert.match((await body(res)).error, /already taken/);
  assert.equal(userCount(DB), 1, 'the rejected duplicate must not create a second row');
});
