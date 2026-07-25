// ============================================================
// POST /api/friends/accept — Accept a friend request { friendship_id }
// ============================================================

import { getUser, unauthorized, json } from '../../lib/auth.js';

export async function onRequestPost({ request, data, env }) {
  const user = await getUser(request, env);
  if (!user) return unauthorized();

  const { friendship_id } = data.body || {};
  if (!friendship_id) return json({ error: 'friendship_id is required' }, 400);

  const friendship = await env.DB.prepare(
    "SELECT * FROM friendships WHERE id = ? AND receiver_id = ? AND status = 'pending'"
  ).bind(friendship_id, user.id).first();

  if (!friendship) return json({ error: 'Pending request not found' }, 404);

  await env.DB.prepare(
    "UPDATE friendships SET status = 'accepted' WHERE id = ?"
  ).bind(friendship_id).run();

  return json({ success: true, status: 'accepted' });
}
