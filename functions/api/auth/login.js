// ============================================================
// POST /api/auth/login
// Body: { email, password }
// ============================================================

import { verifyPassword, signJwt, json } from '../../lib/auth.js';
import { checkRateLimit, getClientIp, rateLimited } from '../../lib/rate-limit.js';

// Generous enough that a user who fat-fingers their password a few times
// never notices, tight enough to make brute-forcing a single account
// impractical when combined with PBKDF2's per-attempt cost. Tune to your own
// traffic if these defaults don't fit.
const LOGIN_LIMIT_PER_EMAIL = 8;
const LOGIN_LIMIT_PER_IP = 30; // covers credential stuffing across many accounts from one source
const LOGIN_WINDOW_SECONDS = 15 * 60;

export async function onRequestPost({ request, data, env }) {
  const raw = data.body || {};
  const email = typeof raw.email === 'string' ? raw.email.trim().toLowerCase() : '';
  const password = typeof raw.password === 'string' ? raw.password : '';

  if (!email || !password) {
    return json({ error: 'Email and password are required' }, 400);
  }

  // IP-based check first: it catches an attacker spraying across many
  // accounts before any single email's counter would ever trip.
  const ip = getClientIp(request);
  const ipLimit = await checkRateLimit(env.DB, `login:ip:${ip}`, {
    limit: LOGIN_LIMIT_PER_IP,
    windowSeconds: LOGIN_WINDOW_SECONDS,
  });
  if (!ipLimit.allowed) {
    return rateLimited(ipLimit.retryAfterSeconds, 'Too many login attempts. Please try again shortly.');
  }

  const emailLimit = await checkRateLimit(env.DB, `login:email:${email}`, {
    limit: LOGIN_LIMIT_PER_EMAIL,
    windowSeconds: LOGIN_WINDOW_SECONDS,
  });
  if (!emailLimit.allowed) {
    return rateLimited(
      emailLimit.retryAfterSeconds,
      'Too many attempts for this account. Please try again shortly.',
    );
  }

  const user = await env.DB.prepare(
    'SELECT id, username, email, display_name, password_hash FROM users WHERE email = ?'
  ).bind(email).first();

  if (!user) {
    return json({ error: 'Invalid email or password' }, 401);
  }

  const valid = await verifyPassword(password, user.password_hash);
  if (!valid) {
    return json({ error: 'Invalid email or password' }, 401);
  }

  const token = await signJwt(
    { sub: user.id, username: user.username, exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30 },
    env.JWT_SECRET
  );

  return json({
    token,
    user: {
      id: user.id,
      username: user.username,
      email: user.email,
      display_name: user.display_name
    }
  });
}
