import { challenges, findChallenge, FREE_TO_PLAY, levels } from './challenges';
import { modelsFor, OPENAI_JUDGE, providerFor } from './models';
import { publicChallenge } from './grading/reveal';
import { EXEC_MODELS, runChallenge } from './run';
import { InvalidRequestError, ProviderError } from './providers/errors';
import {
  findByHash,
  insertSubmission,
  boardFor,
  progressDetailFor,
  promptHash,
  publicResult,
  setShowPrompt,
  sharedResults,
  type Viewer,
  submissionOwner,
  upsertBestScore,
  upsertUser,
} from './db/queries';
import { userFromRequest, type VerifiedUser } from './auth/verify';
import {
  budgetStatus,
  clientIp,
  consumeWindows,
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
  OPENAI_TOKENS_PER_DAY?: string;
  GUEST_RUNS_PER_HOUR?: string;
  USER_RUNS_PER_MINUTE?: string;
  USER_RUNS_PER_HOUR?: string;
  USER_RUNS_PER_DAY?: string;
  /** Signed-in players run on OpenAI. Without it they fall back to Groq. */
  OPENAI_API_KEY?: string;
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

/** What a guest is told when the free tier runs out, whichever way it ran out.
 *  Signing in is the answer every time: a higher allowance, on a paid model that
 *  does not share its quota with every other visitor. */
const GUEST_SIGN_IN =
  "You've used the free runs for guests for now. Sign in with Google to keep going — " +
  'signed-in players get 15 runs an hour on a faster, more reliable model, and their ' +
  'scores count on the leaderboard.';

/** "42s", "12 min", "3 h" — for telling someone how long to wait. */
function formatWait(seconds: number): string {
  if (seconds < 90) return `${Math.max(1, Math.round(seconds))}s`;
  if (seconds < 90 * 60) return `${Math.round(seconds / 60)} min`;
  return `${Math.round(seconds / 3600)} h`;
}

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

  // The sign-in wall. Enforced here, not only greyed out in the page, and before
  // the dedupe cache so a cached result is never a way around it.
  const signedIn = Boolean(user && !user.isAnonymous);
  if (!FREE_TO_PLAY.has(challenge.id) && !signedIn) {
    return Response.json(
      { error: 'sign_in_required', message: 'Sign in to play this challenge.' },
      { status: 401, headers: cors },
    );
  }

  // Which models this player may use here: Groq for guests; for signed-in
  // players gpt-4.1-nano, plus gpt-4.1-mini on Hard. See models.ts.
  const paidEnabled = Boolean(env.OPENAI_API_KEY);
  const allowed = modelsFor(challenge.difficulty ?? 1, signedIn ? 'signed-in' : 'guest', paidEnabled);
  const execModel = typeof model === 'string' && model.length > 0 ? model : allowed[0];
  if (!allowed.includes(execModel)) {
    return Response.json({ error: 'unknown_model', allowed }, { status: 400, headers: cors });
  }
  const provider = providerFor(execModel);

  const kv: CounterStore | undefined = env.BUDGET;
  const limits = limitsFromEnv(env);

  // Submission limits — before the cache, because a repeated prompt is still a
  // submission. Guests are counted per connection (a guest can mint a new
  // anonymous account just by clearing storage); signed-in players per account.
  //
  // Without a KV binding there are no counters and every check passes. That is
  // the deliberate direction to fail in: a KV outage should slow nobody down.
  if (kv) {
    try {
      const subject = signedIn ? `user:${user!.uid}` : `guest:${clientIp(request) ?? user?.uid ?? 'unknown'}`;
      const windows = signedIn
        ? [
            { scope: 'minute' as const, limit: limits.rate.userPerMinute },
            { scope: 'hour' as const, limit: limits.rate.userPerHour },
            { scope: 'day' as const, limit: limits.rate.userPerDay },
          ]
        : [{ scope: 'hour' as const, limit: limits.rate.guestPerHour }];
      const verdict = await consumeWindows(kv, subject, windows);
      if (!verdict.ok) {
        const retry = { ...cors, 'Retry-After': String(verdict.retryAfterSeconds) };
        if (!signedIn) {
          return Response.json(
            {
              error: 'guest_limit',
              limit: verdict.limit,
              retryAfterSeconds: verdict.retryAfterSeconds,
              signInUnlocks: true,
              message:
                `You've used your ${verdict.limit} free run${verdict.limit === 1 ? '' : 's'} for this hour. Sign in with Google to keep going — ` +
                'signed-in players get 15 an hour on a faster, more reliable model.',
            },
            { status: 429, headers: retry },
          );
        }
        const per = { minute: 'a minute', hour: 'an hour', day: 'a day' }[verdict.scope];
        return Response.json(
          {
            error: 'rate_limited',
            scope: verdict.scope,
            limit: verdict.limit,
            retryAfterSeconds: verdict.retryAfterSeconds,
            message: `That's the limit of ${verdict.limit} runs ${per}. Try again in ${formatWait(verdict.retryAfterSeconds)}.`,
          },
          { status: 429, headers: retry },
        );
      }
    } catch {
      /* A counter we cannot read is not a reason to refuse a run. */
    }
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

  // A player's own Groq key is request-scoped: used for this request and nothing
  // else. Never stored, never logged, never echoed back. The page no longer
  // offers it — signed-in players run on the paid tier — but it still works.
  const byoKey = provider === 'groq' ? request.headers.get('X-Groq-Key')?.trim() : undefined;
  const apiKey = provider === 'openai' ? env.OPENAI_API_KEY : byoKey || env.GROQ_API_KEY;
  if (!apiKey) {
    return Response.json({ error: 'no_api_key_configured' }, { status: 503, headers: cors });
  }

  // Budgets, after the cache: a cached run costs nothing. Groq's shared free pool
  // protects the one key every guest shares; the paid pool is a site-wide ceiling
  // on what OpenAI can cost in a day, whatever the number of accounts.
  if (kv && !byoKey) {
    try {
      const pool = provider === 'openai' ? 'openai' : 'groq';
      const verdict = await reserveBudget(
        kv,
        runCost(challenge.limits),
        pool === 'openai' ? limits.paidBudget : limits.budget,
        new Date(),
        pool,
      );
      if (!verdict.ok) {
        const retry = { ...cors, 'Retry-After': String(verdict.retryAfterSeconds) };
        return Response.json(
          {
            error: 'budget_exhausted',
            scope: verdict.scope,
            retryAfterSeconds: verdict.retryAfterSeconds,
            ...(signedIn ? {} : { signInUnlocks: true }),
            message: signedIn
              ? `PromptGym has reached its limit for ${verdict.scope === 'day' ? 'today' : 'this minute'}. Try again in ${formatWait(verdict.retryAfterSeconds)}.`
              : GUEST_SIGN_IN,
          },
          { status: 429, headers: retry },
        );
      }
    } catch {
      /* as above */
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
      provider,
      // Pinned, never the player's choice: every judged score must be comparable.
      judge: paidEnabled
        ? { provider: 'openai', apiKey: env.OPENAI_API_KEY!, scoreModel: OPENAI_JUDGE, labelModel: OPENAI_JUDGE }
        : undefined,
    });

    // Groq's own 429 leaves the player exactly where an exhausted shared budget
    // would have, so it gets the same offer in the same words. Only when it took
    // out the whole run: a scorecard on which every case errored teaches nothing,
    // and storing it would just poison the dedupe cache with a non-result.
    const allErrored = result.tests.length > 0 && result.tests.every((t) => t.status === 'errored');
    if (result.rateLimited && allErrored && !byoKey) {
      return Response.json(
        signedIn
          ? { error: 'upstream_rate_limited', message: 'The model is busy right now. Try again in a minute.' }
          : { error: 'upstream_rate_limited', signInUnlocks: true, message: GUEST_SIGN_IN },
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

/** Who is asking, and what they have passed — the prompt gate needs both. */
async function viewerFor(request: Request, env: Env): Promise<Viewer | undefined> {
  if (!env.DB) return undefined;
  const { user } = await userFromRequest(request, env.FIREBASE_PROJECT_ID);
  if (!user) return undefined;
  const passed = new Set(
    (await progressDetailFor(env.DB, user.uid)).filter((p) => p.passed).map((p) => p.challengeId),
  );
  return { uid: user.uid, passed };
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
        {
          challenges: challenges.map((c) => ({
            ...publicChallenge(c),
            freeToPlay: FREE_TO_PLAY.has(c.id),
            // What a signed-in player may choose here. Guests get `guestModels`.
            models: modelsFor(c.difficulty ?? 1, 'signed-in', Boolean(env.OPENAI_API_KEY)),
          })),
          guestModels: modelsFor(1, 'guest', false),
          // Kept for older pages that read a single list.
          models: EXEC_MODELS,
        },
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
      const result = await publicResult(env.DB, resultMatch[1], await viewerFor(request, env));
      if (!result) return Response.json({ error: 'not_found' }, { status: 404, headers: cors });
      return Response.json(result, { headers: cors });
    }

    const visibilityMatch = /^\/api\/result\/([A-Za-z0-9-]{8,64})\/visibility$/.exec(pathname);
    if (visibilityMatch && request.method === 'POST') {
      if (!env.DB) return Response.json({ error: 'no_database' }, { status: 503, headers: cors });

      const { user } = await userFromRequest(request, env.FIREBASE_PROJECT_ID);
      // Sharing puts a name and a photo in a public gallery, so a guest cannot.
      if (!user || user.isAnonymous) {
        return Response.json({ error: 'sign_in_required' }, { status: 401, headers: cors });
      }

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

    // The shared-results gallery. Public: anyone may browse who shared what and
    // how it scored. Prompt text is gated per viewer inside the query.
    if (pathname === '/api/shares' && request.method === 'GET') {
      if (!env.DB) return Response.json({ error: 'no_database' }, { status: 503, headers: cors });
      const params = new URL(request.url).searchParams;
      const difficulty = Number(params.get('difficulty'));
      const challengeIds = challenges
        .filter((c) => !Number.isFinite(difficulty) || difficulty < 1 || c.difficulty === difficulty)
        .map((c) => c.id);
      try {
        const viewer = await viewerFor(request, env);
        const shares = await sharedResults(env.DB, {
          challengeIds,
          sort: params.get('sort') === 'score' ? 'score' : 'oldest',
          mineOnly: params.get('mine') === '1',
          viewer,
          limit: 200,
        });
        return Response.json({ shares }, { headers: cors });
      } catch {
        return Response.json({ error: 'shares_unavailable' }, { status: 503, headers: cors });
      }
    }

    if (pathname === '/api/leaderboard' && request.method === 'GET') {
      if (!env.DB) {
        return Response.json({ error: 'no_database' }, { status: 503, headers: cors });
      }

      // The page asks for 10 in its sidebar and for everyone when the full list is
      // opened. 500 is a ceiling for a single response, not a design size: past
      // that the panel needs paging, which is a good problem to have.
      const requested = Number(new URL(request.url).searchParams.get('limit') ?? 50);
      const limit = Math.min(Math.max(Number.isFinite(requested) ? requested : 50, 1), 500);

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
        // Guests are not ranked (see ranking.ts), so a guest's `you` is null and the
        // page shows the nudge to sign in instead of a rank.
        const { board, you, total } = await boardFor(env.DB, levels, limit, user?.uid);

        // Only shipped challenges count towards progress. A withheld challenge a
        // player banked before it was withheld would otherwise show as progress on
        // a card they can no longer see.
        const shipped = new Set(challenges.map((c) => c.id));
        const progress = user
          ? (await progressDetailFor(env.DB, user.uid)).filter((p) => shipped.has(p.challengeId))
          : [];

        return Response.json(
          {
            leaderboard: board,
            you,
            completed: progress.filter((p) => p.passed).map((p) => p.challengeId),
            progress,
            totalPlayers: total,
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
