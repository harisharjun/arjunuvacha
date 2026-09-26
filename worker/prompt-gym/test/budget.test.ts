import { describe, it, expect } from 'vitest';
import {
  budgetStatus,
  clientIp,
  consumeWindows,
  DEFAULT_PAID_BUDGET,
  DEFAULT_BUDGET,
  DEFAULT_RATE,
  FALLBACK_RUN_COST,
  limitsFromEnv,
  reserveBudget,
  runCost,
  type CounterStore,
} from '../src/budget';

/** A Map standing in for KV. Deliberately strongly consistent, unlike the real
 *  thing — these tests are about the arithmetic and the key shapes, not about
 *  modelling an eventually consistent store we have already decided to tolerate. */
function fakeKv() {
  const store = new Map<string, string>();
  const ttls = new Map<string, number>();
  const kv: CounterStore = {
    async get(key) {
      return store.get(key) ?? null;
    },
    async put(key, value, options) {
      store.set(key, value);
      if (options?.expirationTtl !== undefined) ttls.set(key, options.expirationTtl);
    },
  };
  return { kv, store, ttls };
}

const at = (iso: string) => new Date(iso);

describe('runCost', () => {
  it("takes the challenge's authoring-time estimate", () => {
    expect(runCost({ estimatedTokensPerRun: 2368 })).toBe(2368);
  });

  it('falls back to the high end when a challenge declares nothing', () => {
    expect(runCost(undefined)).toBe(FALLBACK_RUN_COST);
    expect(runCost({})).toBe(FALLBACK_RUN_COST);
  });

  // A zero or negative estimate would let a challenge run free forever.
  it('refuses a nonsense estimate and charges the fallback', () => {
    expect(runCost({ estimatedTokensPerRun: 0 })).toBe(FALLBACK_RUN_COST);
    expect(runCost({ estimatedTokensPerRun: -100 })).toBe(FALLBACK_RUN_COST);
    expect(runCost({ estimatedTokensPerRun: 'lots' })).toBe(FALLBACK_RUN_COST);
  });
});

describe('reserveBudget', () => {
  const limits = { perDay: 10_000, perMinute: 3_000 };
  /** For the day-limit tests, so a single large reservation is not silently
   *  deciding the outcome on the minute bucket instead. */
  const dayOnly = { perDay: 10_000, perMinute: 1_000_000 };

  it('accumulates spend across runs in the same day and minute', async () => {
    const { kv } = fakeKv();
    const now = at('2026-09-25T10:30:00Z');

    const first = await reserveBudget(kv, 1_000, limits, now);
    const second = await reserveBudget(kv, 1_000, limits, now);

    expect(first.ok && first.remainingToday).toBe(9_000);
    expect(second.ok && second.remainingToday).toBe(8_000);
  });

  it('refuses once the day is spent, and says when it resets', async () => {
    const { kv } = fakeKv();
    const now = at('2026-09-25T23:00:00Z');
    await reserveBudget(kv, 9_500, dayOnly, now);

    const verdict = await reserveBudget(kv, 1_000, dayOnly, now);
    expect(verdict.ok).toBe(false);
    expect(!verdict.ok && verdict.scope).toBe('day');
    // An hour of the UTC day left.
    expect(!verdict.ok && verdict.retryAfterSeconds).toBe(3_600);
  });

  it('refuses a minute that is already full, and resets on the next one', async () => {
    const { kv } = fakeKv();
    const busy = at('2026-09-25T10:30:30Z');
    await reserveBudget(kv, 2_500, limits, busy);

    const blocked = await reserveBudget(kv, 1_000, limits, busy);
    expect(!blocked.ok && blocked.scope).toBe('minute');
    expect(!blocked.ok && blocked.retryAfterSeconds).toBe(30);

    // The next clock minute is a different key, so it starts empty.
    const later = await reserveBudget(kv, 1_000, limits, at('2026-09-25T10:31:00Z'));
    expect(later.ok).toBe(true);
    // ...and the day counter carried over rather than resetting with it.
    expect(later.ok && later.remainingToday).toBe(6_500);
  });

  // A per-minute limit set below one challenge's cost must throttle the site,
  // never make that challenge permanently unplayable.
  it('always admits one run into an empty minute, however expensive', async () => {
    const { kv } = fakeKv();
    const tight = { perDay: 100_000, perMinute: 500 };
    const verdict = await reserveBudget(kv, 2_600, tight, at('2026-09-25T10:30:00Z'));
    expect(verdict.ok).toBe(true);
  });

  it('does not spend the budget on a run it refused', async () => {
    const { kv, store } = fakeKv();
    const now = at('2026-09-25T10:30:00Z');
    await reserveBudget(kv, 9_999, dayOnly, now);
    await reserveBudget(kv, 1_000, dayOnly, now);

    expect(store.get('budget:day:2026-09-25')).toBe('9999');
  });

  it('keys the day bucket by UTC date and the minute bucket to the minute', async () => {
    const { kv, store, ttls } = fakeKv();
    await reserveBudget(kv, 100, limits, at('2026-09-25T10:30:45Z'));

    expect([...store.keys()].sort()).toEqual(['budget:day:2026-09-25', 'budget:min:2026-09-25T10:30']);
    // A day counter written at 23:59 must still read back for the rest of its day.
    expect(ttls.get('budget:day:2026-09-25')).toBeGreaterThan(86_400);
  });

  it('treats a corrupt counter as empty rather than as unlimited or blocked', async () => {
    const { kv, store } = fakeKv();
    store.set('budget:day:2026-09-25', 'not-a-number');
    const verdict = await reserveBudget(kv, 1_000, limits, at('2026-09-25T10:30:00Z'));
    expect(verdict.ok).toBe(true);
    expect(store.get('budget:day:2026-09-25')).toBe('1000');
  });
});

describe('budgetStatus', () => {
  it('reports the remaining day allowance without spending any of it', async () => {
    const { kv, store } = fakeKv();
    const now = at('2026-09-25T10:30:00Z');
    await reserveBudget(kv, 2_000, { perDay: 10_000, perMinute: 9_000 }, now);

    const status = await budgetStatus(kv, { perDay: 10_000, perMinute: 9_000 }, now);
    expect(status).toEqual({ spentToday: 2_000, remainingToday: 8_000, perDay: 10_000 });
    expect(store.get('budget:day:2026-09-25')).toBe('2000');
  });
});

describe('consumeWindows', () => {
  const guest = [{ scope: 'hour' as const, limit: 5 }];
  const user = [
    { scope: 'minute' as const, limit: 3 },
    { scope: 'hour' as const, limit: 15 },
    { scope: 'day' as const, limit: 100 },
  ];

  it('gives a guest five runs an hour, then refuses with the limit and the wait', async () => {
    const { kv } = fakeKv();
    const now = at('2026-09-25T10:40:00Z');
    for (let i = 0; i < 5; i++) expect((await consumeWindows(kv, 'guest:1.2.3.4', guest, now)).ok).toBe(true);
    const sixth = await consumeWindows(kv, 'guest:1.2.3.4', guest, now);
    expect(sixth).toEqual({ ok: false, scope: 'hour', limit: 5, retryAfterSeconds: 20 * 60 });
  });

  it('holds a signed-in player to three a minute', async () => {
    const { kv } = fakeKv();
    const now = at('2026-09-25T10:30:15Z');
    for (let i = 0; i < 3; i++) await consumeWindows(kv, 'user:u', user, now);
    const r = await consumeWindows(kv, 'user:u', user, now);
    expect(!r.ok && r.scope).toBe('minute');
    expect(!r.ok && r.retryAfterSeconds).toBe(45);
  });

  it('keeps counting the hour across minutes, and refuses at fifteen', async () => {
    const { kv } = fakeKv();
    for (let m = 0; m < 5; m++) {
      for (let i = 0; i < 3; i++) await consumeWindows(kv, 'user:u', user, at(`2026-09-25T10:${10 + m}:00Z`));
    }
    const r = await consumeWindows(kv, 'user:u', user, at('2026-09-25T10:20:00Z'));
    expect(!r.ok && r.scope).toBe('hour');
  });

  it('refuses at a hundred in a day, even spread across hours', async () => {
    const { kv, store } = fakeKv();
    store.set('rl:user:u:day:2026-09-25', '100');
    const r = await consumeWindows(kv, 'user:u', user, at('2026-09-25T23:00:00Z'));
    expect(!r.ok && r.scope).toBe('day');
    expect(!r.ok && r.retryAfterSeconds).toBe(3600);
  });

  it('counts each subject separately', async () => {
    const { kv } = fakeKv();
    const now = at('2026-09-25T10:30:00Z');
    for (let i = 0; i < 5; i++) await consumeWindows(kv, 'guest:1.2.3.4', guest, now);
    expect((await consumeWindows(kv, 'guest:5.6.7.8', guest, now)).ok).toBe(true);
    expect((await consumeWindows(kv, 'user:u', user, now)).ok).toBe(true);
  });

  // A refused run must not also use up the allowance it was refused for.
  it('does not count a run it refused', async () => {
    const { kv, store } = fakeKv();
    const now = at('2026-09-25T10:30:00Z');
    for (let i = 0; i < 4; i++) await consumeWindows(kv, 'user:u', user, now);
    expect(store.get('rl:user:u:minute:2026-09-25T10:30')).toBe('3');
    expect(store.get('rl:user:u:hour:2026-09-25T10')).toBe('3');
  });
});

describe('budget pools', () => {
  it('keeps the Groq and OpenAI allowances apart', async () => {
    const { kv, store } = fakeKv();
    const now = at('2026-09-25T10:30:00Z');
    await reserveBudget(kv, 1000, { perDay: 10_000, perMinute: 9_000 }, now);
    await reserveBudget(kv, 2000, { perDay: 10_000, perMinute: 9_000 }, now, 'openai');
    expect(store.get('budget:day:2026-09-25')).toBe('1000');
    expect(store.get('budget-openai:day:2026-09-25')).toBe('2000');
  });

  it('refuses paid runs once the site-wide daily cap is spent', async () => {
    const { kv, store } = fakeKv();
    store.set('budget-openai:day:2026-09-25', String(DEFAULT_PAID_BUDGET.perDay));
    const r = await reserveBudget(kv, 500, DEFAULT_PAID_BUDGET, at('2026-09-25T10:30:00Z'), 'openai');
    expect(!r.ok && r.scope).toBe('day');
  });
});

describe('clientIp', () => {
  const withHeaders = (headers: Record<string, string>) =>
    new Request('https://worker.test/api/run', { headers });

  it('prefers the header Cloudflare sets, which a client cannot forge', () => {
    const req = withHeaders({ 'CF-Connecting-IP': '9.9.9.9', 'X-Forwarded-For': '1.1.1.1' });
    expect(clientIp(req)).toBe('9.9.9.9');
  });

  it('falls back to the first X-Forwarded-For hop', () => {
    expect(clientIp(withHeaders({ 'X-Forwarded-For': '1.1.1.1, 2.2.2.2' }))).toBe('1.1.1.1');
  });

  it('returns null when the request cannot be attributed', () => {
    expect(clientIp(withHeaders({}))).toBeNull();
  });
});

describe('limitsFromEnv', () => {
  it('uses the shipped defaults when nothing is configured', () => {
    expect(limitsFromEnv({})).toEqual({ budget: DEFAULT_BUDGET, paidBudget: DEFAULT_PAID_BUDGET, rate: DEFAULT_RATE });
  });

  it('reads overrides from wrangler vars, which arrive as strings', () => {
    const limits = limitsFromEnv({ BUDGET_TOKENS_PER_DAY: '50000', GUEST_RUNS_PER_HOUR: '2', OPENAI_TOKENS_PER_DAY: '999' });
    expect(limits.budget.perDay).toBe(50_000);
    expect(limits.rate.guestPerHour).toBe(2);
    expect(limits.paidBudget.perDay).toBe(999);
    expect(limits.budget.perMinute).toBe(DEFAULT_BUDGET.perMinute);
  });

  it('ignores a var that is not a positive number rather than disabling the limit', () => {
    const limits = limitsFromEnv({ BUDGET_TOKENS_PER_DAY: '0', USER_RUNS_PER_DAY: 'lots' });
    expect(limits.budget.perDay).toBe(DEFAULT_BUDGET.perDay);
    expect(limits.rate.userPerDay).toBe(DEFAULT_RATE.userPerDay);
  });

  it("ships Arjun's limits: guests 5/hour; signed-in 3/minute, 15/hour, 100/day", () => {
    expect(DEFAULT_RATE).toEqual({ guestPerHour: 5, userPerMinute: 3, userPerHour: 15, userPerDay: 100 });
  });

  // The defaults have to sit under Groq's published free-tier ceilings, or the
  // counter is decorative and Groq's own 429 is doing all the work.
  it('ships defaults below the 8K/minute and 200K/day free-tier ceilings', () => {
    expect(DEFAULT_BUDGET.perMinute).toBeLessThan(8_000);
    expect(DEFAULT_BUDGET.perDay).toBeLessThan(200_000);
  });
});
