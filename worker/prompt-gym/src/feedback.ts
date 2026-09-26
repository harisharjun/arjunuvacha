/** Feedback from signed-in players: validated, stored, then emailed to Arjun.
 *
 *  Stored first and emailed second, on purpose. The row is the record; the email
 *  is a notification about it. If Resend is down, or its key was never set, the
 *  message is still in D1 with `notified = 0` — so the player is told "sent" only
 *  once it is safe, and never because an email happened to go out.
 *
 *  Signed-in only (enforced in index.ts), which is what makes a reply possible:
 *  the address comes from the verified Google token, never from the form, so it
 *  cannot be used to send mail to somebody else. */

export const MAX_FEEDBACK_CHARS = 2000;

/** Per player. Enough to report a bug and follow up on it; not enough to use this
 *  as a way to fill someone's inbox. */
export const FEEDBACK_LIMITS = [
  { scope: 'hour' as const, limit: 5 },
  { scope: 'day' as const, limit: 20 },
];

/** `onboarding@resend.dev` works with no domain set up, but Resend will only
 *  deliver it to the address the Resend account was registered with. Which is
 *  exactly the one recipient this needs. */
export const DEFAULT_FROM = 'PromptGym <onboarding@resend.dev>';

const RESEND_URL = 'https://api.resend.com/emails';
const SEND_TIMEOUT_MS = 8_000;

/** Only the site's own paths are kept. Anything else is dropped rather than
 *  rejected: the page is context for Arjun, and a player should never be refused
 *  over it. */
const PAGE = /^\/prompt-gym(\/[A-Za-z0-9/-]*)?$/;

export interface FeedbackInput {
  message: string;
  page: string | null;
  challengeId: string | null;
}

export type FeedbackParse = { ok: true; value: FeedbackInput } | { ok: false; error: string };

/** Pure: turns an untrusted request body into something safe to store. */
export function parseFeedback(body: unknown, knownChallenge: (id: string) => boolean): FeedbackParse {
  const b = (body ?? {}) as Record<string, unknown>;
  if (typeof b.message !== 'string') return { ok: false, error: 'message_required' };

  const message = b.message.trim();
  if (message.length === 0) return { ok: false, error: 'message_required' };
  if (message.length > MAX_FEEDBACK_CHARS) return { ok: false, error: 'message_too_long' };

  const page = typeof b.page === 'string' && b.page.length <= 120 && PAGE.test(b.page) ? b.page : null;
  const challengeId =
    typeof b.challengeId === 'string' && knownChallenge(b.challengeId) ? b.challengeId : null;

  return { ok: true, value: { message, page, challengeId } };
}

export interface FeedbackRow extends FeedbackInput {
  id: string;
  uid: string;
  email: string | null;
  displayName: string | null;
}

export async function insertFeedback(db: D1Database, row: FeedbackRow): Promise<void> {
  await db
    .prepare(
      `INSERT INTO feedback (id, uid, email, display_name, message, page, challenge_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(row.id, row.uid, row.email, row.displayName, row.message, row.page, row.challengeId)
    .run();
}

export async function markNotified(db: D1Database, id: string): Promise<void> {
  await db.prepare('UPDATE feedback SET notified = 1 WHERE id = ?').bind(id).run();
}

/** A header value cannot carry a line break, and a subject line should be short. */
function oneLine(text: string, max: number): string {
  return text.replace(/[\r\n]+/g, ' ').trim().slice(0, max);
}

/** Pure: the email Arjun receives. Plain text, not HTML — the message is whatever
 *  a player typed, and plain text cannot carry markup or tracking into an inbox. */
export function feedbackEmail(
  row: FeedbackRow,
  opts: { from: string; to: string; challengeTitle?: string; now?: Date },
) {
  const who = row.displayName || 'A signed-in player';
  const lines = [
    row.message,
    '',
    '---',
    `From: ${who}${row.email ? ` <${row.email}>` : ''}`,
    `Player id: ${row.uid}`,
  ];
  if (row.page) lines.push(`Page: https://arjunuvacha.com${row.page}`);
  if (row.challengeId) lines.push(`Challenge: ${opts.challengeTitle ?? row.challengeId} (${row.challengeId})`);
  lines.push(`Sent: ${(opts.now ?? new Date()).toISOString()}`, `Feedback id: ${row.id}`);

  return {
    from: opts.from,
    to: [opts.to],
    subject: oneLine(`PromptGym feedback from ${who}`, 120),
    text: lines.join('\n'),
    // Replying in Gmail goes straight to the player. Absent if their token had no
    // email, in which case the player id is the way to find them.
    ...(row.email ? { reply_to: oneLine(row.email, 254) } : {}),
  };
}

/** Sends one notification. Returns whether Resend accepted it — never throws, and
 *  never lets the API key near a return value, a log line or an error message. */
export async function sendFeedbackEmail(opts: {
  apiKey: string;
  email: ReturnType<typeof feedbackEmail>;
  fetchImpl?: typeof fetch;
}): Promise<boolean> {
  const doFetch = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
  try {
    const res = await doFetch(RESEND_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${opts.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(opts.email),
      signal: controller.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
