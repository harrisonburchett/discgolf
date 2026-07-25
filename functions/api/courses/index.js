// ============================================================
// GET /api/courses — Find courses by name and/or proximity
//
//   ?q=maple                  name search (min 2 chars)
//   ?lat=36.1&lng=-115.2      nearest first
//   ?radius=50                km, with lat/lng (default 40, max 500)
//   ?limit=20                 1-50
//   ?withMaps=1               only courses that have hole geometry
//
// D1 has no spatial index, so proximity is a bounding-box scan over
// idx_courses_lat_lng followed by an exact haversine sort here. That is fine
// at this data size (a few thousand courses) and avoids pulling in a spatial
// extension D1 doesn't have.
// ============================================================

import { getUser, unauthorized, json } from '../../lib/auth.js';

const R_EARTH_KM = 6371.0088;
const toRad = (d) => (d * Math.PI) / 180;

function haversineKm(aLat, aLng, bLat, bLng) {
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R_EARTH_KM * Math.asin(Math.min(1, Math.sqrt(s)));
}

function num(raw, { min, max, fallback = null }) {
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) return fallback;
  return n;
}

export async function onRequestGet({ request, env }) {
  const user = await getUser(request, env);
  if (!user) return unauthorized();

  const params = new URL(request.url).searchParams;
  const q = (params.get('q') || '').trim();
  const lat = num(params.get('lat'), { min: -90, max: 90 });
  const lng = num(params.get('lng'), { min: -180, max: 180 });
  const radiusKm = num(params.get('radius'), { min: 0.1, max: 500, fallback: 40 });
  const limit = num(params.get('limit'), { min: 1, max: 50, fallback: 20 });
  const withMaps = params.get('withMaps') === '1';

  const hasGeo = lat !== null && lng !== null;
  if (!q && !hasGeo) {
    return json({ error: 'Provide q, or lat and lng' }, 400);
  }
  if (q && q.length < 2 && !hasGeo) {
    return json({ courses: [] });
  }

  const where = [];
  const binds = [];

  if (q.length >= 2) {
    // LIKE is case-insensitive for ASCII in SQLite by default. Escape the
    // wildcards so a user searching for "50%" doesn't match everything.
    const escaped = q.replace(/[\\%_]/g, (c) => `\\${c}`);
    where.push("c.name LIKE ? ESCAPE '\\'");
    binds.push(`%${escaped}%`);
  }

  const cosLat = Math.cos(toRad(lat ?? 0));

  if (hasGeo) {
    // Latitude degrees are ~111km everywhere; longitude degrees shrink with
    // latitude. Widen the longitude window accordingly, and fall back to the
    // whole range near the poles where cos() collapses.
    const dLat = radiusKm / 111.32;
    const dLng = Math.abs(cosLat) < 0.01 ? 180 : radiusKm / (111.32 * Math.abs(cosLat));

    where.push('c.lat BETWEEN ? AND ?');
    binds.push(lat - dLat, lat + dLat);

    // A window spanning the antimeridian can't be expressed as one BETWEEN.
    // Rather than return wrong results, drop the longitude bound and let the
    // latitude band plus the exact filter below do the work.
    if (lng - dLng >= -180 && lng + dLng <= 180) {
      where.push('c.lng BETWEEN ? AND ?');
      binds.push(lng - dLng, lng + dLng);
    }
  }

  if (withMaps) {
    where.push(
      `EXISTS (SELECT 1 FROM layouts l JOIN holes h ON h.layout_id = l.id
               WHERE l.course_id = c.id)`,
    );
  }

  // Ordering has to happen in SQL, not after the fact. Sorting by name and then
  // truncating would drop genuinely nearby courses whose names sort late — in a
  // dense region the closest course could be cut before the distance sort ever
  // ran. This is squared planar distance with longitude compressed by
  // cos(latitude): monotonic in true distance over a window this small, so it
  // orders identically to haversine while being expressible as arithmetic.
  const orderBinds = [];
  let orderBy = 'c.name COLLATE NOCASE';
  if (hasGeo) {
    orderBy = '((c.lat - ?) * (c.lat - ?)) + ((c.lng - ?) * (c.lng - ?) * ?)';
    orderBinds.push(lat, lat, lng, lng, cosLat * cosLat);
  }

  // Still over-fetch a little: the bounding box is a square around a circle, so
  // corner rows get discarded by the exact haversine filter below.
  const sqlLimit = hasGeo ? Math.min(limit * 3, 200) : limit;

  const { results } = await env.DB.prepare(
    `SELECT c.id, c.name, c.lat, c.lng, c.city, c.region, c.country,
            c.hole_count, c.source,
            (SELECT COUNT(*) FROM layouts l WHERE l.course_id = c.id) AS layout_count,
            (SELECT COUNT(*) FROM layouts l JOIN holes h ON h.layout_id = l.id
              WHERE l.course_id = c.id) AS mapped_hole_count
     FROM courses c
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY ${orderBy}
     LIMIT ?`,
  )
    .bind(...binds, ...orderBinds, sqlLimit)
    .all();

  let courses = results || [];

  if (hasGeo) {
    courses = courses
      .map((c) => ({ ...c, distance_km: Math.round(haversineKm(lat, lng, c.lat, c.lng) * 10) / 10 }))
      .filter((c) => c.distance_km <= radiusKm)
      .sort((a, b) => a.distance_km - b.distance_km);
  }

  return json({
    courses: courses.slice(0, limit).map((c) => ({
      ...c,
      has_map: c.mapped_hole_count > 0,
    })),
    attribution: 'Course data © OpenStreetMap contributors, ODbL',
  });
}
