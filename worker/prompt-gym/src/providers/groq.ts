import type { Provider } from '../models';
import {
  InvalidRequestError,
  JudgeError,
  RateLimitedError,
  UpstreamError,
} from './errors';

const MAX_PROMPT_CHARS = 2000;
const TIMEOUT_MS = 20_000;
/** A provider can ask us to wait a very long time; we would rather fail fast than
 *  hold a request open for minutes. */
const MAX_RETRY_WAIT_MS = 10_000;
const DEFAULT_TEMPLATE = '{{userPrompt}}\n\n---\nINPUT:\n{{input}}';

export interface GatewayConfig {
  account?: string;
  gateway?: string;
  token?: string;
}

export interface GroqCallOptions {
  apiKey: string;
  model: string;
  /** Groq by default. OpenAI speaks the same chat-completions format, so one
   *  client serves both; only the base URL and two body fields differ. */
  provider?: Provider;
  maxOutputTokens?: number;
  /** The GPT-OSS models reason before answering, and reasoning is billed against
   *  the same `max_tokens` as the answer. At the default effort a 192-token cap can
   *  be consumed entirely by reasoning, returning an empty answer with
   *  `finish_reason: "length"` — which would be scored as a failing prompt when it
   *  is really our cap. Low effort keeps the budget for the answer. */
  reasoningEffort?: 'low' | 'medium' | 'high';
  gateway?: GatewayConfig;
  /** Injected in tests. Unit tests must never reach the real API. */
  fetchImpl?: typeof fetch;
  /** Injected in tests so retry logic does not actually sleep. */
  sleepImpl?: (ms: number) => Promise<void>;
}

/** Routes through the Cloudflare AI Gateway when configured — same gateway as the
 *  other workers, which is what gives one dashboard for every Groq call. */
export function groqBaseUrl(gateway?: GatewayConfig): string {
  return providerBaseUrl('groq', gateway);
}

/** Both providers route through the same Cloudflare AI Gateway when it is
 *  configured, so logging, caching and analytics stay in one place. */
export function providerBaseUrl(provider: Provider, gateway?: GatewayConfig): string {
  if (gateway?.account && gateway?.gateway) {
    return `https://gateway.ai.cloudflare.com/v1/${gateway.account}/${gateway.gateway}/${provider}`;
  }
  return provider === 'openai' ? 'https://api.openai.com/v1' : 'https://api.groq.com/openai/v1';
}

const LABEL: Record<Provider, string> = { groq: 'Groq', openai: 'OpenAI' };

/** The request body. gpt-4.1 is not a reasoning model and rejects
 *  `reasoning_effort`; OpenAI also names the output cap `max_completion_tokens`. */
function requestBody(messages: { role: string; content: string }[], options: GroqCallOptions) {
  const base = { model: options.model, messages, temperature: 0 };
  const cap = options.maxOutputTokens ?? 192;
  if (options.provider === 'openai') return { ...base, max_completion_tokens: cap };
  return { ...base, max_tokens: cap, reasoning_effort: options.reasoningEffort ?? 'low' };
}

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds;
  const date = Date.parse(header);
  if (!Number.isNaN(date)) return Math.max(0, (date - Date.now()) / 1000);
  return undefined;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface ChatResult {
  content: string;
  promptTokens: number;
  completionTokens: number;
  /** The model hit the output cap. Distinct from a wrong answer, and worth telling
   *  the user: their prompt produced more output than the challenge allows. */
  truncated: boolean;
  reasoningTokens: number;
}

/** One chat-completions call, with the timeout and the single 429 retry.
 *
 *  Deliberately never reads the response body into an error message: some provider
 *  error shapes include the submitted request, and the Authorization header with
 *  it. Status codes only. */
async function chat(
  messages: { role: string; content: string }[],
  options: GroqCallOptions,
  attempt = 0,
): Promise<ChatResult> {
  const doFetch = options.fetchImpl ?? fetch;
  const sleep = options.sleepImpl ?? defaultSleep;
  const provider: Provider = options.provider ?? 'groq';
  const name = LABEL[provider];

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${options.apiKey}`,
  };
  if (options.gateway?.token) {
    headers['cf-aig-authorization'] = `Bearer ${options.gateway.token}`;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let response: Response;
  try {
    response = await doFetch(`${providerBaseUrl(provider, options.gateway)}/chat/completions`, {
      method: 'POST',
      headers,
      signal: controller.signal,
      body: JSON.stringify(requestBody(messages, options)),
    });
  } catch (err) {
    // An abort is our own timeout firing, not a provider error, but both are
    // infrastructure rather than the user's prompt.
    const aborted = err instanceof Error && err.name === 'AbortError';
    throw new UpstreamError(aborted ? `${name} request timed out after ${TIMEOUT_MS}ms` : `${name} request failed`);
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 429) {
    const retryAfter = parseRetryAfter(response.headers.get('retry-after'));
    if (attempt === 0) {
      await sleep(Math.min((retryAfter ?? 1) * 1000, MAX_RETRY_WAIT_MS));
      return chat(messages, options, 1);
    }
    throw new RateLimitedError(`${name} rate limit reached`, retryAfter);
  }

  if (response.status >= 500) {
    throw new UpstreamError(`${name} returned ${response.status}`, response.status);
  }

  if (!response.ok) {
    throw new UpstreamError(`${name} rejected the request with ${response.status}`, response.status);
  }

  let body: {
    choices?: { message?: { content?: string }; finish_reason?: string }[];
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      completion_tokens_details?: { reasoning_tokens?: number };
    };
  };
  try {
    body = (await response.json()) as typeof body;
  } catch {
    throw new UpstreamError(`${name} returned a response that was not JSON`);
  }

  const content = body.choices?.[0]?.message?.content;
  if (typeof content !== 'string') {
    throw new UpstreamError(`${name} returned no message content`);
  }

  return {
    content,
    promptTokens: body.usage?.prompt_tokens ?? 0,
    completionTokens: body.usage?.completion_tokens ?? 0,
    truncated: body.choices?.[0]?.finish_reason === 'length',
    reasoningTokens: body.usage?.completion_tokens_details?.reasoning_tokens ?? 0,
  };
}

export interface ExecuteOptions extends GroqCallOptions {
  /** The player's submitted prompt. */
  prompt: string;
  /** The challenge's hidden test input. */
  input: string;
  /** The challenge harness; identical across challenges so players learn one shape. */
  template?: string;
}

export async function execute(options: ExecuteOptions): Promise<ChatResult> {
  // Checked before any network call: a prompt over the cap costs nothing to reject
  // and must never consume budget. Enforced here as well as in the editor, because
  // the editor is not a security boundary.
  if (options.prompt.length > MAX_PROMPT_CHARS) {
    throw new InvalidRequestError(
      `Prompt is ${options.prompt.length} characters; the limit is ${MAX_PROMPT_CHARS}`,
    );
  }

  // One pass, with a function replacer — deliberately not two chained
  // `.replace(string, string)` calls. A string replacement interprets `$&`, `$'`,
  // `` $` `` and `$$`, so a prompt containing "$$" reached the model as "$". And a
  // second pass rescans the first one's output, so a player who typed `{{input}}`
  // in their own prompt had the test input spliced there and the real slot sent
  // as a literal. Substituted text is never looked at again this way.
  const content = (options.template ?? DEFAULT_TEMPLATE).replace(
    /\{\{(userPrompt|input)\}\}/g,
    (_, slot: string) => (slot === 'userPrompt' ? options.prompt : options.input),
  );

  return chat([{ role: 'user', content }], options);
}

export type JudgeVerdict =
  | { pass: boolean; reason: string }
  | { score: number; reason: string };

const JUDGE_SYSTEM =
  'You are grading one model output against a rubric. Reply with JSON only, no prose and no code fences.';

function parseVerdict(raw: string): JudgeVerdict | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.trim());
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;

  const v = parsed as Record<string, unknown>;
  const reason = typeof v.reason === 'string' ? v.reason : '';
  if (typeof v.pass === 'boolean') return { pass: v.pass, reason };
  if (typeof v.score === 'number' && Number.isFinite(v.score)) return { score: v.score, reason };
  return null;
}

export interface JudgeOptions extends GroqCallOptions {
  output: string;
  rubric: string;
  /** Ask for a 0–1 score instead of a pass/fail verdict. */
  wantScore?: boolean;
}

/** The pinned judge. Which model this is, is the house's choice and not the
 *  player's — if everyone graded with a different judge, no two scores would be
 *  comparable and the leaderboard would mean nothing. */
export async function judge(options: JudgeOptions): Promise<JudgeVerdict> {
  const shape = options.wantScore
    ? '{"score": <number between 0 and 1>, "reason": "<one short sentence>"}'
    : '{"pass": <true|false>, "reason": "<one short sentence>"}';

  const ask = (extra: string) => [
    { role: 'system', content: JUDGE_SYSTEM + extra },
    {
      role: 'user',
      content: `RUBRIC:\n${options.rubric}\n\nOUTPUT TO GRADE:\n${options.output}\n\nReply with exactly this JSON shape:\n${shape}`,
    },
  ];

  const first = await chat(ask(''), options);
  const verdict = parseVerdict(first.content);
  if (verdict) return verdict;

  // One retry with a blunter instruction before giving up. A judge that cannot be
  // parsed is an errored assertion, never a failing one.
  const second = await chat(
    ask(' Your previous reply could not be parsed. Output the raw JSON object and nothing else.'),
    options,
  );
  const retried = parseVerdict(second.content);
  if (retried) return retried;

  throw new JudgeError('Judge did not return parseable JSON after a retry');
}
