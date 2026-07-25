// ============================================================
// GET /api/search?username=xyz — Search users by username (for adding friends)
// ============================================================

import { getUser, unauthorized, json } from '../lib/auth.js';

export async function onRequestGet({ request, env }) {
  const user = await getUser(request, env);
  if (!user) return unauthorized();

  const q = new URL(request.url).searchParams.get('username') || '';
  if (q.length < 2) return json({ users: [] });

  const results = await env.DB.prepare(
    `SELECT id, username, display_name FROM users
     WHERE username LIKE ? AND id != ?
     LIMIT 10`
  ).bind(`%${q}%`, user.id).all();

  return json({ users: results.results || [] });
}
