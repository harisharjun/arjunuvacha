#!/usr/bin/env node
// Converts authoring YAML into the runtime JSON the Worker ships.
//
// This is a Node script that runs on your laptop, so Node APIs are fine here —
// unlike anything under worker/src/. See docs/build-guide.md Appendix B.
//
// The YAML is the source of truth for test cases, assertions AND the harness —
// the prompt template and the provider settings promptfoo actually runs. A
// sidecar in challenges/meta/ supplies only the runtime fields promptfoo has no
// concept of (mode, difficulty, the public block, limits, scoring). Generated
// output is disposable — never hand-edit challenges/generated/.

import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHALLENGES = join(ROOT, 'challenges');
const META = join(CHALLENGES, 'meta');
const OUT = join(CHALLENGES, 'generated');
const REGISTRY = join(ROOT, '..', '..', 'worker', 'prompt-gym', 'src', 'grading', 'validators.ts');
const ASSERTIONS = join(ROOT, '..', '..', 'worker', 'prompt-gym', 'src', 'grading', 'assertions.ts');

/** Model-graded assertions are authored now but cannot run until the judge and the
 *  embeddings client exist (M2/M3). They are reported, not treated as errors. */
const DEFERRED_TYPES = new Set(['llm-rubric', 'similar']);
const deferred = new Map();

// v1 ships one reveal level for every test case; the per-case values still in the
// YAML are a deferred target policy. See docs/challenge-format.md §5.
const V1_REVEAL = 'partial';

const problems = [];
const fail = (challenge, message) => problems.push(`${challenge}: ${message}`);

/** The registry is TypeScript, and Node 20 cannot import it directly. Reading the
 *  key names is all this check needs; the guard below catches the case where the
 *  pattern stops matching and the check silently passes everything. */
function loadValidatorNames() {
  const src = readFileSync(REGISTRY, 'utf8');
  const names = new Set([...src.matchAll(/^\s*'(validators\.[A-Za-z0-9_]+)':/gm)].map((m) => m[1]));
  if (names.size < 10) {
    throw new Error(
      `Only ${names.size} validators found in ${REGISTRY} — the extraction pattern is probably broken, refusing to validate refs against an empty set`,
    );
  }
  return names;
}

/** Reads the assertion types the engine actually implements, straight from its
 *  switch statement. Hardcoding the list here would let the two drift — which is
 *  exactly how `icontains-any` reached the challenge set without an implementation. */
function loadEngineTypes() {
  const src = readFileSync(ASSERTIONS, 'utf8');
  const types = new Set([...src.matchAll(/^\s*case '([a-z0-9-]+)':/gm)].map((m) => m[1]));
  if (types.size < 8) {
    throw new Error(`Only ${types.size} assertion types found in ${ASSERTIONS} — extraction pattern is broken`);
  }
  return types;
}

function checkAssertionType(type, challenge, engineTypes) {
  const bare = type.startsWith('not-') ? type.slice(4) : type;
  if (engineTypes.has(bare)) return;
  if (DEFERRED_TYPES.has(bare)) {
    deferred.set(bare, (deferred.get(bare) ?? 0) + 1);
    return;
  }
  fail(challenge, `assertion type "${type}" is not implemented by the grading engine`);
}

/** Splits `validators.dateEquals('2025-04-03')` into a name and its arguments. */
function parseRef(raw, challenge) {
  const match = raw.match(/^([A-Za-z0-9_.]+)(?:\((.*)\))?$/s);
  if (!match) {
    fail(challenge, `could not parse ref "${raw}"`);
    return null;
  }
  const [, name, argSrc] = match;
  if (argSrc === undefined) return { ref: name };

  // Ref arguments are authored as JS literals with single quotes; JSON needs double.
  try {
    return { ref: name, args: [JSON.parse(`[${argSrc}]`.replace(/'/g, '"'))].flat() };
  } catch {
    fail(challenge, `ref "${raw}" has arguments that are not simple literals`);
    return { ref: name };
  }
}

/** Finds the `# ref:` comment inside one assertion's source range. */
function refForAssertion(src, node, challenge) {
  const [start, , end] = node.range ?? [];
  if (start === undefined) return null;
  const slice = src.slice(start, end);
  const m = slice.match(/#\s*ref:\s*([A-Za-z0-9_.]+(?:\([^)]*\))?)/);
  if (!m) {
    fail(challenge, 'a javascript assertion has no `# ref:` comment, so it has no validator name');
    return null;
  }
  return parseRef(m[1], challenge);
}

function convertAssertion(src, node, challenge, validatorNames, engineTypes) {
  const assertion = node.toJSON();
  checkAssertionType(assertion.type, challenge, engineTypes);
  if (assertion.type !== 'javascript' && assertion.type !== 'not-javascript') {
    return assertion;
  }

  const resolved = refForAssertion(src, node, challenge);
  // The function body is deliberately dropped: turning a string into a function
  // needs eval, which the Workers runtime blocks and which has no business in a
  // request handler. The name only ever *selects* a function we shipped.
  const { value, ...rest } = assertion;
  if (!resolved) return { ...rest };

  if (!validatorNames.has(resolved.ref)) {
    fail(challenge, `ref "${resolved.ref}" is not in the validator registry`);
  }
  return { ...rest, ...resolved };
}

/** The harness is read from the YAML, never from the sidecar.
 *
 *  It used to live in the sidecars, which were stubbed with a generic template
 *  and default token caps — and quietly drifted from what the YAML authored.
 *  pg-c5's refund policy lived only in its YAML template, so the Worker never
 *  sent it: the model was asked to "answer using only the policy below" with no
 *  policy below. pg-b1 and pg-b3 were authored for 384 output tokens and ran at
 *  256; pg-e4 and pg-f1 for 256 and ran at 192. One owner makes that impossible. */
function harnessFromYaml(doc, name) {
  const prompts = doc.get('prompts')?.toJSON?.() ?? doc.get('prompts');
  const template = Array.isArray(prompts) ? prompts[0] : null;
  if (typeof template !== 'string') {
    fail(name, 'no prompts[0] template in the YAML — the harness has nothing to render');
    return null;
  }
  // Block scalars end with a newline; that is YAML syntax, not template content.
  const trimmed = template.replace(/\n$/, '');
  if (!trimmed.includes('{{userPrompt}}') || !trimmed.includes('{{input}}')) {
    fail(name, 'the YAML template must contain both {{userPrompt}} and {{input}}');
  }

  const config = doc.getIn(['providers', 0, 'config'])?.toJSON?.() ?? {};
  return {
    template: trimmed,
    temperature: typeof config.temperature === 'number' ? config.temperature : 0,
    maxOutputTokens: typeof config.max_tokens === 'number' ? config.max_tokens : 192,
  };
}

/** What the player should see of the harness around their prompt.
 *
 *  Fixed context the model receives on every case — pg-c5's refund policy — is
 *  part of the task, not a secret: the goal says "using only the policy below",
 *  so it has to actually be below. The label on the input slot (CUSTOMER,
 *  REVIEW, TICKET) tells the player what kind of text their prompt will face.
 *  Neither contains test data: the context is identical on every case, and the
 *  input slot is only ever named here, never filled. */
function frameFromTemplate(template) {
  const after = template.split('{{userPrompt}}')[1] ?? '';
  const body = after.replace(/^\s*---\s*\n/, '');
  const sections = [];
  let current = null;
  for (const line of body.split('\n')) {
    const heading = /^([A-Z][A-Z ]*[A-Z]):\s*$/.exec(line);
    if (heading) {
      current = { label: heading[1], lines: [] };
      sections.push(current);
    } else if (current) {
      current.lines.push(line);
    }
  }
  const context = [];
  let inputLabel = null;
  for (const s of sections) {
    const text = s.lines.join('\n').trim();
    if (text === '{{input}}') inputLabel = s.label;
    else if (text) context.push({ label: s.label, text });
  }
  return { context, inputLabel };
}

function convert(yamlPath, validatorNames, engineTypes) {
  const name = basename(yamlPath).replace(/\.promptfoo\.yaml$/, '');
  const src = readFileSync(yamlPath, 'utf8');
  const doc = YAML.parseDocument(src);

  const metaPath = join(META, `${name}.json`);
  if (!existsSync(metaPath)) {
    fail(name, `no sidecar at challenges/meta/${name}.json — cannot emit runtime fields`);
    return null;
  }
  const meta = JSON.parse(readFileSync(metaPath, 'utf8'));

  if (meta.harness) {
    fail(name, 'the sidecar carries a "harness" block — delete it; the YAML prompts/providers own the harness');
  }
  const harness = harnessFromYaml(doc, name);
  const frame = harness ? frameFromTemplate(harness.template) : { context: [], inputLabel: null };

  // 1. defaultTest.assert is promptfoo's inheritance mechanism; the runtime calls
  //    the same thing defaultAssert and never needs to know defaultTest exists.
  const defaultAssertNode = doc.getIn(['defaultTest', 'assert'], true);
  const defaultAssert = defaultAssertNode
    ? defaultAssertNode.items.map((n) => convertAssertion(src, n, name, validatorNames, engineTypes))
    : [];

  const testsNode = doc.get('tests', true);
  const tests = (testsNode?.items ?? []).map((testNode, i) => {
    const test = testNode.toJSON();
    const assertNode = testNode.getIn(['assert'], true);
    return {
      id: `t${i + 1}`,
      // YAML block scalars (`|` and `>`) always end with a newline. That is syntax,
      // not part of the test input, so exactly one trailing newline is removed —
      // any other whitespace the author wrote deliberately is left alone.
      input: (test.vars?.input ?? '').replace(/\n$/, ''),
      // 2. reveal is promptfoo `metadata` but a first-class runtime field, because it
      //    decides what gets stripped from the response. Forced to the v1 level.
      reveal: V1_REVEAL,
      ...(meta.hints?.[`t${i + 1}`] ? { hint: meta.hints[`t${i + 1}`] } : {}),
      assert: assertNode
        ? assertNode.items.map((n) => convertAssertion(src, n, name, validatorNames, engineTypes))
        : [],
    };
  });

  if (tests.length === 0) fail(name, 'no test cases');

  // `$`-prefixed sidecar keys are notes for a human reader; they never ship.
  const { hints, ...rest } = meta;
  const runtimeMeta = Object.fromEntries(
    Object.entries(rest).filter(([k]) => !k.startsWith('$')),
  );
  const publicBlock = {
    ...(runtimeMeta.public ?? {}),
    context: frame.context,
    inputLabel: frame.inputLabel,
  };
  return {
    path: join(OUT, `${runtimeMeta.id}.json`),
    challenge: { ...runtimeMeta, public: publicBlock, harness, defaultAssert, tests },
  };
}

/** The committed pg-a1 JSON was hand-written before this converter existed, which
 *  makes it a one-time check that the converter agrees with a human.
 *
 *  Only the part the YAML actually owns is compared. The runtime-only fields come
 *  from the sidecar, and `reveal` is forced to the v1 level, so neither can match
 *  the hand-written file by construction. */
function goldenCheck(generated) {
  const goldenPath = join(CHALLENGES, 'pg-a1-address-extractor.json');
  const golden = JSON.parse(readFileSync(goldenPath, 'utf8'));
  const strip = (o) => JSON.parse(JSON.stringify(o, (k, v) => (k.startsWith('$') ? undefined : v)));

  const owned = (c) => ({
    defaultAssert: c.defaultAssert,
    tests: c.tests.map((t) => ({ id: t.id, input: t.input, assert: t.assert })),
  });

  // Key order carries no meaning in JSON, so compare canonically — otherwise the
  // check fails on the order the converter happens to spread its fields in.
  const canonical = (v) =>
    Array.isArray(v)
      ? v.map(canonical)
      : v && typeof v === 'object'
        ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])]))
        : v;

  const a = JSON.stringify(canonical(owned(strip(generated))), null, 2);
  const b = JSON.stringify(canonical(owned(strip(golden))), null, 2);
  if (a === b) return console.log('golden check: pg-a1 matches the hand-written JSON');

  console.error('\ngolden check FAILED for pg-a1 — converter output differs from the committed JSON');
  const al = a.split('\n');
  const bl = b.split('\n');
  for (let i = 0; i < Math.max(al.length, bl.length); i++) {
    if (al[i] !== bl[i]) {
      console.error(`  line ${i + 1}:\n    generated: ${al[i] ?? '(none)'}\n    committed: ${bl[i] ?? '(none)'}`);
      break;
    }
  }
  problems.push('pg-a1: golden check failed');
}

/** Golf variants are configuration, not authoring: each one reuses its parent's
 *  test cases and assertions verbatim and only changes the scoring. They have no
 *  YAML of their own, so they are expanded from pg-golf-variants.json here rather
 *  than hand-maintained as a second copy of the parent's cases. */
function expandGolfVariants(built) {
  const path = join(CHALLENGES, 'pg-golf-variants.json');
  if (!existsSync(path)) return [];

  const { variants = [] } = JSON.parse(readFileSync(path, 'utf8'));
  const expanded = [];

  for (const variant of variants) {
    const parent = built.get(variant.parent);
    if (!parent) {
      fail(variant.id, `parent challenge "${variant.parent}" was not converted`);
      continue;
    }
    if (!(variant.scoring?.parTokens > 0)) {
      fail(variant.id, 'needs a positive scoring.parTokens, or the bonus is unreachable');
      continue;
    }

    expanded.push({
      path: join(OUT, `${variant.id}.json`),
      challenge: {
        id: variant.id,
        title: variant.title,
        mode: variant.mode ?? 'golf',
        difficulty: variant.difficulty ?? parent.difficulty,
        tags: variant.tags ?? parent.tags,
        graderFamilies: parent.graderFamilies,
        // The parent's player-facing copy still applies; the variant only
        // overrides what golf changes.
        public: { ...parent.public, ...variant.public },
        harness: parent.harness,
        limits: parent.limits,
        scoring: {
          maxScore: parent.scoring.maxScore,
          passThreshold: variant.scoring.passThreshold ?? parent.scoring.passThreshold,
          parTokens: variant.scoring.parTokens,
          maxBonus: variant.scoring.maxBonus ?? 20,
        },
        defaultAssert: parent.defaultAssert,
        tests: parent.tests,
      },
    });
  }
  return expanded;
}

const validatorNames = loadValidatorNames();
const engineTypes = loadEngineTypes();
mkdirSync(OUT, { recursive: true });

const only = process.argv.slice(2);
const files = readdirSync(CHALLENGES)
  .filter((f) => f.endsWith('.promptfoo.yaml'))
  .filter((f) => only.length === 0 || only.some((o) => f.includes(o)))
  .sort();

let written = 0;
const built = new Map();
for (const file of files) {
  const result = convert(join(CHALLENGES, file), validatorNames, engineTypes);
  if (!result) continue;
  writeFileSync(result.path, JSON.stringify(result.challenge, null, 2) + '\n');
  built.set(result.challenge.id, result.challenge);
  written++;
  if (result.challenge.id === 'pg-a1') goldenCheck(result.challenge);
}

// Only when converting everything: expanding a variant needs its parent present.
let golf = 0;
if (only.length === 0) {
  for (const result of expandGolfVariants(built)) {
    writeFileSync(result.path, JSON.stringify(result.challenge, null, 2) + '\n');
    golf++;
  }
}

console.log(`\nconverted ${written}/${files.length} challenges + ${golf} golf variants -> challenges/generated/`);
console.log(`validators in registry: ${validatorNames.size}`);
console.log(`assertion types implemented: ${engineTypes.size}`);

if (deferred.size > 0) {
  console.log('\nmodel-graded assertions authored but not yet runnable (M2/M3):');
  for (const [type, n] of deferred) console.log(`  ${type}: ${n}`);
}

if (problems.length > 0) {
  console.error(`\n${problems.length} problem(s):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
