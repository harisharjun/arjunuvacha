# PromptGym — where it goes in the arjunuvacha repo

**Short answer: inside `arjunuvacha`, following the convention you already established with Tax Copilot.** You have built this shape twice — once for `arjun-rag`, once for `tax-copilot` — and PromptGym is the same shape with more moving parts. Do not start a separate repo.

---

## 1 · The convention you already have

Reading your repo, every AI Lab project is split across four places, and each has a distinct job:

| Location | Holds | Served? | Example |
|---|---|---|---|
| `projects/<name>/` | Source, build tooling, tests, README | **No** | `projects/tax-copilot/` — `src/`, `build.py`, `test/`, `dist/` |
| `static/<name>/` | The built artifact | Yes → `arjunuvacha.com/<name>` | `static/tax-copilot/index.html` |
| `worker/<name>/` | The Cloudflare Worker, own `wrangler.toml` | Separate deploy | `worker/tax-copilot-groq/` |
| `content/page/ai-lab.md` | The listing entry in the `projects:` front matter | Yes | The AI Lab page |

Hugo copies `static/` into `public/`, Firebase serves `public/`, and the Workers deploy independently via wrangler. Two deploy pipelines, one repo. That is exactly what PromptGym needs.

**The one thing to know about your deploy**, because it will bite otherwise: your GitHub Action does **not** run Hugo. It checks out the repo and deploys `public/` as-is — which is why `public/` has 752 files tracked in git. So the flow is *edit → run `hugo` locally → commit `public/` → push → Action deploys*. Forget the `hugo` step and the site simply does not change, with no error anywhere to tell you why.

---

## 2 · Where PromptGym goes

```
arjunuvacha/
├── projects/
│   ├── tax-copilot/                  ← existing
│   └── prompt-gym/                   ← NEW: all source lives here
│       ├── README.md
│       ├── CLAUDE.md                 ← the house rules from the runbook
│       ├── package.json
│       ├── .gitignore                ← node_modules/, web/dist/, .wrangler/
│       │
│       ├── docs/                     ← move the 9 design docs here
│       │   ├── design-doc.md
│       │   ├── end-to-end-flow.md
│       │   ├── build-guide.md
│       │   ├── coding-runbook.md
│       │   ├── repo-layout.md        ← this file
│       │   ├── challenge-catalog.md
│       │   ├── challenge-data.md
│       │   ├── challenge-format.md
│       │   └── groq-models.md
│       │
│       ├── challenges/               ← authoring source of truth
│       │   ├── pg-a1-address-extractor.promptfoo.yaml
│       │   ├── … (12 YAMLs)
│       │   ├── pg-golf-variants.json
│       │   └── generated/            ← convert.mjs output, committed
│       │       └── pg-a1.json …
│       │
│       ├── build/
│       │   └── convert.mjs           ← YAML → runtime JSON
│       │
│       ├── scripts/
│       │   ├── try-challenge.mjs     ← grade one challenge against real Groq
│       │   └── publish-web.sh        ← copies web build into ../../static/prompt-gym/
│       │
│       ├── web/                      ← the SPA source
│       │   ├── index.html
│       │   ├── app.js
│       │   ├── styles.css
│       │   └── dist/                 ← build output (gitignored)
│       │
│       └── test/                     ← vitest for the grading engine
│
├── worker/
│   ├── arjun-rag/                    ← existing
│   ├── tax-copilot-groq/             ← existing
│   └── prompt-gym/                   ← NEW: the API + grading engine
│       ├── wrangler.toml
│       ├── package.json
│       ├── migrations/               ← D1 schema
│       └── src/
│           ├── index.ts              ← routes
│           ├── challenges.ts         ← imports ../../projects/prompt-gym/challenges/generated/*.json
│           ├── grading/
│           │   ├── engine.ts
│           │   ├── assertions.ts
│           │   ├── schema.ts         ← the hand-rolled JSON-schema subset
│           │   ├── score.ts
│           │   ├── validators.ts     ← the named function registry
│           │   └── reveal.ts         ← the security filter
│           ├── providers/
│           │   ├── groq.ts
│           │   └── embeddings.ts
│           ├── auth/verify.ts        ← Firebase ID token, WebCrypto
│           ├── db/queries.ts
│           └── limits/
│               ├── ratelimit.ts
│               └── budget.ts
│
├── static/
│   ├── tax-copilot/                  ← existing
│   └── prompt-gym/                   ← NEW: built SPA lands here
│       ├── index.html
│       ├── app.js
│       ├── styles.css
│       └── og-image.png
│
├── public/                           ← Hugo output, committed, deployed by CI
├── content/page/ai-lab.md            ← add a PromptGym entry to `projects:`
└── firebase.json                     ← needs one rewrite added, see §4
```

**Why the Worker sits in `worker/` rather than inside `projects/prompt-gym/`:** it matches where your other two Workers already live, and it keeps the split honest — `worker/` is "things deployed by wrangler", `projects/` is "things built into static files". The one cost is that `worker/prompt-gym/src/challenges.ts` imports across directories into `projects/prompt-gym/challenges/generated/`. That is a normal relative import and wrangler's bundler handles it fine. If it ever feels awkward, add a `paths` alias in `tsconfig.json`.

---

## 3 · Two deploy pipelines, run independently

**The Worker** (whenever API or grading code changes):

```bash
cd worker/prompt-gym
npx wrangler deploy
```

Nothing else in the repo is affected. No Hugo build, no commit required for the Worker to go live — which is genuinely useful during a build weekend.

**The frontend** (whenever the SPA changes):

```bash
cd projects/prompt-gym
npm run build                 # bundles web/ → web/dist/
./scripts/publish-web.sh      # copies web/dist/* → ../../static/prompt-gym/
cd ../..
hugo                          # regenerates public/   ← the step that is easy to forget
git add static/prompt-gym public content/page/ai-lab.md
git commit -m "prompt-gym: …"
git push                      # Action deploys public/
```

Worth putting that whole sequence in `projects/prompt-gym/package.json` as a single `npm run publish` script, precisely because the `hugo` step is invisible when skipped.

---

## 4 · Three things to change in the existing repo

**`firebase.json` needs a rewrite** for the SPA's client-side routes. Currently it has none:

```json
{
  "hosting": {
    "public": "public",
    "ignore": ["firebase.json", "**/.*", "**/node_modules/**"],
    "rewrites": [
      { "source": "/prompt-gym/**", "destination": "/prompt-gym/index.html" }
    ]
  }
}
```

Without this, `arjunuvacha.com/prompt-gym/challenge/pg-a1` returns a 404 — Firebase looks for a file at that path and does not find one. The rewrite tells it to serve the SPA shell and let the client router take over. Note this is scoped to `/prompt-gym/**` so nothing about the blog's routing changes.

**`content/page/ai-lab.md`** gets a new entry in its `projects:` array, same shape as the others — name, tagline, description, icon, link, link_label. Add it when you launch, not before.

**Reuse your AI Gateway.** Your existing Workers route Groq through Cloudflare AI Gateway (`AIG_ACCOUNT = "817ef4ab…"`, `AIG_GATEWAY = "vani"`). PromptGym should use the same gateway rather than calling `api.groq.com` directly — it is free, and it gives you request logs, per-request token counts and latency, plus gateway-level caching and rate limiting that complement the budget levers in the design doc. Being able to see every Groq call in one dashboard while debugging the grading pipeline is worth more than it sounds.

---

## 5 · Where PromptGym departs from your existing pattern, and why

Your current Workers are a single `worker.js` each — plain JavaScript, no build step, no tests. That is exactly right for what they are: thin proxies that forward a request to Groq and return the response.

PromptGym's Worker is a different animal. It holds the grading engine, JWT verification, D1 queries, rate limiting and the reveal filter — the piece whose correctness determines whether every score on the leaderboard is meaningful. So it gets TypeScript, a `src/` tree, and a test suite. That is a deliberate step up in ceremony, justified by the fact that a silent bug in `score.ts` is invisible and corrupts everything downstream, whereas a bug in a proxy is immediately obvious.

Similarly, `projects/tax-copilot` concatenates numbered source fragments with a Python build script into one HTML file. That works beautifully for a single-file client-local app. PromptGym's frontend talks to an API, has multiple routes, and manages auth state, so it gets a normal bundler instead. Not a criticism of the old approach — a different problem.

---

## 6 · One consequence of this hosting setup, now that I can see it

Firebase Hosting serves `/prompt-gym/**` from static files, and its rewrites can only target Cloud Functions or Cloud Run — never a Cloudflare Worker. The build guide's M7 assumed you could route `/prompt-gym/r/:id` through the Worker to inject per-result OG tags. **With Firebase serving that path, you cannot.**

So the share link has three possible shapes, and this is your call:

1. **Static share page, generic preview (recommended for v1).** `/prompt-gym/r/<id>` is the SPA, fetching the result client-side. The link works perfectly for humans; the LinkedIn preview shows a generic PromptGym card rather than the specific score. Zero extra work.
2. **Share links on the Worker domain.** The Worker returns real HTML with per-result OG tags, so the preview is rich — but the URL is `promptgym-api.<sub>.workers.dev/r/<id>`, which undercuts the point of sharing something that says arjunuvacha.com.
3. **Move DNS to Cloudflare** and serve everything from there. Solves it properly, and is a much bigger change than the feature warrants right now.

Go with option 1 for launch. The share link's job is to let someone click through and see your app; a bespoke preview image is a nice-to-have that can arrive later if the plain link underperforms.

---

## 7 · What this changes in the runbook

Session 1 is no longer `npm create cloudflare` in a fresh directory. It becomes:

```bash
cd ~/arjunuvacha
mkdir -p projects/prompt-gym/{docs,challenges/generated,build,scripts,web,test}
mkdir -p worker/prompt-gym/src
mkdir -p static/prompt-gym
mv ~/Personal\ Projects/prompt-gym/*.md projects/prompt-gym/docs/
mv ~/Personal\ Projects/prompt-gym/pg-*.yaml ~/Personal\ Projects/prompt-gym/pg-*.json projects/prompt-gym/challenges/
```

…then point Claude Code at `projects/prompt-gym/docs/` and have it scaffold the Worker in `worker/prompt-gym/`, modelling `wrangler.toml` on your existing `worker/tax-copilot-groq/wrangler.toml` (same AI Gateway vars, same secret name) plus the new D1, KV and AI bindings.

Everything else in the runbook stands — only the paths change.
