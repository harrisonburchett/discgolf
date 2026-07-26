# 🥏 Disc Golf Tracker

Track disc golf scores hole by hole, see your improvement relative to par, browse a
course catalog with real hole layouts, and compare with friends.

Built on **Cloudflare Pages + D1** (SQLite at the edge). No build step — vanilla JS
frontend, serverless API functions.

---

## Features

- **User accounts** — register, login, JWT-based auth
- **Course catalog** — thousands of courses seeded from OpenStreetMap, with tee→basket
  hole geometry, par, distance, and multiple layouts per course
- **Score tracking** — log a round against a catalog layout with a hole-by-hole
  scorecard, or free-text any course that isn't in the catalog yet
- **Improvement analytics** — relative to par, so a round at a par-54 course and a
  round at a par-72 course are actually comparable
- **Friends** — search by username, send/accept requests, view friends' scores
- **Dark, minimal UI** — mobile responsive

---

## Deploy checklist

Everything below has been verified against real tooling — the migrations applied
through actual Wrangler/D1, the Worker and Pages Functions bundle cleanly via
`wrangler pages functions build` and `wrangler deploy --dry-run`, and `npm test` passes.
What's left is the handful of one-time account setup steps only you can do, since they
need your Cloudflare account and your GitHub repo:

1. **Create the D1 database** and paste its ID into **both** `wrangler.toml` and
   `ingest/wrangler.toml` (both currently say `YOUR_DATABASE_ID_HERE`):
   ```bash
   npx wrangler d1 create disc-golf-tracker-db
   ```

2. **Create the Pages project before the first deploy.** This is the step most likely
   to bite you: `wrangler pages deploy` does not create a new project in a
   non-interactive context (CI included) — it fails with "Project not found" on a name
   Cloudflare has never seen. Create it once, manually, first:
   ```bash
   npx wrangler pages project create disc-golf-tracker --production-branch main
   ```
   The ingest Worker doesn't need this step — `wrangler deploy` for an ordinary Worker
   creates it automatically on first run.

3. **Set the JWT secret** (never put this in `wrangler.toml` — see the warning below):
   ```bash
   npx wrangler pages secret put JWT_SECRET --project-name disc-golf-tracker
   # value: openssl rand -hex 32
   ```

4. **Add two GitHub Actions secrets** to the repo (Settings → Secrets and variables →
   Actions): `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`. The token needs, at
   minimum: **Cloudflare Pages: Edit**, **D1: Edit**, and **Workers Scripts: Edit** —
   the default "Edit Cloudflare Workers" template token doesn't include D1 or Pages, so
   a token created from scratch with just that template will fail partway through the
   workflow.

5. **Optional, cosmetic:** replace the placeholder GitHub URL in the `User-Agent`
   string in `scripts/ingest-osm.mjs` and `ingest/src/index.js` — it's sent to
   Overpass as an identifying courtesy, not required for anything to function.

6. Push to `main`. The workflow runs the test suite, applies migrations, deploys the
   Pages project, and deploys the ingest Worker, in that order.

7. **Seed the course catalog** — this can happen any time after the first deploy, and
   the app works before it, just with an empty course search:
   ```bash
   node scripts/ingest-osm.mjs --iso US --apply
   ```

None of the above is optional polish — skipping 1 or 2 will make the first deploy fail
outright. Skipping 3 doesn't fail the deploy itself, but breaks the app the moment
anyone tries to register or log in: with no `JWT_SECRET` bound, `crypto.subtle.importKey`
throws `Zero-length key is not supported` (verified directly — this is not a guess),
which is an uncaught exception in the Function and surfaces as a 500 on every auth
request. There is no silent insecure fallback; auth is just broken until the secret
is set.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Vanilla HTML/CSS/JS (no framework, no build step) |
| API | Cloudflare Pages Functions |
| Database | Cloudflare D1 (SQLite at the edge) |
| Auth | PBKDF2 password hashing + HS256 JWT (Web Crypto API) |
| Course data | OpenStreetMap via Overpass API |
| Scheduled refresh | A separate Cloudflare Worker with a cron trigger |
| Tests | `node:test` + `node:sqlite` (no dependencies) |

---

## Project Structure

```
disc-golf-tracker/
├── public/                       # Static frontend (no build step)
│   ├── index.html
│   ├── _headers                  # CSP + security headers
│   ├── styles.css
│   ├── actions.js                # event delegation (loaded first)
│   ├── courses.js                # catalog, course maps, hole diagrams
│   ├── scorecard.js              # log-a-round flow, round detail
│   └── app.js                    # shell, routing, dashboard, stats, friends
├── functions/                    # Pages Functions (the API)
│   ├── lib/auth.js               # hashing, JWT, auth middleware
│   └── api/
│       ├── _middleware.js
│       ├── auth/                 # register, login, me
│       ├── rounds/               # list/create, edit/delete
│       ├── courses/              # search, detail with hole geometry
│       ├── friends/              # list/request, accept, view
│       ├── stats.js
│       └── search.js
├── shared/                       # Used by BOTH the seed script and the Worker
│   ├── osm-normalize.js          # Overpass QL + response -> course/layout/hole
│   └── osm-sql.js                # normalised courses -> idempotent SQL
├── scripts/
│   └── ingest-osm.mjs            # one-off bulk seed (runs on your machine)
├── ingest/                       # scheduled refresh Worker (cron)
│   ├── wrangler.toml
│   └── src/index.js
├── migrations/                   # D1 migrations, applied in order
│   ├── 0001_baseline.sql
│   ├── 0002_courses_layouts_holes.sql
│   └── 0003_ingest_state.sql
├── tests/
├── wrangler.toml
└── .github/workflows/deploy.yml
```

---

## Setup

### 1. Create the D1 database

```bash
npx wrangler d1 create disc-golf-tracker-db
```

Paste the returned `database_id` into **both** `wrangler.toml` and `ingest/wrangler.toml`
— the Pages project and the ingest Worker bind the same database.

### 2. Apply migrations

```bash
npm run migrate:local     # local dev
npm run migrate           # production
```

Use `d1 migrations apply`, not `d1 execute --file=`. Migrations are tracked, so
re-running is safe and only new files are applied.

### 3. Set the JWT secret

```bash
npx wrangler pages secret put JWT_SECRET --project-name disc-golf-tracker
# value: openssl rand -hex 32
```

For local dev, put it in `.dev.vars` (gitignored):

```
JWT_SECRET="…"
```

> **`JWT_SECRET` is deliberately absent from `wrangler.toml`.** Anything under `[vars]`
> deploys as a plaintext environment variable and overrides a dashboard secret of the
> same name — so declaring it there means a deploy can silently reset your signing key
> to a value that is committed to the repo. Anyone who can read the repo could then
> forge a token for any user.

### 4. Seed the course catalog

```bash
# Dry run first — writes SQL and a data-quality report, changes nothing
node scripts/ingest-osm.mjs --iso US

# Review .ingest/report.json, then load it
node scripts/ingest-osm.mjs --iso US --apply --local     # local D1
node scripts/ingest-osm.mjs --iso US --apply             # production
```

Other scopes: `--bbox 36,-116,37,-114`, `--planet`, or `--from .ingest/overpass.json`
to re-normalise a cached response without hitting the network again.

### 5. Deploy

```bash
npm run deploy                        # Pages
cd ingest && npx wrangler deploy      # ingest Worker
```

Or push to `main` and let `.github/workflows/deploy.yml` do all three (test, migrate,
deploy). It needs `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` as repo secrets.

---

## Course data

### Where it comes from

OpenStreetMap, via the Overpass API, using the documented
[`leisure=disc_golf_course`](https://wiki.openstreetmap.org/wiki/Tag:leisure%3Ddisc_golf_course)
scheme:

| Feature | Tagging |
|---------|---------|
| Course | `leisure=disc_golf_course` + `name` (usually a node) |
| Hole | `disc_golf=hole` — a **way**, drawn tee→basket, carrying `par` and `dist` |
| Tee / basket | `disc_golf=tee` / `disc_golf=basket` (nodes) |
| Layout | `type=disc_golf_layout` relation: `role=course` + ordered `role=hole` |

### Coverage, honestly

As of a July 2026 snapshot OSM had roughly **2,600 disc golf courses** and about
**10,400 mapped hole ways** — call it 600 courses with complete geometry. The PDGA
directory lists over 11,000 courses, so OSM is a real seed but not a complete database.
Coverage is also lopsided: the US, Finland, Sweden, Canada and Norway hold about 79% of
it, which is why `migrations/0003` seeds the refresh rotation in that order.

The gap is meant to be closed by users: a course created in the app is `source='user'`,
and correcting an OSM-seeded course sets `locked=1`, after which the ingest never
overwrites it.

### Two structural details that drive the whole design

1. **Hole number comes from position in the layout relation, not from `ref=*`.** The
   same OSM way is hole 3 in one layout and hole 7 in another, so each layout gets its
   own `holes` rows. Only a single-layout course can trust `ref`.

2. **Most courses have no layout relation.** For those, holes are attached to the
   nearest course and a single layout is synthesised. When `ref` numbering is incomplete
   the order is inferred by a nearest-neighbour walk — plausible, but a guess. Those
   courses are reported as `inferred_hole_order` in the ingest report rather than
   presented as fact.

### Data quality is reported, not swallowed

Every ingest emits a report. The categories are real patterns in the upstream data:

| Warning | Meaning |
|---------|---------|
| `course_name_is_hole_label` | A basket tagged as a whole course (named "3", "Hull 1", "Väylä 9") — skipped |
| `duplicate_course` | Same venue mapped twice (node + boundary) — merged, keeping whichever carries the holes |
| `possible_duplicate_course` | Near-identical names nearby — **kept both**, flagged for review, never auto-merged |
| `orphan_holes` | Holes with no course tag within 1200m — usually a real course missing one tag |
| `inferred_hole_order` | Hole order is provisional (see above) |
| `course_without_name` | Imported as "Unnamed course" |

### Licensing — read this before commercialising

OpenStreetMap data is **ODbL**. That means attribution is required (the API returns an
`attribution` field for exactly this reason, and the UI must surface it), and
share-alike obligations attach to *derived databases*. If this ever becomes a paid
product, or you want a proprietary layer of your own hole data on top, get clear on the
"collective database" vs. "derived database" distinction first. It is workable — plenty
of apps ship on OSM data — but it is a decision to make deliberately rather than
discover later. Not legal advice.

---

## Ingest architecture

Two paths, one shared normaliser (`shared/osm-normalize.js`), so they cannot drift.

**Bulk seed — `scripts/ingest-osm.mjs`, on your machine.** No CPU limit, no 128MB heap,
so it can pull a whole country or the planet in one query. Writes chunked `.sql` files
and applies them with `wrangler d1 execute`.

**Scheduled refresh — `ingest/`, a Worker on a cron trigger.** One region per tick,
every 6 hours. Pages Functions cannot have cron triggers, which is why this is a
separate Worker binding the same D1.

The refresh uses a **two-phase fetch**, and the reason is worth knowing: a
`(newer:…)` query returns only *changed* objects, so an edited hole way arrives without
its unchanged course node and would normalise as an orphan. Phase 1 therefore asks only
"did anything change here?" (`out ids`, a tiny response). Only when the answer is yes
does phase 2 pull the full region. Most regions are quiet on any given day, so the
expensive fetch is usually skipped while correctness is preserved.

Both paths send an identifying `User-Agent` and back off on 429/504. Overpass is a
donated public service — please leave that in place.

Run the Worker manually while testing:

```bash
cd ingest
npx wrangler secret put INGEST_TOKEN
curl -H "Authorization: Bearer <token>" https://<worker-url>/run
```

Inspect what it has been doing:

```sql
SELECT iso, last_status, last_success_at, courses_seen, consecutive_failures
FROM ingest_regions ORDER BY last_run_at DESC;

SELECT iso, started_at, status, courses, holes, warnings
FROM ingest_runs ORDER BY started_at DESC LIMIT 20;
```

---

## Tests

```bash
npm test
```

No dependencies — `node:test` plus `node:sqlite`, Node 22+. Three layers:

- **Unit** (`osm-normalize.test.mjs`) — the normaliser against a fixture built to cover
  the messy cases: shared ways across layouts, unit-suffixed distances, hole-label
  course names, duplicates, orphans, unnamed courses.
- **Integration** (`ingest-integration.test.mjs`) — the real migrations and the real
  generated SQL against a real SQLite database. Proves the ingest is idempotent, that a
  `locked` row survives re-ingest, that a stale hole is removed, and that a layout
  referenced by someone's scorecard is never deleted.
- **Handler** (`api-handlers.test.mjs`, `stats.test.mjs`, `rate-limit.test.mjs`) — the
  actual Pages Function handlers against a D1 shim, with real signed JWTs. This is what
  catches SQL that only breaks on a code path you didn't click through by hand.
- **Frontend client** (`api-client.test.mjs`) — loads the real `app.js` into a `node:vm`
  sandbox with a mocked `fetch`, to test the 429/401/error handling actually shipped to
  the browser rather than a reimplementation of it.
- **Static safety** (`frontend-safety.test.mjs`) — scans the frontend source for
  inline handlers, unescaped interpolation, `data-action`s with no registered handler
  (which fail silently at runtime, on a click, in production), handlers nothing
  references, script load order, and CSP compatibility.
- **Render smoke** (`render-smoke.test.mjs`) — drives the real page renderers against
  stub globals: course detail, layout switching, the scorecard form in each of its
  states, stroke clamping, round detail, and hostile course names.
- **Geometry** (`hole-map.test.mjs`) — the map rendering. `courses.js` is a plain script
  rather than a module, so it is loaded into a `node:vm` context with stub globals; no
  jsdom, no bundler. Covers the projection, the tee-at-bottom rotation across all four
  bearings, dogleg vertices surviving, and per-hole path slicing on the course
  overview — the last being where an off-by-one would quietly draw hole 2 with hole 3's
  shape.

---

## API Reference

| Method | Endpoint | Description | Auth |
|--------|----------|-------------|------|
| POST | `/api/auth/register` | Create account | No |
| POST | `/api/auth/login` | Login | No |
| GET | `/api/auth/me` | Current user | Yes |
| GET | `/api/courses?q=&lat=&lng=&radius=&withMaps=` | Search courses by name or proximity | Yes |
| GET | `/api/courses/:id` | Course detail: layouts, hole geometry, bounds | Yes |
| GET | `/api/rounds?limit=&offset=` | List your rounds (with `to_par`) | Yes |
| POST | `/api/rounds` | Create a round, optionally with `hole_scores` | Yes |
| GET | `/api/rounds/:id` | One round with its full scorecard and hole geometry | Yes |
| PUT | `/api/rounds/:id` | Partial update | Yes |
| DELETE | `/api/rounds/:id` | Delete a round | Yes |
| GET | `/api/stats` | Improvement analytics, par-relative, with hole breakdown | Yes |
| GET | `/api/friends` | List friends + pending | Yes |
| POST | `/api/friends` | Send friend request | Yes |
| POST | `/api/friends/accept` | Accept friend request | Yes |
| GET | `/api/friends/:username` | View a friend's scores | Yes |
| GET | `/api/search?username=` | Search users | Yes |

### Creating a round with a scorecard

```http
POST /api/rounds
{
  "layout_id": "osm-r3001",
  "date_played": "2026-07-24",
  "hole_scores": [
    { "number": 1, "strokes": 4 },
    { "number": 2, "strokes": 3 }
  ]
}
```

`total_score` and `par` are derived server-side from the scorecard and the layout — a
client-supplied `total_score` is ignored when `hole_scores` is present. Courses not in
the catalog still work: send `course` as free text with `total_score`.

---

## Hole maps

Hole geometry is drawn directly from the OSM way, so a dogleg looks like a dogleg.
There is no mapping library and no tile server: at the scale of one hole (under ~300m)
a local equirectangular projection is accurate to well under a metre, which is a few
lines of maths rather than a dependency.

Two orientations, on purpose:

- **A single hole** is rotated so the tee is at the bottom and the basket at the top.
  That is how every printed course map and scorecard app draws it, because it matches
  standing on the pad looking at the target.
- **The course overview** is left north-up with a compass, because on an overview the
  compass carries more information than any one hole's alignment.

Both carry a scale bar, which matters more than it sounds: without one, a diagram
invites the wrong read of how sharp a dogleg is.

One nuance worth knowing: the printed distance comes from the `dist` tag when there is
one, while the scale bar is derived from the drawn geometry. Where a mapper's tagged
distance and their traced line disagree, those two numbers won't quite match. The tag
is the surveyed figure and the line is what was mapped, so both are reported as-is
rather than one being silently recomputed from the other.

## Rate limiting on auth

`/api/auth/login` and `/api/auth/register` are backed by a D1 counter
(`migrations/0004_rate_limits.sql`, `functions/lib/rate-limit.js`): login is limited
per-email (8/15min, catches brute-forcing one account) and per-IP (30/15min, catches
credential stuffing across many accounts from one source); registration is limited
per-IP (6/hour, catches mass account creation). Numbers are constants at the top of
each handler file — tune them to your own traffic.

Cloudflare's native Workers Rate Limiting binding was the other option, and was
rejected deliberately: Cloudflare's own docs describe it as a loose, per-location,
eventually-consistent filter, explicitly **not suited for strict abuse prevention** —
which is exactly what login brute-force protection needs. The D1 counter is a real,
testable guarantee instead of an approximate one, at the cost of one or two extra D1
round-trips per auth request.

It fails **open**, not closed: if the rate-limit table is unreachable, the request goes
through rather than locking out every user over an unrelated D1 hiccup. Auth itself
still fails closed on a missing `JWT_SECRET` (see above) — only the rate limiter has
this fallback, because "briefly less abuse-resistant" is a much smaller failure than
"nobody can log in."

## No inline event handlers — and why the rule is absolute

Every interaction goes through `data-action` attributes and one set of delegated
listeners in `actions.js`. There are no `onclick=` attributes anywhere, and a test
enforces that.

This is not a style preference. An inline handler's attribute value is
HTML-entity-decoded by the parser and *then* compiled as JavaScript, so HTML-escaping a
value interpolated into one does not contain it:

```
server sends:   onclick="pick('a&#39;-alert(1)-&#39;b')"
JS receives:    pick('a'-alert(1)-'b')          <-- executes
```

Escaping `'` to `&#39;` looks like a fix and isn't one — the parser hands a working
quote to the JS compiler. A `data-*` attribute has no second parse: it is only ever
read back as an opaque string through `element.dataset`, so escaping is sufficient and
there is no context where the value becomes code.

Two things fall out of this. First, `script-src 'self'` in `public/_headers` is
actually enforceable, with no `unsafe-inline` and no `unsafe-eval`. Second, adding an
`onclick=` in future breaks both a test and the CSP, which is the intended outcome.

Data-driven widths (the outcome bar on the stats page) are applied through the CSSOM in
`applyDynamicWidths` rather than as markup style attributes, so `style-src` is strict
too.

## Still to do

- Endpoints for user-created and user-corrected courses (setting `source` / `locked`).
  The schema and the ingest already respect both; there is no UI to set them yet.
- Editing an existing round's scorecard (create and read work; `PUT` only touches
  round-level fields, not `hole_scores`)
- Pagination in the round history (the API takes `limit`/`offset`; the UI requests one
  page of 200)

---

## License

MIT (application code). Course data © OpenStreetMap contributors, [ODbL](https://opendatacommons.org/licenses/odbl/).

---

## A note on `/api/stats`

The response reports a `basis` of either `toPar` or `raw`, plus `parCoverage`. This is
deliberate rather than fussy: averaging raw totals across courses with different pars
makes "you improved 3 strokes" mostly a statement about which courses you happened to
play recently. The par basis is used when at least 60% of rounds have a known par, and
the UI says which basis it is showing rather than quietly mixing them.

The comparison window is also equal-sized on both sides. The first version compared
`slice(-10)` against `slice(-20, -10)`, so a user with 15 rounds was comparing 10 rounds
against 5 — a difference in sample size presented as a difference in performance.

---

## Review log

Findings from a pass over the whole codebase, kept because several were invisible
by inspection and are the kind of thing that regresses.

**Security**

- Interpolating values into inline `onclick` handlers was still injectable even after
  HTML-escaping them, for the entity-decoding reason above. Fixed by removing inline
  handlers entirely; a test now enforces the ban and demonstrates the hazard.
- The middleware answered CORS preflight with `Access-Control-Allow-Origin: *` but never
  set the header on real responses — it advertised access it did not grant. Since the
  frontend is same-origin, CORS was removed rather than completed.

**Correctness**

- `GET /api/rounds/:id` did not exist, so `hole_scores` were written on save and could
  never be read back. Added, along with the round detail page that displays them.
- Proximity search ordered by course name and truncated to the SQL limit *before*
  sorting by distance, so in a dense region the closest course could be cut before the
  distance sort ran. Ordering now happens in SQL, using squared planar distance with
  longitude compressed by `cos(latitude)` — monotonic in true distance over a window
  this small, so it orders identically to haversine.
- A longitude window crossing the antimeridian produced a bound past ±180 and matched
  nothing. The bound is now dropped near the wrap and the exact filter does the work.
- `/api/stats` chose the raw basis whenever no comparison window was available, even at
  100% par coverage. Basis and comparison are separate questions; basis now follows
  coverage alone.
- The history, dashboard and friend tables read `r.par` rather than `effective_par`, so
  a round whose par came from its layout displayed an em dash. The friend endpoint
  wasn't returning `effective_par` at all.
- Three search boxes had no ordering guard, so a slow response could land after a newer
  one and overwrite correct results with stale. All three now carry a sequence token.
- `deleteRound` called `renderHistory()` directly instead of routing, leaving
  `currentRoute` pointing at the previous page — visible as a desynced sidebar
  highlight when deleting from the round detail page.
- `searchUsers` dereferenced elements that no longer exist if the modal closed during
  the debounce window.
- Async route handlers were invoked without a `.catch`, so a rejected render produced
  an unhandled rejection and left the page on "Loading…" forever.

**UI and accessibility**

- Making a `<tr>` `role="button"` destroys the table semantics screen readers rely on.
  Whole-row click is kept as a mouse convenience, with a real control in the course cell.
- Alerts had no `role="alert"`, so failures were announced to nobody, and were never
  cleared — a stale error could sit above a screen that had since succeeded.
- Focus-visible styling was per-component and inconsistent; it is now uniform across
  everything focusable.
- Enter in a scorecard field now advances to the next hole, and to the save button on
  the last one. Filling 18 holes was otherwise a tab-shift-tab shuffle.

---

## Deploy-readiness pass

What actually got verified, not just inspected, before calling this deployable:

- **Migrations against real D1**, not just the `node:sqlite` test harness: `npx wrangler
  d1 migrations apply --local` applied all three migration files successfully through
  actual Wrangler/miniflare.
- **Pages Functions bundle cleanly**: `npx wrangler pages functions build` compiles all
  17 function files with zero errors — every import across `functions/` and `shared/`
  resolves.
- **The ingest Worker bundles cleanly** and resolves its cross-directory imports into
  `shared/`: `npx wrangler deploy --dry-run` from `ingest/` succeeds and reports correct
  bindings.
- **Wrangler is pinned**, not floating: added as a `devDependency` with a
  `package-lock.json` committed, so `npx wrangler` in CI runs the exact version tested
  here rather than whatever the latest release happens to be on a given day. The
  workflow now runs `npm ci` before invoking it.
- **A missing `JWT_SECRET` fails closed**, verified directly rather than assumed:
  `crypto.subtle.importKey` throws `Zero-length key is not supported` on an unset
  secret, so auth 500s loudly instead of silently signing with a guessable key. See the
  comment atop `functions/lib/auth.js`.

What was found and fixed in this pass:

- **No LICENSE file**, despite the README claiming MIT. Added.
- **`wrangler pages deploy` does not create a new Pages project non-interactively.**
  The deploy workflow would have failed on its very first run with "Project not found."
  This is now step 2 of the deploy checklist and called out in the workflow itself.
- **The GitHub Actions workflow ran bare `npx wrangler`** with no lockfile and no pinned
  version, so CI could silently pick up a new Wrangler major version with breaking CLI
  changes. Fixed by pinning the dependency and running `npm ci`.
- Confirmed (rather than assumed) that `wrangler d1 migrations apply`'s confirmation
  prompt is auto-skipped in a non-interactive shell — real risk of a CI job hanging
  forever if this weren't true, given the prompt exists at all in interactive use.

---

## Ghost-account bug (found via a real deploy report)

`register.js` used to `INSERT INTO users` *before* calling `signJwt`. If `signJwt` threw
— most notably when `JWT_SECRET` isn't bound yet, which fails hard by design (see
above) — the user row was already committed, but the response never came back. From
the outside this looked like registration silently failed. Retrying then hit "username
or email already taken" against an account that had, in fact, been created
successfully — just never confirmed to the person who created it.

Fixed by reordering: `signJwt` (pure crypto, touches no database) now runs before the
`INSERT`. A failure there leaves no row behind at all. Regression-tested in
`tests/auth-register.test.mjs`, including the exact end-to-end scenario: fail with no
secret, confirm zero rows, fix the secret, confirm the same username/email now succeeds
rather than 409ing.

If you hit "already taken" on what you're sure is your first attempt, check for a
stray row before assuming anything else is wrong:
```sql
SELECT id, username, email, created_at FROM users;
```
Under the old code this could happen; under the current code it can't — a failed
registration request now leaves nothing behind.
