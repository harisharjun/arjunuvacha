import { describe, it, expect, vi, afterEach } from 'vitest';
import worker from '../src/index';
import { reserveBudget, type CounterStore } from '../src/budget';

/** A Map standing in for the KV binding. */
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
  return { kv: kv as unknown as KVNamespace, store, counter: kv as CounterStore };
}

const base = { GROQ_API_KEY: 'gsk_house', AIG_ACCOUNT: 'acc', AIG_GATEWAY: 'vani' };

const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request('https://worker.test/api/run', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: 'https://arjunuvacha.com',
      'CF-Connecting-IP': '1.2.3.4',
      ...headers,
    },
    body: JSON.stringify(body),
  });

const stubGroq = () =>
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: 'billing' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 40, completion_tokens: 2 },
          }),
          { status: 200 },
        ),
    ),
  );

afterEach(() => vi.unstubAllGlobals());

describe('the shared budget', () => {
  it('spends the challenge-declared cost on a run', async () => {
    stubGroq();
    const { kv, store } = fakeKv();
    await worker.fetch(post({ challengeId: 'pg-a2', prompt: 'classify' }), { ...base, BUDGET: kv });

    // pg-a2 declares estimatedTokensPerRun: 1400.
    const day = [...store.entries()].find(([k]) => k.startsWith('budget:day:'));
    expect(day?.[1]).toBe('1400');
  });

  it('refuses with a typed BudgetExhausted once the day is gone', async () => {
    stubGroq();
    const { kv, store } = fakeKv();
    const env = { ...base, BUDGET: kv, BUDGET_TOKENS_PER_DAY: '1000' };

    const res = await worker.fetch(post({ challengeId: 'pg-a2', prompt: 'classify' }), env);
    const body = (await res.json()) as {
      error: string;
      scope: string;
      byoKeyAccepted: boolean;
      retryAfterSeconds: number;
      message: string;
    };

    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe(String(body.retryAfterSeconds));
    expect(body.error).toBe('budget_exhausted');
    expect(body.scope).toBe('day');
    // The SPA switches to BYO-key mode off this flag, so it is part of the contract.
    expect(body.byoKeyAccepted).toBe(true);
    expect(body.message).toMatch(/your own free Groq key/i);
    // Refused before any spend, and before Groq was ever called.
    expect([...store.keys()].some((k) => k.startsWith('budget:day:'))).toBe(false);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('lets a player with their own key straight past an exhausted budget', async () => {
    stubGroq();
    const { kv, counter } = fakeKv();
    const env = { ...base, BUDGET: kv, BUDGET_TOKENS_PER_DAY: '1000' };
    await reserveBudget(counter, 1_000, { perDay: 1_000, perMinute: 9_000 });

    const res = await worker.fetch(
      post({ challengeId: 'pg-a2', prompt: 'classify' }, { 'X-Groq-Key': 'gsk_PLAYER' }),
      env,
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { byoKeyUsed: boolean }).byoKeyUsed).toBe(true);
  });

  it('does not charge the shared budget for a BYO-key run', async () => {
    stubGroq();
    const { kv, store } = fakeKv();
    await worker.fetch(
      post({ challengeId: 'pg-a2', prompt: 'classify' }, { 'X-Groq-Key': 'gsk_PLAYER' }),
      { ...base, BUDGET: kv },
    );
    expect([...store.keys()].some((k) => k.startsWith('budget:'))).toBe(false);
  });

  // A cached run calls nothing, so refusing it for lack of quota would be a lie —
  // and charging it would be a second lie. Both need proving: an exhausted budget
  // hides an over-charge, because a refused reservation writes nothing either.
  const cachedRun = () => {
    const cached = {
      submissionId: 'abc',
      challengeId: 'pg-a2',
      score: 88,
      baseScore: 88,
      efficiencyBonus: 0,
      passed: true,
      execModel: 'openai/gpt-oss-20b',
      promptChars: 8,
      promptTokens: 2,
      leaderboardEligible: true,
      byGrader: [],
      tests: [],
    };
    return {
      prepare: () => ({
        bind: () => ({ first: async () => ({ id: 'abc', grader_results_json: JSON.stringify(cached) }) }),
      }),
    } as unknown as D1Database;
  };

  it('serves a deduped run even with the budget spent', async () => {
    stubGroq();
    const { kv } = fakeKv();
    const res = await worker.fetch(post({ challengeId: 'pg-a2', prompt: 'classify' }), {
      ...base,
      DB: cachedRun(),
      BUDGET: kv,
      BUDGET_TOKENS_PER_DAY: '1',
    });

    expect(res.status).toBe(200);
    expect(((await res.json()) as { cached: boolean }).cached).toBe(true);
  });

  it('charges a deduped run nothing, with the whole budget available', async () => {
    stubGroq();
    const { kv, store } = fakeKv();
    await worker.fetch(post({ challengeId: 'pg-a2', prompt: 'classify' }), {
      ...base,
      DB: cachedRun(),
      BUDGET: kv,
    });

    // The rate limit still counted this request; the budget must not have.
    expect([...store.keys()].some((k) => k.startsWith('budget:'))).toBe(false);
  });

  it('runs unguarded rather than refusing everyone when KV is not bound', async () => {
    stubGroq();
    const res = await worker.fetch(post({ challengeId: 'pg-a2', prompt: 'classify' }), base);
    expect(res.status).toBe(200);
  });

  it('runs unguarded rather than refusing everyone when KV throws', async () => {
    stubGroq();
    const broken = {
      get: async () => {
        throw new Error('KV unavailable');
      },
      put: async () => {},
    } as unknown as KVNamespace;

    const res = await worker.fetch(post({ challengeId: 'pg-a2', prompt: 'classify' }), {
      ...base,
      BUDGET: broken,
    });
    expect(res.status).toBe(200);
  });
});

describe('per-IP rate limits', () => {
  it('refuses a client that has run too many times this minute', async () => {
    stubGroq();
    const { kv } = fakeKv();
    const env = { ...base, BUDGET: kv, RATE_LIMIT_PER_MINUTE: '2' };

    await worker.fetch(post({ challengeId: 'pg-a2', prompt: 'one' }), env);
    await worker.fetch(post({ challengeId: 'pg-a2', prompt: 'two' }), env);
    const res = await worker.fetch(post({ challengeId: 'pg-a2', prompt: 'three' }), env);

    const body = (await res.json()) as { error: string; scope: string; retryAfterSeconds: number };
    expect(res.status).toBe(429);
    expect(body.error).toBe('rate_limited');
    expect(body.scope).toBe('minute');
    expect(res.headers.get('retry-after')).toBe(String(body.retryAfterSeconds));
  });

  // Their key pays Groq. It does not pay for our Worker's CPU or our D1 writes.
  it('applies to a BYO-key client too', async () => {
    stubGroq();
    const { kv } = fakeKv();
    const env = { ...base, BUDGET: kv, RATE_LIMIT_PER_MINUTE: '1' };
    const byo = { 'X-Groq-Key': 'gsk_PLAYER' };

    await worker.fetch(post({ challengeId: 'pg-a2', prompt: 'one' }, byo), env);
    const res = await worker.fetch(post({ challengeId: 'pg-a2', prompt: 'two' }, byo), env);

    expect(res.status).toBe(429);
    expect(((await res.json()) as { error: string }).error).toBe('rate_limited');
  });

  it("does not let one client's limit block another", async () => {
    stubGroq();
    const { kv } = fakeKv();
    const env = { ...base, BUDGET: kv, RATE_LIMIT_PER_MINUTE: '1' };

    await worker.fetch(post({ challengeId: 'pg-a2', prompt: 'one' }), env);
    const other = await worker.fetch(
      post({ challengeId: 'pg-a2', prompt: 'two' }, { 'CF-Connecting-IP': '9.9.9.9' }),
      env,
    );
    expect(other.status).toBe(200);
  });
});

describe("Groq's own 429 makes the same offer the budget would", () => {
  it('offers BYO-key mode when the shared key is the one being throttled', async () => {
    // Groq turning the house key away is the same wall as our own counter, one
    // layer down: the player's own key is the thing that clears either.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(
        async () =>
          // Kept at one second: the provider honours `retry-after` with a real
          // sleep before its single retry, and this test waits it out for real.
          new Response('{"error":"rate limit reached"}', {
            status: 429,
            headers: { 'retry-after': '1' },
          }),
      ),
    );

    const res = await worker.fetch(post({ challengeId: 'pg-a2', prompt: 'classify' }), base);
    const body = (await res.json()) as {
      error: string;
      byoKeyAccepted?: boolean;
      message: string;
    };

    expect(res.status).toBe(429);
    expect(body.error).toBe('upstream_rate_limited');
    expect(body.byoKeyAccepted).toBe(true);
    expect(body.message).toMatch(/your own free Groq key/i);
  });

  it('makes no such offer to a player who is already using their own key', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(
        async () =>
          new Response('{"error":"rate limit"}', { status: 429, headers: { 'retry-after': '1' } }),
      ),
    );

    const res = await worker.fetch(
      post({ challengeId: 'pg-a2', prompt: 'classify' }, { 'X-Groq-Key': 'gsk_PLAYER' }),
      base,
    );
    // Their own key is already the answer, so there is nothing to offer. They get
    // the ordinary errored scorecard, which says it was the provider's fault.
    const body = (await res.json()) as { byoKeyAccepted?: boolean; rateLimited?: boolean };
    expect(res.status).toBe(200);
    expect(body.byoKeyAccepted).toBeUndefined();
    expect(body.rateLimited).toBe(true);
  });

  // A partial throttle still produced real graded cases. Throwing those away to
  // show a banner would cost the player the run they already waited for.
  it('keeps a scorecard that only partly errored', async () => {
    let call = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => {
        call++;
        if (call > 1) {
          return new Response('{"error":"rate limit"}', { status: 429, headers: { 'retry-after': '1' } });
        }
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: 'billing' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 40, completion_tokens: 2 },
          }),
          { status: 200 },
        );
      }),
    );

    const res = await worker.fetch(post({ challengeId: 'pg-a2', prompt: 'classify' }), base);
    const body = (await res.json()) as { tests: { status: string }[]; leaderboardEligible: boolean };

    expect(res.status).toBe(200);
    expect(body.tests.some((t) => t.status !== 'errored')).toBe(true);
    expect(body.leaderboardEligible).toBe(false);
  });
});

describe("a player's own key never leaves the request", () => {
  const SECRET = 'gsk_PLAYER_SUPER_SECRET';

  it('is absent from a rate-limit refusal', async () => {
    stubGroq();
    const { kv } = fakeKv();
    const env = { ...base, BUDGET: kv, RATE_LIMIT_PER_MINUTE: '1' };
    const byo = { 'X-Groq-Key': SECRET };

    await worker.fetch(post({ challengeId: 'pg-a2', prompt: 'one' }, byo), env);
    const res = await worker.fetch(post({ challengeId: 'pg-a2', prompt: 'two' }, byo), env);
    expect(await res.text()).not.toContain(SECRET);
  });

  it("is absent from an upstream error, which can echo the request back", async () => {
    // Some provider error shapes include the request that caused them, Authorization
    // header and all. This is the shape that would leak it.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(
        async () =>
          new Response(JSON.stringify({ error: { message: `bad key ${SECRET}` } }), { status: 401 }),
      ),
    );

    const res = await worker.fetch(
      post({ challengeId: 'pg-a2', prompt: 'classify' }, { 'X-Groq-Key': SECRET }),
      base,
    );
    expect(await res.text()).not.toContain(SECRET);
  });

  it('is never written to the database — only the fact that one was used', async () => {
    stubGroq();
    const bound: unknown[][] = [];
    const db = {
      prepare: () => ({
        bind: (...args: unknown[]) => {
          bound.push(args);
          return { first: async () => null, run: async () => ({}), all: async () => ({ results: [] }) };
        },
      }),
    } as unknown as D1Database;

    await worker.fetch(
      post({ challengeId: 'pg-a2', prompt: 'classify' }, { 'X-Groq-Key': SECRET }),
      { ...base, DB: db },
    );

    expect(bound.length).toBeGreaterThan(0);
    expect(JSON.stringify(bound)).not.toContain(SECRET);
    // The boolean did get through, so this is not passing by writing nothing.
    expect(bound.some((args) => args.includes(1))).toBe(true);
  });

  it('is never written to the KV counters either', async () => {
    stubGroq();
    const { kv, store } = fakeKv();
    await worker.fetch(
      post({ challengeId: 'pg-a2', prompt: 'classify' }, { 'X-Groq-Key': SECRET }),
      { ...base, BUDGET: kv },
    );
    expect(JSON.stringify([...store.entries()])).not.toContain(SECRET);
  });
});

describe('GET /api/health', () => {
  it('reports the remaining shared allowance when KV is bound', async () => {
    const { kv, counter } = fakeKv();
    await reserveBudget(counter, 2_000, { perDay: 10_000, perMinute: 9_000 });

    const res = await worker.fetch(
      new Request('https://worker.test/api/health', { headers: { Origin: 'https://arjunuvacha.com' } }),
      { ...base, BUDGET: kv, BUDGET_TOKENS_PER_DAY: '10000' },
    );
    const body = (await res.json()) as { ok: boolean; budget: { remainingToday: number } | null };

    expect(body.ok).toBe(true);
    expect(body.budget?.remainingToday).toBe(8_000);
  });

  it('still answers when there is no counter to read', async () => {
    const res = await worker.fetch(
      new Request('https://worker.test/api/health', { headers: { Origin: 'https://arjunuvacha.com' } }),
      base,
    );
    expect(((await res.json()) as { ok: boolean; budget: null }).budget).toBeNull();
  });
});
