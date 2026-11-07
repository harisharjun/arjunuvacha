// AI Bulletin — reads one edition from the ai-bulletin Worker and renders it.
//
// There is no curation in here and no model call: the page is a reader. What
// produced the edition (a Claude cloud routine today, a coded pipeline later) is
// invisible from here apart from the pill in the top bar, which is the point —
// see projects/ai-bulletin/ai-bulletin-design-doc.md §Build order.

// Served from localhost while developing, so talk to `wrangler dev` rather than
// the deployed Worker. The staging site talks to the staging Worker. `?api=`
// overrides all of it. Same shape as static/prompt-gym/app.js.
const API =
  new URLSearchParams(location.search).get('api') ??
  (location.hostname === 'localhost' || location.hostname === '127.0.0.1'
    ? 'http://localhost:8787'
    : location.hostname.startsWith('arjunuvacha-test.')
      ? 'https://ai-bulletin-staging.harisharjun127.workers.dev'
      : 'https://ai-bulletin.harisharjun127.workers.dev');

const BASE = '/ai-bulletin';
const $ = (id) => document.getElementById(id);

// Enough to stop one visitor thumbing the same card twice, and no more than
// that. Sign-in is not required to read or to vote; when the site-wide sign-in
// is wired in here later, a uid simply takes precedence (see voterFor in the
// Worker). Storage can throw in a private window, so none of it is trusted.
function browserId() {
  try {
    let id = localStorage.getItem('ab:bid');
    if (!id) {
      id = crypto.randomUUID().replace(/-/g, '').slice(0, 24);
      localStorage.setItem('ab:bid', id);
    }
    return id;
  } catch {
    return null;
  }
}

/** This browser's own votes, so the buttons come back pressed on a reload. */
const myVotes = {
  read() {
    try { return JSON.parse(localStorage.getItem('ab:votes') ?? '{}'); } catch { return {}; }
  },
  set(cardId, vote) {
    try {
      const all = myVotes.read();
      if (vote) all[cardId] = vote; else delete all[cardId];
      localStorage.setItem('ab:votes', JSON.stringify(all));
    } catch { /* private window: the vote still reached the Worker */ }
  },
};

const headers = () => {
  const h = { 'Content-Type': 'application/json' };
  const bid = browserId();
  if (bid) h['X-Browser-Id'] = bid;
  return h;
};

// ───────────────────────────── rendering

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

const CATEGORY_LABEL = {
  'model-release': 'model release', research: 'research', money: 'money', policy: 'policy',
  security: 'security', geopolitics: 'geopolitics', people: 'people', product: 'product',
  'infra-chips': 'chips & infra', society: 'society',
};
const REGION_LABEL = {
  us: 'US', china: 'China', eu: 'EU', uk: 'UK', india: 'India',
  mena: 'MENA', apac: 'APAC', global: 'global',
};

const prettyDate = (iso) => {
  const d = new Date(`${iso}T00:00:00`);
  return Number.isNaN(d.valueOf())
    ? iso
    : d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
};

function cardNode(item) {
  const card = el('article', `card${item.kind === 'lead' ? ' lead' : ''}`);

  const meta = el('div', 'card-meta');
  if (item.category) meta.append(el('span', 'tag', CATEGORY_LABEL[item.category] ?? item.category));
  if (item.region) meta.append(el('span', 'tag region', REGION_LABEL[item.region] ?? item.region));
  if (item.significance != null) {
    // The adjusted score — hype discount already taken off — because that is the
    // number the story was actually ranked on.
    const adjusted = Math.max(1, item.significance - (item.hypeDiscount ?? 0));
    const sig = el('span', `sig${adjusted >= 8 ? ' high' : ''}`, `significance ${adjusted}/10`);
    if (item.hypeDiscount) sig.title = `${item.significance}/10, less ${item.hypeDiscount} for announcement-not-event`;
    meta.append(sig);
  }
  if (item.corroboration >= 2) meta.append(el('span', 'tag', `${item.corroboration} outlets`));
  if (meta.childElementCount) card.append(meta);

  card.append(el('h3', null, item.headline));

  if (item.whyItMatters) card.append(el('p', 'why', item.whyItMatters));

  if (item.threadPrevious) {
    const t = el('p', 'thread');
    t.append(el('b', null, 'Previously: '), document.createTextNode(item.threadPrevious));
    card.append(t);
  }

  if (item.claimsToVerify?.length) {
    card.append(el('p', 'claims', `Unverified by anyone but the source: ${item.claimsToVerify.join('; ')}`));
  }

  const foot = el('div', 'card-foot');
  if (item.sourceUrl) {
    const a = el('a', 'src', item.sourceName ? `${item.sourceName} ↗` : 'Read the source ↗');
    a.href = item.sourceUrl;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    foot.append(a);
  } else if (item.sourceName) {
    foot.append(el('span', 'src', item.sourceName));
  }

  const mine = myVotes.read()[item.id];
  const votes = el('div', 'votes');
  for (const [vote, glyph] of [[1, '👍'], [-1, '👎']]) {
    const b = el('button', `vote${mine === vote ? ' on' : ''}`);
    b.type = 'button';
    b.textContent = vote > 0 ? `${glyph} ${item.up || ''}`.trim() : `${glyph} ${item.down || ''}`.trim();
    b.setAttribute('aria-label', vote > 0 ? 'Worth my time' : 'Not worth my time');
    b.addEventListener('click', () => sendVote(item, vote, votes));
    votes.append(b);
  }
  foot.append(votes);
  card.append(foot);

  return card;
}

/** Optimistic: the button flips at once, and a failure flips it back. */
async function sendVote(item, vote, container) {
  const was = myVotes.read()[item.id];
  const next = was === vote ? null : vote;
  myVotes.set(item.id, next);
  [...container.children].forEach((b, i) => {
    b.classList.toggle('on', next === (i === 0 ? 1 : -1));
  });
  if (!next) return; // Un-voting is local only; the Worker keeps the last vote.

  try {
    const res = await fetch(`${API}/bulletin/feedback`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ cardId: item.id, vote: next }),
    });
    if (!res.ok) throw new Error(String(res.status));
  } catch {
    myVotes.set(item.id, was ?? null);
    [...container.children].forEach((b, i) => {
      b.classList.toggle('on', was === (i === 0 ? 1 : -1));
    });
  }
}

function render(ed) {
  $('date').textContent = prettyDate(ed.date);
  $('through-line').textContent = ed.throughLine ?? '';

  if (ed.quietDay) {
    $('headline').textContent = 'A quiet day in AI';
  }

  // An edition the producer could not get model judgment for is marked, not
  // dressed up: the cards are still ranked, just not explained.
  const pill = $('producer-pill');
  if (ed.llmEnriched === false) {
    pill.textContent = 'ranked without judgment';
    pill.className = 'pill warn';
    pill.hidden = false;
  }

  const s = ed.stats ?? {};
  const bits = [];
  if (s.storiesConsidered) bits.push(`${s.storiesConsidered} stories considered`);
  if (s.sources) bits.push(`${s.sources} sources`);
  const shown = ed.items.filter((i) => i.kind !== 'note').length;
  bits.push(`${shown} made the page`);
  $('stats').textContent = bits.join(' · ');

  const cards = $('cards');
  cards.replaceChildren();
  const notes = [];
  for (const item of ed.items) {
    if (item.kind === 'note') notes.push(item);
    else cards.append(cardNode(item));
  }

  if (notes.length) {
    const ul = $('notes');
    ul.replaceChildren();
    for (const n of notes) {
      const li = el('li');
      if (n.sourceUrl) {
        const a = el('a', null, n.headline);
        a.href = n.sourceUrl;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        li.append(a);
      } else li.append(document.createTextNode(n.headline));
      if (n.sourceName) li.append(el('span', 'muted tiny', ` — ${n.sourceName}`));
      ul.append(li);
    }
    $('notes-wrap').hidden = false;
  }

  $('loading').hidden = true;
  $('edition').hidden = false;
}

async function loadArchive(current) {
  try {
    const res = await fetch(`${API}/bulletin/dates`);
    if (!res.ok) return;
    const { dates } = await res.json();
    if (!dates?.length) return;
    const sel = $('archive');
    sel.replaceChildren();
    for (const d of dates) {
      const o = el('option', null, prettyDate(d.date));
      o.value = d.date;
      if (d.date === current) o.selected = true;
      sel.append(o);
    }
    sel.hidden = false;
    sel.addEventListener('change', () => {
      // A real URL per edition, so a day can be linked to. Firebase rewrites
      // every path under /ai-bulletin/** to index.html.
      history.pushState({}, '', `${BASE}/${sel.value}`);
      load();
    });
  } catch { /* the archive is a convenience; the edition matters more */ }
}

async function load() {
  $('edition').hidden = true;
  $('empty').hidden = true;
  $('failed').hidden = true;
  $('loading').hidden = false;

  // /ai-bulletin/2026-11-06 reads that day; /ai-bulletin/ reads the newest.
  const m = location.pathname.match(/(\d{4}-\d{2}-\d{2})/);
  const path = m ? `/bulletin/${m[1]}` : '/bulletin/latest';

  try {
    const res = await fetch(`${API}${path}`);
    if (res.status === 404) {
      $('loading').hidden = true;
      $('empty').hidden = false;
      return;
    }
    if (!res.ok) throw new Error(String(res.status));
    const ed = await res.json();
    render(ed);
    loadArchive(ed.date);
  } catch {
    $('loading').hidden = true;
    $('failed').hidden = false;
  }
}

$('send-missed').addEventListener('click', async () => {
  const box = $('missed');
  const text = box.value.trim();
  if (!text) return;
  const btn = $('send-missed');
  btn.disabled = true;
  const said = $('missed-said');

  // A URL typed anywhere in the note is pulled out so the entry is actionable
  // later without re-reading the prose.
  const url = text.match(/https?:\/\/\S+/)?.[0] ?? null;
  const m = location.pathname.match(/(\d{4}-\d{2}-\d{2})/);

  try {
    const res = await fetch(`${API}/bulletin/feedback`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ missed: text, url, date: m?.[1] ?? null }),
    });
    if (!res.ok) throw new Error(String(res.status));
    box.value = '';
    said.textContent = 'Logged — thank you. That is how the ranking gets fixed.';
    said.className = 'small muted';
  } catch {
    said.textContent = "Couldn't send that. Try again in a moment?";
    said.className = 'small';
  }
  said.hidden = false;
  btn.disabled = false;
});

addEventListener('popstate', load);
load();
