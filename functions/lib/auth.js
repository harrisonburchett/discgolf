// ============================================================
// auth.js — Shared utilities for hashing, JWT, and auth middleware
// Works inside Cloudflare Pages Functions (Web Crypto API)
//
// If every auth request in production is 500ing, check JWT_SECRET first:
// with no secret bound, encoder.encode(undefined) produces zero bytes (the
// WHATWG encode() spec defaults a missing argument to ""), and
// crypto.subtle.importKey rejects a zero-length HMAC key with
// "Zero-length key is not supported" — verified directly, not assumed. That
// throw is uncaught here, so it surfaces as a 500. There is no silent
// insecure fallback; this fails closed rather than signing with a guessable
// key, but it does mean auth is completely broken until the secret exists.
// Set it with: npx wrangler pages secret put JWT_SECRET --project-name <name>
// ============================================================

const encoder = new TextEncoder();

// ── Password hashing (PBKDF2 via Web Crypto) ──────────────────

export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const derived = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 100_000, hash: 'SHA-256' },
    keyMaterial,
    256
  );
  // Combine salt + hash as base64
  const combined = new Uint8Array(salt.length + derived.byteLength);
  combined.set(salt, 0);
  combined.set(new Uint8Array(derived), salt.length);
  return btoa(String.fromCharCode(...combined));
}

export async function verifyPassword(password, storedHash) {
  try {
    const combined = Uint8Array.from(atob(storedHash), c => c.charCodeAt(0));
    const salt = combined.slice(0, 16);
    const hash = combined.slice(16);
    const keyMaterial = await crypto.subtle.importKey(
      'raw',
      encoder.encode(password),
      'PBKDF2',
      false,
      ['deriveBits']
    );
    const derived = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt, iterations: 100_000, hash: 'SHA-256' },
      keyMaterial,
      256
    );
    const derivedArr = new Uint8Array(derived);
    if (derivedArr.length !== hash.length) return false;
    let diff = 0;
    for (let i = 0; i < hash.length; i++) diff |= hash[i] ^ derivedArr[i];
    return diff === 0;
  } catch {
    return false;
  }
}

// ── JWT (HS256 via Web Crypto HMAC) ────────────────────────────

function base64UrlEncode(obj) {
  const json = JSON.stringify(obj);
  return btoa(json)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function base64UrlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return JSON.parse(atob(str));
}

export async function signJwt(payload, secret) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const data = base64UrlEncode(header) + '.' + base64UrlEncode(payload);
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(data));
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return data + '.' + sigB64;
}

export async function verifyJwt(token, secret) {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, sigB64] = parts;
  const data = headerB64 + '.' + payloadB64;
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify']
  );
  const sig = Uint8Array.from(
    atob(sigB64.replace(/-/g, '+').replace(/_/g, '/')),
    c => c.charCodeAt(0)
  );
  const valid = await crypto.subtle.verify('HMAC', key, sig, encoder.encode(data));
  if (!valid) return null;
  const payload = base64UrlDecode(payloadB64);
  if (payload.exp && Date.now() / 1000 > payload.exp) return null;
  return payload;
}

// ── Auth middleware ────────────────────────────────────────────

export async function getUser(request, env) {
  const auth = request.headers.get('Authorization');
  if (!auth?.startsWith('Bearer ')) return null;
  const token = auth.slice(7);
  const payload = await verifyJwt(token, env.JWT_SECRET);
  if (!payload) return null;
  const user = await env.DB.prepare('SELECT id, username, email, display_name FROM users WHERE id = ?')
    .bind(payload.sub)
    .first();
  return user;
}

export function unauthorized() {
  return Response.json({ error: 'Unauthorized' }, { status: 401 });
}

// ── ID generator ───────────────────────────────────────────────

export function generateId() {
  return crypto.randomUUID();
}

// ── JSON helpers ───────────────────────────────────────────────

export function json(data, status = 200) {
  return Response.json(data, { status });
}
