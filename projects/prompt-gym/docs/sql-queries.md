# PromptGym: SQL queries

Quick reference for looking at scores, prompts and feedback in D1.

**Read-only by habit.** The Console and the CLI run whatever you give them,
including `DELETE` and `UPDATE`. Stick to `SELECT` when you are only looking.

**Prompts are private.** `submissions.prompt_text` is each player's own writing.
In the app, only its author and players who passed that challenge can read it,
and only if the author made it public. Keep exports of it to yourself.

---

## Where to run them

| | Production | Staging |
|---|---|---|
| Database | `promptgym` | `promptgym-staging` |
| Dashboard | dash.cloudflare.com → Storage & databases → D1 SQL database → `promptgym` → **Console** | same, `promptgym-staging` |
| Terminal | see below | see below |

From the terminal:

```sh
cd ~/arjunuvacha/worker/prompt-gym

# production
npx wrangler d1 execute promptgym --remote --command "SELECT COUNT(*) FROM submissions"

# staging
npx wrangler d1 execute promptgym-staging --env staging --remote --command "SELECT COUNT(*) FROM submissions"
```

Add `--json` for machine-readable output.

---

## What each table holds

| Table | What's in it |
|---|---|
| `submissions` | Every run: who (`uid`), `challenge_id`, `exec_model`, `prompt_text`, `prompt_chars`, `score`, `passed`, `leaderboard_eligible`, `created_at`, and the full scorecard as JSON in `grader_results_json` |
| `best_scores` | Each player's best run per challenge (`uid`, `challenge_id`, `score`, `passed`, `submission_id`). The leaderboard and card statuses read this |
| `users` | `uid`, `display_name`, `avatar_url`, `is_anonymous` (1 = guest, 0 = signed in with Google), `created_at` |
| `share_results` | Runs made public in the gallery (`submission_id`, `show_prompt` = 1 when public, `created_at` = when shared) |
| `feedback` | Messages from the feedback panel: `display_name`, `email`, `challenge_id`, `page`, `message`, `notified` (1 = email went out), `created_at` |

Dates are UTC, as text (`2026-09-27 14:03:11`).

---

## Activity

**Latest runs, with names**

```sql
SELECT s.created_at, COALESCE(u.display_name, 'guest') AS player, s.challenge_id,
       s.score, s.passed, s.exec_model, s.prompt_chars
FROM submissions s LEFT JOIN users u ON u.uid = s.uid
ORDER BY s.created_at DESC LIMIT 50;
```

**How each challenge is doing**

```sql
SELECT challenge_id, COUNT(*) AS runs, COUNT(DISTINCT uid) AS players,
       ROUND(AVG(score)) AS avg_score, SUM(passed) AS passes
FROM submissions GROUP BY challenge_id ORDER BY runs DESC;
```

**Runs per day**

```sql
SELECT date(created_at) AS day, COUNT(*) AS runs, COUNT(DISTINCT uid) AS players
FROM submissions GROUP BY day ORDER BY day DESC LIMIT 30;
```

**Signed in vs guests**

```sql
SELECT CASE is_anonymous WHEN 1 THEN 'guest' ELSE 'signed in' END AS kind, COUNT(*)
FROM users GROUP BY is_anonymous;
```

**Best score per player and challenge**

```sql
SELECT u.display_name, b.challenge_id, b.score, b.passed, b.updated_at
FROM best_scores b JOIN users u ON u.uid = b.uid
ORDER BY u.display_name, b.challenge_id;
```

---

## One player's prompts

Change the name on the `display_name` line. `display_name` is their Google name
as it was the last time they used the site.

**Every prompt they ran, newest first**

```sql
SELECT u.display_name, s.created_at, s.challenge_id, s.exec_model,
       s.score, s.passed, s.prompt_chars, s.prompt_text
FROM submissions s
JOIN users u ON u.uid = s.uid
WHERE u.is_anonymous = 0
  AND u.display_name = 'Meera S'
ORDER BY s.created_at DESC;
```

Variations on the query above:

- Only part of the name known: replace the name line with
  `AND u.display_name LIKE '%meera%'`. It ignores case for plain English letters, and
  can match more than one person, so check the `display_name` column.
- One challenge only: add `AND s.challenge_id = 'pg-a2'`.
- Two people with the same name: add `u.uid` to the `SELECT` list to tell them apart.

**Their best prompt per challenge (the one the leaderboard uses)**

```sql
SELECT u.display_name, b.challenge_id, s.score, s.passed, s.prompt_chars,
       s.prompt_text, s.created_at
FROM best_scores b
JOIN users u ON u.uid = b.uid
JOIN submissions s ON s.id = b.submission_id
WHERE u.is_anonymous = 0
  AND u.display_name = 'Meera S'
ORDER BY b.challenge_id;
```

**Only the prompts they made public in the gallery**

```sql
SELECT u.display_name, s.challenge_id, s.score, s.prompt_text, sh.created_at AS shared_at
FROM share_results sh
JOIN submissions s ON s.id = sh.submission_id
JOIN users u ON u.uid = s.uid
WHERE sh.show_prompt = 1
  AND u.display_name = 'Meera S';
```

---

## Feedback

**All messages, newest first**

```sql
SELECT created_at, display_name, email, challenge_id, message, notified
FROM feedback ORDER BY created_at DESC;
```

**Messages whose email never went out** (`notified = 0`): read these here.

```sql
SELECT created_at, display_name, email, challenge_id, message
FROM feedback WHERE notified = 0 ORDER BY created_at DESC;
```

Production's `feedback` table was patched by hand (see `launch-checklist.md`).
Never try to fix it with a migration.
