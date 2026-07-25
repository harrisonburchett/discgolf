// ============================================================
// osm-sql.js — Turn normalised courses into parameterised statements.
//
// Emits `{ sql, params }` objects so the same statements can be executed
// against D1 (env.DB.prepare(sql).bind(...params)) or rendered to a .sql
// file for `wrangler d1 execute --file=`. One code path, two consumers.
//
// Idempotency and user-edit safety:
//
//   * Row IDs are derived from OSM identity, so a re-ingest updates in place.
//   * Every write is guarded by `locked = 0`. When a user corrects an
//     OSM-seeded course, the app sets locked = 1 and the ingest stops
//     touching it — no "helpful" overwrite of a human's fix.
//   * Holes are replaced wholesale per layout, because hole membership and
//     ordering can change between imports and a per-hole upsert would leave
//     stale rows behind.
// ============================================================

import { courseId, layoutId, holeId } from './osm-normalize.js';

/**
 * @param {object} course  A single normalised course from normalize()
 * @returns {{sql: string, params: any[]}[]}
 */
export function statementsForCourse(course) {
  const cid = courseId(course);
  const stmts = [];

  stmts.push({
    sql: `INSERT INTO courses
            (id, name, lat, lng, city, region, country, hole_count,
             source, osm_type, osm_id, osm_version, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'osm', ?, ?, ?, datetime('now'))
          ON CONFLICT(id) DO UPDATE SET
            name        = excluded.name,
            lat         = excluded.lat,
            lng         = excluded.lng,
            city        = excluded.city,
            region      = excluded.region,
            country     = excluded.country,
            hole_count  = excluded.hole_count,
            osm_version = excluded.osm_version,
            updated_at  = datetime('now')
          WHERE courses.locked = 0`,
    params: [
      cid,
      course.name,
      course.lat,
      course.lng,
      course.city,
      course.region,
      course.country,
      course.hole_count,
      course.osm_type,
      course.osm_id,
      course.osm_version,
    ],
  });

  const liveLayoutIds = [];

  course.layouts.forEach((layout, i) => {
    const lid = layoutId(course, layout, i + 1);
    liveLayoutIds.push(lid);

    stmts.push({
      sql: `INSERT INTO layouts
              (id, course_id, name, hole_count, total_par, total_distance_m,
               tee_colour, is_default, source, osm_relation_id, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'osm', ?, datetime('now'))
            ON CONFLICT(id) DO UPDATE SET
              course_id        = excluded.course_id,
              name             = excluded.name,
              hole_count       = excluded.hole_count,
              total_par        = excluded.total_par,
              total_distance_m = excluded.total_distance_m,
              tee_colour       = excluded.tee_colour,
              is_default       = excluded.is_default,
              updated_at       = datetime('now')
            WHERE layouts.locked = 0`,
      params: [
        lid,
        cid,
        layout.name,
        layout.hole_count,
        layout.total_par,
        layout.total_distance_m,
        layout.tee_colour,
        layout.is_default ? 1 : 0,
        layout.osm_relation_id,
      ],
    });

    // Replace the hole set for this layout, unless a user has claimed it.
    stmts.push({
      sql: `DELETE FROM holes
            WHERE layout_id = ?
              AND EXISTS (SELECT 1 FROM layouts WHERE id = ? AND locked = 0)`,
      params: [lid, lid],
    });

    for (const hole of layout.holes) {
      stmts.push({
        sql: `INSERT INTO holes
                (id, layout_id, number, par, distance_m,
                 tee_lat, tee_lng, basket_lat, basket_lng, path_json, osm_way_id)
              SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
              WHERE EXISTS (SELECT 1 FROM layouts WHERE id = ? AND locked = 0)
              ON CONFLICT(layout_id, number) DO UPDATE SET
                par        = excluded.par,
                distance_m = excluded.distance_m,
                tee_lat    = excluded.tee_lat,
                tee_lng    = excluded.tee_lng,
                basket_lat = excluded.basket_lat,
                basket_lng = excluded.basket_lng,
                path_json  = excluded.path_json,
                osm_way_id = excluded.osm_way_id`,
        params: [
          holeId(lid, hole),
          lid,
          hole.number,
          hole.par,
          hole.distance_m,
          hole.tee?.lat ?? null,
          hole.tee?.lng ?? null,
          hole.basket?.lat ?? null,
          hole.basket?.lng ?? null,
          hole.path?.length ? JSON.stringify(hole.path) : null,
          hole.osm_way_id,
          lid,
        ],
      });
    }
  });

  // Drop layouts that disappeared upstream (a relation deleted in OSM, or a
  // synthesised layout that no longer has holes). User-locked layouts and any
  // layout a round references are left alone — ON DELETE SET NULL would
  // silently detach someone's scorecard.
  const placeholders = liveLayoutIds.map(() => '?').join(', ');
  stmts.push({
    sql: `DELETE FROM layouts
          WHERE course_id = ?
            AND source = 'osm'
            AND locked = 0
            ${liveLayoutIds.length ? `AND id NOT IN (${placeholders})` : ''}
            AND id NOT IN (SELECT DISTINCT layout_id FROM rounds WHERE layout_id IS NOT NULL)`,
    params: [cid, ...liveLayoutIds],
  });

  return stmts;
}

/** Flatten many courses into one statement list. */
export function statementsForCourses(courses) {
  return courses.flatMap(statementsForCourse);
}

// ── SQL literal rendering (for the .sql file path only) ───────

function sqlLiteral(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return 'NULL';
    return String(v);
  }
  if (typeof v === 'boolean') return v ? '1' : '0';
  return `'${String(v).replace(/'/g, "''")}'`;
}

/**
 * Render statements as executable SQL text.
 *
 * Only for the local seed path, where `wrangler d1 execute --file=` is the
 * fastest way to bulk-load. The Worker never uses this — it binds parameters.
 */
export function renderSql(statements) {
  const lines = [];
  for (const { sql, params } of statements) {
    let i = 0;
    const inlined = sql.replace(/\?/g, () => sqlLiteral(params[i++]));
    if (i !== params.length) {
      throw new Error(`Placeholder/param mismatch: ${i} placeholders, ${params.length} params`);
    }
    lines.push(`${inlined.replace(/\s+/g, ' ').trim()};`);
  }
  return lines.join('\n');
}
