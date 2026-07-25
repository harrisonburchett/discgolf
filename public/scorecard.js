// ============================================================
// scorecard.js — Logging a round
//
// Three ways in, and the form has to make all of them feel like one flow:
//
//   1. From a course page  -> course and layout already chosen
//   2. From the nav        -> search the catalog first
//   3. Course not in the catalog -> free text name and a total score
//
// When the chosen layout has mapped holes, the default is a hole-by-hole
// scorecard, because that is what unlocks per-hole stats later. Entering just a
// total stays available as a toggle rather than a separate page — the same round
// either way, at whatever detail the player has to hand.
// ============================================================

/* global ACTIONS, api, escapeHtml, setContent, navigate, showAlert, clearAlert,
   holeDiagram, formatDate, currentLayout */

const addRound = {
  mode: 'catalog', // 'catalog' | 'manual'
  course: null, // { id, name }
  layouts: [],
  layoutId: null,
  scorecard: true, // hole-by-hole vs total only
  strokes: {}, // hole number -> strokes
  searchTimer: null,
  searchSeq: 0,
};

function resetAddRound() {
  addRound.mode = 'catalog';
  addRound.course = null;
  addRound.layouts = [];
  addRound.layoutId = null;
  addRound.scorecard = true;
  addRound.strokes = {};
}

const currentLayout = () => addRound.layouts.find((l) => l.id === addRound.layoutId) ?? null;

// ── Entry point ───────────────────────────────────────────────

async function renderAddRound(params = {}) {
  resetAddRound();
  const today = new Date().toISOString().split('T')[0];

  setContent(`
    <div class="page-header"><h2>Log a round</h2></div>
    <div id="alertBox"></div>
    <div class="round-form">
      <div id="coursePickerSlot"></div>
      <div id="scorecardSlot"></div>
      <div class="form-row">
        <div class="form-group">
          <label for="roundDate">Date played</label>
          <input type="date" id="roundDate" value="${today}" max="${today}">
        </div>
        <div class="form-group" id="parSlot"></div>
      </div>
      <div class="form-group">
        <label for="roundNotes">Notes</label>
        <textarea id="roundNotes" rows="3" placeholder="Weather, discs, who you played with…"></textarea>
      </div>
      <button class="primary" id="saveRoundBtn" data-action="save-round">Save round</button>
    </div>
  `);

  // Arriving from a course page: skip straight to the scorecard.
  if (params.courseId) {
    await loadCourseForRound(params.courseId, params.layoutId);
  } else {
    drawCoursePicker();
  }
}

// ── Course selection ──────────────────────────────────────────

function drawCoursePicker() {
  const slot = document.getElementById('coursePickerSlot');
  if (!slot) return;

  if (addRound.mode === 'manual') {
    slot.innerHTML = `
      <div class="form-group">
        <label for="roundCourse">Course name</label>
        <input type="text" id="roundCourse" placeholder="e.g. Maple Hill" autocomplete="off">
      </div>
      <button class="link-button" data-action="round-mode" data-mode="catalog">Search the course catalog instead</button>
    `;
    document.getElementById('roundCourse')?.focus();
    drawScorecard();
    return;
  }

  if (addRound.course) {
    slot.innerHTML = `
      <div class="chosen-course">
        <div>
          <div class="chosen-course-name">${escapeHtml(addRound.course.name)}</div>
          <div class="chosen-course-meta">${
            addRound.layouts.length
              ? `${addRound.layouts.length} layout${addRound.layouts.length === 1 ? '' : 's'}`
              : 'No layouts mapped'
          }</div>
        </div>
        <button class="link-button" data-action="clear-round-course">Change</button>
      </div>
      ${
        addRound.layouts.length > 1
          ? `<div class="form-group">
              <label for="roundLayout">Layout</label>
              <select id="roundLayout" data-action="select-round-layout" data-on="change">
                ${addRound.layouts
                  .map(
                    (l) => `<option value="${escapeHtml(l.id)}" ${l.id === addRound.layoutId ? 'selected' : ''}>
                      ${escapeHtml(l.name)} — ${l.hole_count} holes${l.total_par ? `, par ${l.total_par}` : ''}
                    </option>`,
                  )
                  .join('')}
              </select>
            </div>`
          : ''
      }
    `;
    drawScorecard();
    return;
  }

  slot.innerHTML = `
    <div class="form-group">
      <label for="roundCourseSearch">Course</label>
      <input type="search" id="roundCourseSearch" placeholder="Search courses…" autocomplete="off"
             aria-label="Search for a course" data-action="round-course-query" data-on="input">
      <div id="roundCourseResults" class="inline-results"></div>
    </div>
    <button class="link-button" data-action="round-mode" data-mode="manual">Course not listed? Enter it by hand</button>
  `;

  document.getElementById('roundCourseSearch')?.focus();
  drawScorecard();
}

function setRoundMode(mode) {
  addRound.mode = mode;
  addRound.course = null;
  addRound.layouts = [];
  addRound.layoutId = null;
  addRound.strokes = {};
  drawCoursePicker();
}

function clearRoundCourse() {
  addRound.course = null;
  addRound.layouts = [];
  addRound.layoutId = null;
  addRound.strokes = {};
  drawCoursePicker();
}

async function searchCoursesForRound() {
  const q = document.getElementById('roundCourseSearch')?.value.trim() ?? '';
  const target = document.getElementById('roundCourseResults');
  if (!target) return;

  if (q.length < 2) {
    target.innerHTML = '';
    return;
  }

  const seq = ++addRound.searchSeq;
  try {
    const data = await api(`/courses?q=${encodeURIComponent(q)}&limit=8`);
    if (seq !== addRound.searchSeq) return; // superseded
    if (!data.courses.length) {
      target.innerHTML = `<div class="inline-result-empty">
        No match. <button class="link-button" data-action="round-mode" data-mode="manual">Enter it by hand</button>
      </div>`;
      return;
    }
    target.innerHTML = data.courses
      .map(
        (c) => `
        <button class="inline-result" data-action="pick-course" data-id="${escapeHtml(c.id)}">
          <span class="inline-result-name">${escapeHtml(c.name)}</span>
          <span class="inline-result-meta">${escapeHtml(
            [c.city, c.region].filter(Boolean).join(', ') || '—',
          )}${c.has_map ? ' · map' : ''}</span>
        </button>`,
      )
      .join('');
  } catch (e) {
    if (seq !== addRound.searchSeq) return;
    target.innerHTML = `<div class="alert error" role="alert">${escapeHtml(e.message)}</div>`;
  }
}

async function loadCourseForRound(courseId, preferredLayoutId = null) {
  try {
    const data = await api(`/courses/${encodeURIComponent(courseId)}`);
    addRound.mode = 'catalog';
    addRound.course = { id: data.course.id, name: data.course.name };
    addRound.layouts = data.layouts;
    addRound.layoutId =
      (preferredLayoutId && data.layouts.some((l) => l.id === preferredLayoutId)
        ? preferredLayoutId
        : null) ??
      data.layouts.find((l) => l.is_default)?.id ??
      data.layouts[0]?.id ??
      null;
    addRound.strokes = {};
    // Default to a scorecard only when there are holes to fill in.
    addRound.scorecard = (currentLayout()?.holes?.length ?? 0) > 0;
    drawCoursePicker();
  } catch (e) {
    showAlert(e.message);
  }
}

function selectRoundLayout(id) {
  addRound.layoutId = id;
  addRound.strokes = {};
  addRound.scorecard = (currentLayout()?.holes?.length ?? 0) > 0;
  drawCoursePicker();
}

// ── Scorecard ─────────────────────────────────────────────────

function drawScorecard() {
  const slot = document.getElementById('scorecardSlot');
  const parSlot = document.getElementById('parSlot');
  if (!slot || !parSlot) return;

  const layout = currentLayout();
  const holes = layout?.holes ?? [];

  // Par is only editable when nothing else can supply it.
  parSlot.innerHTML = layout?.total_par
    ? `<label>Par</label><div class="static-field">${layout.total_par} <span>from ${escapeHtml(layout.name)}</span></div>`
    : `<label for="roundPar">Par</label><input type="number" id="roundPar" placeholder="54" min="1" max="300">`;

  if (!holes.length || !addRound.scorecard) {
    slot.innerHTML = `
      <div class="form-group">
        <label for="roundScore">Total score</label>
        <input type="number" id="roundScore" placeholder="54" min="1" max="500" inputmode="numeric">
      </div>
      ${
        holes.length
          ? `<button class="link-button" data-action="toggle-scorecard" data-enabled="1">Enter hole by hole instead</button>`
          : ''
      }
    `;
    return;
  }

  slot.innerHTML = `
    <div class="scorecard">
      <div class="scorecard-head">
        <h3>Scorecard</h3>
        <button class="link-button" data-action="toggle-scorecard" data-enabled="0">Just enter a total</button>
      </div>
      <div class="scorecard-grid">
        ${holes.map((h) => holeRow(h)).join('')}
      </div>
      <div class="scorecard-total" id="scorecardTotal" aria-live="polite"></div>
    </div>
  `;
  updateScorecardTotal();
}

function holeRow(hole) {
  const value = addRound.strokes[hole.number] ?? '';
  return `
    <div class="score-row" data-hole="${hole.number}">
      <div class="score-row-info">
        <span class="score-row-number">${hole.number}</span>
        <span class="score-row-par">Par ${hole.par}</span>
        ${hole.distance_m ? `<span class="score-row-dist">${hole.distance_m} m</span>` : ''}
      </div>
      <div class="stepper">
        <button type="button" aria-label="One fewer stroke on hole ${hole.number}"
                data-action="bump-hole" data-hole="${hole.number}" data-delta="-1">−</button>
        <input type="number" inputmode="numeric" min="1" max="30"
               id="hole-input-${hole.number}"
               aria-label="Strokes on hole ${hole.number}, par ${hole.par}"
               value="${value}" placeholder="${hole.par}"
               data-action="set-hole" data-hole="${hole.number}" data-on="input">
        <button type="button" aria-label="One more stroke on hole ${hole.number}"
                data-action="bump-hole" data-hole="${hole.number}" data-delta="1">+</button>
      </div>
      <span class="score-row-diff" id="hole-diff-${hole.number}"></span>
    </div>`;
}

function toggleScorecard(on) {
  addRound.scorecard = on;
  if (!on) addRound.strokes = {};
  drawScorecard();
}

function setHole(number, raw) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) {
    delete addRound.strokes[number];
  } else {
    addRound.strokes[number] = Math.min(n, 30);
  }
  updateHoleDiff(number);
  updateScorecardTotal();
}

function bumpHole(number, delta) {
  const layout = currentLayout();
  const hole = layout?.holes?.find((h) => h.number === number);
  // First tap starts from par, which is where most holes land anyway.
  const base = addRound.strokes[number] ?? hole?.par ?? 3;
  const next = Math.min(30, Math.max(1, addRound.strokes[number] === undefined ? base : base + delta));
  addRound.strokes[number] = next;
  const input = document.getElementById(`hole-input-${number}`);
  if (input) input.value = String(next);
  updateHoleDiff(number);
  updateScorecardTotal();
}

function updateHoleDiff(number) {
  const el = document.getElementById(`hole-diff-${number}`);
  if (!el) return;
  const hole = currentLayout()?.holes?.find((h) => h.number === number);
  const strokes = addRound.strokes[number];
  if (!hole || strokes === undefined) {
    el.textContent = '';
    el.className = 'score-row-diff';
    return;
  }
  const diff = strokes - hole.par;
  el.textContent = diff === 0 ? 'E' : diff > 0 ? `+${diff}` : String(diff);
  el.className = `score-row-diff ${diff < 0 ? 'under' : diff > 0 ? 'over' : 'even'}`;
}

function updateScorecardTotal() {
  const el = document.getElementById('scorecardTotal');
  if (!el) return;
  const layout = currentLayout();
  const holes = layout?.holes ?? [];
  const entered = holes.filter((h) => addRound.strokes[h.number] !== undefined);

  if (!entered.length) {
    el.innerHTML = `<span class="scorecard-total-hint">Fill in at least one hole.</span>`;
    return;
  }

  const strokes = entered.reduce((a, h) => a + addRound.strokes[h.number], 0);
  const par = entered.reduce((a, h) => a + h.par, 0);
  const diff = strokes - par;
  const diffLabel = diff === 0 ? 'even' : diff > 0 ? `+${diff}` : String(diff);
  const cls = diff < 0 ? 'under' : diff > 0 ? 'over' : 'even';

  el.innerHTML = `
    <span class="scorecard-total-score">${strokes}</span>
    <span class="scorecard-total-diff ${cls}">${escapeHtml(diffLabel)}</span>
    <span class="scorecard-total-hint">
      ${entered.length} of ${holes.length} holes${entered.length < holes.length ? ' — partial round' : ''}
    </span>`;
}

// ── Keyboard flow ─────────────────────────────────────────────
//
// Filling in 18 holes means 18 fields. Enter advancing to the next one turns
// that into a straight run down the card instead of a tab-shift-tab shuffle.

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const input = e.target.closest('[data-action="set-hole"]');
  if (!input) return;
  e.preventDefault();

  const holes = currentLayout()?.holes ?? [];
  const current = Number(input.dataset.hole);
  const idx = holes.findIndex((h) => h.number === current);
  const next = holes[idx + 1];

  if (next) {
    const el = document.getElementById(`hole-input-${next.number}`);
    el?.focus();
    el?.select();
  } else {
    // Last hole: Enter saves, which is what it should do at the end of a form.
    document.getElementById('saveRoundBtn')?.focus();
  }
});

// ── Save ──────────────────────────────────────────────────────

async function handleAddRound() {
  clearAlert();
  const btn = document.getElementById('saveRoundBtn');
  const date_played = document.getElementById('roundDate')?.value;
  const notes = document.getElementById('roundNotes')?.value.trim() ?? '';

  if (!date_played) return showAlert('Pick the date you played.');

  const payload = { date_played, notes };
  const layout = currentLayout();

  if (addRound.mode === 'manual') {
    const course = document.getElementById('roundCourse')?.value.trim();
    if (!course) return showAlert('Enter the course name.');
    payload.course = course;
  } else if (addRound.course) {
    payload.course_id = addRound.course.id;
    if (layout) payload.layout_id = layout.id;
  } else {
    return showAlert('Choose a course, or enter one by hand.');
  }

  const useScorecard = addRound.scorecard && (layout?.holes?.length ?? 0) > 0;

  if (useScorecard) {
    const entries = Object.entries(addRound.strokes)
      .map(([number, strokes]) => ({ number: Number(number), strokes }))
      .sort((a, b) => a.number - b.number);
    if (!entries.length) return showAlert('Enter a score for at least one hole.');
    payload.hole_scores = entries;
  } else {
    const total = parseInt(document.getElementById('roundScore')?.value, 10);
    if (!Number.isFinite(total) || total < 1) return showAlert('Enter your total score.');
    payload.total_score = total;

    const parInput = document.getElementById('roundPar');
    if (parInput?.value) {
      const par = parseInt(parInput.value, 10);
      if (Number.isFinite(par)) payload.par = par;
    }
  }

  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Saving…';
  }

  try {
    await api('/rounds', { method: 'POST', body: JSON.stringify(payload) });
    navigate('dashboard');
  } catch (e) {
    showAlert(e.message);
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Save round';
    }
  }
}

// ── Delegated actions ─────────────────────────────────────────

Object.assign(ACTIONS, {
  'pick-course': ({ id }) => loadCourseForRound(id),
  'round-mode': ({ mode }) => setRoundMode(mode),
  'clear-round-course': () => clearRoundCourse(),
  'toggle-scorecard': ({ enabled }) => toggleScorecard(enabled === '1'),
  'bump-hole': ({ hole, delta }) => bumpHole(Number(hole), Number(delta)),
  'set-hole': ({ hole }, el) => setHole(Number(hole), el.value),
  'select-round-layout': (_d, el) => selectRoundLayout(el.value),
  'save-round': () => handleAddRound(),
  'round-course-query': () => {
    clearTimeout(addRound.searchTimer);
    addRound.searchTimer = setTimeout(searchCoursesForRound, 250);
  },
});

// ============================================================
// Round detail — a saved scorecard, hole by hole
//
// Without this page, hole_scores were written on save and never shown again.
// ============================================================

async function renderRoundDetail(params = {}) {
  setContent('<div class="loading">Loading round…</div>');
  try {
    const { round, hole_scores } = await api(`/rounds/${encodeURIComponent(params.id)}`);

    const toPar = round.to_par;
    const diffLabel = toPar === null ? null : toPar === 0 ? 'E' : toPar > 0 ? `+${toPar}` : String(toPar);
    const diffCls = toPar === null ? '' : toPar < 0 ? 'under' : toPar > 0 ? 'over' : 'even';

    const played = hole_scores.length;
    const partial =
      played > 0 && round.layout_hole_count && played < round.layout_hole_count;

    const cards = played
      ? `<div class="hole-grid">
          ${hole_scores
            .map((h) => {
              const d = h.to_par;
              const label = d === null ? '' : d === 0 ? 'E' : d > 0 ? `+${d}` : String(d);
              const cls = d === null ? '' : d < 0 ? 'under' : d > 0 ? 'over' : 'even';
              return `
                <div class="hole-card">
                  <div class="hole-card-head">
                    <span class="hole-card-number">${h.number}</span>
                    <span class="hole-card-par">Par ${h.par ?? '—'}</span>
                    ${h.distance_m ? `<span class="hole-card-dist">${h.distance_m} m</span>` : ''}
                  </div>
                  <div class="played-score">
                    <span class="played-strokes">${h.strokes}</span>
                    ${label ? `<span class="played-diff ${cls}">${escapeHtml(label)}</span>` : ''}
                  </div>
                  ${holeDiagram(h, { width: 240, height: 150 })}
                </div>`;
            })
            .join('')}
        </div>`
      : `<div class="empty-state">
          <div class="icon">📝</div>
          <div class="title">No hole-by-hole scores</div>
          <div class="desc">This round was saved as a total only.</div>
        </div>`;

    setContent(`
      <div class="page-header course-detail-header">
        <div>
          <button class="link-back" data-action="navigate" data-route="history">← History</button>
          <h2>${escapeHtml(round.course_name || round.course)}</h2>
          <div class="course-place">
            ${escapeHtml(formatDate(round.date_played))}
            ${round.layout_name ? ` · ${escapeHtml(round.layout_name)}` : ''}
          </div>
        </div>
        <button class="danger" data-action="delete-round" data-id="${escapeHtml(round.id)}">Delete round</button>
      </div>

      <div class="round-summary">
        <div class="round-summary-score">
          <span class="round-summary-total">${round.total_score}</span>
          ${diffLabel ? `<span class="round-summary-diff ${diffCls}">${escapeHtml(diffLabel)}</span>` : ''}
        </div>
        <div class="round-summary-meta">
          ${round.effective_par ? `<span>Par <strong>${round.effective_par}</strong></span>` : ''}
          ${played ? `<span><strong>${played}</strong> holes scored</span>` : ''}
          ${partial ? `<span class="warn">Partial round</span>` : ''}
          ${
            round.course_id
              ? `<button class="link-button" data-action="navigate" data-route="course" data-id="${escapeHtml(round.course_id)}">View course</button>`
              : ''
          }
        </div>
      </div>

      ${round.notes ? `<div class="round-notes">${escapeHtml(round.notes)}</div>` : ''}
      ${cards}
    `);
  } catch (e) {
    setContent(`<div class="alert error">${escapeHtml(e.message)}</div>`);
  }
}
