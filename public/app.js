/* ============================================================
   Disc Golf Tracker — SPA Application
   Vanilla JS, no frameworks. Dark, minimal, premium UI.
   ============================================================ */

const API = '/api';
let token = localStorage.getItem('dgt_token');
let currentUser = null;

// ── API helpers ──────────────────────────────────────

/** "45" -> "45s", "125" -> "3m" — rounds up so "try again in 0s" never appears. */
function formatRetryAfter(seconds) {
  const s = Math.max(1, Math.ceil(seconds));
  if (s < 60) return `${s}s`;
  return `${Math.ceil(s / 60)}m`;
}

async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${API}${path}`, {
    ...opts,
    headers: { ...headers, ...opts.headers },
  });
  if (res.status === 401) {
    logout();
    return null;
  }
  const data = await res.json().catch(() => ({}));

  // 429s carry a Retry-After header the server means literally; surface it so
  // "too many attempts" becomes "try again in 45s" instead of leaving the user
  // to guess when it's safe to retry.
  if (res.status === 429) {
    const retryAfter = parseInt(res.headers.get('Retry-After'), 10);
    const base = data.error || 'Too many requests.';
    const suffix = Number.isFinite(retryAfter) && retryAfter > 0
      ? ` Try again in ${formatRetryAfter(retryAfter)}.`
      : '';
    throw new Error(base + suffix);
  }

  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

// ── Auth ──────────────────────────────────────────────

function logout() {
  localStorage.removeItem('dgt_token');
  token = null;
  currentUser = null;
  renderAuth();
}

async function checkAuth() {
  if (!token) { renderAuth(); return false; }
  try {
    const data = await api('/auth/me');
    if (data?.user) {
      currentUser = data.user;
      return true;
    }
  } catch {
    logout();
    return false;
  }
  return false;
}

// ── Delegated actions (see actions.js) ────────────────

Object.assign(ACTIONS, {
  navigate: ({ route, id, username }) => {
    const params = {};
    if (id) params.id = id;
    if (username) params.username = username;
    navigate(route, params);
  },
  logout: () => logout(),
  login: () => handleLogin(),
  register: () => handleRegister(),
  'show-register': () => showRegisterForm(),
  'show-login': () => showLoginForm(),
  'delete-round': ({ id }) => deleteRound(id),
  'accept-friend': ({ id }) => acceptFriend(id),
  'send-friend-request': ({ username }) => sendFriendRequest(username),
  'search-users': () => searchUsers(),
  'add-friend-modal': () => showAddFriendModal(),
  'close-friend-modal': () => document.getElementById('friendModal')?.remove(),
});

// ── Router ────────────────────────────────────────────

const routes = {
  dashboard: renderDashboard,
  add: renderAddRound,        // scorecard.js
  courses: renderCourses,     // courses.js
  course: renderCourseDetail, // courses.js
  history: renderHistory,
  round: renderRoundDetail,   // scorecard.js
  stats: renderStats,
  friends: renderFriends,
  friend: renderFriendDetail,
};

let currentRoute = 'dashboard';

function navigate(route, params = {}) {
  if (!routes[route]) {
    console.warn(`Unknown route: ${route}`);
    route = 'dashboard';
  }
  currentRoute = route;

  // Most renderers are async. Without this catch a rejected one produced an
  // unhandled rejection and left the page stuck on "Loading…" with no
  // explanation of what went wrong.
  const run = () => {
    renderLayout(params);
    Promise.resolve(routes[route](params)).catch(err => {
      console.error(err);
      setContent(`<div class="alert error" role="alert">${escapeHtml(
        err?.message || 'Something went wrong loading this page.'
      )}</div>`);
    });
  };

  if (currentUser) {
    run();
  } else {
    checkAuth().then(ok => { if (ok) run(); });
  }
}

// ── Render: Auth ─────────────────────────────────────

function renderAuth() {
  document.getElementById('app').innerHTML = `
    <div class="auth-wrap">
      <div class="auth-card" id="authCard">
        <h1>🥏 Disc Golf Tracker</h1>
        <p class="subtitle">Track your rounds. See your progress. Compete with friends.</p>
        <div id="authForm"></div>
      </div>
    </div>
  `;
  showLoginForm();
}

function showLoginForm() {
  document.getElementById('authForm').innerHTML = `
    <div id="alertBox"></div>
    <div class="form-group">
      <label>Email</label>
      <input type="email" id="loginEmail" placeholder="you@example.com">
    </div>
    <div class="form-group">
      <label>Password</label>
      <input type="password" id="loginPassword" placeholder="••••••••">
    </div>
    <button class="primary" data-action="login">Log In</button>
    <p class="auth-switch">
      No account? <a href="#" data-action="show-register" class="accent-link">Create one</a>
    </p>
  `;
}

function showRegisterForm() {
  document.getElementById('authForm').innerHTML = `
    <div id="alertBox"></div>
    <div class="form-group">
      <label>Username</label>
      <input type="text" id="regUsername" placeholder="yourname">
    </div>
    <div class="form-group">
      <label>Email</label>
      <input type="email" id="regEmail" placeholder="you@example.com">
    </div>
    <div class="form-group">
      <label>Password (min 6 chars)</label>
      <input type="password" id="regPassword" placeholder="••••••••">
    </div>
    <div class="form-group">
      <label>Display Name (optional)</label>
      <input type="text" id="regDisplayName" placeholder="Your Name">
    </div>
    <button class="primary" data-action="register">Create Account</button>
    <p class="auth-switch">
      Already have an account? <a href="#" data-action="show-login" class="accent-link">Log in</a>
    </p>
  `;
}

/** Clear any stale message. Called before an action so an old error can't sit
 *  above a screen that has since succeeded. */
function clearAlert() {
  const box = document.getElementById('alertBox');
  if (box) box.innerHTML = '';
}

function showAlert(msg, type = 'error') {
  const box = document.getElementById('alertBox');
  if (!box) { console.warn('showAlert with no #alertBox on the page:', msg); return; }
  // role="alert" so assistive tech announces it; without it the message appears
  // silently and a screen-reader user gets no feedback that a save failed.
  box.innerHTML = `<div class="alert ${type}" role="alert">${escapeHtml(msg)}</div>`;
  box.scrollIntoView({ block: 'nearest' });
}

async function handleLogin() {
  const email = document.getElementById('loginEmail').value.trim();
  const password = document.getElementById('loginPassword').value;
  if (!email || !password) return showAlert('Please fill in all fields');
  try {
    const data = await api('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
    if (data) {
      token = data.token;
      localStorage.setItem('dgt_token', data.token);
      currentUser = data.user;
      navigate('dashboard');
    }
  } catch (e) {
    showAlert(e.message);
  }
}

async function handleRegister() {
  const username = document.getElementById('regUsername').value.trim();
  const email = document.getElementById('regEmail').value.trim();
  const password = document.getElementById('regPassword').value;
  const display_name = document.getElementById('regDisplayName').value.trim();
  if (!username || !email || !password) return showAlert('Please fill in all required fields');
  try {
    const data = await api('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ username, email, password, display_name }),
    });
    if (data) {
      token = data.token;
      localStorage.setItem('dgt_token', data.token);
      currentUser = data.user;
      navigate('dashboard');
    }
  } catch (e) {
    showAlert(e.message);
  }
}

// ── Render: Layout (sidebar + content) ───────────────

function renderLayout(params = {}) {
  const navItems = [
    { id: 'dashboard', label: 'Dashboard', icon: '📊' },
    { id: 'add', label: 'Log Round', icon: '➕' },
    { id: 'courses', label: 'Courses', icon: '🗺️' },
    { id: 'history', label: 'History', icon: '📋' },
    { id: 'stats', label: 'Stats', icon: '📈' },
    { id: 'friends', label: 'Friends', icon: '👥' },
  ];

  // A course detail page is reached from the Courses list, so keep that tab lit.
  const activeTab = currentRoute === 'course' ? 'courses'
    : currentRoute === 'friend' ? 'friends'
    : currentRoute;

  const navHtml = navItems.map(n =>
    `<div class="nav-item ${activeTab === n.id ? 'active' : ''}" role="button" tabindex="0"
        data-action="navigate" data-route="${escapeHtml(n.id)}">${n.icon} ${n.label}</div>`
  ).join('');

  const initials = (currentUser.display_name || currentUser.username).charAt(0).toUpperCase();

  document.getElementById('app').innerHTML = `
    <div class="layout">
      <aside class="sidebar">
        <div class="logo">🥏 Disc<span>Tracker</span></div>
        ${navHtml}
        <div class="user-section">
          <div class="username">${escapeHtml(currentUser.display_name || currentUser.username)}</div>
          <div class="logout-link" role="button" tabindex="0" data-action="logout">Log out</div>
        </div>
      </aside>
      <main class="main-content" id="pageContent">
        <div class="loading">Loading…</div>
      </main>
    </div>
  `;
}

function setContent(html) {
  document.getElementById('pageContent').innerHTML = html;
  applyDynamicWidths();
}

/**
 * Size any element carrying data-pct.
 *
 * These widths are data-driven, so they cannot live in the stylesheet, and CSS
 * cannot read a length from an attribute. Applying them through the CSSOM keeps
 * the markup free of style attributes, which is what lets the Content-Security
 * -Policy forbid inline styles outright.
 */
function applyDynamicWidths(root = document) {
  for (const el of root.querySelectorAll('[data-pct]')) {
    const pct = parseFloat(el.dataset.pct);
    if (Number.isFinite(pct)) el.style.width = `${Math.max(0, Math.min(100, pct))}%`;
  }
}

// ── Page: Dashboard ─────────────────────────────────

async function renderDashboard() {
  setContent('<div class="loading">Loading…</div>');
  try {
    const [stats, recentRounds] = await Promise.all([
      api('/stats'),
      api('/rounds?limit=5'),
    ]);

    if (!stats || !recentRounds) return;

    const improvementBadge = stats.improvement !== null
      ? `<span class="improvement-badge ${stats.improvement > 0 ? 'up' : stats.improvement < 0 ? 'down' : 'flat'}">
          ${stats.improvement > 0 ? '↑' : stats.improvement < 0 ? '↓' : '—'}
          ${stats.improvement !== 0 ? Math.abs(stats.improvement) + ' strokes' : 'no change'}
        </span>`
      : '';

    let html = `
      <div class="page-header">
        <h2>Dashboard</h2>
        <button class="primary small" data-action="navigate" data-route="add">Log a round</button>
      </div>
    `;

    if (stats.totalRounds === 0) {
      html += `
        <div class="empty-state">
          <div class="icon">🥏</div>
          <div class="title">No rounds yet</div>
          <div class="desc">Add your first disc golf round to start tracking your progress.</div>
          <button class="primary small" data-action="navigate" data-route="add">Log your first round</button>
        </div>
      `;
      setContent(html);
      return;
    }

    html += `
      <div class="stats-grid">
        <div class="stat-card">
          <div class="label">Rounds</div>
          <div class="value neutral">${stats.totalRounds}</div>
        </div>
        <div class="stat-card">
          <div class="label">${stats.basis === 'toPar' ? 'Best, to par' : 'Best score'}</div>
          <div class="value good">${
            stats.basis === 'toPar' ? escapeHtml(formatToPar(stats.toPar.best)) : stats.bestScore
          }</div>
        </div>
        <div class="stat-card">
          <div class="label">${stats.basis === 'toPar' ? 'Average, to par' : 'Average score'}</div>
          <div class="value neutral">${
            stats.basis === 'toPar' ? escapeHtml(formatToPar(stats.toPar.average)) : stats.averageScore
          }</div>
        </div>
        <div class="stat-card">
          <div class="label">Recent form</div>
          <div class="value ${stats.improvement > 0 ? 'good' : stats.improvement < 0 ? 'bad' : 'neutral'}">${
            stats.basis === 'toPar'
              ? escapeHtml(formatToPar(stats.toPar.recentAverage))
              : (stats.recentAverage ?? '—')
          }</div>
          <div class="sub">${improvementBadge}</div>
        </div>
      </div>
    `;

    // Trend chart — pass the basis so the dashboard and the stats page never
    // disagree about what they are plotting.
    html += renderTrendChart(stats.trend, stats.basis);

    // Recent rounds table
    if (recentRounds.rounds && recentRounds.rounds.length > 0) {
      html += `
        <div class="page-header tight-header">
          <h2 class="section-title">Recent Rounds</h2>
        </div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Date</th><th>Course</th><th>Score</th><th>To par</th></tr></thead>
            <tbody>
              ${recentRounds.rounds.map(r => `
                <tr>
                  <td>${formatDate(r.date_played)}</td>
                  <td>${escapeHtml(r.course)}</td>
                  <td><span class="score-pill ${r.effective_par ? scoreClass(r.total_score, r.effective_par) : 'even'}">${r.total_score}</span></td>
                  <td>${formatToPar(r.to_par)}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      `;
    }

    setContent(html);
  } catch (e) {
    setContent(`<div class="alert error">${escapeHtml(e.message)}</div>`);
  }
}

// ── Page: Add Round ──────────────────────────────────

// renderAddRound / handleAddRound now live in scorecard.js

// ── Page: History ────────────────────────────────────

async function renderHistory() {
  setContent('<div class="loading">Loading…</div>');
  try {
    const data = await api('/rounds?limit=200');
    if (!data) return;

    if (!data.rounds || data.rounds.length === 0) {
      setContent(`
        <div class="page-header"><h2>Round History</h2></div>
        <div class="empty-state">
          <div class="icon">📋</div>
          <div class="title">No rounds recorded</div>
          <div class="desc">Your played rounds will appear here.</div>
          <button class="primary small" data-action="navigate" data-route="add">Log a round</button>
        </div>
      `);
      return;
    }

    const rows = data.rounds.map(r => `
      <tr class="clickable-row"
          data-action="navigate" data-route="round" data-id="${escapeHtml(r.id)}">
        <td>${formatDate(r.date_played)}</td>
        <td>
          <button class="row-link" data-action="navigate" data-route="round" data-id="${escapeHtml(r.id)}">
            ${escapeHtml(r.course_name || r.course)}
          </button>
          ${r.layout_name ? `<span class="row-sub">${escapeHtml(r.layout_name)}</span>` : ''}
        </td>
        <td><span class="score-pill ${r.effective_par ? scoreClass(r.total_score, r.effective_par) : 'even'}">${r.total_score}</span></td>
        <td>${formatToPar(r.to_par)}</td>
        <td>${r.hole_score_count > 0 ? `<span class="tag tag-map">${r.hole_score_count} holes</span>` : '<span class="dim">Total only</span>'}</td>
        <td>${r.notes ? escapeHtml(r.notes.substring(0, 40)) + (r.notes.length > 40 ? '…' : '') : '—'}</td>
        <td><button class="danger" data-action="delete-round" data-id="${escapeHtml(r.id)}">Delete</button></td>
      </tr>
    `).join('');

    setContent(`
      <div class="page-header">
        <h2>Round history</h2>
        <button class="primary small" data-action="navigate" data-route="add">Log a round</button>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Date</th><th>Course</th><th>Score</th><th>To par</th><th>Detail</th><th>Notes</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `);
  } catch (e) {
    setContent(`<div class="alert error">${escapeHtml(e.message)}</div>`);
  }
}

async function deleteRound(id) {
  if (!confirm('Delete this round? This cannot be undone.')) return;
  try {
    await api(`/rounds/${encodeURIComponent(id)}`, { method: 'DELETE' });
    // Through the router, not renderHistory() directly — calling the renderer
    // straight left currentRoute pointing at the old page, so the sidebar
    // highlight desynced from what was on screen (visible when deleting from
    // the round detail page).
    navigate('history');
  } catch (e) {
    showAlert(e.message);
  }
}

// ── Page: Stats ──────────────────────────────────────

async function renderStats() {
  setContent('<div class="loading">Loading…</div>');
  try {
    const stats = await api('/stats');
    if (!stats) return;

    if (stats.totalRounds === 0) {
      setContent(`
        <div class="page-header"><h2>Statistics</h2></div>
        <div class="empty-state">
          <div class="icon">📈</div>
          <div class="title">No data yet</div>
          <div class="desc">Log a few rounds to see how you're tracking.</div>
        </div>
      `);
      return;
    }

    const toPar = stats.basis === 'toPar';
    const fmtToPar = formatToPar;
    const dir = stats.improvement > 0 ? 'good' : stats.improvement < 0 ? 'bad' : 'neutral';

    // Say which basis is in use. Mixing raw totals and to-par silently is how
    // the old version made "3 strokes better" mean nothing.
    const basisNote = toPar
      ? `Measured against par, across ${stats.parCoverage.withPar} of ${stats.parCoverage.total} rounds with a known par.`
      : stats.parCoverage.withPar > 0
        ? `Measured on raw totals — only ${stats.parCoverage.withPar} of ${stats.parCoverage.total} rounds have a known par. Log rounds against a catalog course to compare against par instead.`
        : `Measured on raw totals. Log rounds against a catalog course to compare against par instead.`;

    let html = `
      <div class="page-header"><h2>Statistics</h2></div>
      <p class="basis-note">${escapeHtml(basisNote)}</p>
      <div class="stats-grid">
        <div class="stat-card">
          <div class="label">Rounds</div>
          <div class="value neutral">${stats.totalRounds}</div>
        </div>
        <div class="stat-card">
          <div class="label">${toPar ? 'Best, to par' : 'Best score'}</div>
          <div class="value good">${toPar ? escapeHtml(fmtToPar(stats.toPar.best)) : stats.bestScore}</div>
          ${toPar ? `<div class="sub">${stats.bestScore} strokes</div>` : ''}
        </div>
        <div class="stat-card">
          <div class="label">${toPar ? 'Average, to par' : 'Average score'}</div>
          <div class="value neutral">${toPar ? escapeHtml(fmtToPar(stats.toPar.average)) : stats.averageScore}</div>
        </div>
        <div class="stat-card">
          <div class="label">Recent form</div>
          <div class="value ${dir}">${
            toPar ? escapeHtml(fmtToPar(stats.toPar.recentAverage)) : (stats.recentAverage ?? '—')
          }</div>
          <div class="sub">
            ${stats.improvement !== null
              ? `<span class="improvement-badge ${stats.improvement > 0 ? 'up' : stats.improvement < 0 ? 'down' : 'flat'}">
                  ${stats.improvement > 0 ? 'Improving' : stats.improvement < 0 ? 'Slipping' : 'Steady'}
                  ${stats.improvement !== 0 ? `by ${Math.abs(stats.improvement)}` : ''}
                </span>
                <span class="sub-note">last ${stats.comparisonWindow} vs previous ${stats.comparisonWindow}</span>`
              : `Not enough rounds to compare yet`}
          </div>
        </div>
      </div>
    `;

    html += renderTrendChart(stats.trend, stats.basis);

    // ── Hole-level breakdown ──
    const h = stats.holeStats;
    if (h) {
      const rates = h.outcomeRates;
      const bands = [
        { key: 'eagleOrBetter', label: 'Eagle+', cls: 'eagle' },
        { key: 'birdie', label: 'Birdie', cls: 'birdie' },
        { key: 'par', label: 'Par', cls: 'par' },
        { key: 'bogey', label: 'Bogey', cls: 'bogey' },
        { key: 'doubleBogeyOrWorse', label: 'Double+', cls: 'double' },
      ].filter(b => rates[b.key] > 0);

      html += `
        <div class="chart-section">
          <h3>Hole by hole</h3>
          <p class="section-note">From ${h.holesScored.toLocaleString()} scored holes.</p>
          <div class="outcome-bar" role="img" aria-label="${escapeHtml(
            bands.map(b => `${b.label} ${rates[b.key]}%`).join(', '),
          )}">
            ${bands.map(b => `<div class="outcome-seg ${b.cls}" data-pct="${rates[b.key]}"></div>`).join('')}
          </div>
          <div class="outcome-legend">
            ${bands.map(b => `
              <span class="outcome-key">
                <i class="swatch ${b.cls}"></i>${b.label}
                <strong>${rates[b.key]}%</strong>
              </span>`).join('')}
          </div>

          ${h.byPar.length ? `
            <div class="by-par">
              ${h.byPar.map(p => `
                <div class="by-par-item">
                  <div class="by-par-label">Par ${p.par}</div>
                  <div class="by-par-value ${p.averageToPar < 0 ? 'under' : p.averageToPar > 0 ? 'over' : 'even'}">
                    ${escapeHtml(fmtToPar(p.averageToPar))}
                  </div>
                  <div class="by-par-count">${p.holesPlayed} holes</div>
                </div>`).join('')}
            </div>` : ''}
        </div>
      `;

      if (h.toughestHoles.length || h.bestHoles.length) {
        const holeList = (list, emptyMsg) => list.length
          ? list.map(x => `
              <div class="hole-rank-row">
                <span class="hole-rank-hole">${x.hole_number}</span>
                <span class="hole-rank-where">
                  ${escapeHtml(x.course_name || '—')}
                  ${x.layout_name ? `<span class="dim">· ${escapeHtml(x.layout_name)}</span>` : ''}
                </span>
                <span class="hole-rank-diff ${x.averageToPar < 0 ? 'under' : x.averageToPar > 0 ? 'over' : 'even'}">
                  ${escapeHtml(fmtToPar(x.averageToPar))}
                </span>
                <span class="hole-rank-plays">${x.plays}×</span>
              </div>`).join('')
          : `<p class="section-note">${escapeHtml(emptyMsg)}</p>`;

        html += `
          <div class="rank-columns">
            <div class="chart-section">
              <h3>Costing you most</h3>
              ${holeList(h.toughestHoles, `Needs ${h.minPlaysForHoleRanking} plays of the same hole.`)}
            </div>
            <div class="chart-section">
              <h3>Your best holes</h3>
              ${holeList(h.bestHoles, `Needs ${h.minPlaysForHoleRanking} plays of the same hole.`)}
            </div>
          </div>
        `;
      }
    } else {
      html += `
        <div class="chart-section">
          <h3>Hole by hole</h3>
          <p class="section-note">
            No hole-by-hole scores yet. Log a round against a mapped course to see
            which holes cost you strokes.
          </p>
          <button class="secondary small" data-action="navigate" data-route="courses">Browse courses</button>
        </div>
      `;
    }

    // ── Per-course ──
    if (stats.perCourse && stats.perCourse.length > 0) {
      const anyToPar = stats.perCourse.some(c => c.averageToPar !== null);
      html += `
        <div class="chart-section">
          <h3>By course</h3>
          ${stats.perCourse.map(c => `
            <div class="course-row">
              <div class="course-name">
                ${c.course_id
                  ? `<button class="link-button" data-action="navigate" data-route="course" data-id="${escapeHtml(c.course_id)}">${escapeHtml(c.course)}</button>`
                  : escapeHtml(c.course)}
              </div>
              <div class="course-stats">
                <span><strong>${c.rounds}</strong> rounds</span>
                <span>Best <strong>${c.best}</strong></span>
                <span>Avg <strong>${c.average}</strong></span>
                ${anyToPar && c.averageToPar !== null
                  ? `<span>To par <strong>${escapeHtml(fmtToPar(c.averageToPar))}</strong></span>`
                  : ''}
              </div>
            </div>
          `).join('')}
        </div>
      `;
    }

    setContent(html);
  } catch (e) {
    setContent(`<div class="alert error">${escapeHtml(e.message)}</div>`);
  }
}

// ── Chart: Trend ─────────────────────────────────────

function renderTrendChart(trend, basis = 'raw') {
  if (!trend || trend.length === 0) return '';

  // On the to-par basis, rounds without a known par have nothing to plot.
  const toPar = basis === 'toPar';
  if (toPar) trend = trend.filter(t => t.toPar !== null && t.toPar !== undefined);
  if (trend.length === 0) return '';
  const valueOf = t => (toPar ? t.toPar : t.score);
  const fmt = v => (toPar ? (v === 0 ? 'E' : v > 0 ? `+${v}` : String(v)) : String(v));

  const width = 700;
  const height = 240;
  const pad = { top: 20, right: 20, bottom: 40, left: 50 };
  const chartW = width - pad.left - pad.right;
  const chartH = height - pad.top - pad.bottom;

  const scores = trend.map(valueOf);
  const minScore = Math.min(...scores) - 2;
  const maxScore = Math.max(...scores) + 2;

  const xStep = trend.length > 1 ? chartW / (trend.length - 1) : 0;
  const yScale = score => chartH - ((score - minScore) / (maxScore - minScore)) * chartH;

  // Points
  const points = trend.map((t, i) => ({
    x: pad.left + i * xStep,
    y: pad.top + yScale(valueOf(t)),
    score: valueOf(t),
    date: t.date,
    course: t.course,
  }));

  // Line path
  const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ');

  // Trend line (linear regression)
  const n = points.length;
  const sumX = points.reduce((a, p) => a + p.x, 0);
  const sumY = points.reduce((a, p) => a + p.y, 0);
  const sumXY = points.reduce((a, p) => a + p.x * p.y, 0);
  const sumXX = points.reduce((a, p) => a + p.x * p.x, 0);
  const slope = n > 1 ? (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX) : 0;
  const intercept = (sumY - slope * sumX) / n;
  const trendStart = { x: pad.left, y: intercept + slope * pad.left };
  const trendEnd = { x: pad.left + chartW, y: intercept + slope * (pad.left + chartW) };

  // Y axis labels
  const yLabels = [];
  const yRange = maxScore - minScore;
  const step = yRange <= 10 ? 1 : yRange <= 20 ? 2 : 5;
  for (let v = Math.ceil(minScore); v <= Math.floor(maxScore); v += step) {
    yLabels.push({ value: v, y: pad.top + yScale(v) });
  }

  // X labels (first, middle, last)
  const xLabels = [];
  if (trend.length <= 6) {
    trend.forEach((t, i) => xLabels.push({ label: t.date.slice(5), x: pad.left + i * xStep }));
  } else {
    [0, Math.floor((trend.length - 1) / 2), trend.length - 1].forEach(i => {
      xLabels.push({ label: trend[i].date.slice(5), x: pad.left + i * xStep });
    });
  }

  return `
    <div class="chart-section">
      <h3>${toPar ? 'Score trend, relative to par' : 'Score trend'}</h3>
      <div class="chart-container">
        <svg class="chart-svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
          <!-- Grid -->
          ${yLabels.map(l => `
            <line x1="${pad.left}" y1="${l.y}" x2="${width - pad.right}" y2="${l.y}"
              stroke="#2a2e34" stroke-width="1" stroke-dasharray="3 3" />
            <text x="${pad.left - 8}" y="${l.y + 4}" fill="#8b9098" font-size="11" text-anchor="end">${l.value}</text>
          `).join('')}

          <!-- Trend line -->
          <line x1="${trendStart.x}" y1="${trendStart.y}" x2="${trendEnd.x}" y2="${trendEnd.y}"
            stroke="#4ade80" stroke-width="1.5" stroke-dasharray="6 4" opacity="0.5" />

          <!-- Score line -->
          <path d="${linePath}" fill="none" stroke="#4ade80" stroke-width="2" />

          <!-- Points -->
          ${points.map(p => `
            <circle cx="${p.x}" cy="${p.y}" r="4" fill="#0a0b0d" stroke="#4ade80" stroke-width="2">
              <title>${escapeHtml(p.course)} — ${p.date}: ${fmt(p.score)}</title>
            </circle>
          `).join('')}

          <!-- X labels -->
          ${xLabels.map(l => `
            <text x="${l.x}" y="${height - 12}" fill="#8b9098" font-size="11" text-anchor="middle">${l.label}</text>
          `).join('')}
        </svg>
      </div>
      <p class="chart-caption">
        Lower scores are better. Trend line shows your improvement direction.
      </p>
    </div>
  `;
}

// ── Page: Friends ────────────────────────────────────

async function renderFriends() {
  setContent('<div class="loading">Loading…</div>');
  try {
    const data = await api('/friends');
    if (!data) return;

    let html = `
      <div class="page-header">
        <h2>Friends</h2>
        <button class="primary small" data-action="add-friend-modal">+ Add Friend</button>
      </div>
    `;

    // Pending requests
    if (data.pending && data.pending.length > 0) {
      html += `
        <h3 class="subhead">Pending Requests</h3>
        ${data.pending.map(p => `
          <div class="pending-card">
            <div class="friend-info">
              <div class="friend-avatar">${(p.display_name || p.username).charAt(0).toUpperCase()}</div>
              <div>
                <div class="friend-name">${escapeHtml(p.display_name || p.username)}</div>
                <div class="friend-username">@${escapeHtml(p.username)}</div>
              </div>
            </div>
            <div class="actions">
              <button class="primary small" data-action="accept-friend" data-id="${escapeHtml(p.friendship_id)}">Accept</button>
            </div>
          </div>
        `).join('')}
        <div class="loose-header"></div>
      `;
    }

    // Friends list
    if (data.friends && data.friends.length > 0) {
      html += `
        <h3 class="subhead">Your Friends</h3>
        ${data.friends.map(f => `
          <div class="friend-card">
            <div class="friend-info" role="button" tabindex="0"
                 data-action="navigate" data-route="friend" data-username="${escapeHtml(f.username)}">
              <div class="friend-avatar">${(f.display_name || f.username).charAt(0).toUpperCase()}</div>
              <div>
                <div class="friend-name">${escapeHtml(f.display_name || f.username)}</div>
                <div class="friend-username">@${escapeHtml(f.username)}</div>
              </div>
            </div>
            <button class="secondary small" data-action="navigate" data-route="friend" data-username="${escapeHtml(f.username)}">View scores</button>
          </div>
        `).join('')}
      `;
    } else if (!data.pending || data.pending.length === 0) {
      html += `
        <div class="empty-state">
          <div class="icon">👥</div>
          <div class="title">No friends yet</div>
          <div class="desc">Add friends by their username to see their scores.</div>
          <button class="primary small" data-action="add-friend-modal">+ Add Friend</button>
        </div>
      `;
    }

    setContent(html);
  } catch (e) {
    setContent(`<div class="alert error">${escapeHtml(e.message)}</div>`);
  }
}

function showAddFriendModal() {
  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.id = 'friendModal';
  modal.innerHTML = `
    <div class="modal">
      <div class="close-row">
        <h3>Add Friend</h3>
        <button class="close-btn" data-action="close-friend-modal" aria-label="Close">×</button>
      </div>
      <div class="form-group">
        <label>Search by username</label>
        <input type="text" id="friendSearch" placeholder="Type a username…" data-action="search-users" data-on="input">
      </div>
      <div class="search-results" id="searchResults"></div>
    </div>
  `;
  document.body.appendChild(modal);
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
}

let searchTimer;
let userSearchSeq = 0;

async function searchUsers() {
  clearTimeout(searchTimer);
  // The modal can be closed while a debounce or request is still pending, so
  // every element lookup here has to tolerate the node being gone.
  const input = document.getElementById('friendSearch');
  const target = document.getElementById('searchResults');
  if (!input || !target) return;

  const q = input.value.trim();
  if (q.length < 2) {
    target.innerHTML = '';
    return;
  }

  searchTimer = setTimeout(async () => {
    const seq = ++userSearchSeq;
    try {
      const data = await api(`/search?username=${encodeURIComponent(q)}`);
      if (!data || seq !== userSearchSeq) return;
      const box = document.getElementById('searchResults');
      if (!box) return;

      const results = (data.users || []).map(u => `
        <div class="search-result-item">
          <div>
            <div class="search-result-name">${escapeHtml(u.display_name || u.username)}</div>
            <div class="search-result-handle">@${escapeHtml(u.username)}</div>
          </div>
          <button class="primary small" data-action="send-friend-request" data-username="${escapeHtml(u.username)}">Add</button>
        </div>
      `).join('');

      box.innerHTML = results || '<p class="inline-result-empty">No users found.</p>';
    } catch (e) {
      if (seq !== userSearchSeq) return;
      const box = document.getElementById('searchResults');
      if (box) box.innerHTML = `<p class="inline-result-empty" role="alert">${escapeHtml(e.message)}</p>`;
    }
  }, 300);
}

async function sendFriendRequest(username) {
  clearAlert();
  try {
    await api('/friends', {
      method: 'POST',
      body: JSON.stringify({ username }),
    });
    document.getElementById('friendModal')?.remove();
    renderFriends();
  } catch (e) {
    alert(e.message);
  }
}

async function acceptFriend(friendshipId) {
  try {
    await api('/friends/accept', {
      method: 'POST',
      body: JSON.stringify({ friendship_id: friendshipId }),
    });
    renderFriends();
  } catch (e) {
    alert(e.message);
  }
}

// ── Page: Friend Detail ──────────────────────────────

async function renderFriendDetail({ username }) {
  setContent('<div class="loading">Loading…</div>');
  try {
    const data = await api(`/friends/${encodeURIComponent(username)}`);
    if (!data) return;

    let html = `
      <div class="page-header">
        <h2>${escapeHtml(data.friend.display_name || data.friend.username)}</h2>
        <button class="secondary small" data-action="navigate" data-route="friends">← Back to Friends</button>
      </div>
    `;

    // Stats
    html += `
      <div class="stats-grid">
        <div class="stat-card">
          <div class="label">Rounds</div>
          <div class="value neutral">${data.stats.totalRounds}</div>
        </div>
        <div class="stat-card">
          <div class="label">Best Score</div>
          <div class="value good">${data.stats.bestScore ?? '—'}</div>
        </div>
        <div class="stat-card">
          <div class="label">Average Score</div>
          <div class="value neutral">${data.stats.averageScore ?? '—'}</div>
        </div>
      </div>
    `;

    // Rounds table
    if (data.rounds && data.rounds.length > 0) {
      html += `
        <div class="page-header tight-header">
          <h2 class="section-title">Recent Rounds</h2>
        </div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Date</th><th>Course</th><th>Score</th><th>To par</th></tr></thead>
            <tbody>
              ${data.rounds.map(r => `
                <tr>
                  <td>${formatDate(r.date_played)}</td>
                  <td>${escapeHtml(r.course)}</td>
                  <td><span class="score-pill ${r.effective_par ? scoreClass(r.total_score, r.effective_par) : 'even'}">${r.total_score}</span></td>
                  <td>${formatToPar(r.to_par)}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      `;
    } else {
      html += `
        <div class="empty-state">
          <div class="icon">🥏</div>
          <div class="title">No rounds yet</div>
          <div class="desc">${escapeHtml(data.friend.display_name || data.friend.username)} hasn't logged any rounds.</div>
        </div>
      `;
    }

    setContent(html);
  } catch (e) {
    setContent(`<div class="alert error">${escapeHtml(e.message)}</div>`);
  }
}

// ── Utilities ─────────────────────────────────────────

function formatDate(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function scoreClass(score, par) {
  if (score < par) return 'under';
  if (score > par) return 'over';
  return 'even';
}

/** Golf convention: E for level, explicit + when over. Null renders as an em dash. */
function formatToPar(v) {
  if (v === null || v === undefined) return '—';
  if (v === 0) return 'E';
  return v > 0 ? `+${v}` : String(v);
}

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ── Init ─────────────────────────────────────────────

(async function init() {
  if (token) {
    const ok = await checkAuth();
    if (ok) {
      navigate('dashboard');
    }
  } else {
    renderAuth();
  }
})();
