import { describe, it, expect } from 'vitest';
import { promptHash } from '../src/db/queries';

describe('promptHash', () => {
  it('is a 64-character hex SHA-256', async () => {
    const hash = await promptHash('pg-a2', 'classify it', 'openai/gpt-oss-20b');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is stable for the same inputs', async () => {
    const a = await promptHash('pg-a2', 'classify it', 'openai/gpt-oss-20b');
    const b = await promptHash('pg-a2', 'classify it', 'openai/gpt-oss-20b');
    expect(a).toBe(b);
  });

  // The same prompt on two models is two different runs and must not share a
  // cached result — the whole point of putting the model in the key.
  it('differs by model', async () => {
    const small = await promptHash('pg-a2', 'classify it', 'openai/gpt-oss-20b');
    const large = await promptHash('pg-a2', 'classify it', 'openai/gpt-oss-120b');
    expect(small).not.toBe(large);
  });

  it('differs by challenge', async () => {
    const a = await promptHash('pg-a2', 'same prompt', 'm');
    const b = await promptHash('pg-a1', 'same prompt', 'm');
    expect(a).not.toBe(b);
  });

  it('differs by prompt, including by whitespace', async () => {
    const a = await promptHash('pg-a2', 'classify it', 'm');
    const b = await promptHash('pg-a2', 'classify it ', 'm');
    expect(a).not.toBe(b);
  });

  // The separator matters: without it, ("pg-a2", "x") and ("pg-a", "2x") would
  // hash identically and two different runs would collide into one cached result.
  it('cannot be confused by field boundaries', async () => {
    const a = await promptHash('pg-a2', 'x', 'm');
    const b = await promptHash('pg-a', '2x', 'm');
    expect(a).not.toBe(b);
  });

  it('handles unicode without throwing', async () => {
    await expect(promptHash('pg-a2', 'categorise — naïve 日本語 🎯', 'm')).resolves.toMatch(
      /^[0-9a-f]{64}$/,
    );
  });
});
