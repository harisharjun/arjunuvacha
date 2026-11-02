# Games (and site-wide sign-in)

What lives where:

```
static/games/
  index.html, games.css          /games/ — the games landing page + shared look and header
  stonecross/                     /games/stonecross/
    index.html, styles.css, app.js   the page
    engine.js                        rules (pure; also imported by the Worker)
    ai.js, ai-worker.js              the system opponent (Beginner / Intermediate / Difficult)
static/auth/
  auth.js                         sign-in for the whole site (moved from /prompt-gym/auth.js)
  account.js                      <au-account>: the Google button / user chip, any page
worker/stonecross/
  worker.js, wrangler.toml        rooms + results: POST /rooms, WS /rooms/:code/ws,
                                  POST /results/system, GET /me/stats
  verify.js                       Firebase token check (copy of PromptGym's)
  migrations/                     D1: players, games, game_players, paperfold_progress, paperfold_state
```

## Accounts and results (same as PromptGym)

Sign-in is one module, `static/auth/auth.js`, shared by PromptGym and the games,
and both behave the same way:

| | PromptGym | Games |
|---|---|---|
| First visit | a guest (anonymous Firebase) account | the same |
| Sign in with Google | links the guest: same uid, scores kept | links the guest: same uid, results kept |
| Google account already used before | signs into it; the guest's scores stay with the guest | the same |
| Sign out | a new guest | the same |
| Server checks every request | `worker/prompt-gym/src/auth/verify.ts` | `verify.js` (a line-for-line copy) |
| Results stored | D1 `promptgym`, by uid | D1 `games`, by uid |

The uid is the same Firebase uid on both, so one person is one account across
the site. The header control on the games (`static/auth/account.js`) shows
"Playing as a guest" + Sign in with Google, or the user chip, like PromptGym's.

How results get saved:
- **Online games** are played on the server (one Durable Object per room), and
  each seat belongs to the account that took it, checked from its sign-in token.
  When a game ends, the room writes it for both players.
- **Games against the system** are played in the browser (the search needs more
  CPU than a Worker gets). At the end the page sends the move list and the Worker
  replays it with the same engine; illegal or unfinished games are refused. It
  can't prove the system's moves came from the real AI, so the level is the
  player's word. Each game has an id, so a retry can't count twice.
- **Pass & play** on one device isn't saved (both sides are the same person).

**Paperfold** progress is saved by `POST /paperfold/progress`. The game plays
entirely in the browser and keeps its progress there, then sends all of it to the
account on every visit and after every solved level. Saving only ever adds, so it
can repeat safely, and it merges into whichever account is signed in, including an
existing Google account. Unlike the results above it is the player's word: there
are no folds to replay, and nothing ranks players, so nothing checks it. A browser
is cleared only when a signed-in player signs out, so the next person starts fresh.

`paperfold_effort` measures how hard each level is in practice: the most moves plus
undos in any one attempt, counting attempts that were never finished. Start over
begins a new attempt. Hints aren't counted.

`GET /me/stats` returns the record shown under "Your record" on the game page.
Every finished game also keeps its move list, so any game can be replayed later.

## Test locally

From the repo root, two terminals:

```bash
cd worker/stonecross
npm install                                                             # once
npx wrangler d1 migrations apply games-staging --local --env staging   # once
npx wrangler dev --env staging                                          # http://localhost:8787
```
```bash
hugo server                                                             # http://localhost:1313/games/
```

`package.json` pins wrangler to 4.86.0, the last version that runs on Node 20
(4.156 requires Node 22). `npm install` once, and every `npx wrangler` below
picks up the pinned copy instead of downloading a newer one that won't start.

Its `overrides` patch the dev tools wrangler 4.86.0 pins (`sharp`, `undici`, `ws`,
`esbuild`), which Dependabot flags. None of them ship in the Worker. Moving to
Node 22 and a current wrangler would let these overrides go.

On localhost the pages sign in to the **arjunuvacha-test** Firebase project (as
PromptGym does), so the Worker runs with its staging settings, which expect
tokens from that project.

For online play on one machine, use a normal window and a private window. Two
tabs in the same window are the same account, so the second tab rejoins the
first player's seat instead of taking the other one.

## Deploy

1. **Databases** (once). Paste each id over its placeholder in `wrangler.toml`:
   ```bash
   cd worker/stonecross
   npx wrangler d1 create games
   npx wrangler d1 create games-staging
   npx wrangler d1 migrations apply games --remote
   npx wrangler d1 migrations apply games-staging --remote --env staging
   ```
   Until the ids are pasted in, `wrangler deploy` fails on purpose.

2. **Workers** (before the pages, so a page never points at a missing server):
   ```bash
   npx wrangler deploy --env staging   # stonecross-staging.harisharjun127.workers.dev
   npx wrangler deploy                 # stonecross.harisharjun127.workers.dev
   ```
   If your workers.dev subdomain differs, change `API` at the top of
   `static/games/stonecross/app.js`.

3. **Build the site and push** (the GitHub Action deploys `public/` as
   committed; it doesn't run Hugo). Pushing to master deploys **staging**:
   ```bash
   cd ../.. && hugo
   git add static/games static/auth static/prompt-gym projects/prompt-gym/web/auth.js \
           worker/stonecross assets/icons/dice.svg config.toml firebase.json .gitignore public
   git commit -m "Games: /games/ and Stonecross, results saved to accounts" && git push
   ```
   On arjunuvacha-test.web.app, check:
   - `/games/stonecross/`: finish a game against the system → "Your record" shows it.
   - Sign in with Google → the record is still there ("Your games carried over").
   - Online: create in one browser, join from another (or your phone); both
     records count it, and each side sees the other's name.
   - `/prompt-gym/` shows the same account.

4. **Production**:
   ```bash
   npx firebase-tools deploy -P prod --only hosting
   ```

`firebase.json` sends `Cache-Control: no-cache` for `/games/**` and `/auth/**`
(as for `/prompt-gym/**`), so returning visitors pick up a deploy straight away.

Useful queries:
```bash
npx wrangler d1 execute games --remote --command \
  "SELECT level + 1 AS level, COUNT(*) AS players, ROUND(AVG(max_actions), 1) AS avg_peak, MAX(max_actions) AS highest FROM paperfold_effort GROUP BY level ORDER BY level"
npx wrangler d1 execute games --remote --command \
  "SELECT pl.display_name, COUNT(*) AS levels, SUM(p.perfect) AS perfect, MAX(p.updated_at) AS last FROM paperfold_progress p JOIN players pl ON pl.uid = p.uid GROUP BY p.uid"
npx wrangler d1 execute games --remote --command \
  "SELECT g.mode, g.level, gp.result, COUNT(*) FROM game_players gp JOIN games g ON g.id = gp.game_id GROUP BY 1,2,3"
```

## Rules as built (v0 from the design doc)
- 7×7, 7 stones each on the home row. Ivory moves up, Onyx down.
- Move one stone forward or diagonally forward into an empty cell, or jump an
  adjacent stone in one of those directions into the empty cell beyond.
  Jumping an opponent captures it; jumping your own just moves further.
- Reaching the far row banks the stone (it leaves the board). First to bank 3
  wins; if you can no longer get 3 across (banked + on board), you lose.
- No legal move: the turn passes. Both stuck: most banked, then most stones, wins.
- Online: the creator moves first in game 1; rematches alternate.
- Rooms delete themselves after 2 days idle.

## AI levels
Self-play over a few hundred games: Intermediate beats Beginner ~99%, Difficult
beats Intermediate 20/20. In Difficult-vs-Difficult the starting player won
9 of 12. That's a first-move edge at high level, worth a look (pie rule).
