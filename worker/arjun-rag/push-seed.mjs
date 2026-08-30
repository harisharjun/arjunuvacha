/**
 * push-seed.mjs — chunks the corpus/*.md files and sends them to the deployed
 * arjun-rag worker, which embeds them (Workers AI) and upserts into Vectorize.
 *
 *   WORKER_URL=https://arjun-rag.<you>.workers.dev SEED_TOKEN=yourtoken node push-seed.mjs
 *
 * Chunking: each "## " section in each md file = one chunk. Safe to re-run
 * (upsert overwrites by id). Re-run whenever you edit the corpus.
 */
import fs from "node:fs";
import path from "node:path";

const WORKER_URL = process.env.WORKER_URL;
const SEED_TOKEN = process.env.SEED_TOKEN;
if (!WORKER_URL || !SEED_TOKEN) { console.error("Set WORKER_URL and SEED_TOKEN env vars."); process.exit(1); }

const dir = path.join(path.dirname(new URL(import.meta.url).pathname), "corpus");
const files = fs.readdirSync(dir).filter(f => f.endsWith(".md")).sort();

const items = [];
for (const f of files) {
  const raw = fs.readFileSync(path.join(dir, f), "utf8");
  const title = (raw.match(/^# (.+)$/m) || [, f])[1].trim();
  const sections = raw.split(/^## /m).slice(1);
  sections.forEach((s, i) => {
    const nl = s.indexOf("\n");
    const section = s.slice(0, nl).trim();
    const text = s.slice(nl + 1).trim().replace(/\n{2,}/g, "\n");
    if (!text) return;
    const slug = section.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40);
    items.push({ id: `${f.replace(".md", "")}#${slug || i}`, title, section, text });
  });
}
console.log(`Chunked ${files.length} files into ${items.length} sections.`);

const sleep = ms => new Promise(r => setTimeout(r, ms));
const BATCH = 10;
let pushed = 0;
for (let i = 0; i < items.length; i += BATCH) {
  const batch = items.slice(i, i + BATCH);
  let ok = false;
  for (let attempt = 0; attempt < 4 && !ok; attempt++) {
    const r = await fetch(WORKER_URL.replace(/\/$/, "") + "/seed", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: SEED_TOKEN, items: batch }),
    });
    if (r.ok) { ok = true; pushed += batch.length; console.log(`upserted ${pushed}/${items.length}`); }
    else { console.warn("batch failed", r.status, await r.text()); await sleep(4000); }
  }
  await sleep(500);
}
console.log(`✅ Seeded ${pushed} chunks into Vectorize (arjun-index).`);
