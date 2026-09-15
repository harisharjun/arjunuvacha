const ALLOWED_ORIGINS = [
  'https://arjunuvacha.com',
  'https://www.arjunuvacha.com',
  // Firebase staging project (arjunuvacha-test), serving on both of its domains.
  'https://arjunuvacha-test.web.app',
  'https://arjunuvacha-test.firebaseapp.com',
];
const ALLOWED_DEV_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

function resolveOrigin(origin: string | null): string | null {
  if (!origin) return null;
  if (ALLOWED_ORIGINS.includes(origin)) return origin;
  if (ALLOWED_DEV_ORIGIN.test(origin)) return origin;
  return null;
}

// Echoes back only an origin that is on the allowlist — never `*`. An
// unrecognised origin gets no CORS headers at all, so the browser blocks it.
function corsHeaders(origin: string | null): Record<string, string> {
  const allowed = resolveOrigin(origin);
  if (!allowed) return { Vary: 'Origin' };
  return {
    Vary: 'Origin',
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Groq-Key',
    'Access-Control-Max-Age': '86400',
  };
}

export default {
  async fetch(request: Request): Promise<Response> {
    const cors = corsHeaders(request.headers.get('Origin'));

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    const { pathname } = new URL(request.url);

    if (pathname === '/api/health' && request.method === 'GET') {
      return Response.json({ ok: true }, { headers: cors });
    }

    return Response.json({ error: 'not_found' }, { status: 404, headers: cors });
  },
};
