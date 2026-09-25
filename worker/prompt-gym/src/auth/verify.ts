/**
 * Firebase ID token verification, hand-rolled on WebCrypto.
 *
 * `firebase-admin` does not run here: it verifies with node:crypto
 * (`createVerify('RSA-SHA256')`), and the Workers runtime has WebCrypto instead —
 * a different API for the same mathematics, async rather than sync. This file is
 * the one percent of that SDK this project actually needs, because all our data
 * lives in D1 rather than Firestore.
 *
 * This is the only security-critical code in the project. The failure mode to fear
 * is not a crash — it is quietly accepting a token it should refuse, which tests
 * happily pass over. Every claim below is checked for that reason.
 */

const JWKS_URL =
  'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';

/** Tokens minted a moment ago can carry an `iat` fractionally in the future when
 *  Google's clock and ours disagree. Rejecting those would log people out for no
 *  reason. `exp` gets no such grace: expired is expired. */
const IAT_SKEW_SECONDS = 60;

export interface VerifiedUser {
  uid: string;
  email: string | null;
  name: string | null;
  picture: string | null;
  isAnonymous: boolean;
}

export class TokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TokenError';
  }
}

interface Jwk {
  kid?: string;
  kty?: string;
  alg?: string;
  n?: string;
  e?: string;
}

function base64UrlToBytes(input: string): Uint8Array {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

function decodeJson(segment: string): Record<string, unknown> {
  const text = new TextDecoder().decode(base64UrlToBytes(segment));
  return JSON.parse(text) as Record<string, unknown>;
}

export interface JwksSource {
  fetchImpl?: typeof fetch;
  /** Injectable so tests need no Cache API, and so a cache outage is survivable. */
  cache?: Cache;
  now?: () => number;
}

interface CachedJwks {
  keys: Jwk[];
  expiresAt: number;
}

let memoryCache: CachedJwks | null = null;

/** Fetches Google's public signing keys, honouring the `max-age` they publish.
 *  Google rotates these, so caching forever is wrong and fetching every request
 *  is wasteful; the header tells us exactly how long they are good for. */
export async function fetchJwks(source: JwksSource = {}): Promise<Jwk[]> {
  const doFetch = source.fetchImpl ?? fetch;
  const now = (source.now ?? Date.now)();

  if (memoryCache && memoryCache.expiresAt > now) return memoryCache.keys;

  const response = await doFetch(JWKS_URL);
  if (!response.ok) throw new TokenError('Could not fetch Google signing keys');

  const body = (await response.json()) as { keys?: Jwk[] } | Record<string, unknown>;
  // The endpoint serves either a JWKS object or a bare key map depending on which
  // URL is used; accept both rather than depending on the shape.
  const keys: Jwk[] = Array.isArray((body as { keys?: Jwk[] }).keys)
    ? ((body as { keys: Jwk[] }).keys)
    : Object.values(body as Record<string, Jwk>).filter((k) => k && typeof k === 'object');

  if (keys.length === 0) throw new TokenError('Google signing key set was empty');

  const maxAge = Number(/max-age=(\d+)/.exec(response.headers.get('cache-control') ?? '')?.[1]);
  memoryCache = {
    keys,
    expiresAt: now + (Number.isFinite(maxAge) && maxAge > 0 ? maxAge : 3600) * 1000,
  };
  return keys;
}

/** Test seam — the module-level cache would otherwise leak between cases. */
export function resetJwksCache(): void {
  memoryCache = null;
}

export async function verifyIdToken(
  token: string,
  projectId: string,
  source: JwksSource = {},
): Promise<VerifiedUser> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new TokenError('Malformed token');

  const [headerB64, payloadB64, signatureB64] = parts;

  let header: Record<string, unknown>;
  try {
    header = decodeJson(headerB64);
  } catch {
    throw new TokenError('Unreadable token header');
  }

  // Refusing anything but RS256 also refuses `alg: "none"`, the classic forgery.
  if (header.alg !== 'RS256') throw new TokenError(`Unsupported algorithm: ${String(header.alg)}`);

  const kid = header.kid;
  if (typeof kid !== 'string' || kid.length === 0) throw new TokenError('Token header has no kid');

  // The kid SELECTS one key. Code that loops over the whole key set and accepts
  // any match will accept a token signed by the wrong key — the subtle failure
  // this whole file exists to avoid.
  const keys = await fetchJwks(source);
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
  const signatureValid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    base64UrlToBytes(signatureB64),
    signed,
  );
  if (!signatureValid) throw new TokenError('Token signature is not valid');

  let claims: Record<string, unknown>;
  try {
    claims = decodeJson(payloadB64);
  } catch {
    throw new TokenError('Unreadable token payload');
  }

  // A valid signature only proves Google minted this token. It does NOT prove the
  // token was minted for us — without the aud check, a token from any other
  // Firebase project in the world would be accepted here.
  if (claims.aud !== projectId) throw new TokenError('Token was issued for a different project');
  if (claims.iss !== `https://securetoken.google.com/${projectId}`) {
    throw new TokenError('Token has the wrong issuer');
  }

  const nowSeconds = ((source.now ?? Date.now)()) / 1000;
  const exp = Number(claims.exp);
  const iat = Number(claims.iat);
  if (!Number.isFinite(exp) || exp <= nowSeconds) throw new TokenError('Token has expired');
  if (!Number.isFinite(iat) || iat > nowSeconds + IAT_SKEW_SECONDS) {
    throw new TokenError('Token was issued in the future');
  }

  const sub = claims.sub;
  if (typeof sub !== 'string' || sub.length === 0) throw new TokenError('Token has no subject');

  const firebase = (claims.firebase ?? {}) as { sign_in_provider?: string };
  return {
    uid: sub,
    email: typeof claims.email === 'string' ? claims.email : null,
    name: typeof claims.name === 'string' ? claims.name : null,
    picture: typeof claims.picture === 'string' ? claims.picture : null,
    isAnonymous: firebase.sign_in_provider === 'anonymous',
  };
}

/**
 * Resolves the caller from an Authorization header.
 *
 * A missing or malformed header means an anonymous, unauthenticated request — not
 * an error. Playing without signing in has to keep working; sign-in only buys a
 * place on the leaderboard. A header that is present but *invalid* is different,
 * and is reported so a broken client does not silently look logged out forever.
 */
export async function userFromRequest(
  request: Request,
  projectId: string | undefined,
  source: JwksSource = {},
): Promise<{ user: VerifiedUser | null; error: string | null }> {
  const header = request.headers.get('Authorization');
  if (!header || !header.startsWith('Bearer ')) return { user: null, error: null };

  const token = header.slice('Bearer '.length).trim();
  if (token.length === 0) return { user: null, error: null };

  if (!projectId) return { user: null, error: 'auth_not_configured' };

  try {
    return { user: await verifyIdToken(token, projectId, source), error: null };
  } catch (err) {
    return { user: null, error: err instanceof TokenError ? err.message : 'Invalid token' };
  }
}
