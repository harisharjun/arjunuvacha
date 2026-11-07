// ai-bulletin worker — stores and serves one AI news edition a day.
//
//   POST /ingest/edition   (ingest secret)  the whole edition -> { ok, date, cards }
//   GET  /bulletin/latest                -> the newest edition
//   GET  /bulletin/dates                  -> { dates: [...] }  for the archive nav
//   GET  /bulletin/threads                -> open storylines, for the producer
//   GET  /bulletin/:date                  -> that day's edition (YYYY-MM-DD)
//   POST /bulletin/feedback               { cardId, vote } | { missed, url? }
//   GET  /                                -> health
//
// This Worker does no curation and calls no model. It is the half of the system
// that does not change when the producer does: a Claude cloud routine writes the
// editions today, a coded pipeline will later, and both POST the same JSON here.
// See projects/ai-bulletin/ai-bulletin-design-doc.md §Build order.
//
// Sign-in is optional, unlike stonecross where every write needs an account.
// Anyone can read, anyone can thumb a card, and a visitor is counted by the
// browser id the page makes up; signing in just moves those votes onto the
// Firebase uid the games and PromptGym already use.
import { userFromRequest } from '../stonecross/verify.js';

const ALLOWED = [
  'https://arjunuvacha.com',
  'https://www.arjunuvacha.com',
  'https://arjunuvacha-3de80.web.app',
  'https://arjunuvacha-3de80.firebaseapp.com',
  'https://arjunuvacha-test.web.app',
  'https://arjunuvacha-test.firebaseapp.com',
];
const allowedOrigin = (o) =>
  !o || ALLOWED.includes(o) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o);

const cors = (origin) => ({
  'Access-Control-Allow-Origin': origin && allowedOrigin(origin) ? origin : ALLOWED[0],
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  // X-Browser-Id is how a guest's thumbs are counted. It is a custom header, so
  // the browser preflights every vote and names it here — leave it out and
  // voting fails in the browser while curl, which never preflights, passes.
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Browser-Id',
  'Vary': 'Origin',
});

// Editions are immutable once written, but `latest` changes daily and a thumb
// has to show up at once, so nothing here is cached at the edge.
const json = (data, status, origin) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors(origin) },
  });

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const KINDS = new Set(['lead', 'card', 'note']);
const CATEGORIES = new Set([
  'model-release', 'research', 'money', 'policy', 'security',
  'geopolitics', 'people', 'product', 'infra-chips', 'society',
]);
const REGIONS = new Set(['us', 'china', 'eu', 'uk', 'india', 'mena', 'apac', 'global']);

const str = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const int = (v, lo, hi) =>
  Number.isFinite(v) && v >= lo && v <= hi ? Math.round(v) : null;

// ───────────────────────────── reading an edition

/** An item as the page wants it, from an item as a producer sent it. */
function readItem(raw, i) {
  if (!raw || typeof raw !== 'object') return { error: `item ${i}: not an object` };
  const headline = str(raw.headline, 300);
  if (!headline) return { error: `item ${i}: headline` };
  const kind = KINDS.has(raw.kind) ? raw.kind : 'card';

  // Unknown enum values are dropped rather than refused. A producer inventing a
  // category should cost that one field, not the whole morning's edition.
  const category = CATEGORIES.has(raw.category) ? raw.category : null;
  const region = REGIONS.has(raw.region) ? raw.region : null;

  return {
    item: {
      kind,
      headline,
      sourceName: str(raw.sourceName, 120),
      sourceUrl: str(raw.sourceUrl, 2000),
      sourceTier: str(raw.sourceTier, 20),
      significance: int(raw.significance, 1, 10),
      hypeDiscount: int(raw.hypeDiscount, 0, 3),
      category,
      region,
      // The one line the model writes. Everything else on a card is quoted or
      // counted; this is the only generated prose on the page, which is why the
      // producer is told to ground it in the source and nothing else.
      whyItMatters: str(raw.whyItMatters, 400),
      threadSlug: str(raw.threadSlug, 80),
      threadPrevious: str(raw.threadPrevious, 300),
      corroboration: int(raw.corroboration, 0, 200),
      claimsToVerify: Array.isArray(raw.claimsToVerify)
        ? raw.claimsToVerify.map((c) => str(c, 240)).filter(Boolean).slice(0, 5)
        : [],
    },
  };
}

/** The whole edition. Returns { edition } or { error }. */
function readEdition(body) {
  if (!body || typeof body !== 'object') return { error: 'body' };
  const date = str(body.date, 10);
  if (!date || !DATE.test(date)) return { error: 'date must be YYYY-MM-DD' };

  const rawItems = Array.isArray(body.items) ? body.items : null;
  if (!rawItems) return { error: 'items must be an array' };
  if (!rawItems.length) return { error: 'items is empty' };
  if (rawItems.length > 40) return { error: 'too many items' };

  const items = [];
  for (let i = 0; i < rawItems.length; i++) {
    const { item, error } = readItem(rawItems[i], i);
    if (error) return { error };
    items.push(item);
  }
  if (items.filter((it) => it.kind === 'lead').length > 1)
    return { error: 'more than one lead' };

  return {
    edition: {
      date,
      throughLine: str(body.throughLine, 1200),
      quietDay: body.quietDay === true,
      llmEnriched: body.llmEnriched !== false,
      producer: str(body.producer, 40) ?? 'unknown',
      model: str(body.model, 80),
      stats: body.stats && typeof body.stats === 'object' ? body.stats : null,
      items,
    },
  };
}

// ───────────────────────────── D1

/**
 * Write an edition and its cards. Re-POSTing the same date replaces it, so a
 * producer that failed halfway can simply run again — and so a bad morning can
 * be corrected by hand without a deploy.
 */
async function saveEdition(db, ed) {
  const payload = {
    date: ed.date,
    throughLine: ed.throughLine,
    quietDay: ed.quietDay,
    llmEnriched: ed.llmEnriched,
    items: ed.items,
  };

  const stmts = [
    db.prepare('DELETE FROM cards WHERE edition_date = ?').bind(ed.date),
    db.prepare(
      `INSERT INTO editions (date, through_line, quiet_day, llm_enriched, producer, model, stats_json, payload_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(date) DO UPDATE SET
         through_line = excluded.through_line,
         quiet_day    = excluded.quiet_day,
         llm_enriched = excluded.llm_enriched,
         producer     = excluded.producer,
         model        = excluded.model,
         stats_json   = excluded.stats_json,
         payload_json = excluded.payload_json,
         updated_at   = datetime('now')`,
    ).bind(
      ed.date, ed.throughLine, ed.quietDay ? 1 : 0, ed.llmEnriched ? 1 : 0,
      ed.producer, ed.model, ed.stats ? JSON.stringify(ed.stats) : null,
      JSON.stringify(payload),
    ),
  ];

  ed.items.forEach((it, idx) => {
    stmts.push(
      db.prepare(
        `INSERT INTO cards (id, edition_date, idx, kind, headline, source_name, source_url,
                            source_tier, significance, hype_discount, category, region,
                            why_it_matters, thread_slug, corroboration)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        `${ed.date}:${idx}`, ed.date, idx, it.kind, it.headline, it.sourceName, it.sourceUrl,
        it.sourceTier, it.significance, it.hypeDiscount, it.category, it.region,
        it.whyItMatters, it.threadSlug, it.corroboration,
      ),
    );
  });

  // Touch every storyline this edition continued, so tomorrow's producer can see
  // what is already running and how recently it was covered.
  for (const slug of new Set(ed.items.map((it) => it.threadSlug).filter(Boolean))) {
    const title = ed.items.find((it) => it.threadSlug === slug)?.headline ?? slug;
    stmts.push(
      db.prepare(
        `INSERT INTO threads (slug, title, last_seen, n_items) VALUES (?, ?, datetime('now'), 1)
         ON CONFLICT(slug) DO UPDATE SET
           last_seen = datetime('now'),
           n_items   = threads.n_items + 1`,
      ).bind(slug, title),
    );
  }

  await db.batch(stmts);
  return stmts.length;
}

/** An edition with its vote counts folded in, ready for the page. */
async function editionFor(db, date) {
  const row = date
    ? await db.prepare('SELECT * FROM editions WHERE date = ?').bind(date).first()
    : await db.prepare('SELECT * FROM editions ORDER BY date DESC LIMIT 1').first();
  if (!row) return null;

  const { results: votes } = await db
    .prepare(
      `SELECT card_id, SUM(CASE WHEN vote > 0 THEN 1 ELSE 0 END) AS up,
                       SUM(CASE WHEN vote < 0 THEN 1 ELSE 0 END) AS down
       FROM feedback WHERE card_id LIKE ? || ':%' GROUP BY card_id`,
    )
    .bind(row.date)
    .all();

  const payload = JSON.parse(row.payload_json);
  const byId = Object.fromEntries((votes ?? []).map((v) => [v.card_id, v]));
  payload.items = payload.items.map((it, idx) => {
    const id = `${row.date}:${idx}`;
    return { ...it, id, up: byId[id]?.up ?? 0, down: byId[id]?.down ?? 0 };
  });
  payload.publishedAt = row.published_at;
  payload.producer = row.producer;
  return payload;
}

// ───────────────────────────── feedback

/**
 * Who is voting. A signed-in account wins, so that votes follow the person
 * across devices; otherwise the browser id the page generates, which is enough
 * to stop one visitor voting twice on the same card and is not pretending to be
 * anything stronger.
 */
async function voterFor(request, env) {
  const { user } = await userFromRequest(request, env).catch(() => ({ user: null }));
  if (user) return { voter: `uid:${user.uid}`, uid: user.uid };
  const bid = str(request.headers.get('X-Browser-Id'), 64);
  if (bid && /^[A-Za-z0-9_-]{8,64}$/.test(bid)) return { voter: `anon:${bid}`, uid: null };
  return { voter: null, uid: null };
}

// ───────────────────────────── HTTP

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors(origin) });

    // The ingest endpoint is called by a routine or a CI job, which send no
    // Origin, so the browser allowlist is checked only for the rest.
    const isIngest = url.pathname === '/ingest/edition';
    if (!isIngest && !allowedOrigin(origin)) return json({ error: 'origin' }, 403, origin);

    if (isIngest && request.method === 'POST') {
      // The one endpoint where a mistake is publicly visible: without this
      // check, anyone who finds the URL can publish an edition on the site.
      const secret = env.BULLETIN_INGEST_SECRET;
      const given = (request.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
      if (!secret) return json({ error: 'ingest_not_configured' }, 503, origin);
      if (given !== secret) return json({ error: 'unauthorized' }, 401, origin);

      const { edition, error } = readEdition(await request.json().catch(() => null));
      if (error) return json({ error }, 400, origin);
      await saveEdition(env.DB, edition);
      return json({ ok: true, date: edition.date, cards: edition.items.length }, 200, origin);
    }

    if (url.pathname === '/bulletin/latest' && request.method === 'GET') {
      const ed = await editionFor(env.DB, null);
      return ed ? json(ed, 200, origin) : json({ error: 'no_editions' }, 404, origin);
    }

    if (url.pathname === '/bulletin/dates' && request.method === 'GET') {
      const { results } = await env.DB
        .prepare('SELECT date, quiet_day FROM editions ORDER BY date DESC LIMIT 120')
        .all();
      return json({ dates: results ?? [] }, 200, origin);
    }

    // Read by the producer before it curates, so a storyline covered yesterday
    // is framed as a development and a minor one is left out.
    if (url.pathname === '/bulletin/threads' && request.method === 'GET') {
      const { results } = await env.DB
        .prepare(
          `SELECT slug, title, first_seen, last_seen, n_items FROM threads
           WHERE last_seen > datetime('now', '-90 days')
           ORDER BY last_seen DESC LIMIT 60`,
        )
        .all();
      return json({ threads: results ?? [] }, 200, origin);
    }

    if (url.pathname === '/bulletin/feedback' && request.method === 'POST') {
      const body = await request.json().catch(() => null);
      if (!body) return json({ error: 'body' }, 400, origin);
      const { voter, uid } = await voterFor(request, env);
      if (!voter) return json({ error: 'no_voter' }, 400, origin);

      // "What did I miss?" — the entry that makes a miss diagnosable later.
      const missed = str(body.missed, 1000);
      if (missed) {
        await env.DB
          .prepare('INSERT INTO regret (edition_date, text, url, uid, voter) VALUES (?, ?, ?, ?, ?)')
          .bind(str(body.date, 10), missed, str(body.url, 2000), uid, voter)
          .run();
        return json({ ok: true, kind: 'regret' }, 200, origin);
      }

      const cardId = str(body.cardId, 40);
      const vote = int(body.vote, -1, 1);
      if (!cardId || !vote) return json({ error: 'bad_vote' }, 400, origin);
      const card = await env.DB.prepare('SELECT id FROM cards WHERE id = ?').bind(cardId).first();
      if (!card) return json({ error: 'no_card' }, 404, origin);

      await env.DB
        .prepare(
          `INSERT INTO feedback (card_id, voter, vote, uid) VALUES (?, ?, ?, ?)
           ON CONFLICT(card_id, voter) DO UPDATE SET
             vote = excluded.vote, updated_at = datetime('now')`,
        )
        .bind(cardId, voter, vote, uid)
        .run();
      return json({ ok: true, kind: 'vote' }, 200, origin);
    }

    const m = url.pathname.match(/^\/bulletin\/(\d{4}-\d{2}-\d{2})$/);
    if (m && request.method === 'GET') {
      const ed = await editionFor(env.DB, m[1]);
      return ed ? json(ed, 200, origin) : json({ error: 'no_edition' }, 404, origin);
    }

    if (url.pathname === '/') return json({ ok: true, service: 'ai-bulletin' }, 200, origin);
    return json({ error: 'not found' }, 404, origin);
  },
};
