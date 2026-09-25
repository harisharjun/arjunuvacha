import { describe, it, expect, beforeEach, vi } from 'vitest';
import { verifyIdToken, userFromRequest, resetJwksCache, TokenError } from '../src/auth/verify';

const PROJECT = 'arjunuvacha-3de80';
const KID = 'test-key-1';

/** Real RSA keys and real signatures. Mocking the verify step would test nothing:
 *  the bug this file guards against is accepting a token whose signature is fine
 *  but whose claims are not. */
async function makeKeyPair(kid: string) {
  const pair = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  return { privateKey: pair.privateKey, jwk: { ...jwk, kid, alg: 'RS256' } };
}

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const encodeJson = (value: unknown) => b64url(new TextEncoder().encode(JSON.stringify(value)));

async function signToken(
  privateKey: CryptoKey,
  claims: Record<string, unknown>,
  header: Record<string, unknown> = { alg: 'RS256', kid: KID, typ: 'JWT' },
) {
  const body = `${encodeJson(header)}.${encodeJson(claims)}`;
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    privateKey,
    new TextEncoder().encode(body),
  );
  return `${body}.${b64url(new Uint8Array(signature))}`;
}

const now = () => Date.now();
const validClaims = (overrides: Record<string, unknown> = {}) => ({
  iss: `https://securetoken.google.com/${PROJECT}`,
  aud: PROJECT,
  sub: 'uid-123',
  iat: Math.floor(now() / 1000) - 30,
  exp: Math.floor(now() / 1000) + 3600,
  firebase: { sign_in_provider: 'google.com' },
  ...overrides,
});

let keys: Awaited<ReturnType<typeof makeKeyPair>>;
let jwksFetch: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  resetJwksCache();
  keys = await makeKeyPair(KID);
  jwksFetch = vi.fn().mockImplementation(
    async () =>
      new Response(JSON.stringify({ keys: [keys.jwk] }), {
        status: 200,
        headers: { 'cache-control': 'public, max-age=3600' },
      }),
  );
});

const verify = (token: string, projectId = PROJECT) =>
  verifyIdToken(token, projectId, { fetchImpl: jwksFetch as unknown as typeof fetch });

describe('a genuine token', () => {
  it('is accepted and yields the uid', async () => {
    const token = await signToken(keys.privateKey, validClaims());
    const user = await verify(token);
    expect(user.uid).toBe('uid-123');
    expect(user.isAnonymous).toBe(false);
  });

  it('carries profile claims through when present', async () => {
    const token = await signToken(
      keys.privateKey,
      validClaims({ email: 'a@example.com', name: 'Arjun', picture: 'https://x/y.png' }),
    );
    const user = await verify(token);
    expect(user.email).toBe('a@example.com');
    expect(user.name).toBe('Arjun');
  });

  it('recognises an anonymous sign-in', async () => {
    const token = await signToken(
      keys.privateKey,
      validClaims({ firebase: { sign_in_provider: 'anonymous' } }),
    );
    expect((await verify(token)).isAnonymous).toBe(true);
  });
});

describe('claims that must fail closed', () => {
  // THE test from the build guide: a valid signature is not enough. Without this
  // check, a token from any other Firebase project would be accepted.
  it('rejects a validly-signed token issued for a different project', async () => {
    const token = await signToken(keys.privateKey, validClaims({ aud: 'someone-elses-project' }));
    await expect(verify(token)).rejects.toBeInstanceOf(TokenError);
    await expect(verify(token)).rejects.toThrow(/different project/i);
  });

  it('rejects a token whose issuer is not our project', async () => {
    const token = await signToken(
      keys.privateKey,
      validClaims({ iss: 'https://securetoken.google.com/other-project' }),
    );
    await expect(verify(token)).rejects.toThrow(/issuer/i);
  });

  it('rejects an expired token', async () => {
    const token = await signToken(
      keys.privateKey,
      validClaims({ exp: Math.floor(now() / 1000) - 10 }),
    );
    await expect(verify(token)).rejects.toThrow(/expired/i);
  });

  it('rejects a token issued in the future beyond clock skew', async () => {
    const token = await signToken(
      keys.privateKey,
      validClaims({ iat: Math.floor(now() / 1000) + 600 }),
    );
    await expect(verify(token)).rejects.toThrow(/future/i);
  });

  it('tolerates a small clock skew on iat', async () => {
    const token = await signToken(
      keys.privateKey,
      validClaims({ iat: Math.floor(now() / 1000) + 20 }),
    );
    await expect(verify(token)).resolves.toBeTruthy();
  });

  it('rejects a token with no subject', async () => {
    const token = await signToken(keys.privateKey, validClaims({ sub: '' }));
    await expect(verify(token)).rejects.toThrow(/subject/i);
  });

  it('rejects missing exp or iat rather than treating them as zero', async () => {
    const noExp = await signToken(keys.privateKey, validClaims({ exp: undefined }));
    await expect(verify(noExp)).rejects.toThrow(/expired/i);
  });
});

describe('signature and key selection', () => {
  it('rejects a token signed by a different key', async () => {
    const attacker = await makeKeyPair(KID); // same kid, different key material
    const token = await signToken(attacker.privateKey, validClaims());
    await expect(verify(token)).rejects.toThrow(/signature/i);
  });

  // Code that tries every key in the set instead of selecting by kid accepts
  // tokens signed by the wrong one. The kid must SELECT.
  it('rejects a token whose kid is not in the key set, without trying other keys', async () => {
    const token = await signToken(keys.privateKey, validClaims(), {
      alg: 'RS256',
      kid: 'a-kid-google-never-published',
      typ: 'JWT',
    });
    await expect(verify(token)).rejects.toThrow(/unknown key/i);
  });

  it('rejects alg:none, the classic forgery', async () => {
    const header = encodeJson({ alg: 'none', kid: KID, typ: 'JWT' });
    const payload = encodeJson(validClaims());
    await expect(verify(`${header}.${payload}.`)).rejects.toThrow(/algorithm/i);
  });

  it('rejects a token with a tampered payload', async () => {
    const token = await signToken(keys.privateKey, validClaims());
    const [h, , s] = token.split('.');
    const swapped = encodeJson(validClaims({ sub: 'someone-else' }));
    await expect(verify(`${h}.${swapped}.${s}`)).rejects.toThrow(/signature/i);
  });

  it('rejects a malformed token', async () => {
    await expect(verify('not.a.token')).rejects.toBeInstanceOf(TokenError);
    await expect(verify('onlyonepart')).rejects.toThrow(/malformed/i);
  });
});

describe('JWKS caching', () => {
  it('fetches once and reuses the keys within max-age', async () => {
    const token = await signToken(keys.privateKey, validClaims());
    await verify(token);
    await verify(token);
    expect(jwksFetch).toHaveBeenCalledTimes(1);
  });

  it('refetches once the published max-age has elapsed', async () => {
    // The token must outlive the clock jump below, or this would be testing
    // expiry rather than cache expiry.
    const token = await signToken(
      keys.privateKey,
      validClaims({ exp: Math.floor(Date.now() / 1000) + 86_400 }),
    );
    const base = Date.now();
    await verifyIdToken(token, PROJECT, {
      fetchImpl: jwksFetch as unknown as typeof fetch,
      now: () => base,
    });
    await verifyIdToken(token, PROJECT, {
      fetchImpl: jwksFetch as unknown as typeof fetch,
      now: () => base + 3_600_001,
    });
    expect(jwksFetch).toHaveBeenCalledTimes(2);
  });
});

describe('userFromRequest — anonymous play must keep working', () => {
  const withHeaders = (headers: Record<string, string>) =>
    new Request('https://worker.test/api/run', { headers });
  const source = () => ({ fetchImpl: jwksFetch as unknown as typeof fetch });

  it('treats a missing Authorization header as an unauthenticated request, not an error', async () => {
    const result = await userFromRequest(withHeaders({}), PROJECT, source());
    expect(result.user).toBeNull();
    expect(result.error).toBeNull();
  });

  it('treats a malformed header the same way', async () => {
    const result = await userFromRequest(
      withHeaders({ Authorization: 'Basic abc123' }),
      PROJECT,
      source(),
    );
    expect(result.user).toBeNull();
    expect(result.error).toBeNull();
  });

  it('reports an invalid bearer token rather than silently ignoring it', async () => {
    const token = await signToken(keys.privateKey, validClaims({ aud: 'wrong' }));
    const result = await userFromRequest(
      withHeaders({ Authorization: `Bearer ${token}` }),
      PROJECT,
      source(),
    );
    expect(result.user).toBeNull();
    expect(result.error).toMatch(/different project/i);
  });

  it('resolves a good token to a user', async () => {
    const token = await signToken(keys.privateKey, validClaims());
    const result = await userFromRequest(
      withHeaders({ Authorization: `Bearer ${token}` }),
      PROJECT,
      source(),
    );
    expect(result.user?.uid).toBe('uid-123');
  });

  it('does not authenticate anyone when the project id is not configured', async () => {
    const token = await signToken(keys.privateKey, validClaims());
    const result = await userFromRequest(
      withHeaders({ Authorization: `Bearer ${token}` }),
      undefined,
      source(),
    );
    expect(result.user).toBeNull();
    expect(result.error).toBe('auth_not_configured');
  });
});
