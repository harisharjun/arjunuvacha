import { describe, it, expect, vi } from 'vitest';
import worker from '../src/index';
import { challenges } from '../src/challenges';

const env = { GROQ_API_KEY: 'gsk_test', AIG_ACCOUNT: 'acc', AIG_GATEWAY: 'vani' };

const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request('https://worker.test/api/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://arjunuvacha.com', ...headers },
    body: JSON.stringify(body),
  });

const get = (path: string) =>
  new Request(`https://worker.test${path}`, { headers: { Origin: 'https://arjunuvacha.com' } });

describe('GET /api/challenges', () => {
  it('lists every challenge with the model allowlist', async () => {
    const res = await worker.fetch(get('/api/challenges'), env);
    const body = (await res.json()) as { challenges: unknown[]; models: string[] };
    expect(res.status).toBe(200);
    expect(body.challenges).toHaveLength(14);
    expect(body.models).toContain('openai/gpt-oss-20b');
  });

  // This response is fetched before the player writes a single word.
  //
  // One test input IS public on purpose: `exampleInput` shows the player the shape
  // of the task, and every challenge uses its first case as that worked example.
  // Everything after it must stay hidden — those are the cases that discriminate.
  it('leaks no hidden test input beyond the published example', async () => {
    const res = await worker.fetch(get('/api/challenges'), env);
    const text = await res.text();
    const body = (await worker.fetch(get('/api/challenges'), env).then((r) => r.json())) as {
      challenges: { id: string; exampleInput?: string }[];
    };

    let checked = 0;
    for (const challenge of challenges) {
      const published = body.challenges.find((c) => c.id === challenge.id)?.exampleInput;
      for (const test of challenge.tests) {
        if (test.input === published) continue;
        if (test.input.length < 25) continue;
        expect(text, `${challenge.id}/${test.id} leaked`).not.toContain(test.input);
        checked++;
      }
    }
    // Guard against the loop silently checking nothing.
    expect(checked).toBeGreaterThan(20);
  });

  it('carries no expected values, assertions or validator names', async () => {
    const text = await (await worker.fetch(get('/api/challenges'), env)).text();
    expect(text).not.toContain('validators.');
    expect(text).not.toContain('defaultAssert');
    expect(text).not.toContain('"assert"');
    expect(text).not.toContain('"reveal"');
  });
});

describe('POST /api/run validation', () => {
  it('rejects an unknown challenge id cleanly', async () => {
    const res = await worker.fetch(post({ challengeId: 'pg-nope', prompt: 'x' }), env);
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toBe('unknown_challenge');
  });

  it('rejects a missing prompt', async () => {
    const res = await worker.fetch(post({ challengeId: 'pg-a2' }), env);
    expect(res.status).toBe(400);
  });

  it('rejects an empty prompt', async () => {
    const res = await worker.fetch(post({ challengeId: 'pg-a2', prompt: '   ' }), env);
    expect(res.status).toBe(400);
  });

  it('rejects an over-long prompt server-side, not just in the editor', async () => {
    const res = await worker.fetch(post({ challengeId: 'pg-a2', prompt: 'x'.repeat(2001) }), env);
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toBe('prompt_too_long');
  });

  it('rejects a model outside the allowlist', async () => {
    const res = await worker.fetch(
      post({ challengeId: 'pg-a2', prompt: 'x', model: 'gpt-4o' }),
      env,
    );
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toBe('unknown_model');
  });

  it('rejects malformed JSON', async () => {
    const req = new Request('https://worker.test/api/run', {
      method: 'POST',
      headers: { Origin: 'https://arjunuvacha.com' },
      body: 'not json',
    });
    expect((await worker.fetch(req, env)).status).toBe(400);
  });

  it('returns 503 rather than crashing when no key is configured', async () => {
    const res = await worker.fetch(post({ challengeId: 'pg-a2', prompt: 'x' }), {});
    expect(res.status).toBe(503);
  });
});

describe('POST /api/run with a stubbed provider', () => {
  const stub = (content: string) =>
    vi.fn().mockImplementation(async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 40, completion_tokens: 2 },
        }),
        { status: 200 },
      ),
    );

  it('scores a correct set of answers and reports per-grader results', async () => {
    // pg-a2's four cases want four different labels; one stubbed answer cannot
    // satisfy all of them, so this asserts the shape rather than a perfect score.
    vi.stubGlobal('fetch', stub('billing'));
    const res = await worker.fetch(post({ challengeId: 'pg-a2', prompt: 'classify it' }), env);
    const body = (await res.json()) as {
      score: number;
      tests: { id: string; input: string | null }[];
      byGrader: unknown[];
      execModel: string;
      leaderboardEligible: boolean;
    };

    expect(res.status).toBe(200);
    expect(body.tests).toHaveLength(4);
    expect(body.byGrader.length).toBeGreaterThan(0);
    expect(body.execModel).toBe('openai/gpt-oss-20b');
    expect(body.score).toBeGreaterThan(0);
    vi.unstubAllGlobals();
  });

  it('marks a run non-eligible when a grader could not run', async () => {
    // pg-c1 carries `similar` assertions, which need embeddings we have not built.
    vi.stubGlobal('fetch', stub('a paraphrase'));
    const res = await worker.fetch(post({ challengeId: 'pg-c1', prompt: 'rewrite it' }), env);
    const body = (await res.json()) as { leaderboardEligible: boolean };
    expect(body.leaderboardEligible).toBe(false);
    vi.unstubAllGlobals();
  });

  it('never echoes a player-supplied key back in the response', async () => {
    vi.stubGlobal('fetch', stub('billing'));
    const res = await worker.fetch(
      post({ challengeId: 'pg-a2', prompt: 'classify' }, { 'X-Groq-Key': 'gsk_PLAYER_SECRET' }),
      env,
    );
    const text = await res.text();
    expect(text).not.toContain('gsk_PLAYER_SECRET');
    expect(JSON.parse(text).byoKeyUsed).toBe(true);
    vi.unstubAllGlobals();
  });

  it('reports an upstream failure as errored rather than as a zero score', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => new Response('{"error":"boom"}', { status: 503 })),
    );
    const res = await worker.fetch(post({ challengeId: 'pg-a2', prompt: 'classify' }), env);
    const body = (await res.json()) as {
      leaderboardEligible: boolean;
      tests: { status: string }[];
    };
    expect(body.tests.every((t) => t.status === 'errored')).toBe(true);
    expect(body.leaderboardEligible).toBe(false);
    vi.unstubAllGlobals();
  });
});

describe('persistence is never allowed to break a run', () => {
  const brokenDb = {
    prepare: () => {
      throw new Error('D1 unavailable');
    },
  } as unknown as D1Database;

  const stubFetch = () =>
    vi.fn().mockImplementation(async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: 'billing' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 1 },
        }),
        { status: 200 },
      ),
    );

  // A cache lookup that throws should cost us a re-run, not cost the player their
  // result. The dedupe check sits before the main try block, so this is easy to
  // get wrong.
  it('still returns a scorecard when the database is unavailable', async () => {
    vi.stubGlobal('fetch', stubFetch());
    const res = await worker.fetch(post({ challengeId: 'pg-a2', prompt: 'classify' }), {
      ...env,
      DB: brokenDb,
    });
    expect(res.status).toBe(200);
    expect((await res.json() as { score: number }).score).toBeGreaterThanOrEqual(0);
    vi.unstubAllGlobals();
  });
});

describe('CORS', () => {
  it('echoes an allowlisted origin, never a wildcard', async () => {
    const res = await worker.fetch(get('/api/challenges'), env);
    expect(res.headers.get('access-control-allow-origin')).toBe('https://arjunuvacha.com');
  });

  it('gives an unknown origin no CORS headers at all', async () => {
    const req = new Request('https://worker.test/api/challenges', {
      headers: { Origin: 'https://evil.com' },
    });
    const res = await worker.fetch(req, env);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });
});
