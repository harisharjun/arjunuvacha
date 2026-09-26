import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Miniflare } from 'miniflare';
import schema1 from '../migrations/0001_initial.sql?raw';
import schema2 from '../migrations/0002_feedback.sql?raw';
import { feedbackEmail, parseFeedback, MAX_FEEDBACK_CHARS } from '../src/feedback';

/** Who the Worker thinks is calling, set per test. */
const who = vi.hoisted(() => ({
  user: null as null | { uid: string; isAnonymous: boolean; email: string | null; name: string | null },
}));
vi.mock('../src/auth/verify', () => ({
  userFromRequest: async () => ({ user: who.user && { ...who.user, picture: null }, error: undefined }),
}));

import worker from '../src/index';

const statements = (sql: string) =>
  sql
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.split('\n').every((l) => l.trim().startsWith('--')));

const RESEND_KEY = 're_SUPER_SECRET_KEY';
const ARJUN = 'arjun@example.test';

let mf: Miniflare;
let db: D1Database;
let sent: { url: string; auth: string | null; body: Record<string, unknown> }[];
let resendStatus: number;

const post = (body: unknown) =>
  new Request('https://worker.test/api/feedback', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://arjunuvacha.com', Authorization: 'Bearer t' },
    body: JSON.stringify(body),
  });

const env = () => ({ DB: db, RESEND_API_KEY: RESEND_KEY, FEEDBACK_TO: ARJUN });

const rows = async () =>
  (await db.prepare('SELECT * FROM feedback ORDER BY created_at').all<Record<string, unknown>>()).results;

beforeEach(async () => {
  mf = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok"); } };',
    d1Databases: { DB: ':memory:' },
  });
  db = (await mf.getD1Database('DB')) as unknown as D1Database;
  for (const s of [...statements(schema1), ...statements(schema2)]) await db.prepare(s).run();

  // Only Resend is intercepted; anything else goes where it was going.
  sent = [];
  resendStatus = 200;
  const realFetch = globalThis.fetch;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith('https://api.resend.com/')) {
        const headers = new Headers(init?.headers);
        sent.push({ url, auth: headers.get('Authorization'), body: JSON.parse(String(init?.body)) });
        return new Response('{"id":"email_1"}', { status: resendStatus });
      }
      return realFetch(input, init);
    }),
  );

  who.user = { uid: 'u-meera', isAnonymous: false, email: 'meera@example.test', name: 'Meera S' };
});

afterEach(async () => {
  vi.unstubAllGlobals();
  who.user = null;
  await mf.dispose();
});

describe('who may send feedback', () => {
  it('refuses a request with no token', async () => {
    who.user = null;
    const res = await worker.fetch(post({ message: 'hello' }), env());
    expect(res.status).toBe(401);
    expect(await rows()).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  // A guest has no address to reply to, and an anonymous account costs nothing to
  // mint — the combination is exactly an inbox-flooding tool.
  it('refuses a guest', async () => {
    who.user = { uid: 'g', isAnonymous: true, email: null, name: null };
    const res = await worker.fetch(post({ message: 'hello' }), env());
    expect(res.status).toBe(401);
    expect(await rows()).toHaveLength(0);
  });
});

describe('a signed-in player sending feedback', () => {
  it('is stored, emailed, and marked as notified', async () => {
    const res = await worker.fetch(
      post({ message: 'The run button did nothing on pg-a1.', page: '/prompt-gym/c/pg-a1', challengeId: 'pg-a1' }),
      env(),
    );
    expect(res.status).toBe(200);

    const [row] = await rows();
    expect(row).toMatchObject({
      uid: 'u-meera',
      email: 'meera@example.test',
      display_name: 'Meera S',
      message: 'The run button did nothing on pg-a1.',
      page: '/prompt-gym/c/pg-a1',
      challenge_id: 'pg-a1',
      notified: 1,
    });

    expect(sent).toHaveLength(1);
    expect(sent[0].auth).toBe(`Bearer ${RESEND_KEY}`);
    expect(sent[0].body).toMatchObject({
      to: [ARJUN],
      reply_to: 'meera@example.test',
      subject: 'PromptGym feedback from Meera S',
    });
    expect(sent[0].body.text).toContain('The run button did nothing on pg-a1.');
    expect(sent[0].body.text).toContain('https://arjunuvacha.com/prompt-gym/c/pg-a1');
    expect(sent[0].body.text).toContain('Pull out an address (pg-a1)');
  });

  // The whole reason the row is written first.
  it('keeps the message when the email fails, and says it was not notified', async () => {
    resendStatus = 500;
    const res = await worker.fetch(post({ message: 'Still here?' }), env());
    expect(res.status).toBe(200);
    const [row] = await rows();
    expect(row.message).toBe('Still here?');
    expect(row.notified).toBe(0);
  });

  it('stores without emailing when Resend is not configured', async () => {
    const res = await worker.fetch(post({ message: 'No key yet' }), { DB: db });
    expect(res.status).toBe(200);
    expect(await rows()).toHaveLength(1);
    expect(sent).toHaveLength(0);
  });

  it('never puts the Resend key in the response, even when sending fails', async () => {
    resendStatus = 401;
    const res = await worker.fetch(post({ message: 'x' }), env());
    expect(await res.text()).not.toContain(RESEND_KEY);
  });

  it('refuses an empty message and an over-long one', async () => {
    expect((await worker.fetch(post({ message: '   ' }), env())).status).toBe(400);
    const long = await worker.fetch(post({ message: 'x'.repeat(MAX_FEEDBACK_CHARS + 1) }), env());
    expect(long.status).toBe(400);
    expect(((await long.json()) as { error: string }).error).toBe('message_too_long');
    expect(await rows()).toHaveLength(0);
  });

  it('refuses malformed JSON', async () => {
    const req = new Request('https://worker.test/api/feedback', {
      method: 'POST',
      headers: { Origin: 'https://arjunuvacha.com' },
      body: 'not json',
    });
    expect((await worker.fetch(req, env())).status).toBe(400);
  });

  it('is rate limited per player when the counters are bound', async () => {
    const store = new Map<string, string>();
    const kv = {
      get: async (k: string) => store.get(k) ?? null,
      put: async (k: string, v: string) => void store.set(k, v),
    } as unknown as KVNamespace;

    for (let i = 0; i < 5; i++) {
      expect((await worker.fetch(post({ message: `m${i}` }), { ...env(), BUDGET: kv })).status).toBe(200);
    }
    const sixth = await worker.fetch(post({ message: 'm5' }), { ...env(), BUDGET: kv });
    expect(sixth.status).toBe(429);
    expect(await rows()).toHaveLength(5);
  });
});

describe('parseFeedback', () => {
  const known = (id: string) => id === 'pg-a1';

  it('keeps a page on this site and drops anything else', () => {
    const ok = parseFeedback({ message: 'm', page: '/prompt-gym/c/pg-a1' }, known);
    expect(ok.ok && ok.value.page).toBe('/prompt-gym/c/pg-a1');

    for (const page of ['https://evil.test/', '/elsewhere', '/prompt-gym/<script>', 42]) {
      const r = parseFeedback({ message: 'm', page }, known);
      expect(r.ok && r.value.page, String(page)).toBeNull();
    }
  });

  it('keeps only a challenge id that exists', () => {
    const r = parseFeedback({ message: 'm', challengeId: 'pg-nope' }, known);
    expect(r.ok && r.value.challengeId).toBeNull();
  });

  it('trims the message', () => {
    const r = parseFeedback({ message: '  hi  ' }, known);
    expect(r.ok && r.value.message).toBe('hi');
  });
});

describe('feedbackEmail', () => {
  const base = {
    id: 'f1',
    uid: 'u1',
    email: 'p@example.test',
    displayName: 'Pat',
    message: 'm',
    page: null,
    challengeId: null,
  };

  // A display name is chosen by the player on Google's side. It must not be able
  // to smuggle a second header line into the subject.
  it('keeps the subject to one line whatever the display name', () => {
    const mail = feedbackEmail({ ...base, displayName: 'Pat\r\nBcc: everyone@example.test' }, { from: 'f', to: 't' });
    expect(mail.subject).not.toMatch(/[\r\n]/);
  });

  it('has no reply-to when the token carried no email', () => {
    const mail = feedbackEmail({ ...base, email: null }, { from: 'f', to: 't' });
    expect('reply_to' in mail).toBe(false);
  });
});
