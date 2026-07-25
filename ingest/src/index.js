// ============================================================
// Scheduled OSM refresh Worker
//
// Runs on a cron trigger, refreshes ONE region per tick, and records what it
// did in ingest_regions / ingest_runs.
//
// Why a separate Worker: Cloudflare Pages Functions have no cron triggers.
// This Worker binds the same D1 database as the Pages project.
//
// Why one region per tick, and why a two-phase fetch:
//
//   A `(newer:…)` Overpass query returns only the objects that changed. That
//   is cheap, but it is NOT sufficient to ingest from directly — a hole way
//   that was edited arrives without its unchanged course node, so the
//   normaliser would see an orphan hole and drop it. Relational data needs
//   its context.
//
//   So phase 1 asks "did anything change in this region?" (ids only, tiny
//   response). Only if the answer is yes does phase 2 pull the full region
//   and ingest it. Most regions are quiet on any given day, so the expensive
//   fetch is skipped most of the time while correctness is preserved.
//
// The initial bulk load is NOT this Worker's job — use
// `node scripts/ingest-osm.mjs --iso US --apply`. A Worker has a 128MB heap,
// and this one refuses to normalise a response bigger than MAX_RESPONSE_BYTES
// rather than dying halfway through.
// ============================================================

import { buildOverpassQuery, normalize } from '../../shared/osm-normalize.js';
import { statementsForCourses } from '../../shared/osm-sql.js';

const ENDPOINT = 'https://overpass-api.de/api/interpreter';
const USER_AGENT =
  'disc-golf-tracker/1.0 (scheduled OSM course refresh; https://github.com/REPLACE_WITH_YOUR_USERNAME/disc-golf-tracker)';

// D1 caps how much one batch can carry; chunk generously below any limit.
const BATCH_SIZE = 100;

// If a region has never succeeded, or last succeeded longer ago than this,
// do a full fetch rather than trusting a change-detection window.
const MAX_INCREMENTAL_AGE_DAYS = 60;

// ── Region selection ──────────────────────────────────────────

/**
 * Pick the region most in need of a refresh.
 *
 * Ordering: never-run regions first, then by priority, then by staleness.
 * Regions that have failed repeatedly are pushed to the back rather than
 * retried forever — a persistently broken region shouldn't starve the rest
 * of the rotation.
 */
async function pickRegion(db) {
  return db
    .prepare(
      `SELECT iso, label, last_success_at, consecutive_failures
       FROM ingest_regions
       ORDER BY
         CASE WHEN consecutive_failures >= 5 THEN 1 ELSE 0 END ASC,
         CASE WHEN last_run_at IS NULL THEN 0 ELSE 1 END ASC,
         priority ASC,
         COALESCE(last_run_at, '0000') ASC
       LIMIT 1`,
    )
    .first();
}

// ── Overpass ──────────────────────────────────────────────────

async function overpass(query, { expectJson = true } = {}) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': USER_AGENT,
    },
    body: new URLSearchParams({ data: query }),
  });

  if (!res.ok) {
    throw new Error(`Overpass ${res.status} ${res.statusText}`);
  }

  const text = await res.text();
  if (!expectJson) return { text, bytes: text.length };

  try {
    return { json: JSON.parse(text), bytes: text.length };
  } catch {
    // Overpass reports QL errors as HTML with a 200 status.
    throw new Error(`Overpass returned non-JSON (likely a query error): ${text.slice(0, 300)}`);
  }
}

/**
 * Phase 1 — has anything changed in this region since `since`?
 * `out ids` keeps the response to a few bytes per object.
 */
async function countChanges(iso, since) {
  const query = buildOverpassQuery({ iso, newerThan: since, timeout: 180 }).replace(
    'out geom qt;',
    'out ids qt;',
  );
  const { json } = await overpass(query);
  return Array.isArray(json?.elements) ? json.elements.length : 0;
}

// ── D1 writes ─────────────────────────────────────────────────

async function applyStatements(db, statements) {
  for (let i = 0; i < statements.length; i += BATCH_SIZE) {
    const batch = statements
      .slice(i, i + BATCH_SIZE)
      .map(({ sql, params }) => db.prepare(sql).bind(...params.map((p) => p ?? null)));
    await db.batch(batch);
  }
}

async function finishRun(db, runId, iso, fields) {
  const {
    status,
    stats = null,
    warnings = [],
    error = null,
    incremental = 0,
  } = fields;

  // Keep only a sample of warnings: the point is triage, not an audit log,
  // and a pathological region could otherwise write megabytes.
  const warningSample = JSON.stringify(warnings.slice(0, 50));

  await db.batch([
    db
      .prepare(
        `UPDATE ingest_runs SET
           finished_at = datetime('now'), status = ?, incremental = ?,
           elements = ?, courses = ?, layouts = ?, holes = ?,
           warnings = ?, warning_json = ?, error = ?
         WHERE id = ?`,
      )
      .bind(
        status,
        incremental,
        stats?.elements ?? null,
        stats?.courses ?? null,
        stats?.layouts ?? null,
        stats?.holes ?? null,
        warnings.length,
        warningSample,
        error,
        runId,
      ),
    db
      .prepare(
        `UPDATE ingest_regions SET
           last_run_at = datetime('now'),
           last_status = ?,
           last_error  = ?,
           courses_seen = COALESCE(?, courses_seen),
           last_success_at = CASE WHEN ? IN ('ok','skipped')
                                  THEN datetime('now') ELSE last_success_at END,
           consecutive_failures = CASE WHEN ? IN ('ok','skipped')
                                       THEN 0 ELSE consecutive_failures + 1 END
         WHERE iso = ?`,
      )
      .bind(status, error, stats?.courses ?? null, status, status, iso),
  ]);
}

// ── One refresh cycle ─────────────────────────────────────────

async function refreshOneRegion(env, log) {
  const db = env.DB;
  const region = await pickRegion(db);
  if (!region) {
    log('No regions configured — apply migration 0003.');
    return { status: 'noop' };
  }

  const runId = crypto.randomUUID();
  await db
    .prepare('INSERT INTO ingest_runs (id, iso, status) VALUES (?, ?, ?)')
    .bind(runId, region.iso, 'running')
    .run();

  log(`Refreshing ${region.label} (${region.iso})`);

  try {
    const incrementalEnabled = env.INCREMENTAL !== 'false';
    const maxBytes = parseInt(env.MAX_RESPONSE_BYTES ?? '25000000', 10);

    // Is the last success recent enough to trust a change-detection window?
    let since = null;
    if (incrementalEnabled && region.last_success_at) {
      const ageDays = (Date.now() - Date.parse(`${region.last_success_at}Z`)) / 86_400_000;
      if (Number.isFinite(ageDays) && ageDays < MAX_INCREMENTAL_AGE_DAYS) {
        since = `${region.last_success_at.replace(' ', 'T')}Z`;
      }
    }

    if (since) {
      const changed = await countChanges(region.iso, since);
      log(`  ${changed} object(s) edited since ${since}`);
      if (changed === 0) {
        await finishRun(db, runId, region.iso, { status: 'skipped', incremental: 1 });
        return { status: 'skipped', iso: region.iso, changed: 0 };
      }
    }

    // Phase 2: full region fetch. Needed even for an incremental trigger,
    // because a changed hole must be normalised alongside its unchanged course.
    const query = buildOverpassQuery({ iso: region.iso, timeout: 280 });
    const { json, bytes } = await overpass(query);
    log(`  ${(bytes / 1_048_576).toFixed(1)} MB from Overpass`);

    if (bytes > maxBytes) {
      const msg =
        `Response ${bytes} bytes exceeds MAX_RESPONSE_BYTES (${maxBytes}). ` +
        `Seed this region locally: node scripts/ingest-osm.mjs --iso ${region.iso} --apply`;
      await finishRun(db, runId, region.iso, { status: 'error', error: msg });
      return { status: 'too_large', iso: region.iso, bytes };
    }

    const { courses, warnings, stats } = normalize(json);
    log(`  ${stats.courses} courses, ${stats.layouts} layouts, ${stats.holes} holes, ${warnings.length} notes`);

    await applyStatements(db, statementsForCourses(courses));

    await finishRun(db, runId, region.iso, {
      status: 'ok',
      stats,
      warnings,
      incremental: since ? 1 : 0,
    });
    return { status: 'ok', iso: region.iso, stats, warnings: warnings.length };
  } catch (err) {
    const msg = String(err?.message ?? err).slice(0, 1000);
    log(`  FAILED: ${msg}`);
    await finishRun(db, runId, region.iso, { status: 'error', error: msg }).catch(() => {});
    return { status: 'error', iso: region.iso, error: msg };
  }
}

// ── Entry points ──────────────────────────────────────────────

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(refreshOneRegion(env, (...m) => console.log(...m)));
  },

  // Manual trigger, for testing the pipeline without waiting for the cron.
  // Guarded by INGEST_TOKEN, which must be set as a secret:
  //   npx wrangler secret put INGEST_TOKEN
  // With no token configured the endpoint stays closed rather than open.
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== '/run') {
      return new Response('Not found', { status: 404 });
    }
    if (!env.INGEST_TOKEN) {
      return new Response('INGEST_TOKEN is not configured; manual runs disabled.', { status: 503 });
    }
    if (request.headers.get('Authorization') !== `Bearer ${env.INGEST_TOKEN}`) {
      return new Response('Unauthorized', { status: 401 });
    }

    const lines = [];
    const result = await refreshOneRegion(env, (...m) => {
      const line = m.join(' ');
      lines.push(line);
      console.log(line);
    });
    return Response.json({ result, log: lines });
  },
};
