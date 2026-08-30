# Ask Arjun — RAG worker (Cloudflare + Groq, 100% free tier)

Pipeline: visitor question → **embed** (Cloudflare Workers AI) → **search** your
experience corpus (Cloudflare Vectorize) → **compose** a grounded answer (Groq).
Same architecture as vani's `gita-rag` worker — same account, same Groq key,
same AI Gateway. You only create one new Worker and one new Vectorize index.

## One-time setup (~10 min)

From this folder (`worker/arjun-rag/`) on your Mac:

```bash
# 0. wrangler is already installed from the vani setup; if not:
npm install -g wrangler && wrangler login

# 1. Create the vector index (768 dims matches bge-base-en-v1.5)
wrangler vectorize create arjun-index --dimensions=768 --metric=cosine

# 2. Deploy the worker
wrangler secret put GROQ_API_KEY     # paste the same gsk_… key vani uses
wrangler secret put SEED_TOKEN       # type any random string (remember it)
wrangler deploy
# → copy the URL it prints, e.g. https://arjun-rag.<you>.workers.dev

# 3. Seed the corpus (fast — ~60 chunks, under a minute)
WORKER_URL=https://arjun-rag.<you>.workers.dev SEED_TOKEN=yourtoken node push-seed.mjs
```

## Point the site at it

In `config.toml` (site root), set:

```toml
[params]
askArjunWorker = "https://arjun-rag.<you>.workers.dev"
```

Then `hugo && firebase deploy`. Until this is set, the chat automatically falls
back to the built-in curated Q&A (`data/askarjun.yaml`) — the widget never breaks.

## Test

- Visit the worker URL in a browser → JSON health check (`groqTest: "OK"`,
  `vectorMatches: 1` means everything works).
- On the site, ask something layered: *"How does he handle pushback from
  engineering?"* — you should get a grounded answer citing the Phable story.

## Updating your experience later

Edit or add md files in `corpus/` (each `## section` = one retrievable chunk,
keep sections under ~1,800 characters), then re-run step 3. Upserts overwrite
by id, so re-running is always safe.

## Notes

- Free tiers: Workers 100k req/day, Workers AI embeddings, Vectorize ≤50k
  vectors (we use ~60), Groq free tier.
- CORS is `*` for simplicity; to lock it down, change
  `Access-Control-Allow-Origin` in `worker.js` to `https://arjunuvacha.com`.
- This `worker/` folder is not published by Hugo — nothing here reaches the site.
