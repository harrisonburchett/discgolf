// ============================================================
// GET /api/courses/:id — Course detail: every layout with its hole geometry
//
// Returns enough in one round trip to render both the course overview map and
// any single-hole view, so the frontend never has to fan out per hole.
// ============================================================

import { getUser, unauthorized, json } from '../../lib/auth.js';

export async function onRequestGet({ request, env, params }) {
  const user = await getUser(request, env);
  if (!user) return unauthorized();

  const courseId = params.id;

  const course = await env.DB.prepare(
    `SELECT id, name, lat, lng, city, region, country, hole_count,
            source, osm_type, osm_id, locked, updated_at
     FROM courses WHERE id = ?`,
  )
    .bind(courseId)
    .first();

  if (!course) return json({ error: 'Course not found' }, 404);

  // Two queries rather than one join, so a layout with no holes still appears
  // (a real case: a course node mapped without hole geometry).
  const [layoutRows, holeRows] = await Promise.all([
    env.DB.prepare(
      `SELECT id, name, hole_count, total_par, total_distance_m,
              tee_colour, is_default, source
       FROM layouts WHERE course_id = ?
       ORDER BY is_default DESC, hole_count DESC, name`,
    )
      .bind(courseId)
      .all(),
    env.DB.prepare(
      `SELECT h.layout_id, h.number, h.par, h.distance_m,
              h.tee_lat, h.tee_lng, h.basket_lat, h.basket_lng, h.path_json
       FROM holes h
       JOIN layouts l ON l.id = h.layout_id
       WHERE l.course_id = ?
       ORDER BY h.layout_id, h.number`,
    )
      .bind(courseId)
      .all(),
  ]);

  const holesByLayout = new Map();
  for (const h of holeRows.results || []) {
    if (!holesByLayout.has(h.layout_id)) holesByLayout.set(h.layout_id, []);
    let path = null;
    if (h.path_json) {
      // Stored by our own ingest, but never trust a JSON column blindly —
      // a malformed row should degrade to "no geometry", not 500 the request.
      try {
        const parsed = JSON.parse(h.path_json);
        if (Array.isArray(parsed)) path = parsed;
      } catch {
        path = null;
      }
    }
    holesByLayout.get(h.layout_id).push({
      number: h.number,
      par: h.par,
      distance_m: h.distance_m,
      tee: h.tee_lat != null ? { lat: h.tee_lat, lng: h.tee_lng } : null,
      basket: h.basket_lat != null ? { lat: h.basket_lat, lng: h.basket_lng } : null,
      path,
    });
  }

  const layouts = (layoutRows.results || []).map((l) => ({
    id: l.id,
    name: l.name,
    hole_count: l.hole_count,
    total_par: l.total_par,
    total_distance_m: l.total_distance_m,
    tee_colour: l.tee_colour,
    is_default: !!l.is_default,
    source: l.source,
    holes: holesByLayout.get(l.id) || [],
  }));

  // Bounding box for the whole course, so the client can fit the map without
  // walking every hole itself.
  const pts = layouts.flatMap((l) =>
    l.holes.flatMap((h) => (h.path?.length ? h.path : [])).filter(Array.isArray),
  );
  const bounds = pts.length
    ? {
        south: Math.min(...pts.map((p) => p[0])),
        west: Math.min(...pts.map((p) => p[1])),
        north: Math.max(...pts.map((p) => p[0])),
        east: Math.max(...pts.map((p) => p[1])),
      }
    : null;

  return json({
    course: {
      ...course,
      locked: !!course.locked,
      osm_url:
        course.source === 'osm' && course.osm_type && course.osm_id
          ? `https://www.openstreetmap.org/${course.osm_type}/${course.osm_id}`
          : null,
    },
    layouts,
    bounds,
    attribution:
      course.source === 'osm' ? 'Course data © OpenStreetMap contributors, ODbL' : null,
  });
}
