import { challenges, findChallenge } from './challenges';
import { publicChallenge } from './grading/reveal';
import { EXEC_MODELS, runChallenge } from './run';
import { InvalidRequestError, ProviderError } from './providers/errors';
import {
  findByHash,
  insertSubmission,
  leaderboard,
  progressFor,
  promptHash,
  publicResult,
  rankFor,
  setShowPrompt,
  submissionOwner,
  upsertBestScore,
  upsertUser,
} from './db/queries';
import { userFromRequest, type VerifiedUser } from './auth/verify';
import {
  budgetStatus,
  clientIp,
  consumeRateLimit,
  limitsFromEnv,
  reserveBudget,
  runCost,
  type CounterStore,
} from './budget';
import { bindingEmbedder, type AiBinding } from './providers/embeddings';
import type { RunResponse } from './run';

export interface Env {
  GROQ_API_KEY?: string;
  AIG_ACCOUNT?: string;
  AIG_GATEWAY?: string;
  AIG_TOKEN?: string;
  FIREBASE_PROJECT_ID?: string;
  DB?: D1Database;
  /** Shared-budget and per-IP rate-limit counters. See `budget.ts`. */
  BUDGET?: KVNamespace;
  /** Workers AI, for the embeddings the `similar` assertions need. Without it
   *  those assertions stay pending and the run is not leaderboard-eligible. */
  AI?: AiBinding;
  BUDGET_TOKENS_PER_DAY?: string;
  BUDGET_TOKENS_PER_MINUTE?: string;
  RATE_LIMIT_PER_MINUTE?: string;
  RATE_LIMIT_PER_HOUR?: string;
}

/** Records who earned a score, and updates their best if this beat it.
 *
 *  Best-effort by design: a signed-in player whose leaderboard write fails should
 *  still see their scorecard. The write itself refuses anything not
 *  leaderboard-eligible. */
async function recordForUser(
  db: D1Database,
  user: VerifiedUser,
  result: RunResponse,
): Promise<boolean> {
  try {
    await upsertUser(db, {
      uid: user.uid,
      displayName: user.name,
      avatarUrl: user.picture,
      isAnonymous: user.isAnonymous,
    });
    return await upsertBestScore(db, user.uid, result);
  } catch {
    return false;
  }
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

/** The same sentence the landing page already made, repeated at the moment it
 *  bites. Nobody should meet the idea of bringing their own key for the first time
 *  while they are blocked — see `docs/design-doc.md`, "Bring-your-own key". */
const BYO_KEY_PROMPT =
  "PromptGym's shared Groq allowance is spent for now. Add your own free Groq key " +
  'and you never queue behind anyone — it stays in your browser and is never stored ' +
  'on our side. Your runs still count on the leaderboard.';

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
  // A missing or malformed Authorization header is an anonymous request, not an
  // error: playing without signing in has to keep working.
  const { user, error: authError } = await userFromRequest(request, env.FIREBASE_PROJECT_ID);
  if (authError && authError !== 'auth_not_configured') {
    return Response.json({ error: 'invalid_token', message: authError }, { status: 401, headers: cors });
  }

  const hash = await promptHash(challengeId, prompt, execModel);
  if (env.DB) {
    try {
      const cached = await findByHash(env.DB, hash);
      if (cached) {
        // The cache is global, so this may be someone else's earlier run of the
        // same prompt. It still counts for whoever submits it: everything is
        // temperature 0, so they would have got this result themselves.
        let banked = false;
        if (user) banked = await recordForUser(env.DB, user, cached.result);
        return Response.json(
          { ...cached.result, cached: true, uid: user?.uid ?? null, newBest: banked },
          { headers: cors },
        );
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

  // Guardrails, in this order and after the dedupe lookup above: a cached run
  // costs nothing and must never be refused for lack of quota.
  //
  // Without a KV binding there are no counters, so both checks pass. That is the
  // deliberate direction to fail in — a KV outage should slow nobody down, and
  // Groq's own 429 is the backstop underneath this one.
  if (env.BUDGET) {
    const kv: CounterStore = env.BUDGET;
    const limits = limitsFromEnv(env);

    try {
      // Counted for everyone. A player's own key pays Groq; it does not pay for
      // our Worker's CPU or our D1 writes.
      const ip = clientIp(request);
      if (ip) {
        const verdict = await consumeRateLimit(kv, ip, limits.rate);
        if (!verdict.ok) {
          return Response.json(
            {
              error: 'rate_limited',
              scope: verdict.scope,
              retryAfterSeconds: verdict.retryAfterSeconds,
              message: `Too many runs from this connection. Try again in ${verdict.retryAfterSeconds}s.`,
            },
            {
              status: 429,
              headers: { ...cors, 'Retry-After': String(verdict.retryAfterSeconds) },
            },
          );
        }
      }

      // The shared budget exists to protect the one key everybody shares. A player
      // spending their own quota is not spending ours, so they skip it entirely.
      if (!byoKey) {
        const verdict = await reserveBudget(kv, runCost(challenge.limits), limits.budget);
        if (!verdict.ok) {
          return Response.json(
            {
              error: 'budget_exhausted',
              scope: verdict.scope,
              retryAfterSeconds: verdict.retryAfterSeconds,
              byoKeyAccepted: true,
              message: BYO_KEY_PROMPT,
            },
            {
              status: 429,
              headers: { ...cors, 'Retry-After': String(verdict.retryAfterSeconds) },
            },
          );
        }
      }
    } catch {
      /* A counter we cannot read is not a reason to refuse a run. */
    }
  }

  try {
    const result = await runChallenge({
      challenge,
      prompt,
      model: execModel,
      apiKey,
      gateway: { account: env.AIG_ACCOUNT, gateway: env.AIG_GATEWAY, token: env.AIG_TOKEN },
      embedder: env.AI ? bindingEmbedder(env.AI) : undefined,
    });

    // Groq's own 429 leaves the player exactly where an exhausted shared budget
    // would have, so it gets the same offer in the same words. Only when it took
    // out the whole run: a scorecard on which every case errored teaches nothing,
    // and storing it would just poison the dedupe cache with a non-result.
    const allErrored = result.tests.length > 0 && result.tests.every((t) => t.status === 'errored');
    if (result.rateLimited && allErrored && !byoKey) {
      return Response.json(
        { error: 'upstream_rate_limited', byoKeyAccepted: true, message: BYO_KEY_PROMPT },
        { status: 429, headers: cors },
      );
    }

    let newBest = false;
    if (env.DB) {
      // A storage failure must not lose the player the run they just paid for, so
      // the scorecard is returned either way and the write failure is swallowed.
      try {
        if (user) {
          await upsertUser(env.DB, {
            uid: user.uid,
            displayName: user.name,
            avatarUrl: user.picture,
            isAnonymous: user.isAnonymous,
          });
        }
        await insertSubmission(env.DB, {
          result,
          uid: user?.uid ?? null,
          prompt,
          hash,
          byoKeyUsed: Boolean(byoKey),
        });
        if (user) newBest = await upsertBestScore(env.DB, user.uid, result);
      } catch {
        /* persistence is best-effort; the scorecard is what the player came for */
      }
    }

    return Response.json(
      { ...result, byoKeyUsed: Boolean(byoKey), cached: false, uid: user?.uid ?? null, newBest },
      { headers: cors },
    );
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
      // The remaining shared allowance is worth knowing before a LinkedIn post
      // goes out, and it is not sensitive: it is a count of tokens, not of people.
      let budget: Awaited<ReturnType<typeof budgetStatus>> | null = null;
      if (env.BUDGET) {
        try {
          budget = await budgetStatus(env.BUDGET, limitsFromEnv(env).budget);
        } catch {
          /* health must stay up even when the counter store does not */
        }
      }
      return Response.json({ ok: true, budget }, { headers: cors });
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

    // A share permalink. The id is an unguessable UUID, which is the capability —
    // the link is unlisted rather than public, and the prompt stays hidden until
    // its owner says otherwise.
    const resultMatch = /^\/api\/result\/([A-Za-z0-9-]{8,64})$/.exec(pathname);
    if (resultMatch && request.method === 'GET') {
      if (!env.DB) return Response.json({ error: 'no_database' }, { status: 503, headers: cors });
      const result = await publicResult(env.DB, resultMatch[1]);
      if (!result) return Response.json({ error: 'not_found' }, { status: 404, headers: cors });
      return Response.json(result, { headers: cors });
    }

    const visibilityMatch = /^\/api\/result\/([A-Za-z0-9-]{8,64})\/visibility$/.exec(pathname);
    if (visibilityMatch && request.method === 'POST') {
      if (!env.DB) return Response.json({ error: 'no_database' }, { status: 503, headers: cors });

      const { user } = await userFromRequest(request, env.FIREBASE_PROJECT_ID);
      if (!user) return Response.json({ error: 'sign_in_required' }, { status: 401, headers: cors });

      const submissionId = visibilityMatch[1];
      const owner = await submissionOwner(env.DB, submissionId);
      if (owner === null) return Response.json({ error: 'not_found' }, { status: 404, headers: cors });
      // Only the person who wrote the prompt may publish it.
      if (owner !== user.uid) {
        return Response.json({ error: 'not_your_result' }, { status: 403, headers: cors });
      }

      let body: { showPrompt?: unknown };
      try {
        body = (await request.json()) as { showPrompt?: unknown };
      } catch {
        return Response.json({ error: 'invalid_json' }, { status: 400, headers: cors });
      }
      const showPrompt = body.showPrompt === true;
      await setShowPrompt(env.DB, submissionId, showPrompt);
      return Response.json({ ok: true, showPrompt }, { headers: cors });
    }

    if (pathname === '/api/leaderboard' && request.method === 'GET') {
      if (!env.DB) {
        return Response.json({ error: 'no_database' }, { status: 503, headers: cors });
      }

      const requested = Number(new URL(request.url).searchParams.get('limit') ?? 50);
      const limit = Math.min(Math.max(Number.isFinite(requested) ? requested : 50, 1), 100);

      const { user } = await userFromRequest(request, env.FIREBASE_PROJECT_ID);

      // Refresh the profile from the token while we have it.
      //
      // Linking a guest account to Google keeps the same uid, so the scores are
      // already theirs — but `users.display_name` is only written during a run,
      // so without this the board would still call them "player 4f2a1c" until
      // they happened to submit again. The first thing most people do after
      // signing in is look at the board.
      if (user) {
        try {
          await upsertUser(env.DB, {
            uid: user.uid,
            displayName: user.name,
            avatarUrl: user.picture,
            isAnonymous: user.isAnonymous,
          });
        } catch {
          /* best-effort: never fail a read because a write did */
        }
      }

      try {
        const board = await leaderboard(env.DB, limit);
        // Someone outside the top N still gets to see where they stand, so the
        // board is useful rather than just aspirational.
        const inBoard = user ? board.some((row) => row.uid === user.uid) : false;
        const you = user && !inBoard ? await rankFor(env.DB, user.uid) : null;

        return Response.json(
          {
            leaderboard: board,
            you: you ?? (user ? (board.find((r) => r.uid === user.uid) ?? null) : null),
            completed: user ? await progressFor(env.DB, user.uid) : [],
            totalChallenges: challenges.length,
          },
          { headers: cors },
        );
      } catch {
        return Response.json({ error: 'leaderboard_unavailable' }, { status: 503, headers: cors });
      }
    }

    return Response.json({ error: 'not_found' }, { status: 404, headers: cors });
  },
};
