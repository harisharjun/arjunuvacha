/** Embeddings for the `similar` assertions.
 *
 *  Groq has no embeddings endpoint, so this is Cloudflare Workers AI. Two ways in,
 *  because the same code has to run in two places:
 *
 *    - In the deployed Worker, through the `AI` binding. No token, no account id,
 *      no egress — the platform resolves it.
 *    - On the laptop (`npm run try --live`), through the REST API, which needs a
 *      Cloudflare account id and an API token with Workers AI read.
 *
 *  Both satisfy the same `Embedder` shape, so `run.ts` never knows which it has.
 *  Neither is reachable from `grading/`, which stays pure. */

/** Batch in, vectors out, same order. Throws on failure — the caller turns that
 *  into an `errored` assertion rather than a zero score. */
export type Embedder = (texts: string[]) => Promise<number[][]>;

/** bge-base-en-v1.5: 768 dimensions, on Workers AI's free allowance. Pinned
 *  because changing the model changes every similarity score, and therefore every
 *  historical grade it would be compared against. */
export const EMBEDDING_MODEL = '@cf/baai/bge-base-en-v1.5';

/** The `AI` binding's shape, narrowed to what we call. Declared here rather than
 *  depending on the full Workers AI types, which move faster than this file. */
export interface AiBinding {
  run(model: string, inputs: { text: string[] }): Promise<{ data: number[][] }>;
}

function checkShape(data: unknown, expected: number): number[][] {
  if (!Array.isArray(data) || data.length !== expected) {
    throw new Error(`Embeddings: expected ${expected} vectors, got ${Array.isArray(data) ? data.length : typeof data}`);
  }
  for (const v of data) {
    if (!Array.isArray(v) || v.length === 0 || !v.every((n) => typeof n === 'number' && Number.isFinite(n))) {
      throw new Error('Embeddings: a vector came back malformed');
    }
  }
  return data as number[][];
}

/** The in-Worker path. */
export function bindingEmbedder(ai: AiBinding): Embedder {
  return async (texts) => {
    const res = await ai.run(EMBEDDING_MODEL, { text: texts });
    return checkShape(res?.data, texts.length);
  };
}

/** The laptop path. Never used by the deployed Worker — it would mean paying for
 *  egress to reach a binding that is already attached. */
export function restEmbedder(
  accountId: string,
  apiToken: string,
  fetchImpl: typeof fetch = fetch,
): Embedder {
  return async (texts) => {
    const res = await fetchImpl(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${EMBEDDING_MODEL}`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: texts }),
      },
    );

    if (!res.ok) {
      // Deliberately not the body: a Cloudflare error can echo the request back,
      // and the request carries the token.
      throw new Error(`Workers AI returned ${res.status}`);
    }

    const json = (await res.json()) as { result?: { data?: unknown } };
    return checkShape(json?.result?.data, texts.length);
  };
}
