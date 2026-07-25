// ============================================================
// rate-limit.js — Fixed-window rate limiting backed by D1
//
// One row per (key, window bucket) in rate_limit_counters, incremented
// atomically per request. See migration 0004 for why this beats Cloudflare's
// native Rate Limiting binding for this specific job: that binding is an
// explicitly loose, per-location, eventually-consistent filter, not a strict
// guarantee — wrong tool for login brute-force protection.
//
// Fails OPEN, not closed: if the rate-limit table can't be reached (a
// transient D1 error, a table that somehow doesn't exist yet), the request is
// allowed through rather than locking every user out of auth because of an
// unrelated infrastructure hiccup. Auth itself still fails closed (see
// lib/auth.js) — only the rate limiter has this fallback, because "slightly
// less abuse resistant for a few minutes" is a much smaller problem than
// "nobody can log in."
// ============================================================

/**
 * @param {D1Database} db
 * @param {string} key       Identifies what's being limited, e.g. "login:email:foo@x.com".
 * @param {object} opts
 * @param {number} opts.limit         Max requests allowed per window.
 * @param {number} opts.windowSeconds Window length in seconds.
 * @returns {Promise<{allowed: boolean, remaining: number, retryAfterSeconds: number, count: number}>}
 */
export async function checkRateLimit(db, key, { limit, windowSeconds }) {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const bucket = Math.floor(nowSeconds / windowSeconds);
  const retryAfterSeconds = (bucket + 1) * windowSeconds - nowSeconds;

  try {
    // Atomic per-row upsert. Concurrent requests for the same key serialize
    // through SQLite's normal write guarantees, so this doesn't have the
    // classic read-then-write race a naive counter would.
    await db
      .prepare(
        `INSERT INTO rate_limit_counters (rl_key, bucket, count) VALUES (?, ?, 1)
         ON CONFLICT(rl_key, bucket) DO UPDATE SET count = count + 1`,
      )
      .bind(key, bucket)
      .run();

    const row = await db
      .prepare('SELECT count FROM rate_limit_counters WHERE rl_key = ? AND bucket = ?')
      .bind(key, bucket)
      .first();
    const count = row?.count ?? 1;

    // Opportunistic cleanup: only this key's stale buckets, only on a write
    // that's already happening. Keeps the table from growing unbounded
    // without a separate scheduled job. Best-effort — a failure here must
    // never affect the rate-limit decision itself.
    try {
      await db
        .prepare('DELETE FROM rate_limit_counters WHERE rl_key = ? AND bucket < ?')
        .bind(key, bucket - 1)
        .run();
    } catch {
      /* cleanup is not load-bearing */
    }

    return {
      allowed: count <= limit,
      remaining: Math.max(0, limit - count),
      retryAfterSeconds,
      count,
    };
  } catch (err) {
    console.error('Rate limit check failed, allowing request through:', err?.message ?? err);
    return { allowed: true, remaining: limit, retryAfterSeconds: 0, count: 0, degraded: true };
  }
}

/**
 * Best-effort client IP. Cloudflare sets CF-Connecting-IP at the edge; local
 * dev and any proxy that strips it fall back to the first X-Forwarded-For
 * entry, and finally to a constant. That constant bucket means all
 * IP-unknown traffic shares one counter — a real limitation, but strictly
 * better than either crashing or exempting unknown-origin traffic from any
 * limit at all.
 */
export function getClientIp(request) {
  const cf = request.headers.get('CF-Connecting-IP');
  if (cf) return cf;
  const xff = request.headers.get('X-Forwarded-For');
  if (xff) return xff.split(',')[0].trim();
  return 'unknown';
}

/** A standard 429 with Retry-After, so a well-behaved client backs off correctly. */
export function rateLimited(retryAfterSeconds, message) {
  return new Response(
    JSON.stringify({ error: message ?? 'Too many attempts. Please try again later.' }),
    {
      status: 429,
      headers: {
        'Content-Type': 'application/json',
        'Retry-After': String(Math.max(1, retryAfterSeconds)),
      },
    },
  );
}
