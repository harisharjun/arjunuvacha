import { describe, it, expect, vi, afterEach } from 'vitest';

/** Who the Worker thinks is calling, set per test. */
const who = vi.hoisted(() => ({ user: null as null | { uid: string; isAnonymous: boolean } }));
vi.mock('../src/auth/verify', () => ({
  userFromRequest: async () => ({
    user: who.user && { ...who.user, email: null, name: 'Test', picture: null },
    error: undefined,
  }),
}));

import worker from '../src/index';

/** A Map standing in for KV. */
function fakeKv() {
  const store = new Map<string, string>();
  const kv = {
    async get(key: string) {
      return store.get(key) ?? null;
    },
    async put(key: string, value: string) {
      store.set(key, value);
    },
  };
  return { kv: kv as unknown as KVNamespace, store };
}

const paid = { GROQ_API_KEY: 'gsk_house', OPENAI_API_KEY: 'sk-openai-house' };

const run = (challengeId: string, extra: Record<string, unknown> = {}) =>
  new Request('https://worker.test/api/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t', 'CF-Connecting-IP': '1.2.3.4' },
    body: JSON.stringify({ challengeId, prompt: `p ${Math.random()}`, ...extra }),
  });

/** Records every provider call: which host, which model, which key. */
function provider(content = 'billing') {
  const calls: { url: string; model: string; auth: string }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      calls.push({ url, model: body.model, auth: (init.headers as Record<string, string>).Authorization });
      return new Response(
        JSON.stringify({
          choices: [{ message: { content }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 2 },
        }),
        { status: 200 },
      );
    }),
  );
  return calls;
}

const signedIn = () => (who.user = { uid: 'arjun', isAnonymous: false });
const guest = () => (who.user = { uid: 'anon', isAnonymous: true });

afterEach(() => {
  vi.unstubAllGlobals();
  who.user = null;
});

describe('which model a player runs on', () => {
  it('runs a signed-in player on gpt-4.1-nano, through OpenAI, with the house OpenAI key', async () => {
    signedIn();
    const calls = provider();
    const res = await worker.fetch(run('pg-a2'), paid);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { execModel: string }).execModel).toBe('gpt-4.1-nano');
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      expect(c.url).toBe('https://api.openai.com/v1/chat/completions');
      expect(c.model).toBe('gpt-4.1-nano');
      expect(c.auth).toBe('Bearer sk-openai-house');
    }
  });

  it('runs a guest on Groq, never on the paid key', async () => {
    guest();
    const calls = provider();
    await worker.fetch(run('pg-a2'), paid);
    for (const c of calls) {
      expect(c.url).toContain('groq.com');
      expect(c.auth).toBe('Bearer gsk_house');
    }
  });

  it('offers gpt-4.1-mini on Hard, and defaults to it there', async () => {
    signedIn();
    provider('[PHONE]');
    const res = await worker.fetch(run('pg-b3'), paid);
    expect(((await res.json()) as { execModel: string }).execModel).toBe('gpt-4.1-mini');
    expect((await worker.fetch(run('pg-b3', { model: 'gpt-4.1-nano' }), paid)).status).toBe(200);
  });

  it('refuses gpt-4.1-mini below Hard', async () => {
    signedIn();
    provider();
    const res = await worker.fetch(run('pg-a2', { model: 'gpt-4.1-mini' }), paid);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'unknown_model', allowed: ['gpt-4.1-nano'] });
  });

  it('refuses a guest the paid models, and a signed-in player the Groq ones', async () => {
    provider();
    guest();
    expect((await worker.fetch(run('pg-a2', { model: 'gpt-4.1-nano' }), paid)).status).toBe(400);
    signedIn();
    expect((await worker.fetch(run('pg-a2', { model: 'openai/gpt-oss-20b' }), paid)).status).toBe(400);
  });

  // A missing secret should degrade the site, not lock every signed-in player out.
  it('falls back to Groq for signed-in players when no OpenAI key is configured', async () => {
    signedIn();
    const calls = provider();
    const res = await worker.fetch(run('pg-a2'), { GROQ_API_KEY: 'gsk_house' });
    expect(res.status).toBe(200);
    expect(calls.every((c) => c.url.includes('groq.com'))).toBe(true);
  });

  it('grades judged assertions with the pinned OpenAI judge, whatever the player chose', async () => {
    signedIn();
    // bug / P1 passes t1's cheap graders, so the judge genuinely runs on that case.
    const calls = provider('{"category":"bug","priority":"P1","summary":"Boards do not load for the whole workspace"}');
    await worker.fetch(run('pg-f1', { model: 'gpt-4.1-nano' }), paid);
    const judged = calls.filter((c) => c.model === 'gpt-4.1-mini');
    expect(calls.some((c) => c.model === 'gpt-4.1-nano')).toBe(true);
    expect(judged.length).toBeGreaterThan(0);
    expect(judged.every((c) => c.url.includes('api.openai.com'))).toBe(true);
    expect(calls.some((c) => c.url.includes('groq.com'))).toBe(false);
  });

  it('tells the page which models each challenge offers a signed-in player', async () => {
    const res = await worker.fetch(new Request('https://worker.test/api/challenges'), paid);
    const body = (await res.json()) as { guestModels: string[]; challenges: { id: string; difficulty: number; models: string[] }[] };
    expect(body.guestModels).toContain('openai/gpt-oss-20b');
    for (const c of body.challenges) {
      expect(c.models, c.id).toEqual(c.difficulty >= 4 ? ['gpt-4.1-mini', 'gpt-4.1-nano'] : ['gpt-4.1-nano']);
    }
  });
});

describe('signed-in submission limits', () => {
  it('allows three a minute, then refuses with how long to wait', async () => {
    signedIn();
    provider();
    const { kv } = fakeKv();
    const env = { ...paid, BUDGET: kv };
    for (let i = 0; i < 3; i++) expect((await worker.fetch(run('pg-a2'), env)).status).toBe(200);
    const res = await worker.fetch(run('pg-a2'), env);
    const body = (await res.json()) as { error: string; scope: string; limit: number; message: string };
    expect(res.status).toBe(429);
    expect(body).toMatchObject({ error: 'rate_limited', scope: 'minute', limit: 3 });
    expect(body.message).toMatch(/limit of 3 runs a minute/);
  });

  it('counts per account, so a new connection does not reset it', async () => {
    signedIn();
    provider();
    const { kv } = fakeKv();
    const env = { ...paid, BUDGET: kv, USER_RUNS_PER_MINUTE: '1' };
    await worker.fetch(run('pg-a2'), env);
    const elsewhere = new Request('https://worker.test/api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t', 'CF-Connecting-IP': '9.9.9.9' },
      body: JSON.stringify({ challengeId: 'pg-a2', prompt: 'another' }),
    });
    expect((await worker.fetch(elsewhere, env)).status).toBe(429);
  });

  it('never tells a signed-in player to sign in', async () => {
    signedIn();
    provider();
    const { kv } = fakeKv();
    const env = { ...paid, BUDGET: kv, USER_RUNS_PER_MINUTE: '1' };
    await worker.fetch(run('pg-a2'), env);
    const body = (await (await worker.fetch(run('pg-a2'), env)).json()) as { signInUnlocks?: boolean };
    expect(body.signInUnlocks).toBeUndefined();
  });

  it('charges paid runs to the OpenAI pool, not the shared Groq one', async () => {
    signedIn();
    provider();
    const { kv, store } = fakeKv();
    await worker.fetch(run('pg-a2'), { ...paid, BUDGET: kv });
    expect([...store.keys()].some((k) => k.startsWith('budget-openai:day:'))).toBe(true);
    expect([...store.keys()].some((k) => k.startsWith('budget:day:'))).toBe(false);
  });

  it('stops paid runs at the site-wide daily cap, without offering sign-in', async () => {
    signedIn();
    provider();
    const { kv } = fakeKv();
    const res = await worker.fetch(run('pg-a2'), { ...paid, BUDGET: kv, OPENAI_TOKENS_PER_DAY: '10' });
    const body = (await res.json()) as { error: string; signInUnlocks?: boolean };
    expect(res.status).toBe(429);
    expect(body.error).toBe('budget_exhausted');
    expect(body.signInUnlocks).toBeUndefined();
  });
});
