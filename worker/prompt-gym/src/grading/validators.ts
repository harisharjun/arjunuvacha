import type { ValidatorRegistry } from './types';

/** Named validators, compiled into the bundle. Challenge data selects from this map
 *  by `ref` and can never supply a function body, so there is no path from data to
 *  executed code.
 *
 *  GENERATED ONCE from the `value:` bodies in challenges/*.promptfoo.yaml, then
 *  maintained here by hand. build/convert.mjs verifies every `ref` a challenge emits
 *  exists in this map, so a rename breaks the build rather than the leaderboard.
 *
 *  The bodies are ports, not rewrites. Several parse without guarding, which is
 *  faithful to the source and safe because the engine treats a throw as an errored
 *  assertion. Do not "fix" them defensively: promptfoo runs the YAML copy locally
 *  and this map runs in production, and the two must agree on what they test.
 *  The only edits made during extraction were `any` type annotations, which change
 *  no behaviour. */
export const validators: ValidatorRegistry = {
  // pg-b1-invoice-sum
  'validators.b1Arithmetic': (output) => {
          const j = JSON.parse(output);
          const num = (v: any) => typeof v === 'number' ? v : Number(String(v).replace(/[^0-9.-]/g, ''));
          const sum = j.line_items.reduce((s: any, li: any) => s + num(li.amount), 0);
          const computed = num(j.computed_total);
          const stated = num(j.stated_total);
          const matchesOk = j.total_matches === (Math.abs(stated - computed) < 0.01);
          return Math.abs(sum - computed) < 0.01 && matchesOk;
        },

  // pg-b1-invoice-sum
  'validators.b1CleanThreeLine': (output) => {
          const j = JSON.parse(output);
          return j.line_items.length === 3 && Number(j.stated_total) === 17500 &&
                 j.total_matches === true;
        },

  // pg-b1-invoice-sum
  'validators.b1CreditCancelsCharge': (output) => {
          const j = JSON.parse(output);
          return j.line_items.length === 3 && Number(j.stated_total) === 60000 &&
                 j.total_matches === true;
        },

  // pg-b1-invoice-sum
  'validators.b1MismatchReported': (output) => {
          const j = JSON.parse(output);
          const num = (v: any) => typeof v === 'number' ? v : Number(String(v).replace(/[^0-9.-]/g, ''));
          return num(j.stated_total) === 4270 && num(j.computed_total) === 4720 &&
                 j.total_matches === false;
        },

  // pg-b1-invoice-sum
  'validators.b1NegativeDiscountLine': (output) => {
          const j = JSON.parse(output);
          const num = (v: any) => typeof v === 'number' ? v : Number(String(v).replace(/[^0-9.-]/g, ''));
          const hasNegative = j.line_items.some((li: any) => num(li.amount) < 0);
          return j.line_items.length === 3 && hasNegative &&
                 Number(j.stated_total) === 26550 && j.total_matches === true;
        },

  // pg-b3-redaction
  'validators.b3NoLeak': (output) => {
          const leaked = ['98765', '43210', 'arun.m@example.com'];
          return !leaked.some(s => output.includes(s));
        },

  // pg-b3-redaction
  'validators.b3NoLeakObfuscated': (output) => {
          const digits = output.replace(/\D/g, '');
          const leakedEmail = output.includes('a.menon+lumen@example.co.in');
          // no run of 4+ digits from the phone may survive in any spacing
          const runs = digits.match(/\d{4,}/g) || [];
          return !leakedEmail && runs.length === 0;
        },

  // pg-b3-redaction
  //
  // Masking is not deletion. A prompt that simply removes the sensitive span
  // passes every leak check trivially while destroying the transcript, which is
  // the opposite of the task — so the non-PII bytes have to be accounted for too.
  // Each mask token collapses to one sentinel and the rest must match exactly:
  // a deleted name, a dropped ticket reference, a reworded sentence, or an
  // over-redacted non-PII span all fail. Whitespace runs and curly apostrophes
  // are normalised first; nothing else is forgiven.
  'validators.b3SkeletonT1': (output) => {
          const skeleton = output.trim()
            .replace(/\s+/g, ' ')
            .replace(/[\u2018\u2019]/g, "'")
            .replace(/\[(PHONE|EMAIL|ID)\]/g, '\u00a7');
          return skeleton ===
            'Customer Arun M (\u00a7, \u00a7) reported the sync failure on ticket LMN-3391.';
        },

  // pg-b3-redaction
  'validators.b3SkeletonT2': (output) => {
          const skeleton = output.trim()
            .replace(/\s+/g, ' ')
            .replace(/[\u2018\u2019]/g, "'")
            .replace(/\[(PHONE|EMAIL|ID)\]/g, '\u00a7');
          return skeleton ===
            "Reachable on \u00a7 or at \u00a7 \u2014 he's also tried \u00a7.";
        },

  // pg-b3-redaction
  'validators.b3NoOverRedaction': (output) => {
          const mustSurvive = ['4,500', '3344', '560001', 'LMN-4471', '12/09/25'];
          const survived = mustSurvive.every(s => output.includes(s));
          const overRedacted = /\[(PHONE|EMAIL|ID)\]/.test(output);
          return survived && !overRedacted;
        },

  // pg-b3-redaction
  'validators.b3SplitAndId': (output) => {
          const noPhone = !output.includes('98765') && !output.includes('43210');
          const noPan = !output.includes('ABCDE1234F');
          const hasId = output.includes('[ID]');
          return noPhone && noPan && hasId;
        },

  // pg-b7-empty-in-empty-out
  'validators.b7SingleUnownedItem': (output) => {
          const a = JSON.parse(output);
          if (a.length !== 1) return false;
          const o = a[0].owner;
          return o === null || o === '' || o === undefined;
        },

  // pg-b7-empty-in-empty-out
  'validators.b7TwoOwnedItems': (output) => {
          const a = JSON.parse(output);
          if (a.length !== 2) return false;
          const owners = a.map((x: any) => String(x.owner || '').toLowerCase()).sort();
          return owners[0].includes('nisha') && owners[1].includes('ravi');
        },

  // pg-c1-faithful-paraphrase
  'validators.c1NegationHeld': (output) => /\b(not|no|never|without|isn't|aren't|non-)\b/i.test(output),

  // pg-c1-faithful-paraphrase
  'validators.c1NotACopy': (output, context) => {
          const a = output.trim(), b = String(context.vars.input).trim();
          const m = a.length, n = b.length;
          let prev = Array.from({ length: n + 1 }, (_, j) => j);
          let cur = new Array(n + 1);
          for (let i = 1; i <= m; i++) {
            cur[0] = i;
            for (let j = 1; j <= n; j++) {
              cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1,
                                prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
            }
            [prev, cur] = [cur, prev];
          }
          return prev[n] / Math.max(m, n) >= 0.4;
        },

  // pg-c5-near-miss-trap
  'validators.c5AddOnRefused': (output) => {
          const t = output.toLowerCase();
          const negative = /\b(no|not eligible|unfortunately|can't|cannot|unable|non-refundable)\b/.test(t);
          return negative && /activat/.test(t);
        },

  // pg-c5-near-miss-trap
  'validators.c5Affirmative14': (output) => {
          const t = output.toLowerCase();
          const affirmative = /\b(yes|you can|eligible|we can refund|happy to refund)\b/.test(t);
          const negative = /\b(no,|not eligible|unfortunately|can't|cannot|unable)\b/.test(t);
          return affirmative && !negative && t.includes('14');
        },

  // pg-c5-near-miss-trap
  'validators.c5Affirmative30': (output) => {
          const t = output.toLowerCase();
          const affirmative = /\b(yes|you can|eligible|we can refund|happy to refund)\b/.test(t);
          const negative = /\b(no,|not eligible|unfortunately|can't|cannot|unable)\b/.test(t);
          return affirmative && !negative && t.includes('30');
        },

  // pg-c5-near-miss-trap
  'validators.c5Negative14': (output) => {
          const t = output.toLowerCase();
          const negative = /\b(no|not eligible|unfortunately|can't|cannot|unable|outside)\b/.test(t);
          const citesRightRule = t.includes('14');
          const citesWrongRule = t.includes('30');
          return negative && citesRightRule && !citesWrongRule;
        },

  // pg-a3-date-normaliser
  'validators.dateIsNull': (output) => JSON.parse(output).date === null,

  // pg-e4-right-question
  'validators.exactlyOneQuestion': (output) => (output.match(/\?/g) || []).length === 1,

  // pg-f1-ticket-triage
  'validators.f1OutageIsP1': (output) => {
          const j = JSON.parse(output);
          return j.category === 'bug' && j.priority === 'P1';
        },

  // pg-f1-ticket-triage
  'validators.f1PlanQuestionIsLowPriority': (output) => {
          const j = JSON.parse(output);
          return ['billing', 'other'].includes(j.category) &&
                 ['P3', 'P4'].includes(j.priority);
        },

  // pg-f1-ticket-triage
  'validators.f1SummaryLength': (output) => {
          const s = JSON.parse(output).summary || '';
          const words = s.trim().split(/\s+/).filter(Boolean).length;
          return words > 0 && words <= 15;
        },

  // pg-f1-ticket-triage
  'validators.f1ToneNotSeverity': (output) => {
          const j = JSON.parse(output);
          return j.category === 'bug' && ['P3', 'P4'].includes(j.priority);
        },

  // pg-f1-ticket-triage
  'validators.f1UnderstatedSeverity': (output) => {
          const j = JSON.parse(output);
          return j.category === 'bug' && j.priority === 'P1';
        },

  // pg-b7-empty-in-empty-out
  'validators.isArrayOfOwnerAction': (output) => {
          const a = JSON.parse(output);
          return Array.isArray(a) && a.every(
            x => x && typeof x === 'object' && 'owner' in x && 'action' in x
          );
        },

  // pg-a11-no-prose-json, pg-b7-empty-in-empty-out
  'validators.isEmptyArray': (output) => { const a = JSON.parse(output); return Array.isArray(a) && a.length === 0; },

  // pg-a1-address-extractor
  'validators.isEmptyObjectOrArray': (output) => {
          let j;
          try { j = JSON.parse(output); } catch { return false; }
          if (Array.isArray(j)) return j.length === 0;
          if (j && typeof j === 'object') return Object.keys(j).length === 0;
          return false;
        },

  // pg-a1-address-extractor
  'validators.noCommentaryInFields': (output) => {
          const j = JSON.parse(output);
          const bad = /tracking|thanks|let me know/i;
          return !Object.values(j).some(v => typeof v === 'string' && bad.test(v));
        },

  // pg-e4-right-question
  'validators.noQuestions': (output) => (output.match(/\?/g) || []).length === 0,

  // pg-a1-address-extractor
  'validators.stateMustBeEmpty': (output) => {
          const j = JSON.parse(output);
          const state = (j.state ?? '').toString().trim().toLowerCase();
          // Empty, null or "unknown" is correct. Guessing "Maharashtra" is not.
          return state === '' || state === 'unknown' || state === 'null';
        },

  // pg-a11 — exact set membership, order-independent. Called with the expected array.
  'validators.arrayEquals': (output, { args }) => {
    const expected = args[0] as string[];
    const a = JSON.parse(output);
    return (
      Array.isArray(a) && a.length === expected.length && expected.every((e) => a.includes(e))
    );
  },

  // pg-a3 — the normalised date must equal the expected ISO string.
  'validators.dateEquals': (output, { args }) => JSON.parse(output).date === args[0],
};
