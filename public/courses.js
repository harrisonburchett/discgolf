// ============================================================
// courses.js — Course catalog, hole maps, and scorecard entry
//
// Loaded before app.js so its function declarations are hoisted into global
// scope by the time app.js builds its route table. No build step, no modules —
// same architecture as the rest of the frontend.
//
// The hole diagram is the one piece of real drawing work here. OSM gives each
// hole as a way drawn tee -> basket, so there is true geometry to render: not a
// decorative graphic, but the actual shape of the fairway including doglegs.
// ============================================================

/* global ACTIONS, api, escapeHtml, setContent, navigate, showAlert */

// ── Geographic projection ─────────────────────────────────────
//
// At the scale of a single disc golf hole (under ~300m) a local equirectangular
// projection is accurate to well under a metre, so there is no reason to pull in
// a mapping library. Longitude degrees are scaled by cos(latitude); latitude
// degrees are effectively constant.

const M_PER_DEG_LAT = 110574;
const M_PER_DEG_LNG_EQ = 111320;

/** Convert [[lat,lng], …] to local metres, east-positive and north-positive. */
function toLocalMetres(points) {
  if (!points || !points.length) return [];
  const lat0 = points.reduce((a, p) => a + p[0], 0) / points.length;
  const lng0 = points.reduce((a, p) => a + p[1], 0) / points.length;
  const mPerDegLng = M_PER_DEG_LNG_EQ * Math.cos((lat0 * Math.PI) / 180);
  return points.map(([lat, lng]) => ({
    x: (lng - lng0) * mPerDegLng,
    y: (lat - lat0) * M_PER_DEG_LAT,
  }));
}

function rotate(points, radians) {
  const c = Math.cos(radians);
  const s = Math.sin(radians);
  return points.map(({ x, y }) => ({ x: x * c - y * s, y: x * s + y * c }));
}

/**
 * Fit local-metre points into an SVG box, preserving aspect ratio.
 * Returns screen points plus the scale, so a distance bar can be drawn to
 * match — a diagram without a scale invites the wrong read of a dogleg.
 */
function fitToBox(points, width, height, pad = 18) {
  if (!points.length) return { points: [], scale: 1 };

  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const spanX = Math.max(...xs) - Math.min(...xs);
  const spanY = Math.max(...ys) - Math.min(...ys);

  const usableW = width - pad * 2;
  const usableH = height - pad * 2;
  // A perfectly straight hole has zero width; fall back so it doesn't divide by 0.
  const scale = Math.min(
    spanX > 0.01 ? usableW / spanX : Infinity,
    spanY > 0.01 ? usableH / spanY : Infinity,
  );
  const s = Number.isFinite(scale) ? scale : 1;

  const midX = (Math.max(...xs) + Math.min(...xs)) / 2;
  const midY = (Math.max(...ys) + Math.min(...ys)) / 2;

  return {
    // SVG y grows downward, so north is negated here.
    points: points.map((p) => ({
      x: width / 2 + (p.x - midX) * s,
      y: height / 2 - (p.y - midY) * s,
    })),
    scale: s,
  };
}

const pathD = (pts) =>
  pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');

/** A scale bar with a round number of metres, sized to the diagram. */
function scaleBar(scale, x, y) {
  const candidates = [10, 20, 25, 50, 100, 200];
  const metres = candidates.find((m) => m * scale > 40 && m * scale < 140) ?? 50;
  const px = metres * scale;
  if (!Number.isFinite(px) || px < 8) return '';
  return `
    <g class="scale-bar" transform="translate(${x} ${y})">
      <line x1="0" y1="0" x2="${px.toFixed(1)}" y2="0" />
      <line x1="0" y1="-3" x2="0" y2="3" />
      <line x1="${px.toFixed(1)}" y1="-3" x2="${px.toFixed(1)}" y2="3" />
      <text x="${(px / 2).toFixed(1)}" y="-6">${metres} m</text>
    </g>`;
}

// ── Single-hole diagram ───────────────────────────────────────

/**
 * Draw one hole with the tee at the bottom and the basket at the top — the
 * orientation every printed course map and scorecard app uses, because it
 * matches how you stand on the pad looking at the target.
 */
function holeDiagram(hole, { width = 260, height = 190 } = {}) {
  const raw = Array.isArray(hole.path) && hole.path.length >= 2 ? hole.path : null;

  if (!raw) {
    return `
      <div class="hole-diagram empty" role="img" aria-label="No map data for hole ${hole.number}">
        <span>No map data</span>
      </div>`;
  }

  let pts = toLocalMetres(raw);

  // Rotate so the tee->basket axis points up.
  const tee = pts[0];
  const basket = pts[pts.length - 1];
  const dx = basket.x - tee.x;
  const dy = basket.y - tee.y;
  if (Math.hypot(dx, dy) > 0.5) {
    pts = rotate(pts, Math.PI / 2 - Math.atan2(dy, dx));
  }

  const { points, scale } = fitToBox(pts, width, height);
  const t = points[0];
  const b = points[points.length - 1];

  const label = `Hole ${hole.number}, par ${hole.par}${
    hole.distance_m ? `, ${hole.distance_m} metres` : ''
  }`;

  return `
    <svg class="hole-diagram" viewBox="0 0 ${width} ${height}"
         xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${escapeHtml(label)}">
      <path class="fairway-shadow" d="${pathD(points)}" />
      <path class="fairway" d="${pathD(points)}" />
      <g class="tee-marker" transform="translate(${t.x.toFixed(1)} ${t.y.toFixed(1)})">
        <rect x="-7" y="-4" width="14" height="8" rx="2" />
      </g>
      <g class="basket-marker" transform="translate(${b.x.toFixed(1)} ${b.y.toFixed(1)})">
        <circle r="6" />
        <line x1="0" y1="0" x2="0" y2="9" />
      </g>
      ${scaleBar(scale, 14, height - 12)}
    </svg>`;
}

// ── Whole-course diagram ──────────────────────────────────────

/**
 * All holes of a layout in true orientation, north up. Deliberately not
 * rotated: on a course overview, the compass matters more than any one hole.
 */
function courseDiagram(layout, { width = 680, height = 420 } = {}) {
  const holesWithPath = (layout.holes || []).filter(
    (h) => Array.isArray(h.path) && h.path.length >= 2,
  );
  if (!holesWithPath.length) return '';

  const flat = holesWithPath.flatMap((h) => h.path);
  const local = toLocalMetres(flat);
  const { points, scale } = fitToBox(local, width, height, 28);

  // Walk the flattened array back into per-hole slices.
  let cursor = 0;
  const shapes = holesWithPath.map((h) => {
    const slice = points.slice(cursor, cursor + h.path.length);
    cursor += h.path.length;
    return { hole: h, pts: slice };
  });

  const fairways = shapes
    .map(({ pts }) => `<path class="fairway" d="${pathD(pts)}" />`)
    .join('');

  const markers = shapes
    .map(({ hole, pts }) => {
      const t = pts[0];
      const b = pts[pts.length - 1];
      return `
        <g class="course-hole" tabindex="0" role="button"
           aria-label="Hole ${hole.number}, par ${hole.par}"
           data-action="focus-hole" data-hole="${hole.number}">
          <circle class="basket-dot" cx="${b.x.toFixed(1)}" cy="${b.y.toFixed(1)}" r="3.5" />
          <circle class="tee-hit" cx="${t.x.toFixed(1)}" cy="${t.y.toFixed(1)}" r="11" />
          <text class="hole-number" x="${t.x.toFixed(1)}" y="${(t.y + 4).toFixed(1)}">${hole.number}</text>
        </g>`;
    })
    .join('');

  return `
    <div class="course-map-wrap">
      <svg class="course-map" viewBox="0 0 ${width} ${height}"
           xmlns="http://www.w3.org/2000/svg" role="img"
           aria-label="Map of ${escapeHtml(layout.name)}, ${holesWithPath.length} holes">
        <g class="compass" transform="translate(${width - 26} 26)">
          <path d="M0 -11 L4 4 L0 1 L-4 4 Z" />
          <text y="17">N</text>
        </g>
        ${fairways}
        ${markers}
        ${scaleBar(scale, 22, height - 16)}
      </svg>
    </div>`;
}

/** Scroll a hole card into view and flash it. Called from the course map. */
function focusHole(number) {
  const el = document.getElementById(`hole-card-${number}`);
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.remove('flash');
  // Force a reflow so the animation restarts on repeated clicks.
  void el.offsetWidth;
  el.classList.add('flash');
}

// ── Page: course search ───────────────────────────────────────

let courseSearchTimer = null;
// Monotonic token. Debouncing reduces the number of in-flight requests but does
// not order them: a slow response for "map" could still land after a fast one
// for "maple" and overwrite the correct results with stale ones.
let courseSearchSeq = 0;

function renderCourses() {
  setContent(`
    <div class="page-header">
      <h2>Courses</h2>
    </div>
    <div id="alertBox"></div>
    <div class="course-search">
      <input type="search" id="courseQuery" placeholder="Search by name…"
             autocomplete="off" aria-label="Search courses by name"
             data-action="course-query" data-on="input">
      <button class="secondary" data-action="courses-near-me">Near me</button>
    </div>
    <label class="checkbox-row">
      <input type="checkbox" id="courseWithMaps" data-action="course-search" data-on="change">
      <span>Only courses with hole maps</span>
    </label>
    <div id="courseResults">
      <div class="empty-state">
        <div class="icon">🗺️</div>
        <div class="title">Find a course</div>
        <div class="desc">Search by name, or use your location to see what's nearby.</div>
      </div>
    </div>
  `);

  document.getElementById('courseQuery')?.focus();
}

function courseResultsHtml(courses, { showDistance = false } = {}) {
  if (!courses.length) {
    return `
      <div class="empty-state">
        <div class="icon">🔍</div>
        <div class="title">No courses found</div>
        <div class="desc">Try a shorter search, or add the course when you log a round.</div>
      </div>`;
  }

  return `
    <div class="course-list">
      ${courses
        .map((c) => {
          const place = [c.city, c.region].filter(Boolean).join(', ');
          const meta = [
            c.hole_count ? `${c.hole_count} holes` : null,
            c.layout_count > 1 ? `${c.layout_count} layouts` : null,
            showDistance && c.distance_km != null ? `${c.distance_km} km away` : null,
          ].filter(Boolean);
          return `
            <button class="course-card" data-action="navigate" data-route="course" data-id="${escapeHtml(c.id)}">
              <div class="course-card-main">
                <div class="course-card-name">${escapeHtml(c.name)}</div>
                ${place ? `<div class="course-card-place">${escapeHtml(place)}</div>` : ''}
                ${meta.length ? `<div class="course-card-meta">${meta.map(escapeHtml).join(' · ')}</div>` : ''}
              </div>
              ${c.has_map ? '<span class="tag tag-map">Map</span>' : '<span class="tag">No map</span>'}
            </button>`;
        })
        .join('')}
    </div>`;
}

async function runCourseSearch() {
  const q = document.getElementById('courseQuery')?.value.trim() ?? '';
  const withMaps = document.getElementById('courseWithMaps')?.checked;
  const target = document.getElementById('courseResults');
  if (!target) return;

  if (q.length < 2) {
    target.innerHTML = `
      <div class="empty-state">
        <div class="icon">🗺️</div>
        <div class="title">Find a course</div>
        <div class="desc">Type at least two characters, or use your location.</div>
      </div>`;
    return;
  }

  const seq = ++courseSearchSeq;
  target.innerHTML = '<div class="loading">Searching…</div>';
  try {
    const params = new URLSearchParams({ q, limit: '30' });
    if (withMaps) params.set('withMaps', '1');
    const data = await api(`/courses?${params}`);
    if (seq !== courseSearchSeq) return; // superseded by a newer search
    target.innerHTML = courseResultsHtml(data.courses) + attributionHtml(data.attribution);
  } catch (e) {
    if (seq !== courseSearchSeq) return;
    target.innerHTML = `<div class="alert error" role="alert">${escapeHtml(e.message)}</div>`;
  }
}

function findCoursesNearMe() {
  const target = document.getElementById('courseResults');
  if (!navigator.geolocation) {
    return showAlert('This browser has no location support. Search by name instead.');
  }
  target.innerHTML = '<div class="loading">Getting your location…</div>';

  const seq = ++courseSearchSeq;

  navigator.geolocation.getCurrentPosition(
    async ({ coords }) => {
      if (seq !== courseSearchSeq) return;
      target.innerHTML = '<div class="loading">Finding courses nearby…</div>';
      try {
        const withMaps = document.getElementById('courseWithMaps')?.checked;
        const params = new URLSearchParams({
          lat: String(coords.latitude),
          lng: String(coords.longitude),
          radius: '80',
          limit: '30',
        });
        if (withMaps) params.set('withMaps', '1');
        const data = await api(`/courses?${params}`);
        if (seq !== courseSearchSeq) return;
        target.innerHTML =
          courseResultsHtml(data.courses, { showDistance: true }) + attributionHtml(data.attribution);
      } catch (e) {
        if (seq !== courseSearchSeq) return;
        target.innerHTML = `<div class="alert error" role="alert">${escapeHtml(e.message)}</div>`;
      }
    },
    (err) => {
      if (seq !== courseSearchSeq) return;
      // Name the fix, not the error code.
      const msg =
        err.code === err.PERMISSION_DENIED
          ? 'Location is blocked for this site. Allow it in your browser settings, or search by name.'
          : 'Could not get your location. Search by name instead.';
      target.innerHTML = `<div class="alert error">${escapeHtml(msg)}</div>`;
    },
    { timeout: 10000, maximumAge: 300000 },
  );
}

const attributionHtml = (text) =>
  text ? `<p class="attribution">${escapeHtml(text)}</p>` : '';

// ── Page: course detail ───────────────────────────────────────

let currentCourse = null;
let currentLayoutId = null;

async function renderCourseDetail(params = {}) {
  setContent('<div class="loading">Loading course…</div>');
  try {
    const data = await api(`/courses/${encodeURIComponent(params.id)}`);
    currentCourse = data;
    currentLayoutId = data.layouts.find((l) => l.is_default)?.id ?? data.layouts[0]?.id ?? null;
    drawCourseDetail();
  } catch (e) {
    setContent(`<div class="alert error">${escapeHtml(e.message)}</div>`);
  }
}

function selectLayout(id) {
  currentLayoutId = id;
  drawCourseDetail();
}

function drawCourseDetail() {
  const { course, layouts, attribution } = currentCourse;
  const layout = layouts.find((l) => l.id === currentLayoutId) ?? layouts[0] ?? null;
  const place = [course.city, course.region, course.country].filter(Boolean).join(', ');

  const layoutTabs =
    layouts.length > 1
      ? `<div class="layout-tabs" role="tablist" aria-label="Layouts">
          ${layouts
            .map(
              (l) => `
            <button role="tab" class="layout-tab ${l.id === currentLayoutId ? 'active' : ''}"
                    aria-selected="${l.id === currentLayoutId}"
                    data-action="select-layout" data-id="${escapeHtml(l.id)}">
              ${escapeHtml(l.name)}
              <span class="layout-tab-meta">${l.hole_count} holes${l.total_par ? ` · par ${l.total_par}` : ''}</span>
            </button>`,
            )
            .join('')}
        </div>`
      : '';

  const summary = layout
    ? `<div class="layout-summary">
        <span><strong>${layout.hole_count}</strong> holes</span>
        ${layout.total_par ? `<span>Par <strong>${layout.total_par}</strong></span>` : ''}
        ${layout.total_distance_m ? `<span><strong>${layout.total_distance_m.toLocaleString()}</strong> m</span>` : ''}
        ${layout.tee_colour ? `<span>${escapeHtml(layout.tee_colour.replace(/;/g, ' / '))} tees</span>` : ''}
      </div>`
    : '';

  const holeCards = layout?.holes?.length
    ? `<div class="hole-grid">
        ${layout.holes
          .map(
            (h) => `
          <div class="hole-card" id="hole-card-${h.number}">
            <div class="hole-card-head">
              <span class="hole-card-number">${h.number}</span>
              <span class="hole-card-par">Par ${h.par}</span>
              ${h.distance_m ? `<span class="hole-card-dist">${h.distance_m} m</span>` : ''}
            </div>
            ${holeDiagram(h)}
          </div>`,
          )
          .join('')}
      </div>`
    : `<div class="empty-state">
        <div class="icon">🗺️</div>
        <div class="title">No hole map yet</div>
        <div class="desc">This course is in the catalog but its holes aren't mapped. You can still log rounds here.</div>
      </div>`;

  setContent(`
    <div class="page-header course-detail-header">
      <div>
        <button class="link-back" data-action="navigate" data-route="courses">← Courses</button>
        <h2>${escapeHtml(course.name)}</h2>
        ${place ? `<div class="course-place">${escapeHtml(place)}</div>` : ''}
      </div>
      <button class="primary" data-action="start-round-here">Log a round here</button>
    </div>
    ${layoutTabs}
    ${summary}
    ${layout ? courseDiagram(layout) : ''}
    ${holeCards}
    ${attributionHtml(attribution)}
    ${
      course.osm_url
        ? `<p class="attribution">
             Something wrong? <a href="${escapeHtml(course.osm_url)}" target="_blank" rel="noopener noreferrer">Fix it on OpenStreetMap</a>
             and it will update here within a few days.
           </p>`
        : ''
    }
  `);
}

function startRoundHere(courseId) {
  navigate('add', { courseId, layoutId: currentLayoutId });
}

// ── Delegated actions ─────────────────────────────────────────

Object.assign(ACTIONS, {
  'focus-hole': ({ hole }) => focusHole(Number(hole)),
  'select-layout': ({ id }) => selectLayout(id),
  'start-round-here': () => startRoundHere(),
  'courses-near-me': () => findCoursesNearMe(),
  'course-search': () => runCourseSearch(),
  // Debounced here rather than via addEventListener, so the handler survives
  // the page being re-rendered without needing to be re-attached.
  'course-query': () => {
    clearTimeout(courseSearchTimer);
    courseSearchTimer = setTimeout(runCourseSearch, 250);
  },
});
