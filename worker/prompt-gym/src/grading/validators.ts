import type { ValidatorRegistry } from './types';

/** Named validators, compiled into the bundle. Challenge data selects from this map
 *  by `ref` and can never supply a function body, so there is no path from data to
 *  executed code.
 *
 *  These are ports of the bodies documented in each challenge's `$validators` block.
 *  Several parse without guarding — that is faithful to the source and safe here,
 *  because the grading engine treats a throw as an errored assertion rather than
 *  letting it escape. Do not "fix" them defensively; the challenge YAML is the
 *  source of truth and divergence would change what a challenge actually tests.
 *
 *  The remaining validators from the other ten challenges land in M1b, when
 *  build/convert.mjs extracts every `# ref:` body and checks it exists here. */
export const validators: ValidatorRegistry = {
  // pg-a1 — extracted values must not carry conversational text from the input.
  'validators.noCommentaryInFields': (output) => {
    const parsed = JSON.parse(output) as Record<string, unknown>;
    const bad = /tracking|thanks|let me know/i;
    return !Object.values(parsed).some((v) => typeof v === 'string' && bad.test(v));
  },

  // pg-a1 — an input with no address must produce an empty object or array.
  'validators.isEmptyObjectOrArray': (output) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(output);
    } catch {
      return false;
    }
    if (Array.isArray(parsed)) return parsed.length === 0;
    if (parsed && typeof parsed === 'object') return Object.keys(parsed).length === 0;
    return false;
  },

  // pg-a1 — a field absent from the input must be left empty, never guessed.
  'validators.stateMustBeEmpty': (output) => {
    const parsed = JSON.parse(output) as { state?: unknown };
    const state = (parsed.state ?? '').toString().trim().toLowerCase();
    return state === '' || state === 'unknown' || state === 'null';
  },
};
