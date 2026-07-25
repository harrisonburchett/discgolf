// ============================================================
// POST /api/auth/register
// Body: { username, email, password, display_name? }
// ============================================================

import { hashPassword, signJwt, generateId, json } from '../../lib/auth.js';
import { checkRateLimit, getClientIp, rateLimited } from '../../lib/rate-limit.js';

// These collide with static routes under /api/friends/ and /api/, so a user
// holding one of them would be unreachable via /api/friends/:username.
const RESERVED_USERNAMES = new Set(['accept', 'index', 'me', 'search', 'admin', 'api', 'null', 'undefined']);

// IP-only: unlike login, there's no single account to protect here — the
// abuse case is mass account creation, which an IP-scoped limit catches
// directly. A generous window since real signups are rare per visitor.
const REGISTER_LIMIT_PER_IP = 6;
const REGISTER_WINDOW_SECONDS = 60 * 60;

export async function onRequestPost({ request, data, env }) {
  const ip = getClientIp(request);
  const limit = await checkRateLimit(env.DB, `register:ip:${ip}`, {
    limit: REGISTER_LIMIT_PER_IP,
    windowSeconds: REGISTER_WINDOW_SECONDS,
  });
  if (!limit.allowed) {
    return rateLimited(limit.retryAfterSeconds, 'Too many accounts created recently. Please try again later.');
  }

  const raw = data.body || {};
  const username = typeof raw.username === 'string' ? raw.username.trim() : '';
  const email = typeof raw.email === 'string' ? raw.email.trim().toLowerCase() : '';
  const password = typeof raw.password === 'string' ? raw.password : '';
  const display_name = typeof raw.display_name === 'string' ? raw.display_name.trim().slice(0, 60) : '';

  if (!username || !email || !password) {
    return json({ error: 'Username, email, and password are required' }, 400);
  }
  if (!/^[a-zA-Z0-9_-]{3,30}$/.test(username)) {
    return json({ error: 'Username must be 3–30 characters, letters/numbers/underscore/hyphen only' }, 400);
  }
  if (RESERVED_USERNAMES.has(username.toLowerCase())) {
    return json({ error: 'That username is reserved' }, 409);
  }
  if (password.length < 6) {
    return json({ error: 'Password must be at least 6 characters' }, 400);
  }

  // Check uniqueness
  const existing = await env.DB.prepare(
    'SELECT id FROM users WHERE username = ? OR email = ?'
  ).bind(username, email).first();
  if (existing) {
    return json({ error: 'Username or email already taken' }, 409);
  }

  const id = generateId();
  const passwordHash = await hashPassword(password);
  const name = display_name || username;

  await env.DB.prepare(
    'INSERT INTO users (id, username, email, display_name, password_hash) VALUES (?, ?, ?, ?, ?)'
  ).bind(id, username, email, name, passwordHash).run();

  const token = await signJwt(
    { sub: id, username, exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30 },
    env.JWT_SECRET
  );

  return json({
    token,
    user: { id, username, email, display_name: name }
  }, 201);
}
