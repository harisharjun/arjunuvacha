import { describe, it, expect, vi } from 'vitest';
import { cosineSimilarity } from '../src/grading/text';
import { bindingEmbedder, restEmbedder, EMBEDDING_MODEL, type AiBinding } from '../src/providers/embeddings';
import { runChallenge } from '../src/run';
import { findChallenge } from '../src/challenges';

describe('cosineSimilarity', () => {
  it('is 1 for identical vectors and 0 for orthogonal ones', () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
  });

  it('is scale-invariant — direction is what carries the meaning', () => {
    expect(cosineSimilarity([1, 2, 3], [10, 20, 30])).toBeCloseTo(1);
  });

  // A cosine is in [-1, 1] but an assertion score is defined as 0-1.
  it('clamps an opposing vector to 0 rather than going negative', () => {
    expect(cosineSimilarity([1, 1], [-1, -1])).toBe(0);
  });

  it('returns 0 rather than NaN for a zero vector', () => {
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });

  it('returns 0 on a length mismatch instead of scoring a partial vector', () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2])).toBe(0);
    expect(cosineSimilarity([], [])).toBe(0);
  });
});

describe('bindingEmbedder', () => {
  it('calls the pinned model and returns the vectors', async () => {
    const run = vi.fn().mockResolvedValue({ data: [[1, 0], [0, 1]] });
    const vectors = await bindingEmbedder({ run } as AiBinding)(['a', 'b']);
    expect(run).toHaveBeenCalledWith(EMBEDDING_MODEL, { text: ['a', 'b'] });
    expect(vectors).toEqual([[1, 0], [0, 1]]);
  });

  // Silently returning fewer vectors than texts would misalign every assertion
  // with the wrong expected value — worse than failing.
  it('throws when the count does not match the input', async () => {
    const run = vi.fn().mockResolvedValue({ data: [[1, 0]] });
    await expect(bindingEmbedder({ run } as AiBinding)(['a', 'b'])).rejects.toThrow(/expected 2 vectors/);
  });

  it('throws on a malformed vector rather than scoring against NaN', async () => {
    const run = vi.fn().mockResolvedValue({ data: [[1, null], [0, 1]] });
    await expect(bindingEmbedder({ run } as AiBinding)(['a', 'b'])).rejects.toThrow(/malformed/);
  });
});

describe('restEmbedder', () => {
  it('posts to the account endpoint and unwraps result.data', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ result: { data: [[1, 0]] } }), { status: 200 }),
    );
    const vectors = await restEmbedder('acct123', 'cf_token', fetchImpl as unknown as typeof fetch)(['a']);
    expect(vectors).toEqual([[1, 0]]);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toContain('/accounts/acct123/ai/run/');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer cf_token');
  });

  // A Cloudflare error body can echo the request back, and the request carries
  // the token.
  it('never puts the response body — and so never the token — in the error', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ errors: [{ message: 'bad token cf_SECRET' }] }), { status: 403 }),
    );
    await expect(
      restEmbedder('acct', 'cf_SECRET', fetchImpl as unknown as typeof fetch)(['a']),
    ).rejects.toThrow(/^Workers AI returned 403$/);
  });
});

describe('similar assertions inside runChallenge', () => {
  const groqStub = (content: string) =>
    vi.fn().mockImplementation(async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 2 },
        }),
        { status: 200 },
      ),
    );

  /** Identical vectors for everything, so every similarity is 1.0. */
  const perfect = async (texts: string[]) => texts.map(() => [1, 0, 0]);
  /** Orthogonal to the output, so every similarity is 0. */
  const useless = async (texts: string[]) => texts.map((_, i) => (i === 0 ? [1, 0, 0] : [0, 1, 0]));

  it('stays non-eligible and pending when no embedder is supplied', async () => {
    vi.stubGlobal('fetch', groqStub('a paraphrase'));
    const r = await runChallenge({
      challenge: findChallenge('pg-c1')!,
      prompt: 'rewrite it',
      model: 'openai/gpt-oss-20b',
      apiKey: 'gsk_test',
    });
    expect(r.leaderboardEligible).toBe(false);
    vi.unstubAllGlobals();
  });

  it('becomes eligible once an embedder can run them', async () => {
    vi.stubGlobal('fetch', groqStub('a paraphrase'));
    const r = await runChallenge({
      challenge: findChallenge('pg-c1')!,
      prompt: 'rewrite it',
      model: 'openai/gpt-oss-20b',
      apiKey: 'gsk_test',
      embedder: perfect,
    });
    expect(r.leaderboardEligible).toBe(true);
    // `faithfulness` is not only the four `similar` assertions (weight 4 each) —
    // it also carries a `contains-any` on t3 (2) and a javascript check on t4 (4),
    // which the stubbed output genuinely fails. 16 of 22 is the whole metric
    // scoring exactly as it should with similarity pinned at 1.
    expect(r.byGrader.find((g) => g.metric === 'faithfulness')?.score).toBeCloseTo(16 / 22);
    vi.unstubAllGlobals();
  });

  it('scores faithfulness down when the output is unrelated', async () => {
    vi.stubGlobal('fetch', groqStub('something else entirely'));
    const r = await runChallenge({
      challenge: findChallenge('pg-c1')!,
      prompt: 'rewrite it',
      model: 'openai/gpt-oss-20b',
      apiKey: 'gsk_test',
      embedder: useless,
    });
    expect(r.byGrader.find((g) => g.metric === 'faithfulness')?.score).toBe(0);
    // Still eligible: the grader ran and the player genuinely scored badly.
    expect(r.leaderboardEligible).toBe(true);
    vi.unstubAllGlobals();
  });

  // An embeddings outage is our problem, not the player's.
  it('marks the run errored, not failed, when embedding throws', async () => {
    vi.stubGlobal('fetch', groqStub('a paraphrase'));
    const r = await runChallenge({
      challenge: findChallenge('pg-c1')!,
      prompt: 'rewrite it',
      model: 'openai/gpt-oss-20b',
      apiKey: 'gsk_test',
      embedder: async () => {
        throw new Error('Workers AI returned 500');
      },
    });
    expect(r.leaderboardEligible).toBe(false);
    vi.unstubAllGlobals();
  });

  it('embeds the output once per case, alongside every expected value', async () => {
    vi.stubGlobal('fetch', groqStub('a paraphrase'));
    const calls: string[][] = [];
    await runChallenge({
      challenge: findChallenge('pg-c1')!,
      prompt: 'rewrite it',
      model: 'openai/gpt-oss-20b',
      apiKey: 'gsk_test',
      embedder: async (texts) => {
        calls.push(texts);
        return texts.map(() => [1, 0, 0]);
      },
    });
    // pg-c1 has one `similar` per case, so each call is [output, expected].
    expect(calls.length).toBe(4);
    for (const c of calls) expect(c.length).toBe(2);
    vi.unstubAllGlobals();
  });
});
