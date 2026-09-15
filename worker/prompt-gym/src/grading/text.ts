function tokenise(text: string): string[] {
  return text.toLowerCase().split(/\s+/).filter(Boolean);
}

export function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  // Single row rather than a full matrix — the Worker has a memory budget and
  // only the previous row is ever needed.
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);

  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const substitution = previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1);
      const insertion = current[j - 1] + 1;
      const deletion = previous[j] + 1;
      current[j] = Math.min(substitution, insertion, deletion);
    }
    previous = current;
  }

  return previous[b.length];
}

/** 0–1, where 1 is identical. Two empty strings are identical, not undefined. */
export function levenshteinSimilarity(expected: string, actual: string): number {
  const longest = Math.max(expected.length, actual.length);
  if (longest === 0) return 1;
  return 1 - levenshteinDistance(expected, actual) / longest;
}

function ngrams(tokens: string[], n: number): string[] {
  if (n <= 1) return tokens;
  const out: string[] = [];
  for (let i = 0; i + n <= tokens.length; i++) {
    out.push(tokens.slice(i, i + n).join(' '));
  }
  return out;
}

/** ROUGE-N recall: what fraction of the reference's n-grams the output reproduces.
 *  Counts multiplicity, so repeating one matching word does not inflate the score. */
export function rougeN(expected: string, actual: string, n = 1): number {
  const reference = ngrams(tokenise(expected), n);
  if (reference.length === 0) return 0;

  const available = new Map<string, number>();
  for (const gram of ngrams(tokenise(actual), n)) {
    available.set(gram, (available.get(gram) ?? 0) + 1);
  }

  let matched = 0;
  for (const gram of reference) {
    const remaining = available.get(gram) ?? 0;
    if (remaining > 0) {
      matched++;
      available.set(gram, remaining - 1);
    }
  }

  return matched / reference.length;
}
