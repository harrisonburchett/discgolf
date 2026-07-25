#!/usr/bin/env node
// ============================================================
// ingest-osm.mjs — Bulk-load disc golf courses from OpenStreetMap into D1.
//
// This is the *initial seed* path. It runs on your machine, where there is no
// CPU limit and no 128MB Worker heap, so it can pull a whole country (or the
// planet) in one query. The scheduled Worker in ../ingest handles incremental
// refresh after that.
//
// Usage:
//   node scripts/ingest-osm.mjs --iso US                  # one country
//   node scripts/ingest-osm.mjs --bbox 36,-116,37,-114    # a bounding box
//   node scripts/ingest-osm.mjs --planet                  # everything (slow)
//   node scripts/ingest-osm.mjs --iso US --apply          # ...and load into D1
//   node scripts/ingest-osm.mjs --iso US --apply --local   # ...into local D1
//   node scripts/ingest-osm.mjs --from cached.json         # re-run offline
//
// Flags:
//   --iso <CC>        ISO 3166-1 alpha-2 country code
//   --bbox s,w,n,e    Bounding box (south,west,north,east)
//   --planet          No spatial filter. Expect a multi-minute query.
//   --from <file>     Skip the network; normalise a saved Overpass response
//   --out <dir>       Output directory (default: ./.ingest)
//   --apply           Run `wrangler d1 execute` on the generated SQL
//   --local           With --apply, target the local D1 instead of remote
//   --db <name>       D1 database name (default: disc-golf-tracker-db)
//   --chunk <n>       Statements per SQL file (default: 400)
//   --quiet
//
// Overpass etiquette: this sends an identifying User-Agent, retries with
// exponential backoff on 429/504, and falls back to a mirror. Please do not
// remove those — Overpass is a donated public service and heavy anonymous
// hammering is how endpoints get closed to everyone.
// ============================================================

import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';

import { buildOverpassQuery, normalize } from '../shared/osm-normalize.js';
import { statementsForCourses, renderSql } from '../shared/osm-sql.js';

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

const USER_AGENT =
  'disc-golf-tracker/1.0 (OSM course ingest; https://github.com/REPLACE_WITH_YOUR_USERNAME/disc-golf-tracker)';

// ── Argument parsing ──────────────────────────────────────────

function parseArgs(argv) {
  const args = { out: '.ingest', db: 'disc-golf-tracker-db', chunk: 400 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v == null) throw new Error(`${a} needs a value`);
      return v;
    };
    switch (a) {
      case '--iso': args.iso = next().toUpperCase(); break;
      case '--bbox': args.bbox = next().split(',').map(Number); break;
      case '--planet': args.planet = true; break;
      case '--from': args.from = next(); break;
      case '--out': args.out = next(); break;
      case '--apply': args.apply = true; break;
      case '--local': args.local = true; break;
      case '--db': args.db = next(); break;
      case '--chunk': args.chunk = parseInt(next(), 10); break;
      case '--quiet': args.quiet = true; break;
      case '-h': case '--help': args.help = true; break;
      default: throw new Error(`Unknown flag: ${a}`);
    }
  }
  const scopes = [args.iso, args.bbox, args.planet, args.from].filter(Boolean).length;
  if (!args.help && scopes !== 1) {
    throw new Error('Pass exactly one of --iso, --bbox, --planet, or --from');
  }
  if (args.bbox && (args.bbox.length !== 4 || args.bbox.some((n) => !Number.isFinite(n)))) {
    throw new Error('--bbox must be four numbers: south,west,north,east');
  }
  return args;
}

const HELP = `
Bulk-load disc golf courses from OpenStreetMap into Cloudflare D1.

  node scripts/ingest-osm.mjs --iso US [--apply [--local]]
  node scripts/ingest-osm.mjs --bbox 36,-116,37,-114
  node scripts/ingest-osm.mjs --planet
  node scripts/ingest-osm.mjs --from .ingest/overpass.json

Run with --iso US first and read the report before using --apply.
`.trim();

// ── Overpass fetch ────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchOverpass(query, log) {
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    const endpoint = ENDPOINTS[attempt % ENDPOINTS.length];
    if (attempt > 0) {
      const wait = 2 ** attempt * 5000;
      log(`  retry ${attempt} in ${wait / 1000}s via ${new URL(endpoint).host}`);
      await sleep(wait);
    }
    try {
      log(`  querying ${new URL(endpoint).host}…`);
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': USER_AGENT,
        },
        body: new URLSearchParams({ data: query }),
      });

      if (res.status === 429 || res.status === 504 || res.status === 502) {
        lastErr = new Error(`Overpass returned ${res.status} (server busy)`);
        continue;
      }
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Overpass ${res.status}: ${body.slice(0, 400)}`);
      }

      const text = await res.text();
      log(`  received ${(text.length / 1_048_576).toFixed(1)} MB`);
      try {
        return JSON.parse(text);
      } catch {
        // Overpass reports query errors as an HTML page with a 200 status.
        throw new Error(`Overpass returned non-JSON — likely a query error:\n${text.slice(0, 600)}`);
      }
    } catch (err) {
      lastErr = err;
      if (/query error/.test(err.message)) throw err; // no point retrying bad QL
    }
  }
  throw lastErr ?? new Error('Overpass fetch failed');
}

// ── Reporting ─────────────────────────────────────────────────

function summariseWarnings(warnings) {
  const byKind = new Map();
  for (const w of warnings) {
    if (!byKind.has(w.kind)) byKind.set(w.kind, []);
    byKind.get(w.kind).push(w);
  }
  return [...byKind.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([kind, list]) => ({ kind, count: list.length, sample: list.slice(0, 5) }));
}

// ── Main ──────────────────────────────────────────────────────

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`${err.message}\n\n${HELP}`);
    process.exit(2);
  }
  if (args.help) {
    console.log(HELP);
    return;
  }

  const log = args.quiet ? () => {} : (...m) => console.log(...m);
  const runId = randomUUID();
  await mkdir(args.out, { recursive: true });

  // 1. Acquire the raw Overpass response.
  let raw;
  if (args.from) {
    log(`Reading ${args.from}`);
    raw = JSON.parse(await readFile(args.from, 'utf8'));
  } else {
    const query = buildOverpassQuery({
      iso: args.iso ?? null,
      bbox: args.bbox ?? null,
      timeout: args.planet ? 900 : 300,
    });
    const scope = args.iso ?? (args.bbox ? `bbox ${args.bbox.join(',')}` : 'planet');
    log(`Fetching disc golf data for ${scope}`);
    log(`\n${query}\n`);
    raw = await fetchOverpass(query, log);
    const rawPath = join(args.out, 'overpass.json');
    await writeFile(rawPath, JSON.stringify(raw));
    log(`  cached raw response -> ${rawPath}  (re-run offline with --from)`);
  }

  // 2. Normalise.
  log('\nNormalising…');
  const { courses, warnings, stats } = normalize(raw);
  log(`  ${stats.elements.toLocaleString()} elements in`);
  log(`  ${stats.courses.toLocaleString()} courses (${stats.coursesWithHoleGeometry.toLocaleString()} with hole geometry)`);
  log(`  ${stats.layouts.toLocaleString()} layouts from ${stats.layoutRelations.toLocaleString()} layout relations`);
  log(`  ${stats.holes.toLocaleString()} hole rows from ${stats.holesInSource.toLocaleString()} source ways`);

  if (warnings.length) {
    log(`\n${warnings.length.toLocaleString()} data-quality notes:`);
    for (const g of summariseWarnings(warnings)) {
      log(`  ${String(g.count).padStart(6)}  ${g.kind}`);
    }
  }

  // 3. Generate SQL.
  const statements = statementsForCourses(courses);
  log(`\n${statements.length.toLocaleString()} SQL statements`);

  const files = [];
  for (let i = 0, part = 1; i < statements.length; i += args.chunk, part++) {
    const slice = statements.slice(i, i + args.chunk);
    const name = `seed-${String(part).padStart(4, '0')}.sql`;
    const path = join(args.out, name);
    await writeFile(
      path,
      `-- disc-golf-tracker OSM seed, part ${part}\n` +
        `-- run ${runId}\n` +
        `-- generated ${new Date().toISOString()}\n` +
        `-- Course data (c) OpenStreetMap contributors, ODbL.\n\n` +
        renderSql(slice) +
        '\n',
    );
    files.push(path);
  }
  log(`  wrote ${files.length} file(s) to ${args.out}/`);

  const reportPath = join(args.out, 'report.json');
  await writeFile(
    reportPath,
    JSON.stringify({ runId, generatedAt: new Date().toISOString(), stats, warnings }, null, 2),
  );
  log(`  full warning report -> ${reportPath}`);

  // 4. Optionally apply.
  if (!args.apply) {
    log(`\nDry run. Review ${reportPath}, then re-run with --apply to load into D1.`);
    log('Apply manually with:');
    for (const f of files) {
      log(`  npx wrangler d1 execute ${args.db} ${args.local ? '--local' : '--remote'} --file=${f}`);
    }
    return;
  }

  log(`\nApplying to ${args.db} (${args.local ? 'local' : 'remote'})…`);
  for (const [i, f] of files.entries()) {
    log(`  [${i + 1}/${files.length}] ${f}`);
    const r = spawnSync(
      'npx',
      ['wrangler', 'd1', 'execute', args.db, args.local ? '--local' : '--remote', `--file=${f}`, '-y'],
      { stdio: 'inherit', shell: process.platform === 'win32' },
    );
    if (r.status !== 0) {
      console.error(`\nFailed on ${f}. Earlier files are already applied; the load is`);
      console.error('idempotent, so fix the cause and re-run the same command to resume.');
      process.exit(1);
    }
  }
  log('\nDone.');
}

main().catch((err) => {
  console.error(`\n${err.stack || err.message}`);
  process.exit(1);
});
