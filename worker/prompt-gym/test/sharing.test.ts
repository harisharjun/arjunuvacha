import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Miniflare } from 'miniflare';
import schema1 from '../migrations/0001_initial.sql?raw';
import schema2 from '../migrations/0002_feedback.sql?raw';

/** Who the Worker thinks is calling, set per test. */
const who = vi.hoisted(() => ({ user: null as null | { uid: string; isAnonymous: boolean; name: string | null } }));
vi.mock('../src/auth/verify', () => ({
  userFromRequest: async () => ({
    user: who.user && { ...who.user, email: null, picture: null },
    error: undefined,
  }),
}));

import worker from '../src/index';

const statements = (sql: string) =>
  sql
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.split('\n').every((l) => l.trim().startsWith('--')));

let mf: Miniflare;
let db: D1Database;
let modelCalls: number;

const env = () => ({ GROQ_API_KEY: 'gsk_test', AIG_ACCOUNT: 'acc', AIG_GATEWAY: 'vani', DB: db });

const post = (path: string, body: unknown) =>
  new Request(`https://worker.test${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://arjunuvacha.com', Authorization: 'Bearer t' },
    body: JSON.stringify(body),
  });

interface RunBody {
  submissionId: string;
  cached: boolean;
  shareable: boolean;
  sharedToGallery: boolean;
}

const run = async (prompt = 'Label the ticket.') =>
  (await (await worker.fetch(post('/api/run', { challengeId: 'pg-a2', prompt }), env())).json()) as RunBody;

const share = (submissionId: string, on = true) =>
  worker.fetch(post(`/api/result/${submissionId}/visibility`, { showPrompt: on }), env());

const ownerOf = async (id: string) =>
  (await db.prepare('SELECT uid FROM submissions WHERE id = ?').bind(id).first<{ uid: string }>())?.uid;

beforeEach(async () => {
  mf = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok"); } };',
    d1Databases: { DB: ':memory:' },
  });
  db = (await mf.getD1Database('DB')) as unknown as D1Database;
  for (const s of [...statements(schema1), ...statements(schema2)]) await db.prepare(s).run();

  // The model: counted, so a test can prove a cached run called nothing.
  modelCalls = 0;
  const realFetch = globalThis.fetch;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('groq') || url.includes('gateway')) {
        modelCalls++;
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: 'billing' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 10, completion_tokens: 1 },
          }),
          { status: 200 },
        );
      }
      return realFetch(input, init);
    }),
  );

  who.user = { uid: 'meera', isAnonymous: false, name: 'Meera' };
});

afterEach(async () => {
  vi.unstubAllGlobals();
  who.user = null;
  await mf.dispose();
});

describe('whether a run can be shared', () => {
  it('can share a fresh run, which starts out unshared', async () => {
    const first = await run();
    expect(first.cached).toBe(false);
    expect(first.shareable).toBe(true);
    expect(first.sharedToGallery).toBe(false);
    expect((await share(first.submissionId)).status).toBe(200);
  });

  // The bug: re-running a passing prompt unchanged is what people do before
  // sharing it, and the cached result used to hide the share controls.
  it('can share a re-run served from the cache, as the same submission', async () => {
    const first = await run();
    const calls = modelCalls;
    const again = await run();

    expect(again.cached).toBe(true);
    expect(modelCalls).toBe(calls);
    expect(again.shareable).toBe(true);
    expect(again.submissionId).toBe(first.submissionId);
    expect((await share(again.submissionId)).status).toBe(200);
  });

  it('says a re-run is already shared when it is', async () => {
    const first = await run();
    await share(first.submissionId);
    const again = await run();
    expect(again.sharedToGallery).toBe(true);
  });

  // The cache is global. Two players can type the same prompt; the second must
  // still be able to publish it as their own, without borrowing the first's row.
  it("gives a player their own copy of someone else's cached run", async () => {
    who.user = { uid: 'rohan', isAnonymous: false, name: 'Rohan' };
    const rohans = await run();
    await share(rohans.submissionId);

    who.user = { uid: 'meera', isAnonymous: false, name: 'Meera' };
    const calls = modelCalls;
    const meeras = await run();

    expect(meeras.cached).toBe(true);
    expect(modelCalls).toBe(calls);
    expect(meeras.submissionId).not.toBe(rohans.submissionId);
    expect(await ownerOf(meeras.submissionId)).toBe('meera');
    // Rohan's share is his, not hers.
    expect(meeras.sharedToGallery).toBe(false);
    expect((await share(meeras.submissionId)).status).toBe(200);
    // And his row is untouched.
    expect(await ownerOf(rohans.submissionId)).toBe('rohan');
  });

  it('prefers the player’s own earlier row over anyone else’s', async () => {
    const meerasFirst = await run();
    who.user = { uid: 'rohan', isAnonymous: false, name: 'Rohan' };
    await run();

    who.user = { uid: 'meera', isAnonymous: false, name: 'Meera' };
    const again = await run();
    expect(again.submissionId).toBe(meerasFirst.submissionId);
  });

  it('cannot share a run made with no account at all', async () => {
    who.user = null;
    const anon = await run();
    expect(anon.shareable).toBe(false);
  });
});
