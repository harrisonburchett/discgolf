// ============================================================
// osm-normalize.js — Turn an Overpass response into course/layout/hole rows.
//
// Pure functions, no I/O, no platform APIs. Imported by both the local seed
// script (scripts/ingest-osm.mjs) and the scheduled refresh Worker
// (ingest/src/index.js) so the two can never drift.
//
// The tagging scheme this implements is documented at
// https://wiki.openstreetmap.org/wiki/Tag:leisure%3Ddisc_golf_course
//
//   course  leisure=disc_golf_course  (node, sometimes way/relation)
//   hole    disc_golf=hole            (way, drawn tee -> basket)
//             par=*, dist=*, ref=*
//   tee     disc_golf=tee             (node)
//   basket  disc_golf=basket          (node)
//   layout  type=disc_golf_layout     (relation; role=course + ordered role=hole)
//
// Two structural facts drive the design:
//
//   1. Hole *number* comes from position in the layout relation, not from
//      ref=* on the way — the same way is a different hole number in a
//      different layout. Only single-layout courses can trust ref.
//
//   2. Most courses have no layout relation at all. For those, holes are
//      attached to the nearest course by proximity and a single layout is
//      synthesised. That inference is fallible, so it is reported.
// ============================================================

// A hole further than this from its course point is assumed to belong to a
// different course. Real courses span ~300-800m; 1200m is deliberately loose.
export const MAX_HOLE_DISTANCE_M = 1200;

// Two courses with the same name closer than this are treated as one course
// mapped twice (node + boundary area, node + relation).
export const DEDUPE_RADIUS_M = 500;

// Course names that are really hole/basket labels. planetdg's audit found 131
// of these mistagged as courses; they are furniture, not venues.
const HOLE_LABEL_PATTERNS = [
  /^\s*\d+\s*$/,
  /\b(?:hole|hull|h[åa]ll|v[äa]yl[äa]|reik[äa]|kori|basket|tee|fairway|korv)\s*#?\s*\d+\s*$/i,
  /^#\s*\d+\s*$/,
];

// ── Overpass query ────────────────────────────────────────────

/**
 * Build an Overpass QL query for every disc golf object we consume.
 *
 * `out geom` is what makes this workable: it inlines each way's node
 * coordinates and each relation's member geometry, so no second pass is
 * needed to resolve references.
 *
 * @param {object}  [opts]
 * @param {number[]} [opts.bbox]     [south, west, north, east]
 * @param {string}  [opts.iso]       ISO 3166-1 alpha-2, e.g. 'US' (mutually exclusive with bbox)
 * @param {number}  [opts.timeout]   Overpass server-side timeout, seconds
 * @param {string}  [opts.newerThan] ISO timestamp; only objects edited since
 */
export function buildOverpassQuery(opts = {}) {
  const { bbox = null, iso = null, timeout = 300, newerThan = null } = opts;

  if (bbox && iso) throw new Error('Pass bbox or iso, not both');
  if (bbox && bbox.length !== 4) throw new Error('bbox must be [south, west, north, east]');

  const filter = newerThan ? `(newer:"${newerThan}")` : '';
  let scope = '';
  let preamble = `[out:json][timeout:${timeout}]`;

  if (bbox) {
    preamble += `[bbox:${bbox.join(',')}]`;
  } else if (iso) {
    scope = '(area.searchArea)';
  }

  const areaDecl = iso
    ? `area["ISO3166-1"="${iso}"]["admin_level"="2"]->.searchArea;\n`
    : '';

  return `${preamble};
${areaDecl}(
  nwr["leisure"="disc_golf_course"]${scope}${filter};
  way["disc_golf"="hole"]${scope}${filter};
  node["disc_golf"="tee"]${scope}${filter};
  node["disc_golf"="basket"]${scope}${filter};
  relation["type"="disc_golf_layout"]${scope}${filter};
);
out geom qt;`;
}

// ── Geometry helpers ──────────────────────────────────────────

const R_EARTH_M = 6371008.8;
const toRad = (d) => (d * Math.PI) / 180;

/** Great-circle distance in metres. */
export function haversineM(aLat, aLng, bLat, bLng) {
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R_EARTH_M * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Representative point for any Overpass element. */
function pointOf(el) {
  if (typeof el.lat === 'number' && typeof el.lon === 'number') {
    return { lat: el.lat, lng: el.lon };
  }
  if (el.center) return { lat: el.center.lat, lng: el.center.lon };
  if (el.bounds) {
    return {
      lat: (el.bounds.minlat + el.bounds.maxlat) / 2,
      lng: (el.bounds.minlon + el.bounds.maxlon) / 2,
    };
  }
  if (Array.isArray(el.geometry) && el.geometry.length) {
    const pts = el.geometry.filter((p) => p && typeof p.lat === 'number');
    if (!pts.length) return null;
    return {
      lat: pts.reduce((a, p) => a + p.lat, 0) / pts.length,
      lng: pts.reduce((a, p) => a + p.lon, 0) / pts.length,
    };
  }
  return null;
}

// ── Tag parsing ───────────────────────────────────────────────

/**
 * Parse a distance tag into metres.
 *
 * The scheme asks for bare metres (`dist=88`) but the wild contains units,
 * decimal commas, and feet. Anything unparseable returns null rather than a
 * wrong number.
 */
export function parseDistanceM(raw) {
  if (raw == null) return null;
  const s = String(raw).trim().toLowerCase().replace(',', '.');
  const m = s.match(/^(-?\d+(?:\.\d+)?)\s*(m|metres?|meters?|ft|foot|feet|yd|yards?)?$/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = m[2] || 'm';
  const metres =
    unit.startsWith('ft') || unit.startsWith('foo') || unit.startsWith('fee')
      ? n * 0.3048
      : unit.startsWith('yd') || unit.startsWith('yard')
        ? n * 0.9144
        : n;
  // A disc golf hole is not 4km long; reject obvious unit confusion.
  if (metres < 5 || metres > 2000) return null;
  return Math.round(metres);
}

function parseIntTag(raw, { min = 1, max = 20 } = {}) {
  if (raw == null) return null;
  const n = parseInt(String(raw).trim(), 10);
  if (!Number.isFinite(n) || n < min || n > max) return null;
  return n;
}

function firstTag(tags, keys) {
  for (const k of keys) {
    if (tags[k] != null && String(tags[k]).trim() !== '') return String(tags[k]).trim();
  }
  return null;
}

/** True when a course `name` is really a hole/basket label. */
export function looksLikeHoleLabel(name) {
  if (!name) return false;
  return HOLE_LABEL_PATTERNS.some((re) => re.test(name));
}

/**
 * Fold a course name for duplicate comparison.
 *
 * Separators are removed rather than collapsed to spaces, because the common
 * real-world duplicate is a compound-word variant of the same venue:
 * "Wildhorse DiscGolfPark" and "Wildhorse Disc Golf Park" both fold to
 * "wildhorsediscgolfpark". Diacritics are stripped so Nordic and Czech course
 * names — a large share of the dataset — compare correctly.
 */
function normaliseName(name) {
  return String(name || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '');
}

// ── Element extraction ────────────────────────────────────────

const key = (type, id) => `${type}/${id}`;

function extractCourses(elements, warnings) {
  const out = [];
  for (const el of elements) {
    const tags = el.tags || {};
    if (tags.leisure !== 'disc_golf_course') continue;

    const name = firstTag(tags, ['name', 'name:en']);
    if (looksLikeHoleLabel(name)) {
      warnings.push({
        kind: 'course_name_is_hole_label',
        osm: key(el.type, el.id),
        name,
        detail: 'Tagged as a course but named like a hole; treated as furniture and skipped.',
      });
      continue;
    }

    const pt = pointOf(el);
    if (!pt) {
      warnings.push({ kind: 'course_without_geometry', osm: key(el.type, el.id), name });
      continue;
    }

    out.push({
      osm_type: el.type,
      osm_id: el.id,
      osm_version: el.version ?? null,
      name: name || null,
      lat: pt.lat,
      lng: pt.lng,
      city: firstTag(tags, ['addr:city', 'addr:town', 'addr:village']),
      region: firstTag(tags, ['addr:state', 'addr:province', 'addr:county']),
      country: firstTag(tags, ['addr:country']),
      // disc_golf:course=9|18 is the mapper's own statement of hole count.
      declared_hole_count: parseIntTag(tags['disc_golf:course'], { min: 1, max: 200 }),
      layouts: [],
    });
  }
  return out;
}

function extractHoles(elements) {
  const byKey = new Map();
  for (const el of elements) {
    const tags = el.tags || {};
    if (tags.disc_golf !== 'hole') continue;

    const geom = Array.isArray(el.geometry)
      ? el.geometry.filter((p) => p && typeof p.lat === 'number' && typeof p.lon === 'number')
      : [];
    const pt = pointOf(el);
    if (!pt) continue;

    // The way is drawn tee -> basket, so the endpoints are meaningful.
    const tee = geom.length ? { lat: geom[0].lat, lng: geom[0].lon } : null;
    const basket = geom.length ? { lat: geom.at(-1).lat, lng: geom.at(-1).lon } : null;

    // Fall back to measuring the drawn line when dist=* is absent.
    let distance_m = parseDistanceM(
      firstTag(tags, ['dist', 'distance', 'disc_golf:length', 'length']),
    );
    if (distance_m == null && tee && basket) {
      const measured = Math.round(haversineM(tee.lat, tee.lng, basket.lat, basket.lng));
      if (measured >= 5 && measured <= 2000) distance_m = measured;
    }

    byKey.set(key(el.type, el.id), {
      osm_way_id: el.id,
      ref: parseIntTag(tags.ref, { min: 1, max: 200 }),
      par: parseIntTag(firstTag(tags, ['par', 'disc_golf:par']), { min: 1, max: 12 }) ?? 3,
      par_is_assumed: firstTag(tags, ['par', 'disc_golf:par']) == null,
      distance_m,
      tee,
      basket,
      path: geom.map((p) => [p.lat, p.lon]),
      anchor: tee || pt,
    });
  }
  return byKey;
}

function extractLayouts(elements) {
  const out = [];
  for (const el of elements) {
    const tags = el.tags || {};
    if (tags.type !== 'disc_golf_layout') continue;

    const members = Array.isArray(el.members) ? el.members : [];
    const courseRef = members.find((m) => m.role === 'course');
    const holeRefs = members.filter((m) => m.role === 'hole');

    out.push({
      osm_relation_id: el.id,
      name: firstTag(tags, ['name', 'disc_golf:layout', 'ref']),
      tee_colour: firstTag(tags, ['disc_golf:layout', 'tee', 'tee:colour', 'colour']),
      courseKey: courseRef ? key(courseRef.type, courseRef.ref) : null,
      holeKeys: holeRefs.map((m) => key(m.type, m.ref)),
    });
  }
  return out;
}

// ── Assembly ──────────────────────────────────────────────────

function makeLayout({ name, holes, osm_relation_id = null, tee_colour = null, holeOrderTrusted }) {
  const numbered = holes.map((h, i) => ({ ...h, number: i + 1 }));
  const total_par = numbered.reduce((a, h) => a + (h.par || 0), 0) || null;
  const dists = numbered.map((h) => h.distance_m).filter((d) => d != null);
  return {
    name: name || `Main (${numbered.length})`,
    osm_relation_id,
    tee_colour,
    hole_count: numbered.length,
    total_par,
    // Only meaningful if every hole has a distance; a partial sum misleads.
    total_distance_m: dists.length === numbered.length && dists.length ? dists.reduce((a, d) => a + d, 0) : null,
    hole_order_trusted: holeOrderTrusted,
    holes: numbered,
  };
}

/**
 * Order holes for a course that has no layout relation.
 *
 * Uses ref=* when every hole has one and they are unique — the only case
 * where the numbering is actually stated. Otherwise falls back to a
 * nearest-neighbour walk from the course point, which produces a plausible
 * route but is a guess, and says so.
 */
function orderHolesWithoutRelation(holes, coursePoint) {
  const refs = holes.map((h) => h.ref);
  const allHaveRef = refs.every((r) => r != null);
  const refsUnique = new Set(refs).size === refs.length;

  if (allHaveRef && refsUnique) {
    return { holes: [...holes].sort((a, b) => a.ref - b.ref), trusted: true };
  }

  const remaining = [...holes];
  const ordered = [];
  let cursor = coursePoint;
  while (remaining.length) {
    let bestIdx = 0;
    let bestDist = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const a = remaining[i].anchor;
      const d = haversineM(cursor.lat, cursor.lng, a.lat, a.lng);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    }
    const [next] = remaining.splice(bestIdx, 1);
    ordered.push(next);
    cursor = next.basket || next.anchor;
  }
  return { holes: ordered, trusted: false };
}

function dedupeCourses(courses, warnings) {
  const kept = [];
  const typeRank = { node: 0, relation: 1, way: 2 };

  const holesOf = (c) => c.layouts.reduce((a, l) => Math.max(a, l.hole_count), 0);

  for (const c of courses) {
    const nn = normaliseName(c.name);
    const dupIdx = nn
      ? kept.findIndex(
          (k) =>
            normaliseName(k.name) === nn &&
            haversineM(k.lat, k.lng, c.lat, c.lng) <= DEDUPE_RADIUS_M,
        )
      : -1;

    if (dupIdx === -1) {
      // Near-identical names nearby are flagged but never merged: a single
      // venue can legitimately run a red and a yellow course side by side,
      // and collapsing those would lose a real course.
      if (nn.length >= 6) {
        const near = kept.find(
          (k) => {
            const kn = normaliseName(k.name);
            if (kn === nn || kn.length < 6) return false;
            const contained = kn.startsWith(nn) || nn.startsWith(kn);
            return contained && haversineM(k.lat, k.lng, c.lat, c.lng) <= DEDUPE_RADIUS_M;
          },
        );
        if (near) {
          warnings.push({
            kind: 'possible_duplicate_course',
            osm: key(c.osm_type, c.osm_id),
            name: c.name,
            detail: `Name is a prefix variant of nearby "${near.name}" (${key(near.osm_type, near.osm_id)}). Kept both — needs human review, not an automatic merge.`,
          });
        }
      }
      kept.push(c);
      continue;
    }

    const existing = kept[dupIdx];
    // Prefer whichever object actually carries the holes; break ties on the
    // element type the scheme prefers.
    const cWins =
      holesOf(c) > holesOf(existing) ||
      (holesOf(c) === holesOf(existing) && typeRank[c.osm_type] < typeRank[existing.osm_type]);

    const loser = cWins ? existing : c;
    const winner = cWins ? c : existing;
    if (cWins) kept[dupIdx] = c;

    warnings.push({
      kind: 'duplicate_course',
      osm: key(loser.osm_type, loser.osm_id),
      name: loser.name,
      detail: `Same name within ${DEDUPE_RADIUS_M}m as ${key(winner.osm_type, winner.osm_id)}; dropped in favour of it.`,
    });
  }
  return kept;
}

/**
 * Normalise a raw Overpass JSON response into course rows.
 *
 * @param {object} overpassJson  Parsed `out geom` response
 * @param {object} [opts]
 * @param {number} [opts.maxHoleDistanceM]
 * @returns {{courses: object[], warnings: object[], stats: object}}
 */
export function normalize(overpassJson, opts = {}) {
  const maxHoleDistanceM = opts.maxHoleDistanceM ?? MAX_HOLE_DISTANCE_M;
  const elements = Array.isArray(overpassJson?.elements) ? overpassJson.elements : [];
  const warnings = [];

  const courses = extractCourses(elements, warnings);
  const holesByKey = extractHoles(elements);
  const layoutRels = extractLayouts(elements);

  const courseByKey = new Map(courses.map((c) => [key(c.osm_type, c.osm_id), c]));
  const claimedHoleKeys = new Set();

  // ── Pass 1: layout relations. Hole numbering comes from member order. ──
  for (const rel of layoutRels) {
    const course = rel.courseKey ? courseByKey.get(rel.courseKey) : null;
    if (!course) {
      warnings.push({
        kind: 'layout_without_course_member',
        osm: `relation/${rel.osm_relation_id}`,
        name: rel.name,
        detail: 'Relation has no resolvable role=course member; its holes fall back to proximity matching.',
      });
      continue;
    }

    const holes = [];
    for (const hk of rel.holeKeys) {
      const h = holesByKey.get(hk);
      if (h) {
        holes.push(h);
        claimedHoleKeys.add(hk);
      }
    }
    if (!holes.length) {
      warnings.push({
        kind: 'layout_without_holes',
        osm: `relation/${rel.osm_relation_id}`,
        name: rel.name,
      });
      continue;
    }

    course.layouts.push(
      makeLayout({
        name: rel.name,
        holes,
        osm_relation_id: rel.osm_relation_id,
        tee_colour: rel.tee_colour,
        holeOrderTrusted: true,
      }),
    );
  }

  // ── Pass 2: unclaimed holes attach to the nearest course. ──
  const orphanHoles = [];
  const byCourseKey = new Map();

  for (const [hk, hole] of holesByKey) {
    if (claimedHoleKeys.has(hk)) continue;

    let best = null;
    let bestDist = Infinity;
    for (const c of courses) {
      const d = haversineM(c.lat, c.lng, hole.anchor.lat, hole.anchor.lng);
      if (d < bestDist) {
        bestDist = d;
        best = c;
      }
    }

    if (!best || bestDist > maxHoleDistanceM) {
      orphanHoles.push({ hk, dist: bestDist });
      continue;
    }
    const ck = key(best.osm_type, best.osm_id);
    if (!byCourseKey.has(ck)) byCourseKey.set(ck, []);
    byCourseKey.get(ck).push(hole);
  }

  if (orphanHoles.length) {
    warnings.push({
      kind: 'orphan_holes',
      count: orphanHoles.length,
      detail: `Holes with no leisure=disc_golf_course within ${maxHoleDistanceM}m. Usually a real course missing its course tag.`,
      sample: orphanHoles.slice(0, 10).map((o) => o.hk),
    });
  }

  for (const [ck, holes] of byCourseKey) {
    const course = courseByKey.get(ck);
    const { holes: ordered, trusted } = orderHolesWithoutRelation(holes, {
      lat: course.lat,
      lng: course.lng,
    });

    // A course with layout relations plus loose holes means the relations are
    // incomplete. Keep the loose ones as a separate, clearly-named layout
    // rather than silently merging them into a curated layout.
    const isSupplementary = course.layouts.length > 0;
    course.layouts.push(
      makeLayout({
        name: isSupplementary ? `Unassigned holes (${ordered.length})` : null,
        holes: ordered,
        holeOrderTrusted: trusted,
      }),
    );

    if (!trusted) {
      warnings.push({
        kind: 'inferred_hole_order',
        osm: ck,
        name: course.name,
        detail:
          'No layout relation and no complete ref=* numbering; hole order inferred by nearest-neighbour walk and should be treated as provisional.',
      });
    }
  }

  // ── Finish up ──
  let deduped = dedupeCourses(courses, warnings);

  for (const c of deduped) {
    if (c.layouts.length) {
      // Default layout: the one with the most holes.
      const best = c.layouts.reduce((a, b) => (b.hole_count > a.hole_count ? b : a));
      for (const l of c.layouts) l.is_default = l === best;
      c.hole_count = c.declared_hole_count ?? best.hole_count;
    } else {
      c.hole_count = c.declared_hole_count ?? null;
    }
    delete c.declared_hole_count;

    if (!c.name) {
      warnings.push({
        kind: 'course_without_name',
        osm: key(c.osm_type, c.osm_id),
        detail: 'Course has no name tag; imported as "Unnamed course" and worth a user correction.',
      });
      c.name = 'Unnamed course';
    }
  }

  // A course with no holes is still a useful catalog entry (you can log a
  // round there) — it just has no map. Keep it, but count it.
  const withGeometry = deduped.filter((c) => c.layouts.some((l) => l.hole_count > 0));

  return {
    courses: deduped,
    warnings,
    stats: {
      elements: elements.length,
      courses: deduped.length,
      coursesWithHoleGeometry: withGeometry.length,
      layouts: deduped.reduce((a, c) => a + c.layouts.length, 0),
      holes: deduped.reduce((a, c) => a + c.layouts.reduce((b, l) => b + l.hole_count, 0), 0),
      layoutRelations: layoutRels.length,
      holesInSource: holesByKey.size,
      warnings: warnings.length,
    },
  };
}

// ── Stable IDs ────────────────────────────────────────────────
// Deterministic so a re-ingest updates rows instead of duplicating them.
// A hole ID is scoped to its layout, because the same OSM way is a different
// hole number in a different layout.

const OSM_TYPE_ABBR = { node: 'n', way: 'w', relation: 'r' };

export const courseId = (c) => `osm-${OSM_TYPE_ABBR[c.osm_type]}${c.osm_id}`;

export const layoutId = (c, layout, index) =>
  layout.osm_relation_id
    ? `osm-r${layout.osm_relation_id}`
    : `${courseId(c)}-l${index}`;

export const holeId = (lid, hole) => `${lid}-h${hole.number}`;
