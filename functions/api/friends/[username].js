// ============================================================
// GET /api/friends/[username] — View a friend's scores + stats
// ============================================================

import { getUser, unauthorized, json } from '../../lib/auth.js';

export async function onRequestGet({ request, env, params }) {
  const user = await getUser(request, env);
  if (!user) return unauthorized();

  const friendUsername = params.username;

  // Find the friend
  const friend = await env.DB.prepare(
    'SELECT id, username, display_name FROM users WHERE username = ?'
  ).bind(friendUsername).first();

  if (!friend) return json({ error: 'User not found' }, 404);

  // Verify friendship
  const isFriend = await env.DB.prepare(
    `SELECT id FROM friendships
     WHERE status = 'accepted'
       AND ((requester_id = ? AND receiver_id = ?)
            OR (requester_id = ? AND receiver_id = ?))`
  ).bind(user.id, friend.id, friend.id, user.id).first();

  if (!isFriend) return json({ error: 'You are not friends with this user' }, 403);

  // Get their rounds. Same COALESCE as /api/rounds so a friend's scores are
  // shown on the same basis as your own — otherwise their layout-derived par
  // rendered as an em dash while yours resolved.
  const rounds = await env.DB.prepare(
    `SELECT r.*,
            COALESCE(l.total_par, r.par) AS effective_par,
            CASE WHEN COALESCE(l.total_par, r.par) IS NULL THEN NULL
                 ELSE r.total_score - COALESCE(l.total_par, r.par) END AS to_par,
            l.name AS layout_name,
            c.name AS course_name
     FROM rounds r
     LEFT JOIN layouts l ON l.id = r.layout_id
     LEFT JOIN courses c ON c.id = r.course_id
     WHERE r.user_id = ?
     ORDER BY r.date_played DESC, r.created_at DESC
     LIMIT 200`
  ).bind(friend.id).all();

  const roundList = rounds.results || [];

  // Basic stats
  let stats = {
    totalRounds: 0,
    bestScore: null,
    averageScore: null
  };

  if (roundList.length > 0) {
    const scores = roundList.map(r => r.total_score);
    stats = {
      totalRounds: roundList.length,
      bestScore: Math.min(...scores),
      averageScore: Math.round(scores.reduce((a, b) => a + b, 0) / scores.length * 10) / 10
    };
  }

  return json({
    friend: {
      username: friend.username,
      display_name: friend.display_name
    },
    rounds: roundList,
    stats
  });
}
