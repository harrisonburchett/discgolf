// ============================================================
// /api/rounds
//   GET  — List the current user's rounds (?limit=, ?offset=)
//   POST — Create a round, optionally against a catalog layout and
//          optionally with a hole-by-hole scorecard
//
// Body (POST):
//   {
//     layout_id?:   "osm-r3001",        // preferred: par comes from the layout
//     course_id?:   "osm-n1001",
//     course?:      "Maple Hill",       // required when no layout/course id
//     date_played:  "2026-07-24",
//     total_score?: 57,                 // derived from hole_scores when given
//     par?:         54,                 // derived from the layout when given
//     notes?:       "",
//     hole_scores?: [{ number: 1, strokes: 4 }, …]
//   }
// ============================================================

import { getUser, unauthorized, generateId, json } from '../../lib/auth.js';

const MAX_LIMIT = 200;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function toInt(v) {
  if (typeof v === 'number' && Number.isInteger(v)) return v;
  if (typeof v === 'string' && /^-?\d+$/.test(v.trim())) return parseInt(v, 10);
  return null;
}

/** A real calendar date, not just something shaped like one. */
function validDate(s) {
  if (typeof s !== 'string' || !ISO_DATE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export async function onRequestGet({ request, env }) {
  const user = await getUser(request, env);
  if (!user) return unauthorized();

  const params = new URL(request.url).searchParams;
  const limit = Math.min(Math.max(toInt(params.get('limit')) ?? 100, 1), MAX_LIMIT);
  const offset = Math.max(toInt(params.get('offset')) ?? 0, 0);

  // COALESCE lets a round fall back to its own par snapshot when it has no
  // layout, so legacy rows and off-catalog courses still report to-par.
  const rounds = await env.DB.prepare(
    `SELECT r.*,
            COALESCE(l.total_par, r.par) AS effective_par,
            CASE WHEN COALESCE(l.total_par, r.par) IS NULL THEN NULL
                 ELSE r.total_score - COALESCE(l.total_par, r.par) END AS to_par,
            l.name AS layout_name,
            c.name AS course_name,
            (SELECT COUNT(*) FROM hole_scores hs WHERE hs.round_id = r.id) AS hole_score_count
     FROM rounds r
     LEFT JOIN layouts l ON l.id = r.layout_id
     LEFT JOIN courses c ON c.id = r.course_id
     WHERE r.user_id = ?
     ORDER BY r.date_played DESC, r.created_at DESC
     LIMIT ? OFFSET ?`,
  )
    .bind(user.id, limit, offset)
    .all();

  return json({ rounds: rounds.results || [], limit, offset });
}

export async function onRequestPost({ request, data, env }) {
  const user = await getUser(request, env);
  if (!user) return unauthorized();

  const body = data.body || {};
  const notes = typeof body.notes === 'string' ? body.notes.slice(0, 2000) : '';
  const date_played = body.date_played;

  if (!validDate(date_played)) {
    return json({ error: 'date_played must be a valid date in YYYY-MM-DD form' }, 400);
  }

  // ── Resolve the layout, if any ──
  let layout = null;
  if (body.layout_id != null) {
    layout = await env.DB.prepare(
      'SELECT id, course_id, name, hole_count, total_par FROM layouts WHERE id = ?',
    )
      .bind(String(body.layout_id))
      .first();
    if (!layout) return json({ error: 'Layout not found' }, 404);
  }

  // Checked before the course-name fallback so the error names the real
  // problem: a scorecard is meaningless without a layout to score against.
  if (body.hole_scores != null && !layout) {
    return json({ error: 'hole_scores requires a layout_id' }, 400);
  }

  let course = null;
  const courseIdInput = body.course_id ?? layout?.course_id ?? null;
  if (courseIdInput != null) {
    course = await env.DB.prepare('SELECT id, name FROM courses WHERE id = ?')
      .bind(String(courseIdInput))
      .first();
    if (!course) return json({ error: 'Course not found' }, 404);
  }

  // A round always carries a human-readable course name: from the catalog when
  // there is one, otherwise from free text. This is what keeps a scorecard
  // readable after a catalog row is deleted.
  const courseName =
    course?.name ??
    (typeof body.course === 'string' && body.course.trim()
      ? body.course.trim().slice(0, 200)
      : null);
  if (!courseName) {
    return json({ error: 'Provide course_id, layout_id, or a course name' }, 400);
  }

  // ── Hole-by-hole scorecard, if supplied ──
  let holeScores = null;
  if (body.hole_scores != null) {
    if (!Array.isArray(body.hole_scores) || body.hole_scores.length === 0) {
      return json({ error: 'hole_scores must be a non-empty array' }, 400);
    }
    if (body.hole_scores.length > 36) {
      return json({ error: 'hole_scores cannot exceed 36 holes' }, 400);
    }
    const { results: holeRows } = await env.DB.prepare(
      'SELECT id, number, par FROM holes WHERE layout_id = ?',
    )
      .bind(layout.id)
      .all();
    const holesByNumber = new Map((holeRows || []).map((h) => [h.number, h]));
    if (holesByNumber.size === 0) {
      return json({ error: 'That layout has no mapped holes, so it cannot take a scorecard' }, 409);
    }

    const seen = new Set();
    holeScores = [];
    for (const entry of body.hole_scores) {
      const number = toInt(entry?.number);
      const strokes = toInt(entry?.strokes);
      if (number === null || strokes === null) {
        return json({ error: 'Each hole score needs an integer number and strokes' }, 400);
      }
      if (strokes < 1 || strokes > 30) {
        return json({ error: `Strokes for hole ${number} must be between 1 and 30` }, 400);
      }
      if (seen.has(number)) {
        return json({ error: `Duplicate score for hole ${number}` }, 400);
      }
      const hole = holesByNumber.get(number);
      if (!hole) {
        return json({ error: `Hole ${number} is not part of that layout` }, 400);
      }
      seen.add(number);
      holeScores.push({ hole_id: hole.id, number, par: hole.par, strokes });
    }
    holeScores.sort((a, b) => a.number - b.number);
  }

  // ── Totals ──
  // A supplied scorecard is authoritative; total_score is only read when there
  // is no scorecard to add up.
  let total_score;
  if (holeScores) {
    total_score = holeScores.reduce((a, h) => a + h.strokes, 0);
  } else {
    total_score = toInt(body.total_score);
    if (total_score === null) {
      return json({ error: 'total_score is required (or supply hole_scores)' }, 400);
    }
    if (total_score < 1 || total_score > 500) {
      return json({ error: 'total_score must be between 1 and 500' }, 400);
    }
  }

  // Par preference: the layout's own par, then a partial par covering only the
  // holes actually played, then whatever the client sent.
  let par = layout?.total_par ?? null;
  if (par == null && holeScores) {
    const partial = holeScores.reduce((a, h) => a + (h.par ?? 0), 0);
    par = partial > 0 ? partial : null;
  }
  if (par == null) {
    const supplied = toInt(body.par);
    if (supplied !== null && supplied >= 1 && supplied <= 300) par = supplied;
  }

  // ── Write ──
  const id = generateId();
  const statements = [
    env.DB.prepare(
      `INSERT INTO rounds
         (id, user_id, course_id, layout_id, course, date_played, total_score, par, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      id,
      user.id,
      course?.id ?? null,
      layout?.id ?? null,
      courseName,
      date_played,
      total_score,
      par,
      notes,
    ),
  ];

  for (const h of holeScores || []) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO hole_scores (round_id, hole_id, hole_number, par, strokes)
         VALUES (?, ?, ?, ?, ?)`,
      ).bind(id, h.hole_id, h.number, h.par, h.strokes),
    );
  }

  // batch() runs as one transaction, so a rejected hole score cannot leave a
  // round with a half-written scorecard.
  await env.DB.batch(statements);

  const round = await env.DB.prepare(
    `SELECT r.*, COALESCE(l.total_par, r.par) AS effective_par,
            CASE WHEN COALESCE(l.total_par, r.par) IS NULL THEN NULL
                 ELSE r.total_score - COALESCE(l.total_par, r.par) END AS to_par,
            l.name AS layout_name
     FROM rounds r LEFT JOIN layouts l ON l.id = r.layout_id
     WHERE r.id = ?`,
  )
    .bind(id)
    .first();

  return json({ round, hole_scores: holeScores || [] }, 201);
}
