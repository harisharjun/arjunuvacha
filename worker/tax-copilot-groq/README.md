# tax-copilot-groq — explainer worker (Cloudflare + Groq)

Powers "Ask the Copilot" on the Tax Regime Copilot
(arjunuvacha.com/tax-copilot). The app sends a question plus a PII-free JSON
snapshot of the already-computed numbers; this worker asks Groq to explain
them in plain English and hands the reply back. It never sees the uploaded
payslip, a name, a PAN, or anything the app itself doesn't already show on
screen — see the file header in `worker.js` for the full contract.

Same account, same Groq key, same AI Gateway as `arjun-rag` and vani's
`gita-rag` — you're just adding one more small Worker.

## One-time setup (~2 min)

From this folder (`worker/tax-copilot-groq/`) on your Mac:

```bash
# wrangler is already installed from the vani / arjun-rag setup; if not:
npm install -g wrangler && wrangler login

wrangler secret put GROQ_API_KEY     # paste the same gsk_… key vani/arjun-rag use
wrangler deploy
# → copy the URL it prints, e.g. https://tax-copilot-groq.<you>.workers.dev
```

That's the only secret this worker needs. Nothing else to seed — unlike
`arjun-rag` there's no corpus or vector index here, just a passthrough to Groq
with a fixed system prompt.

## Point the app at it

In `/Users/kharisharjun/arjunuvacha/projects/tax-copilot/src/80_groq.js`, set:

```js
const TAXCOPILOT_WORKER = 'https://tax-copilot-groq.<you>.workers.dev';
```

Then `cd /Users/kharisharjun/arjunuvacha/projects/tax-copilot && python3 build.py`
and copy the rebuilt `dist/tax-copilot.html` over
`/Users/kharisharjun/arjunuvacha/static/tax-copilot/index.html`, then
`hugo && firebase deploy` from the repo root.

Until this URL is deployed and reachable, "Ask the Copilot" automatically
falls back to a small built-in reference (`localAnswer()` in `src/70_ui.js`)
— the rest of the app (the actual tax computation) never depends on this
worker at all.

## Test

Visit the worker URL in a browser — a JSON health check
(`hasGroqKey: true`, `groqTest: "OK"` means it's wired up correctly).

## Notes

- Free tiers: Workers 100k requests/day, Groq free tier.
- CORS is `*` for simplicity, same as `arjun-rag`. The key itself never
  reaches the browser either way — CORS only affects which sites can call
  this endpoint from JS, not who could otherwise see the key (nobody can;
  it's a Worker secret, never in any file, never in the response).
- This `worker/` folder is not published by Hugo — nothing here reaches the
  site as static files; only the deployed Worker's URL is referenced from
  the app's JS.
