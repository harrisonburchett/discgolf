// ============================================================
// GET /api/auth/me — Get current user profile
// ============================================================

import { getUser, unauthorized, json } from '../../lib/auth.js';

export async function onRequestGet({ request, env }) {
  const user = await getUser(request, env);
  if (!user) return unauthorized();
  return json({ user });
}
