/** The shared-budget counter and the per-IP rate limits, both backed by KV.
 *
 *  Two different jobs that happen to share a store:
 *
 *  - The **budget** protects the one Groq key the whole site runs on. Groq's free
 *    tier gives us 8K tokens/minute and 200K tokens/day across every visitor
 *    combined (see `docs/groq-models.md`), so roughly 66 full runs a day. Once it
 *    is gone it is gone, and the honest answer is to say so and offer the player
 *    their own key — not to queue them behind a wall they cannot see.
 *  - The **rate limit** protects everything else from one client hammering it.
 *    It counts runs, not tokens, and applies to a player using their own key too:
 *    their key spares our budget, not our CPU.
 *
 *  KV is eventually consistent, so both counters undercount under concurrency and
 *  the real spend overshoots the limit slightly. That is deliberate and priced in
 *  — the limits below sit under Groq's actual ceilings precisely so the overshoot
 *  lands in the headroom. Do not build anything on these numbers being exact.
 *  (Durable Objects would be exact, and are not worth a paid plan here.) */

/** The slice of `KVNamespace` this module uses. Narrow on purpose: the tests hand
 *  in a plain Map-backed fake, and nothing here needs list/metadata/streaming. */
export interface CounterStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

export interface BudgetLimits {
  /** Tokens per UTC day across all visitors on the shared key. */
  perDay: number;
  /** Tokens per clock minute across all visitors on the shared key. */
  perMinute: number;
}

/** How many runs a caller may submit, by who they are.
 *
 *  Set by Arjun on 26 Sep 2026. Guests: 5 an hour, then the nudge to sign in.
 *  Signed-in players: 3 a minute, 15 an hour, 100 a day — generous for someone
 *  iterating on a prompt, and a ceiling on what one account can cost. */
export interface RateLimits {
  guestPerHour: number;
  userPerMinute: number;
  userPerHour: number;
  userPerDay: number;
}

/** Under Groq's 200K/day and 8K/minute, with room for the overshoot above and for
 *  the judge calls a challenge's `estimatedTokensPerRun` only approximates. */
export const DEFAULT_BUDGET: BudgetLimits = { perDay: 180_000, perMinute: 7_000 };

export const DEFAULT_RATE: RateLimits = { guestPerHour: 5, userPerMinute: 3, userPerHour: 15, userPerDay: 100 };

/** A site-wide daily cap on paid (OpenAI) tokens. Per-player limits do not stop
 *  someone opening ten Google accounts; this does. ~3M tokens is roughly $1-5 a
 *  day depending on the nano/mini mix. */
export const DEFAULT_PAID_BUDGET: BudgetLimits = { perDay: 3_000_000, perMinute: 1_000_000 };

/** Used when a challenge carries no `estimatedTokensPerRun`. Deliberately the
 *  high end of what the 14 shipped challenges cost, so an unmeasured challenge
 *  over-reserves rather than slipping through for free. */
export const FALLBACK_RUN_COST = 2_600;

const MINUTE = 60;
const HOUR = 3_600;
const DAY = 86_400;

/** Two days, so a day counter written at 23:59 still reads back correctly for the
 *  rest of its own day. KV's minimum TTL is 60s, which every value here clears. */
const DAY_TTL = 2 * DAY;

export type BudgetScope = 'day' | 'minute';
export type RateScope = 'minute' | 'hour' | 'day';

export type BudgetDecision =
  | { ok: true; cost: number; remainingToday: number }
  | { ok: false; scope: BudgetScope; retryAfterSeconds: number };

export type RateDecision =
  | { ok: true }
  | { ok: false; scope: RateScope; limit: number; retryAfterSeconds: number };

/** UTC throughout. A budget that resets at a time zone's midnight would reset at a
 *  different moment than Groq's own quota does, which is the one thing it has to
 *  agree with. */
/** A budget pool: Groq's shared free allowance, or the paid OpenAI one. */
export type BudgetPool = 'groq' | 'openai';

/** The Groq pool keeps its original key names, so counters written before the
 *  paid tier existed carry on. */
const POOL_PREFIX: Record<BudgetPool, string> = { groq: 'budget', openai: 'budget-openai' };

function dayKey(now: Date, pool: BudgetPool = 'groq'): string {
  return `${POOL_PREFIX[pool]}:day:${now.toISOString().slice(0, 10)}`;
}

function minuteKey(now: Date, pool: BudgetPool = 'groq'): string {
  return `${POOL_PREFIX[pool]}:min:${now.toISOString().slice(0, 16)}`;
}

function secondsLeftIn(period: number, now: Date): number {
  const elapsed = Math.floor(now.getTime() / 1000) % period;
  return period - elapsed;
}

async function readCount(kv: CounterStore, key: string): Promise<number> {
  const raw = await kv.get(key);
  if (raw === null) return 0;
  const n = Number(raw);
  // A corrupt value must not read as a licence to spend, nor as a permanent block.
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** The run's estimated token cost, from the challenge's own authoring-time figure. */
export function runCost(limits: Record<string, unknown> | undefined): number {
  const declared = limits?.estimatedTokensPerRun;
  return typeof declared === 'number' && declared > 0 ? Math.ceil(declared) : FALLBACK_RUN_COST;
}

/** Reserves `cost` tokens against both buckets, up front and without a refund.
 *
 *  Up front because a refund needs a second write on a path that has just spent
 *  20 seconds in Groq, and because reserving late is how you overspend. No refund
 *  on an errored run either: two concurrent refunds against an eventually
 *  consistent counter can credit back more than was ever spent, and a budget that
 *  can grow is not a budget. The cost of that choice is that a bad Groq afternoon
 *  eats the day's allowance — which is also true of Groq's own quota. */
export async function reserveBudget(
  kv: CounterStore,
  cost: number,
  limits: BudgetLimits,
  now: Date = new Date(),
  pool: BudgetPool = 'groq',
): Promise<BudgetDecision> {
  const keys = { day: dayKey(now, pool), minute: minuteKey(now, pool) };
  const [spentToday, spentThisMinute] = await Promise.all([
    readCount(kv, keys.day),
    readCount(kv, keys.minute),
  ]);

  if (spentToday + cost > limits.perDay) {
    return { ok: false, scope: 'day', retryAfterSeconds: secondsLeftIn(DAY, now) };
  }
  // An empty minute always admits one run, however expensive. Otherwise a
  // per-minute limit set below a single challenge's cost would make that challenge
  // permanently unplayable rather than merely slow — a misconfiguration should
  // throttle the site, not brick it.
  if (spentThisMinute > 0 && spentThisMinute + cost > limits.perMinute) {
    return { ok: false, scope: 'minute', retryAfterSeconds: secondsLeftIn(MINUTE, now) };
  }

  await Promise.all([
    kv.put(keys.day, String(spentToday + cost), { expirationTtl: DAY_TTL }),
    kv.put(keys.minute, String(spentThisMinute + cost), { expirationTtl: 2 * MINUTE }),
  ]);

  return { ok: true, cost, remainingToday: Math.max(0, limits.perDay - spentToday - cost) };
}

/** Reads the day counter without touching it, for the health route. */
export async function budgetStatus(
  kv: CounterStore,
  limits: BudgetLimits,
  now: Date = new Date(),
): Promise<{ spentToday: number; remainingToday: number; perDay: number }> {
  const spentToday = await readCount(kv, dayKey(now));
  return {
    spentToday,
    remainingToday: Math.max(0, limits.perDay - spentToday),
    perDay: limits.perDay,
  };
}

/** The client's IP as Cloudflare sees it.
 *
 *  `CF-Connecting-IP` is set by the edge and cannot be spoofed by the client;
 *  `X-Forwarded-For` can be, and is only a fallback for running behind something
 *  else locally. A request we cannot attribute is not rate limited — better to let
 *  an unidentifiable request through than to drop every such request into one
 *  shared bucket and have them throttle each other. */
export function clientIp(request: Request): string | null {
  const direct = request.headers.get('CF-Connecting-IP');
  if (direct) return direct.trim();
  const forwarded = request.headers.get('X-Forwarded-For');
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first;
  }
  return null;
}

const WINDOW: Record<RateScope, { seconds: number; stamp: number }> = {
  minute: { seconds: MINUTE, stamp: 16 },
  hour: { seconds: HOUR, stamp: 13 },
  day: { seconds: DAY, stamp: 10 },
};

/** Counts one run against every window given, for one subject — `guest:<ip>` or
 *  `user:<uid>`. Refuses, without counting, if any window is already full.
 *
 *  Counted before the result cache is consulted: a repeated prompt is still a
 *  submission, and a limit a replayed prompt could sidestep is not a limit. */
export async function consumeWindows(
  kv: CounterStore,
  subject: string,
  windows: { scope: RateScope; limit: number }[],
  now: Date = new Date(),
): Promise<RateDecision> {
  const stamp = now.toISOString();
  const keyed = windows.map((w) => ({ ...w, key: `rl:${subject}:${w.scope}:${stamp.slice(0, WINDOW[w.scope].stamp)}` }));
  const counts = await Promise.all(keyed.map((w) => readCount(kv, w.key)));

  for (let i = 0; i < keyed.length; i++) {
    if (counts[i] >= keyed[i].limit) {
      const { scope, limit } = keyed[i];
      return { ok: false, scope, limit, retryAfterSeconds: secondsLeftIn(WINDOW[scope].seconds, now) };
    }
  }

  await Promise.all(
    keyed.map((w, i) => kv.put(w.key, String(counts[i] + 1), { expirationTtl: 2 * WINDOW[w.scope].seconds })),
  );
  return { ok: true };
}

function positiveInt(value: unknown, fallback: number): number {
  const n = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export interface LimitEnv {
  BUDGET_TOKENS_PER_DAY?: string;
  BUDGET_TOKENS_PER_MINUTE?: string;
  OPENAI_TOKENS_PER_DAY?: string;
  GUEST_RUNS_PER_HOUR?: string;
  USER_RUNS_PER_MINUTE?: string;
  USER_RUNS_PER_HOUR?: string;
  USER_RUNS_PER_DAY?: string;
}

/** Limits are `[vars]` rather than constants so they can be retuned in
 *  `wrangler.toml` without a code change. */
export function limitsFromEnv(env: LimitEnv): {
  budget: BudgetLimits;
  paidBudget: BudgetLimits;
  rate: RateLimits;
} {
  return {
    budget: {
      perDay: positiveInt(env.BUDGET_TOKENS_PER_DAY, DEFAULT_BUDGET.perDay),
      perMinute: positiveInt(env.BUDGET_TOKENS_PER_MINUTE, DEFAULT_BUDGET.perMinute),
    },
    paidBudget: {
      perDay: positiveInt(env.OPENAI_TOKENS_PER_DAY, DEFAULT_PAID_BUDGET.perDay),
      perMinute: DEFAULT_PAID_BUDGET.perMinute,
    },
    rate: {
      guestPerHour: positiveInt(env.GUEST_RUNS_PER_HOUR, DEFAULT_RATE.guestPerHour),
      userPerMinute: positiveInt(env.USER_RUNS_PER_MINUTE, DEFAULT_RATE.userPerMinute),
      userPerHour: positiveInt(env.USER_RUNS_PER_HOUR, DEFAULT_RATE.userPerHour),
      userPerDay: positiveInt(env.USER_RUNS_PER_DAY, DEFAULT_RATE.userPerDay),
    },
  };
}
