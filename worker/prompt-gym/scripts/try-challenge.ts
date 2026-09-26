/**
 * Grades one challenge end to end against the real Groq API and prints the
 * scorecard. This runs on the laptop (Node), not on the Workers runtime, which is
 * why it may touch the filesystem and read environment variables.
 *
 *   npm run try -- pg-a2 --prompt "Classify the ticket."
 *   npm run try -- pg-a2 --prompt-file reference.txt
 *   npm run try -- pg-a2 --prompt-file ref.txt --model openai/gpt-oss-120b
 *   npm run try -- pg-d2 --prompt-file ref.txt --live
 *
 * Two grading paths, deliberately:
 *
 *   default  grades with `gradeChallenge`, the pure engine. Fast and free, and it
 *            prints every individual assertion, which is what you want while
 *            iterating on a prompt. But it makes no judge call, so every
 *            `llm-rubric` and `similar` assertion comes back ERRORED and scores
 *            zero — on a challenge that has them, the total is a FLOOR, not a score.
 *
 *   --live   grades through `runChallenge`, exactly as the deployed Worker does,
 *            judge calls included. Slower and it spends real budget, but it is the
 *            only way to see a model-graded challenge's true score. Output is
 *            reveal-filtered, same as a player would see, so you get metrics and
 *            reasons rather than individual assertions.
 *
 * The key is read from $GROQ_API_KEY, or from .dev.vars, and is never printed.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { gradeChallenge } from '../src/grading/engine';
import { runChallenge } from '../src/run';
import { restEmbedder, type Embedder } from '../src/providers/embeddings';
import { estimateTokens } from '../src/grading/score';
import { validators } from '../src/grading/validators';
import { execute } from '../src/providers/groq';
import { toOutcome, type ExecutionOutcome } from '../src/providers/errors';
import type { Challenge } from '../src/grading/types';

const CHALLENGE_DIR = join(
  import.meta.dirname,
  '../../../projects/prompt-gym/challenges/generated',
);
const EXEC_CONCURRENCY = 3;

/** Joins every token up to the next `--flag`, because `npm run try -- --prompt "a b"`
 *  strips the quotes on the way through and would otherwise pass only "a". */
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const rest: string[] = [];
  for (let j = i + 1; j < process.argv.length && !process.argv[j].startsWith('--'); j++) {
    rest.push(process.argv[j]);
  }
  return rest.length > 0 ? rest.join(' ') : undefined;
}

function loadApiKey(): string {
  if (process.env.GROQ_API_KEY) return process.env.GROQ_API_KEY;

  const keyFile = arg('key-file') ?? join(import.meta.dirname, '..', '.dev.vars');
  if (existsSync(keyFile)) {
    const match = readFileSync(keyFile, 'utf8').match(/^\s*GROQ_API_KEY\s*=\s*"?([^"\n]+)"?/m);
    if (match) return match[1].trim();
  }

  console.error(
    'No Groq key found. Either:\n' +
      '  export GROQ_API_KEY=gsk_...\n' +
      'or put GROQ_API_KEY=gsk_... in worker/prompt-gym/.dev.vars (gitignored).',
  );
  process.exit(2);
}

/** Small concurrency cap: the free tier has a per-minute token ceiling, and firing
 *  every test case at once is the fastest way to hit it. */
async function mapWithLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>) {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i]);
      }
    }),
  );
  return results;
}

const challengeId = process.argv[2];
if (!challengeId || challengeId.startsWith('--')) {
  console.error('usage: npm run try -- <challengeId> --prompt "..." | --prompt-file <path>');
  process.exit(2);
}

const challengePath = join(CHALLENGE_DIR, `${challengeId}.json`);
if (!existsSync(challengePath)) {
  console.error(`No generated challenge at ${challengePath}. Run the converter first.`);
  process.exit(2);
}
const challenge = JSON.parse(readFileSync(challengePath, 'utf8')) as Challenge;

const promptFile = arg('prompt-file');
const prompt = promptFile ? readFileSync(promptFile, 'utf8').trim() : arg('prompt');
if (!prompt) {
  console.error('Provide a prompt with --prompt or --prompt-file.');
  process.exit(2);
}

const model = arg('model') ?? 'openai/gpt-oss-20b';
const apiKey = loadApiKey();
const live = process.argv.includes('--live');

/** Workers AI over REST, for `similar`. Optional: without it those assertions
 *  stay pending and the run reports itself non-eligible, exactly as the deployed
 *  Worker does when the AI binding is missing. Needs, in .dev.vars:
 *    CF_ACCOUNT_ID=...
 *    CF_API_TOKEN=...     (a token with Workers AI read) */
function loadEmbedder(): Embedder | undefined {
  const file = join(import.meta.dirname, '..', '.dev.vars');
  const env = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const pick = (k: string) =>
    process.env[k] ?? env.match(new RegExp(`^\\s*${k}\\s*=\\s*"?([^"\\n]+)"?`, 'm'))?.[1]?.trim();

  const account = pick('CF_ACCOUNT_ID');
  const token = pick('CF_API_TOKEN');
  if (!account || !token) return undefined;
  return restEmbedder(account, token);
}

console.log(`\n${challenge.id} — ${challenge.title}`);
console.log(`model: ${model}   cases: ${challenge.tests.length}   prompt: ${prompt.length} chars` +
  (live ? '   grading: LIVE (judge calls enabled)' : ''));
console.log('─'.repeat(72));

const started = Date.now();

// The production path, judge and all. Kept in its own branch rather than merged
// into the one below: this one deliberately sees only what a player sees.
if (live) {
  const embedder = loadEmbedder();
  if (!embedder) {
    console.log('note: no CF_ACCOUNT_ID / CF_API_TOKEN in .dev.vars — `similar`');
    console.log('      assertions stay pending and this run is not eligible.');
  }
  const r = await runChallenge({ challenge, prompt, model, apiKey, embedder });

  for (const t of r.tests) {
    const mark = t.status === 'errored' ? '!' : t.status === 'passed' ? '✓' : '✗';
    console.log(`\n${mark} ${t.id}  ${t.status}${t.judgingSkipped ? '  (judge skipped — cheap graders had already failed)' : ''}`);
    if (t.output !== null) {
      console.log(`    output: ${JSON.stringify(t.output.slice(0, 160))}${t.output.length > 160 ? '…' : ''}`);
    }
    for (const f of t.failures) console.log(`    - [${f.metric}] ${f.reason}`);
  }

  console.log('\n' + '─'.repeat(72));
  console.log(`SCORE ${r.score}/100   ${r.passed ? 'PASSED' : 'did not pass'}` +
    `   (threshold ${challenge.scoring.passThreshold * 100}%)`);
  if (r.efficiencyBonus > 0) {
    console.log(`  correctness ${r.baseScore} + efficiency ${r.efficiencyBonus}`);
  }
  console.log('by metric: ' + r.byGrader.map((m) => `${m.metric} ${(m.score * 100).toFixed(0)}%`).join('  '));
  if (!r.leaderboardEligible) {
    console.log('\nNOT leaderboard-eligible — a grader errored or could not run.');
  }
  console.log(`elapsed ${((Date.now() - started) / 1000).toFixed(1)}s\n`);
  process.exit(0);
}
const truncated = new Set<string>();
const outcomes = await mapWithLimit(
  challenge.tests,
  EXEC_CONCURRENCY,
  async (test): Promise<{ id: string; outcome: ExecutionOutcome }> => {
    try {
      const r = await execute({
        apiKey,
        model,
        prompt,
        input: test.input,
        template: challenge.harness?.template,
        maxOutputTokens: challenge.harness?.maxOutputTokens,
      });
      if (r.truncated) truncated.add(test.id);
      return {
        id: test.id,
        outcome: {
          status: 'ok',
          output: r.content,
          promptTokens: r.promptTokens,
          completionTokens: r.completionTokens,
        },
      };
    } catch (err) {
      return { id: test.id, outcome: toOutcome(err) };
    }
  },
);

// Only successful executions reach the scorer. An errored case has no output to
// grade, and grading it as empty would score the user down for our outage.
const outputs: Record<string, string> = {};
const errored: { id: string; reason: string }[] = [];
for (const { id, outcome } of outcomes) {
  if (outcome.status === 'ok') outputs[id] = outcome.output;
  else errored.push({ id, reason: `${outcome.kind}: ${outcome.reason}` });
}

const promptTokens = outcomes.reduce(
  (sum, o) => sum + (o.outcome.status === 'ok' ? o.outcome.promptTokens : 0),
  0,
);

// The player's own prompt, not the whole request — `promptTokens` includes the
// harness and the test input, which they did not write.
const result = gradeChallenge(challenge, outputs, validators, {
  promptTokens: estimateTokens(prompt),
});

for (const testCase of result.cases) {
  const failed = errored.find((e) => e.id === testCase.id);
  const mark = failed ? '!' : testCase.passed ? '✓' : '✗';
  console.log(`\n${mark} ${testCase.id}  score ${(testCase.score * 100).toFixed(0)}%`);

  if (failed) {
    console.log(`    ERRORED — ${failed.reason}`);
    continue;
  }
  const output = outputs[testCase.id] ?? '';
  console.log(`    output: ${JSON.stringify(output.slice(0, 160))}${output.length > 160 ? '…' : ''}`);
  if (truncated.has(testCase.id)) {
    console.log(`    TRUNCATED at the ${challenge.harness?.maxOutputTokens ?? 192}-token cap —` +
      ' the output was cut off, not merely wrong');
  }
  for (const a of testCase.assertions) {
    if (a.passed) continue;
    const why = a.error ? `ERRORED (${a.error})` : 'failed';
    console.log(`    - ${a.type}${a.metric ? ` [${a.metric}]` : ''} ${why}  weight ${a.weight}`);
  }
}

console.log('\n' + '─'.repeat(72));
console.log(`SCORE ${result.score}/100   ${result.passed ? 'PASSED' : 'did not pass'}` +
  `   (threshold ${challenge.scoring.passThreshold * 100}%)`);
if (result.efficiencyBonus > 0) {
  console.log(`  correctness ${result.baseScore} + efficiency ${result.efficiencyBonus}`);
}
console.log('by metric: ' + result.byMetric.map((m) => `${m.metric} ${(m.score * 100).toFixed(0)}%`).join('  '));
if (errored.length > 0) {
  console.log(`\n${errored.length} case(s) errored — this run would NOT be leaderboard-eligible.`);
}
console.log(`elapsed ${((Date.now() - started) / 1000).toFixed(1)}s\n`);
