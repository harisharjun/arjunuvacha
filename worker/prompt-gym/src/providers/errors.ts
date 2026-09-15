/** Upstream failures are `errored`, never `failed`.
 *
 *  A user's prompt must never be scored down because our infrastructure had a bad
 *  moment, so these are modelled as a distinct kind of outcome rather than a low
 *  score. Nothing here ever carries the raw upstream response body: some provider
 *  error shapes echo the request back, API key included. */
export abstract class ProviderError extends Error {
  abstract readonly kind: 'rate-limited' | 'upstream' | 'judge' | 'invalid-request';
  /** True when the run should be recorded as errored rather than scored. */
  readonly errored: boolean = true;
}

/** The caller asked for something impossible before any network call happened.
 *  This one is the user's fault, not the infrastructure's, so it is not `errored`. */
export class InvalidRequestError extends ProviderError {
  readonly kind = 'invalid-request';
  override readonly errored = false;
  constructor(message: string) {
    super(message);
    this.name = 'InvalidRequestError';
  }
}

export class RateLimitedError extends ProviderError {
  readonly kind = 'rate-limited';
  constructor(
    message: string,
    /** Seconds the provider asked us to wait, when it said. */
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'RateLimitedError';
  }
}

export class UpstreamError extends ProviderError {
  readonly kind = 'upstream';
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'UpstreamError';
  }
}

export class JudgeError extends ProviderError {
  readonly kind = 'judge';
  constructor(message: string) {
    super(message);
    this.name = 'JudgeError';
  }
}

/** One test case's execution result.
 *
 *  A discriminated union so an errored case cannot reach the scorer: it carries no
 *  `output` field at all, and the grading engine requires one. The type system,
 *  rather than a convention, is what stops an infrastructure blip being banked as
 *  a real score. */
export type ExecutionOutcome =
  | { status: 'ok'; output: string; promptTokens: number; completionTokens: number }
  | { status: 'errored'; kind: ProviderError['kind']; reason: string };

export function toOutcome(err: unknown): Extract<ExecutionOutcome, { status: 'errored' }> {
  if (err instanceof ProviderError) {
    return { status: 'errored', kind: err.kind, reason: err.message };
  }
  return { status: 'errored', kind: 'upstream', reason: 'Unexpected failure' };
}
