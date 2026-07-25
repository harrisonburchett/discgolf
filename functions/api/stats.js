// ============================================================
// GET /api/stats — Improvement analytics for the current user
//
// The headline change from the first version: improvement is measured
// RELATIVE TO PAR wherever par is known. Averaging raw totals across courses
// with different pars makes "you improved 3 strokes" mostly a statement about
// which courses you happened to play recently, not about how you played.
//
// Par isn't always available (a free-text round with no par, a catalog course
// with no mapped holes), so the response reports `parCoverage` and the client
// is expected to say which basis it is showing rather than quietly mixing them.
//
// Every legacy field name is preserved so the existing dashboard keeps working.
// ============================================================

import { getUser, unauthorized, json } from '../lib/auth.js';

const round1 = (n) => (n === null || n === undefined ? null : Math.round(n * 10) / 10);
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/**
 * Compare the most recent window against the window immediately before it,
 * using EQUAL window sizes.
 *
 * The first version compared `slice(-10)` against `slice(-20, -10)`, so a user
 * with 15 rounds was comparing 10 rounds against 5 — a difference in sample
 * size dressed up as a difference in performance.
 *
 * Returns null until there are enough rounds for both windows to be the same
 * size and large enough to mean anything.
 */
function windowedImprovement(values, maxWindow = 10, minWindow = 3) {
  const window = Math.min(maxWindow, Math.floor(values.length / 2));
  if (window < minWindow) {
    return { window: null, recent: null, previous: null, improvement: null };
  }
  const recent = values.slice(-window);
  const previous = values.slice(-2 * window, -window);
  const recentAvg = mean(recent);
  const prevAvg = mean(previous);
  return {
    window,
    recent: recentAvg,
    previous: prevAvg,
    // Positive = improving. Scores go down as you get better, so the
    // subtraction runs previous-minus-recent for both bases.
    improvement: prevAvg === null || recentAvg === null ? null : prevAvg - recentAvg,
  };
}

/** Golf naming for a single hole result, used for the rate breakdown. */
function holeOutcome(diff) {
  if (diff <= -2) return 'eagleOrBetter';
  if (diff === -1) return 'birdie';
  if (diff === 0) return 'par';
  if (diff === 1) return 'bogey';
  return 'doubleBogeyOrWorse';
}

export async function onRequestGet({ request, env }) {
  const user = await getUser(request, env);
  if (!user) return unauthorized();

  // COALESCE(l.total_par, r.par): prefer the layout's par, fall back to the
  // snapshot stored on the round. That keeps legacy rows and off-catalog
  // courses in the analytics instead of dropping them.
  const [roundRows, holeRows] = await Promise.all([
    env.DB.prepare(
      `SELECT r.id, r.date_played, r.total_score, r.course, r.course_id, r.layout_id,
              COALESCE(l.total_par, r.par) AS effective_par,
              l.name AS layout_name
       FROM rounds r
       LEFT JOIN layouts l ON l.id = r.layout_id
       WHERE r.user_id = ?
       ORDER BY r.date_played ASC, r.created_at ASC`,
    )
      .bind(user.id)
      .all(),
    env.DB.prepare(
      `SELECT hs.hole_number, hs.par, hs.strokes, r.layout_id, l.name AS layout_name,
              COALESCE(c.name, r.course) AS course_name
       FROM hole_scores hs
       JOIN rounds r ON r.id = hs.round_id
       LEFT JOIN layouts l ON l.id = r.layout_id
       LEFT JOIN courses c ON c.id = r.course_id
       WHERE r.user_id = ? AND hs.par IS NOT NULL`,
    )
      .bind(user.id)
      .all(),
  ]);

  const data = roundRows.results || [];

  if (data.length === 0) {
    return json({
      totalRounds: 0,
      bestScore: null,
      averageScore: null,
      recentAverage: null,
      previousAverage: null,
      improvement: null,
      trend: [],
      perCourse: [],
      basis: 'none',
      parCoverage: { withPar: 0, total: 0 },
      toPar: null,
      holeStats: null,
      comparisonWindow: null,
    });
  }

  // ── Raw totals (legacy basis, kept for continuity) ──
  const scores = data.map((r) => r.total_score);
  const rawWindow = windowedImprovement(scores);

  // ── Par-relative basis ──
  const withPar = data.filter((r) => r.effective_par != null);
  const toParValues = withPar.map((r) => r.total_score - r.effective_par);
  const parWindow = windowedImprovement(toParValues);

  // Report only one basis as authoritative, and say which. Requiring most
  // rounds to have par stops a single par-tagged round from flipping the
  // dashboard to a basis it can't actually support.
  //
  // Note this depends on coverage ALONE, not on whether a windowed comparison
  // is available. Those are separate questions: with five par-known rounds the
  // right answer is to show to-par averages and withhold only the improvement
  // figure, rather than falling back to raw totals for everything.
  const coverage = withPar.length / data.length;
  const basis = coverage >= 0.6 ? 'toPar' : 'raw';

  // ── Trend ──
  const trend = data.map((r) => ({
    date: r.date_played,
    score: r.total_score,
    course: r.course,
    par: r.effective_par,
    toPar: r.effective_par != null ? r.total_score - r.effective_par : null,
    layout: r.layout_name,
  }));

  // ── Per-course ──
  // Keyed on course_id when available so two spellings of the same catalog
  // course don't split into two rows; free-text rounds still key on name.
  const courseMap = new Map();
  for (const r of data) {
    const key = r.course_id ?? `name:${r.course}`;
    if (!courseMap.has(key)) {
      courseMap.set(key, {
        course: r.course,
        course_id: r.course_id,
        rounds: 0,
        scores: [],
        toPar: [],
      });
    }
    const c = courseMap.get(key);
    c.rounds++;
    c.scores.push(r.total_score);
    if (r.effective_par != null) c.toPar.push(r.total_score - r.effective_par);
  }

  const perCourse = [...courseMap.values()]
    .map((c) => ({
      course: c.course,
      course_id: c.course_id,
      rounds: c.rounds,
      best: Math.min(...c.scores),
      average: round1(mean(c.scores)),
      bestToPar: c.toPar.length ? Math.min(...c.toPar) : null,
      averageToPar: round1(mean(c.toPar)),
    }))
    .sort((a, b) => b.rounds - a.rounds);

  // ── Hole-level insights ──
  const holes = holeRows.results || [];
  let holeStats = null;

  if (holes.length) {
    const outcomes = {
      eagleOrBetter: 0,
      birdie: 0,
      par: 0,
      bogey: 0,
      doubleBogeyOrWorse: 0,
    };
    const byPar = new Map();
    const byHole = new Map();

    for (const h of holes) {
      const diff = h.strokes - h.par;
      outcomes[holeOutcome(diff)]++;

      if (!byPar.has(h.par)) byPar.set(h.par, []);
      byPar.get(h.par).push(diff);

      // Group by the specific hole on the specific layout: "hole 7" only means
      // something within one layout.
      const key = `${h.layout_id ?? 'none'}#${h.hole_number}`;
      if (!byHole.has(key)) {
        byHole.set(key, {
          hole_number: h.hole_number,
          par: h.par,
          layout_name: h.layout_name,
          course_name: h.course_name,
          diffs: [],
        });
      }
      byHole.get(key).diffs.push(diff);
    }

    const total = holes.length;
    const rate = (n) => round1((n / total) * 100);

    // Only holes played enough times for the average to be worth showing.
    const MIN_PLAYS = 3;
    const eligible = [...byHole.values()]
      .filter((h) => h.diffs.length >= MIN_PLAYS)
      .map((h) => ({
        hole_number: h.hole_number,
        par: h.par,
        layout_name: h.layout_name,
        course_name: h.course_name,
        plays: h.diffs.length,
        averageToPar: round1(mean(h.diffs)),
      }));

    holeStats = {
      holesScored: total,
      outcomes,
      outcomeRates: {
        eagleOrBetter: rate(outcomes.eagleOrBetter),
        birdie: rate(outcomes.birdie),
        par: rate(outcomes.par),
        bogey: rate(outcomes.bogey),
        doubleBogeyOrWorse: rate(outcomes.doubleBogeyOrWorse),
      },
      byPar: [...byPar.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([par, diffs]) => ({
          par,
          holesPlayed: diffs.length,
          averageToPar: round1(mean(diffs)),
        })),
      minPlaysForHoleRanking: MIN_PLAYS,
      toughestHoles: [...eligible].sort((a, b) => b.averageToPar - a.averageToPar).slice(0, 5),
      bestHoles: [...eligible].sort((a, b) => a.averageToPar - b.averageToPar).slice(0, 5),
    };
  }

  const active = basis === 'toPar' ? parWindow : rawWindow;

  return json({
    // ── Legacy fields, unchanged shape ──
    totalRounds: data.length,
    bestScore: Math.min(...scores),
    averageScore: round1(mean(scores)),
    recentAverage: round1(rawWindow.recent),
    // `!== null` rather than a truthy check: the old version used `prevAvg ? …`,
    // which turned a legitimate average of 0 into null.
    previousAverage: rawWindow.previous !== null ? round1(rawWindow.previous) : null,
    improvement: round1(active.improvement),
    trend,
    perCourse,

    // ── New ──
    basis,
    comparisonWindow: active.window,
    parCoverage: {
      withPar: withPar.length,
      total: data.length,
      fraction: round1(coverage * 100),
    },
    toPar:
      withPar.length === 0
        ? null
        : {
            best: Math.min(...toParValues),
            average: round1(mean(toParValues)),
            recentAverage: round1(parWindow.recent),
            previousAverage: parWindow.previous !== null ? round1(parWindow.previous) : null,
            improvement: round1(parWindow.improvement),
            rounds: withPar.length,
          },
    holeStats,
  });
}
