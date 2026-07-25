// ============================================================
// _middleware.js — JSON body parsing for all API routes
//
// There is deliberately no CORS handling here. The previous version answered
// preflight with Access-Control-Allow-Origin: * but never set the header on
// actual responses, so cross-origin reads failed anyway — it advertised access
// it did not grant. The frontend is served from the same origin as this API and
// needs no CORS at all, and a wildcard origin on a Bearer-token API is worth
// avoiding on principle. If a third-party client is ever needed, add the header
// to real responses and name the allowed origins explicitly.
// ============================================================

export async function onRequest(context) {
  const { request } = context;

  // Parse JSON body for POST/PUT
  if (['POST', 'PUT'].includes(request.method)) {
    try {
      const body = await request.json();
      context.data = context.data || {};
      context.data.body = body;
    } catch {
      context.data = context.data || {};
      context.data.body = {};
    }
  }

  return context.next();
}
