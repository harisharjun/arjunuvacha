import { describe, it, expect, vi } from 'vitest';
import { execute, judge, groqBaseUrl } from '../src/providers/groq';
import {
  InvalidRequestError,
  JudgeError,
  RateLimitedError,
  UpstreamError,
  toOutcome,
} from '../src/providers/errors';

/** Builds a fake Groq response. The suite never touches the network: the live
 *  budget is small and the deployed site needs it. */
const ok = (content: string, usage = { prompt_tokens: 10, completion_tokens: 5 }) =>
  new Response(JSON.stringify({ choices: [{ message: { content } }], usage }), { status: 200 });

const status = (code: number, headers: Record<string, string> = {}) =>
  new Response('{"error":{"message":"nope","key":"gsk_SECRET_SHOULD_NOT_LEAK"}}', {
    status: code,
    headers,
  });

const base = {
  apiKey: 'gsk_test_key',
  model: 'openai/gpt-oss-20b',
  sleepImpl: async () => {},
};

describe('groqBaseUrl', () => {
  it('routes through the AI Gateway when configured', () => {
    expect(groqBaseUrl({ account: 'acc', gateway: 'vani' })).toBe(
      'https://gateway.ai.cloudflare.com/v1/acc/vani/groq',
    );
  });

  it('falls back to the direct API when it is not', () => {
    expect(groqBaseUrl()).toBe('https://api.groq.com/openai/v1');
    expect(groqBaseUrl({ account: 'acc' })).toBe('https://api.groq.com/openai/v1');
  });
});

describe('execute', () => {
  it('returns the message content and token usage', async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => ok('billing'));
    const r = await execute({ ...base, fetchImpl, prompt: 'classify', input: 'ticket' });
    expect(r.content).toBe('billing');
    expect(r.promptTokens).toBe(10);
    expect(r.completionTokens).toBe(5);
  });

  it('substitutes the prompt and input into the harness template', async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => ok('x'));
    await execute({ ...base, fetchImpl, prompt: 'MY PROMPT', input: 'MY INPUT' });
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.messages[0].content).toContain('MY PROMPT');
    expect(body.messages[0].content).toContain('MY INPUT');
  });

  it('always calls at temperature 0', async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => ok('x'));
    await execute({ ...base, fetchImpl, prompt: 'p', input: 'i' });
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).temperature).toBe(0);
  });

  it('applies the challenge max_tokens', async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => ok('x'));
    await execute({ ...base, fetchImpl, prompt: 'p', input: 'i', maxOutputTokens: 256 });
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).max_tokens).toBe(256);
  });

  it('rejects an over-long prompt without making any call at all', async () => {
    const fetchImpl = vi.fn();
    await expect(
      execute({ ...base, fetchImpl, prompt: 'x'.repeat(2001), input: 'i' }),
    ).rejects.toBeInstanceOf(InvalidRequestError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('accepts a prompt exactly at the cap', async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => ok('x'));
    await expect(
      execute({ ...base, fetchImpl, prompt: 'x'.repeat(2000), input: 'i' }),
    ).resolves.toBeTruthy();
  });

  it('sends the gateway authorisation header only when a token is set', async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => ok('x'));
    await execute({ ...base, fetchImpl, prompt: 'p', input: 'i' });
    expect(fetchImpl.mock.calls[0][1].headers['cf-aig-authorization']).toBeUndefined();

    await execute({
      ...base,
      fetchImpl,
      prompt: 'p',
      input: 'i',
      gateway: { account: 'a', gateway: 'g', token: 't' },
    });
    expect(fetchImpl.mock.calls[1][1].headers['cf-aig-authorization']).toBe('Bearer t');
  });
});

describe('rate limiting', () => {
  it('retries exactly once after a 429, then succeeds', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(status(429, { 'retry-after': '1' }))
      .mockResolvedValueOnce(ok('recovered'));
    const r = await execute({ ...base, fetchImpl, prompt: 'p', input: 'i' });
    expect(r.content).toBe('recovered');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('throws RateLimitedError when the retry is also rate limited', async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => status(429, { 'retry-after': '2' }));
    const err = await execute({ ...base, fetchImpl, prompt: 'p', input: 'i' }).catch((e) => e);
    expect(err).toBeInstanceOf(RateLimitedError);
    expect(err.retryAfterSeconds).toBe(2);
    // Exactly one retry — not a loop that burns the daily budget.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('waits the retry-after interval, capped so a request cannot hang for minutes', async () => {
    const sleepImpl = vi.fn().mockResolvedValue(undefined);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(status(429, { 'retry-after': '9999' }))
      .mockResolvedValueOnce(ok('x'));
    await execute({ ...base, sleepImpl, fetchImpl, prompt: 'p', input: 'i' });
    expect(sleepImpl.mock.calls[0][0]).toBeLessThanOrEqual(10_000);
  });

  it('still retries when no retry-after header is sent', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(status(429)).mockResolvedValueOnce(ok('x'));
    await expect(execute({ ...base, fetchImpl, prompt: 'p', input: 'i' })).resolves.toBeTruthy();
  });
});

describe('upstream failures', () => {
  it('treats 5xx as UpstreamError', async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => status(503));
    const err = await execute({ ...base, fetchImpl, prompt: 'p', input: 'i' }).catch((e) => e);
    expect(err).toBeInstanceOf(UpstreamError);
    expect(err.status).toBe(503);
  });

  it('treats a network failure as UpstreamError', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('socket hang up'));
    await expect(execute({ ...base, fetchImpl, prompt: 'p', input: 'i' })).rejects.toBeInstanceOf(
      UpstreamError,
    );
  });

  it('treats an abort as a timeout, not a failing prompt', async () => {
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const fetchImpl = vi.fn().mockRejectedValue(abort);
    const err = await execute({ ...base, fetchImpl, prompt: 'p', input: 'i' }).catch((e) => e);
    expect(err).toBeInstanceOf(UpstreamError);
    expect(err.message).toMatch(/timed out/i);
  });

  it('fails cleanly when the body is not JSON', async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => new Response('<html>502</html>', { status: 200 }));
    await expect(execute({ ...base, fetchImpl, prompt: 'p', input: 'i' })).rejects.toBeInstanceOf(
      UpstreamError,
    );
  });

  // The whole reason errors carry status codes and not bodies.
  it('never leaks the upstream body, which can echo the API key', async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => status(500));
    const err = await execute({ ...base, fetchImpl, prompt: 'p', input: 'i' }).catch((e) => e);
    expect(err.message).not.toContain('gsk_');
    expect(JSON.stringify(err)).not.toContain('gsk_');
    expect(err.message).not.toContain('nope');
  });
});

describe('judge', () => {
  it('parses a pass/fail verdict', async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => ok('{"pass": true, "reason": "faithful"}'));
    const v = await judge({ ...base, fetchImpl, output: 'o', rubric: 'r' });
    expect(v).toEqual({ pass: true, reason: 'faithful' });
  });

  it('parses a score verdict', async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => ok('{"score": 0.8, "reason": "mostly"}'));
    const v = await judge({ ...base, fetchImpl, output: 'o', rubric: 'r', wantScore: true });
    expect(v).toEqual({ score: 0.8, reason: 'mostly' });
  });

  it('retries once with a stricter instruction when the reply is unparseable', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(ok('Sure! Here you go: {"pass": true}'))
      .mockResolvedValueOnce(ok('{"pass": false, "reason": "no"}'));
    const v = await judge({ ...base, fetchImpl, output: 'o', rubric: 'r' });
    expect(v).toEqual({ pass: false, reason: 'no' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchImpl.mock.calls[1][1].body).messages[0].content).toMatch(
      /could not be parsed/i,
    );
  });

  it('throws JudgeError after the retry also fails to parse', async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => ok('still prose'));
    await expect(judge({ ...base, fetchImpl, output: 'o', rubric: 'r' })).rejects.toBeInstanceOf(
      JudgeError,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('rejects a verdict missing both pass and score', async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => ok('{"reason": "no verdict here"}'));
    await expect(judge({ ...base, fetchImpl, output: 'o', rubric: 'r' })).rejects.toBeInstanceOf(
      JudgeError,
    );
  });
});

describe('errored is structurally distinct from failed', () => {
  it('an errored outcome carries no output to be scored', () => {
    const outcome = toOutcome(new UpstreamError('Groq returned 500', 500));
    expect(outcome.status).toBe('errored');
    expect('output' in outcome).toBe(false);
  });

  it('an invalid request is the user’s fault, so it is not errored', () => {
    expect(new InvalidRequestError('too long').errored).toBe(false);
    expect(new UpstreamError('boom').errored).toBe(true);
    expect(new RateLimitedError('slow down').errored).toBe(true);
    expect(new JudgeError('unparseable').errored).toBe(true);
  });

  it('an unrecognised throw is still errored rather than silently scored', () => {
    const outcome = toOutcome(new TypeError('something odd'));
    expect(outcome.status).toBe('errored');
    expect(outcome.kind).toBe('upstream');
  });
});
