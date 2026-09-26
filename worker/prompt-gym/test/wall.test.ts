import { describe, it, expect, vi, afterEach } from 'vitest';

/** Who the Worker thinks is calling, set per test. The real verifier is covered
 *  in auth.test.ts; here the question is only what each kind of caller may do. */
const who = vi.hoisted(() => ({ user: null as null | { uid: string; isAnonymous: boolean } }));
vi.mock('../src/auth/verify', () => ({
  userFromRequest: async () => ({
    user: who.user && { ...who.user, email: null, name: 'Test', picture: null },
    error: undefined,
  }),
}));

import worker from '../src/index';

const env = { GROQ_API_KEY: 'gsk_test', AIG_ACCOUNT: 'acc', AIG_GATEWAY: 'vani' };

const post = (path: string, body: unknown) =>
  new Request(`https://worker.test${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://arjunuvacha.com', Authorization: 'Bearer t' },
    body: JSON.stringify(body),
  });

const groq = (content: string) =>
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 10, completion_tokens: 2 },
          }),
          { status: 200 },
        ),
    ),
  );

afterEach(() => {
  vi.unstubAllGlobals();
  who.user = null;
});

describe('the sign-in wall', () => {
  it('lets a guest play the three free challenges', async () => {
    groq('billing');
    who.user = { uid: 'guest', isAnonymous: true };
    for (const id of ['pg-a2', 'pg-a3', 'pg-b7']) {
      const res = await worker.fetch(post('/api/run', { challengeId: id, prompt: 'x' }), env);
      expect(res.status, id).toBe(200);
    }
  });

  it('refuses a guest everything else, before any model call', async () => {
    groq('billing');
    who.user = { uid: 'guest', isAnonymous: true };
    const res = await worker.fetch(post('/api/run', { challengeId: 'pg-b3', prompt: 'x' }), env);
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe('sign_in_required');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('refuses a request with no token at all', async () => {
    groq('No');
    const res = await worker.fetch(post('/api/run', { challengeId: 'pg-b3', prompt: 'x' }), env);
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe('sign_in_required');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('lets a signed-in player through', async () => {
    groq('[PHONE]');
    who.user = { uid: 'arjun', isAnonymous: false };
    const res = await worker.fetch(post('/api/run', { challengeId: 'pg-b3', prompt: 'x' }), env);
    expect(res.status).toBe(200);
  });

  it('marks which challenges are free in the public list', async () => {
    const res = await worker.fetch(new Request('https://worker.test/api/challenges'), env);
    const { challenges } = (await res.json()) as { challenges: { id: string; freeToPlay: boolean }[] };
    expect(challenges.filter((c) => c.freeToPlay).map((c) => c.id).sort()).toEqual(['pg-a2', 'pg-a3', 'pg-b7']);
  });
});

describe('sharing', () => {
  it('is refused to a guest — it puts a name in a public gallery', async () => {
    who.user = { uid: 'guest', isAnonymous: true };
    // A placeholder DB: the guest must be turned away before it is ever touched.
    const db = new Proxy({}, { get: () => { throw new Error('DB touched for a guest'); } }) as D1Database;
    const res = await worker.fetch(post('/api/result/abcdef12-3456/visibility', { showPrompt: true }), { ...env, DB: db });
    expect(res.status).toBe(401);
  });
});

describe('a fenced JSON answer is the prompt failing, not our side failing', () => {
  // What Arjun hit on pg-a11: ```json fences made the validator's JSON.parse throw,
  // which used to count as an errored grader — run ineligible, and "that is our
  // side, not your prompt". It is the prompt's fault, and exactly what pg-a11 tests.
  it('stays leaderboard-eligible and simply fails', async () => {
    groq('```json\n["Lumen Starter", "Lumen Enterprise"]\n```');
    who.user = { uid: 'arjun', isAnonymous: false };
    const res = await worker.fetch(post('/api/run', { challengeId: 'pg-a11', prompt: 'x' }), env);
    const body = (await res.json()) as { leaderboardEligible: boolean; passed: boolean; tests: { status: string }[] };
    expect(body.leaderboardEligible).toBe(true);
    expect(body.passed).toBe(false);
    expect(body.tests.every((t) => t.status !== 'errored')).toBe(true);
  });
});
