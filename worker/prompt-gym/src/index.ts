import { challenges, findChallenge } from './challenges';
import { publicChallenge } from './grading/reveal';
import { EXEC_MODELS, runChallenge } from './run';
import { InvalidRequestError, ProviderError } from './providers/errors';
import { findByHash, insertSubmission, promptHash } from './db/queries';

export interface Env {
  GROQ_API_KEY?: string;
  AIG_ACCOUNT?: string;
  AIG_GATEWAY?: string;
  AIG_TOKEN?: string;
  DB?: D1Database;
}

const ALLOWED_ORIGINS = [
  'https://arjunuvacha.com',
  'https://www.arjunuvacha.com',
  // Firebase staging project (arjunuvacha-test), serving on both of its domains.
  'https://arjunuvacha-test.web.app',
  'https://arjunuvacha-test.firebaseapp.com',
];
const ALLOWED_DEV_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

const MAX_PROMPT_CHARS = 2000;

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

interface RunBody {
  challengeId?: unknown;
  prompt?: unknown;
  model?: unknown;
}

async function handleRun(request: Request, env: Env, cors: Record<string, string>) {
  let body: RunBody;
  try {
    body = (await request.json()) as RunBody;
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400, headers: cors });
  }

  const { challengeId, prompt, model } = body;

  if (typeof challengeId !== 'string' || typeof prompt !== 'string') {
    return Response.json({ error: 'challengeId and prompt are required' }, { status: 400, headers: cors });
  }

  const challenge = findChallenge(challengeId);
  if (!challenge) {
    return Response.json({ error: 'unknown_challenge' }, { status: 400, headers: cors });
  }

  if (prompt.trim().length === 0) {
    return Response.json({ error: 'prompt is empty' }, { status: 400, headers: cors });
  }
  // Enforced here as well as in the editor: the editor is not a security boundary.
  if (prompt.length > MAX_PROMPT_CHARS) {
    return Response.json(
      { error: 'prompt_too_long', limit: MAX_PROMPT_CHARS, got: prompt.length },
      { status: 400, headers: cors },
    );
  }

  const execModel = typeof model === 'string' && model.length > 0 ? model : EXEC_MODELS[0];
  if (!(EXEC_MODELS as readonly string[]).includes(execModel)) {
    return Response.json(
      { error: 'unknown_model', allowed: EXEC_MODELS },
      { status: 400, headers: cors },
    );
  }

  // Dedupe is checked before the key, the rate limit or the budget, because a
  // cached run costs nothing and should never be refused for lack of quota.
  //
  // A cache that is unavailable must degrade to a re-run rather than fail the
  // request: the player's prompt is fine, and the worst case is that we pay for a
  // run we already had.
  const hash = await promptHash(challengeId, prompt, execModel);
  if (env.DB) {
    try {
      const cached = await findByHash(env.DB, hash);
      if (cached) {
        return Response.json({ ...cached.result, cached: true }, { headers: cors });
      }
    } catch {
      /* fall through and run it again */
    }
  }

  // A player's own key is request-scoped: used for this request and nothing else.
  // Never stored, never logged, never echoed back in a response or an error.
  const byoKey = request.headers.get('X-Groq-Key')?.trim();
  const apiKey = byoKey || env.GROQ_API_KEY;
  if (!apiKey) {
    return Response.json({ error: 'no_api_key_configured' }, { status: 503, headers: cors });
  }

  try {
    const result = await runChallenge({
      challenge,
      prompt,
      model: execModel,
      apiKey,
      gateway: { account: env.AIG_ACCOUNT, gateway: env.AIG_GATEWAY, token: env.AIG_TOKEN },
    });

    if (env.DB) {
      // A storage failure must not lose the player the run they just paid for, so
      // the scorecard is returned either way and the write failure is swallowed.
      try {
        await insertSubmission(env.DB, {
          result,
          uid: null, // auth lands at M5
          prompt,
          hash,
          byoKeyUsed: Boolean(byoKey),
        });
      } catch {
        /* persistence is best-effort until it has an owner to belong to */
      }
    }

    return Response.json({ ...result, byoKeyUsed: Boolean(byoKey), cached: false }, { headers: cors });
  } catch (err) {
    if (err instanceof InvalidRequestError) {
      return Response.json({ error: err.message }, { status: 400, headers: cors });
    }
    if (err instanceof ProviderError) {
      return Response.json(
        { error: err.kind, message: err.message },
        { status: err.kind === 'rate-limited' ? 429 : 502, headers: cors },
      );
    }
    return Response.json({ error: 'internal_error' }, { status: 500, headers: cors });
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const cors = corsHeaders(request.headers.get('Origin'));

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    const { pathname } = new URL(request.url);

    if (pathname === '/api/health' && request.method === 'GET') {
      return Response.json({ ok: true }, { headers: cors });
    }

    // Only the public block of each challenge. Test inputs, expected values,
    // rubrics and validator names never leave the Worker.
    if (pathname === '/api/challenges' && request.method === 'GET') {
      return Response.json(
        { challenges: challenges.map(publicChallenge), models: EXEC_MODELS },
        { headers: cors },
      );
    }

    if (pathname === '/api/run' && request.method === 'POST') {
      return handleRun(request, env, cors);
    }

    return Response.json({ error: 'not_found' }, { status: 404, headers: cors });
  },
};
