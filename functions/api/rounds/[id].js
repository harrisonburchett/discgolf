// ============================================================
// /api/rounds/[id]
//   DELETE — Delete a round
//   PUT    — Edit a round
// ============================================================

import { getUser, unauthorized, json } from '../../lib/auth.js';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function toInt(v) {
  if (typeof v === 'number' && Number.isInteger(v)) return v;
  if (typeof v === 'string' && /^-?\d+$/.test(v.trim())) return parseInt(v, 10);
  return null;
}

function validDate(s) {
  if (typeof s !== 'string' || !ISO_DATE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export async function onRequestGet({ request, env, params }) {
  const user = await getUser(request, env);
  if (!user) return unauthorized();

  const round = await env.DB.prepare(
    `SELECT r.*,
            COALESCE(l.total_par, r.par) AS effective_par,
            CASE WHEN COALESCE(l.total_par, r.par) IS NULL THEN NULL
                 ELSE r.total_score - COALESCE(l.total_par, r.par) END AS to_par,
            l.name AS layout_name,
            l.hole_count AS layout_hole_count,
            c.name AS course_name
     FROM rounds r
     LEFT JOIN layouts l ON l.id = r.layout_id
     LEFT JOIN courses c ON c.id = r.course_id
     WHERE r.id = ?`,
  )
    .bind(params.id)
    .first();

  if (!round) return json({ error: 'Round not found' }, 404);
  // Same 403-not-404 choice the other handlers make: the round exists, it just
  // isn't yours.
  if (round.user_id !== user.id) return json({ error: 'Not your round' }, 403);

  // Hole geometry is joined in so a saved scorecard can be shown next to the
  // hole it was played on. Without this endpoint, hole_scores were written and
  // never readable anywhere.
  const { results: holeScores } = await env.DB.prepare(
    `SELECT hs.hole_number, hs.strokes, hs.par,
            h.distance_m, h.path_json
     FROM hole_scores hs
     LEFT JOIN holes h ON h.id = hs.hole_id
     WHERE hs.round_id = ?
     ORDER BY hs.hole_number`,
  )
    .bind(params.id)
    .all();

  const hole_scores = (holeScores || []).map((h) => {
    let path = null;
    if (h.path_json) {
      try {
        const parsed = JSON.parse(h.path_json);
        if (Array.isArray(parsed)) path = parsed;
      } catch {
        path = null;
      }
    }
    return {
      number: h.hole_number,
      strokes: h.strokes,
      par: h.par,
      distance_m: h.distance_m,
      to_par: h.par == null ? null : h.strokes - h.par,
      path,
    };
  });

  return json({ round, hole_scores });
}

export async function onRequestDelete({ request, env, params }) {
  const user = await getUser(request, env);
  if (!user) return unauthorized();

  const roundId = params.id;
  const round = await env.DB.prepare(
    'SELECT user_id FROM rounds WHERE id = ?'
  ).bind(roundId).first();

  if (!round) return json({ error: 'Round not found' }, 404);
  if (round.user_id !== user.id) return json({ error: 'Not your round' }, 403);

  await env.DB.prepare('DELETE FROM rounds WHERE id = ?').bind(roundId).run();
  return json({ success: true });
}

export async function onRequestPut({ request, data, env, params }) {
  const user = await getUser(request, env);
  if (!user) return unauthorized();

  const roundId = params.id;
  const round = await env.DB.prepare(
    'SELECT user_id FROM rounds WHERE id = ?'
  ).bind(roundId).first();

  if (!round) return json({ error: 'Round not found' }, 404);
  if (round.user_id !== user.id) return json({ error: 'Not your round' }, 403);

  // Partial update. The previous version bound every field unconditionally,
  // so a body omitting `course` passed `undefined` to D1 and threw a 500
  // instead of returning a 400.
  const body = data.body || {};
  const sets = [];
  const binds = [];

  if (body.course !== undefined) {
    if (typeof body.course !== 'string' || !body.course.trim()) {
      return json({ error: 'course must be a non-empty string' }, 400);
    }
    sets.push('course = ?');
    binds.push(body.course.trim().slice(0, 200));
  }

  if (body.date_played !== undefined) {
    if (!validDate(body.date_played)) {
      return json({ error: 'date_played must be a valid date in YYYY-MM-DD form' }, 400);
    }
    sets.push('date_played = ?');
    binds.push(body.date_played);
  }

  if (body.total_score !== undefined) {
    const n = toInt(body.total_score);
    if (n === null || n < 1 || n > 500) {
      return json({ error: 'total_score must be an integer between 1 and 500' }, 400);
    }
    sets.push('total_score = ?');
    binds.push(n);
  }

  if (body.par !== undefined) {
    if (body.par === null) {
      sets.push('par = NULL');
    } else {
      const n = toInt(body.par);
      if (n === null || n < 1 || n > 300) {
        return json({ error: 'par must be an integer between 1 and 300, or null' }, 400);
      }
      sets.push('par = ?');
      binds.push(n);
    }
  }

  if (body.notes !== undefined) {
    if (typeof body.notes !== 'string') {
      return json({ error: 'notes must be a string' }, 400);
    }
    sets.push('notes = ?');
    binds.push(body.notes.slice(0, 2000));
  }

  if (!sets.length) {
    return json({ error: 'No updatable fields supplied' }, 400);
  }

  await env.DB.prepare(`UPDATE rounds SET ${sets.join(', ')} WHERE id = ?`)
    .bind(...binds, roundId)
    .run();

  const updated = await env.DB.prepare(
    `SELECT r.*, COALESCE(l.total_par, r.par) AS effective_par,
            CASE WHEN COALESCE(l.total_par, r.par) IS NULL THEN NULL
                 ELSE r.total_score - COALESCE(l.total_par, r.par) END AS to_par
     FROM rounds r LEFT JOIN layouts l ON l.id = r.layout_id
     WHERE r.id = ?`,
  )
    .bind(roundId)
    .first();
  return json({ round: updated });
}
