// Firebase ID token verification on WebCrypto.
//
// A plain-JavaScript copy of worker/prompt-gym/src/auth/verify.ts, so both
// Workers accept exactly the same sign-ins: Google's signature, by the key the
// token names; the right project (aud and iss); not expired; a subject. If one
// changes, change the other. The only addition is `jwksUrl`, used by the local
// tests and honoured only for a localhost address (see jwksUrlFrom below).

const GOOGLE_JWKS_URL =
  'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
const IAT_SKEW_SECONDS = 60;

export class TokenError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TokenError';
  }
}

function base64UrlToBytes(input) {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

function decodeJson(segment) {
  return JSON.parse(new TextDecoder().decode(base64UrlToBytes(segment)));
}

// Tests can point at their own key set, but only on localhost: a deployed
// Worker can't reach localhost, so this can never swap Google's keys in production.
export function jwksUrlFrom(env) {
  const u = env && env.TEST_JWKS_URL;
  return typeof u === 'string' && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(u) ? u : GOOGLE_JWKS_URL;
}

const memoryCache = new Map(); // url -> { keys, expiresAt }

async function fetchJwks(url) {
  const now = Date.now();
  const hit = memoryCache.get(url);
  if (hit && hit.expiresAt > now) return hit.keys;

  const response = await fetch(url);
  if (!response.ok) throw new TokenError('Could not fetch Google signing keys');
  const body = await response.json();
  const keys = Array.isArray(body.keys)
    ? body.keys
    : Object.values(body).filter((k) => k && typeof k === 'object');
  if (keys.length === 0) throw new TokenError('Google signing key set was empty');

  const maxAge = Number(/max-age=(\d+)/.exec(response.headers.get('cache-control') ?? '')?.[1]);
  memoryCache.set(url, { keys, expiresAt: now + (Number.isFinite(maxAge) && maxAge > 0 ? maxAge : 3600) * 1000 });
  return keys;
}

export async function verifyIdToken(token, projectId, jwksUrl = GOOGLE_JWKS_URL) {
  if (typeof token !== 'string') throw new TokenError('Malformed token');
  const parts = token.split('.');
  if (parts.length !== 3) throw new TokenError('Malformed token');
  const [headerB64, payloadB64, signatureB64] = parts;

  let header;
  try { header = decodeJson(headerB64); } catch { throw new TokenError('Unreadable token header'); }
  // Refusing anything but RS256 also refuses `alg: "none"`.
  if (header.alg !== 'RS256') throw new TokenError(`Unsupported algorithm: ${String(header.alg)}`);
  const kid = header.kid;
  if (typeof kid !== 'string' || kid.length === 0) throw new TokenError('Token header has no kid');

  // The kid SELECTS one key; never accept a match against any key in the set.
  const keys = await fetchJwks(jwksUrl);
  const jwk = keys.find((k) => k.kid === kid);
  if (!jwk) throw new TokenError('Token was signed with an unknown key');
  if (!jwk.kty || !jwk.n || !jwk.e) throw new TokenError('Signing key is incomplete');

  const key = await crypto.subtle.importKey(
    'jwk',
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const signed = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, base64UrlToBytes(signatureB64), signed);
  if (!ok) throw new TokenError('Token signature is not valid');

  let claims;
  try { claims = decodeJson(payloadB64); } catch { throw new TokenError('Unreadable token payload'); }

  // Without the aud check, a token from any Firebase project would be accepted.
  if (claims.aud !== projectId) throw new TokenError('Token was issued for a different project');
  if (claims.iss !== `https://securetoken.google.com/${projectId}`) throw new TokenError('Token has the wrong issuer');

  const nowSeconds = Date.now() / 1000;
  const exp = Number(claims.exp);
  const iat = Number(claims.iat);
  if (!Number.isFinite(exp) || exp <= nowSeconds) throw new TokenError('Token has expired');
  if (!Number.isFinite(iat) || iat > nowSeconds + IAT_SKEW_SECONDS) throw new TokenError('Token was issued in the future');

  const sub = claims.sub;
  if (typeof sub !== 'string' || sub.length === 0) throw new TokenError('Token has no subject');

  const firebase = claims.firebase ?? {};
  return {
    uid: sub,
    name: typeof claims.name === 'string' ? claims.name : null,
    picture: typeof claims.picture === 'string' ? claims.picture : null,
    isAnonymous: firebase.sign_in_provider === 'anonymous',
  };
}

/** The caller from `Authorization: Bearer <id token>`. Unlike PromptGym, every
 *  games endpoint that touches results needs one, so a missing token is `null`
 *  and an invalid one is an error the caller reports. */
export async function userFromRequest(request, env) {
  const header = request.headers.get('Authorization');
  if (!header || !header.startsWith('Bearer ')) return { user: null, error: 'sign_in_required' };
  if (!env.FIREBASE_PROJECT_ID) return { user: null, error: 'auth_not_configured' };
  try {
    return { user: await verifyIdToken(header.slice(7).trim(), env.FIREBASE_PROJECT_ID, jwksUrlFrom(env)), error: null };
  } catch (err) {
    return { user: null, error: err instanceof TokenError ? err.message : 'Invalid token' };
  }
}
