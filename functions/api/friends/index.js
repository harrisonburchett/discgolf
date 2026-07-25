// ============================================================
// GET  /api/friends          — List friends + pending requests
// POST /api/friends/request   — Send friend request { username }
// POST /api/friends/accept    — Accept request { friendship_id }
// ============================================================

import { getUser, unauthorized, generateId, json } from '../../lib/auth.js';

export async function onRequestGet({ request, env }) {
  const user = await getUser(request, env);
  if (!user) return unauthorized();

  // Accepted friends
  const friends = await env.DB.prepare(
    `SELECT f.id AS friendship_id,
            u.id AS user_id, u.username, u.display_name
     FROM friendships f
     JOIN users u ON u.id = CASE WHEN f.requester_id = ? THEN f.receiver_id ELSE f.requester_id END
     WHERE (f.requester_id = ? OR f.receiver_id = ?) AND f.status = 'accepted'`
  ).bind(user.id, user.id, user.id).all();

  // Pending requests (incoming only)
  const pending = await env.DB.prepare(
    `SELECT f.id AS friendship_id,
            u.id AS user_id, u.username, u.display_name
     FROM friendships f
     JOIN users u ON u.id = f.requester_id
     WHERE f.receiver_id = ? AND f.status = 'pending'`
  ).bind(user.id).all();

  return json({
    friends: friends.results || [],
    pending: pending.results || []
  });
}

export async function onRequestPost({ request, data, env }) {
  const user = await getUser(request, env);
  if (!user) return unauthorized();

  const { username } = data.body || {};
  if (!username) return json({ error: 'Username is required' }, 400);

  const target = await env.DB.prepare(
    'SELECT id FROM users WHERE username = ?'
  ).bind(username).first();

  if (!target) return json({ error: 'User not found' }, 404);
  if (target.id === user.id) return json({ error: 'Cannot friend yourself' }, 400);

  // Check if friendship already exists (either direction)
  const existing = await env.DB.prepare(
    `SELECT id, status FROM friendships
     WHERE (requester_id = ? AND receiver_id = ?)
        OR (requester_id = ? AND receiver_id = ?)`
  ).bind(user.id, target.id, target.id, user.id).first();

  if (existing) {
    return json({ error: `Friendship already ${existing.status}` }, 409);
  }

  const id = generateId();
  await env.DB.prepare(
    'INSERT INTO friendships (id, requester_id, receiver_id, status) VALUES (?, ?, ?, ?)'
  ).bind(id, user.id, target.id, 'pending').run();

  return json({ friendship_id: id, status: 'pending', target: username }, 201);
}
