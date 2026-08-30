/**
 * tax-copilot-groq — Cloudflare Worker powering "Ask the Copilot" on the
 * Tax Regime Copilot (arjunuvacha.com/tax-copilot).
 *
 *   POST /   { message, context, history }  ->  { reply, actions }
 *   GET  /   -> health check (visit in a browser to diagnose)
 *
 * `context` is the tax-copilot app's own PII-free snapshot — the completed
 * computation (see `computation` below) plus every editable input at its
 * current value (see `inputs`) — figures already on screen, never the
 * uploaded document, never a name or PAN. This worker never receives
 * either of those; there is nothing here to leak even if it did.
 *
 * `history` is the last few turns of this same chat (plain {role,content}
 * pairs, no JSON context repeated per turn) — enough for the model to
 * resolve "those"/"it"/a short reply against what was just discussed,
 * without re-litigating older turns as fresh instructions.
 *
 * This is the single place that decides "is this a question or an edit" —
 * the model classifies intent AND extracts the structured fields, but never
 * performs the arithmetic itself. `actions` names a field, an operation
 * (set/add) and the amount the person stated verbatim; the client applies
 * that to whatever it already has stored and recomputes with the real
 * engine. The model is never trusted with a running total.
 *
 * The four rules this must never break (see /projects/tax-copilot/README.md):
 *   1. The model never does arithmetic — every number in `reply` must come
 *      from `context`, and every `actions[].amount` must be a number the
 *      person actually typed, never inferred or computed.
 *   2. It never invents a deduction, section or limit not present in `context`.
 *   3. It never receives the payslip, a name, PAN, UAN or bank detail.
 *   4. The app must keep working with this worker unreachable — the client
 *      falls back to a small deterministic regex parser and a built-in
 *      reference (see tryApplyEdit()/localAnswer() in src/70_ui.js).
 *
 * Secret: GROQ_API_KEY. Vars: AIG_ACCOUNT, AIG_GATEWAY (Cloudflare AI Gateway).
 * Same pattern as arjun-rag / vani's gita-rag worker.
 */
// The only chat model actually enabled on this account/gateway — llama
// alternatives 404 here (model_not_found), so this is not a free choice.
// It's a reasoning model, and this account's Groq tier caps it at 8000
// tokens/minute — shared across every AI feature on this Cloudflare account
// (vani, arjun-rag, this one) — with a chunk of every call's budget going
// to hidden "thinking" tokens before it ever writes the JSON. REASONING_EFFORT
// below turns that down, since classifying question-vs-edit and extracting
// a field/amount doesn't need deep reasoning.
const CHAT_MODEL = "openai/gpt-oss-120b";
const REASONING_EFFORT = "low";

// Keep in sync with FIELD_SETTERS in src/70_ui.js — this is the only set of
// keys the client's applyActions() will accept, so anything else is a no-op.
// "rentMonthly" and "rentPaid" are deliberately both here rather than making
// the model convert one to the other — people naturally say rent per month,
// but the app stores it per year, and multiplying by 12 is arithmetic the
// model must never be asked to do. It copies whichever unit the person
// actually used; the client does the ×12 itself.
const ALLOWED_FIELDS = [
  "bonus", "homeLoanInterest", "s80D", "s80CCD1B", "s80E", "s80G",
  "s80C.elss", "s80C.ppf", "s80C.lic", "s80C.tuition", "s80C.homeLoanPrincipal", "s80C.other",
  "savingsInterest", "fdInterest", "rentPaid", "rentMonthly"
];

function groqBase(env) {
  if (env.AIG_ACCOUNT && env.AIG_GATEWAY)
    return `https://gateway.ai.cloudflare.com/v1/${env.AIG_ACCOUNT}/${env.AIG_GATEWAY}/groq`;
  return "https://api.groq.com/openai/v1";
}
function groqHeaders(env) {
  const h = {
    "Authorization": "Bearer " + (env.GROQ_API_KEY || "").trim(),
    "Content-Type": "application/json",
    "Accept": "application/json",
    "User-Agent": "arjunuvacha/1.0 (+https://arjunuvacha.com)",
  };
  if (env.AIG_TOKEN) h["cf-aig-authorization"] = "Bearer " + env.AIG_TOKEN.trim();
  return h;
}

const SYSTEM_PROMPT = [
  'You help a salaried Indian person, who has no chartered accountant, understand an already-completed old-vs-new tax regime computation, and you can apply changes to their inputs on their behalf.',
  '',
  'Before the person\'s latest message, you may see earlier turns of this same conversation (oldest first) — use them ONLY to resolve what a pronoun or short reply refers to ("those", "it", "that one", "no I don\'t"). Never treat something said two or more turns ago as a fresh instruction to repeat. The JSON given with the LATEST message is always the current, authoritative state — if an earlier turn mentioned a number, and "inputs" now shows something different, "inputs" is correct.',
  '',
  'You are given two JSON objects with the latest message:',
  '- "computation": the completed regime comparison — totals, deductions, robustness. Numbers only, already computed. Never recompute or second-guess these.',
  '- "inputs": every editable figure this person has entered so far, at its current value (0 if not entered).',
  '',
  'Respond with ONLY one JSON object, no markdown fences, no other text, matching exactly this shape:',
  '{"reply": "<plain-English text>", "actions": [{"field": "<field key>", "op": "set"|"add", "amount": <number>}]}',
  '',
  'RULES:',
  '1. If the message is a question (not an instruction to change something), "actions" MUST be []. Answer "reply" using ONLY numbers present in "computation" or "inputs" — if a number was not given to you, say plainly that you do not have it. Never compute, estimate, or infer a number yourself.',
  '2. If the message instructs you to add, invest, put, contribute, top up, increase, change, update, set, or make one of the fields below a certain amount, emit one action per distinct instruction. "amount" must be exactly the number the person stated — copy it, never adjust, round, or combine it with anything from "inputs". "reply" should be one short confirmation sentence naming what changes, not a restatement of the whole verdict.',
  '3. "op" is "add" for add/invest/put/contribute/top-up/increase language, and "set" for change/update/set/make/edit language. If the phrasing is ambiguous about which, use "set".',
  '4. Allowed field keys — use exactly one of these strings, nothing else, nothing invented: ' + ALLOWED_FIELDS.join(', ') + '. "s80C.*" fields are the itemised Section 123 (old 80C) sub-categories; use "s80C.other" only when no more specific one fits. For rent: if the person states a monthly figure (the natural way most people say it, e.g. "rent is 35000 a month"), use "rentMonthly" with that exact monthly number — do NOT multiply it by 12 yourself. Only use "rentPaid" if they explicitly state an annual figure. Never convert between the two; copy exactly what they said.',
  '5. If a message both asks something and requests a change, include both: the action(s) for the change, and a "reply" that briefly does both — answers the question and confirms the change.',
  '6. Never invent a deduction, section, limit, or eligibility rule not present in "computation" or "inputs".',
  '7. If the question or instruction is outside salaried income tax — capital gains, business income, foreign assets, residency, or anything needing documents you were not given — set "actions" to [] and say plainly this tool does not cover it and needs a CA.',
  '8. You are not a chartered accountant and this is not tax advice. Do not tell anyone what to do with their money; explain what the computation says.',
  '9. If you are not confident which field(s) a message refers to, or whether it is asking for a change at all — even after reading the earlier turns — set "actions" to [] and ask a short clarifying question in "reply" instead of guessing. NEVER touch a field just because it was recently mentioned, suggested, or edited, unless the person is clearly talking about that exact field. A reply like "I don\'t have those" about deductions the person doesn\'t hold is NOT an instruction to change anything — it means no action is needed.',
  '',
  'STYLE for "reply": plain English, no jargon without a one-line gloss, Indian number formatting (₹1,35,200 and lakhs). One or two short SENTENCES, hard limit — never a list, never one item per line, no matter how broad the question. For something broad like "what else can I add" or "what deductions are available", just name up to three category names in a single sentence (e.g. "You could still add 80D health insurance, 80E education loan interest, or 80G donations.") and stop there — do not restate each one\'s rule, section number, or cap; the on-screen table already has that.',
  '',
  'Section numbers changed on 1 April 2026 under the Income-tax Act 2025: 80C is now Section 123, 80D is Section 126, standard deduction is Section 19, home-loan interest is Section 22, the rebate is Section 156. Use both names the first time, like "80C, now Section 123".'
].join('\n');

export default {
  async fetch(request, env) {
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });
    if (request.method === "GET") return health(env, cors);
    if (request.method !== "POST") return json({ error: "POST only" }, 405, cors);
    let body; try { body = await request.json(); } catch { return json({ error: "bad json" }, 400, cors); }
    return ask(body, env, cors);
  },
};

async function health(env, cors) {
  const out = { ok: true, chatModel: CHAT_MODEL, hasGroqKey: !!env.GROQ_API_KEY,
    usingGateway: !!(env.AIG_ACCOUNT && env.AIG_GATEWAY), groqBase: groqBase(env) };
  try {
    const g = await fetch(groqBase(env) + "/chat/completions", {
      method: "POST", headers: groqHeaders(env),
      body: JSON.stringify({ model: CHAT_MODEL, max_tokens: 5, messages: [{ role: "user", content: "say ok" }] }),
    });
    out.groqTest = g.ok ? "OK" : (g.status + " " + (await g.text()).slice(0, 150));
  } catch (e) { out.groqTest = "fetch_failed " + String(e).slice(0, 100); }
  return json(out, 200, cors);
}

async function ask(body, env, cors) {
  const message = String(body.message || "").slice(0, 600);
  if (!message) return json({ error: "empty message" }, 400, cors);
  if (!env.GROQ_API_KEY) return json({ error: "worker not configured (no GROQ_API_KEY)" }, 500, cors);

  // context is the app's own PII-free snapshot — cap its size defensively,
  // but never try to interpret or recompute it here.
  let contextJson;
  try { contextJson = JSON.stringify(body.context || {}).slice(0, 10000); }
  catch { contextJson = "{}"; }

  // Prior turns of this same chat, plain text only (no JSON context repeated
  // per turn — only the latest gets that, since it's the only one guaranteed
  // fresh). This is what lets "I don't have those" resolve against the
  // previous reply instead of the model guessing a field to touch.
  const history = sanitizeHistory(body.history);

  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    ...history,
    { role: "user", content:
      "Here is the current state as JSON:\n\n" + contextJson +
      "\n\nThe person says: " + message }
  ];

  // CHAT_MODEL is a reasoning model — some of its output budget is spent on
  // internal reasoning before the final JSON, invisible to us, so even a
  // properly brief reply can occasionally get cut off mid-document and fail
  // Groq's strict JSON-mode validator (json_validate_failed). One retry with
  // a materially larger budget resolves that without falling all the way
  // back to the canned local answer for what was a perfectly good question.
  let result = await callGroq(env, messages, 700);
  if (!result.ok && result.code === "json_validate_failed") {
    result = await callGroq(env, messages, 1400);
  }
  // This account's Groq tier caps CHAT_MODEL at 8000 tokens/minute, shared
  // across every AI feature on this Cloudflare account — a burst of chat
  // messages (here, or on vani/arjun-rag) can genuinely exhaust it. Groq's
  // own 429 body says exactly how long until the window clears; wait that
  // long (capped, so one request never hangs for long) and try once more
  // rather than surfacing a hard error for what is just momentary traffic.
  if (!result.ok && result.groqStatus === 429 && result.retryAfterMs != null) {
    await sleep(Math.min(2500, result.retryAfterMs + 150));
    result = await callGroq(env, messages, 700);
  }
  if (!result.ok) return json({ error: result.error, detail: result.detail }, result.status || 502, cors);
  return json({ reply: result.reply, actions: result.actions }, 200, cors);
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function callGroq(env, messages, maxTokens) {
  const groqBody = {
    model: CHAT_MODEL,
    temperature: 0.1,
    max_tokens: maxTokens,
    reasoning_effort: REASONING_EFFORT,
    response_format: { type: "json_object" },
    messages
  };
  try {
    const res = await fetch(groqBase(env) + "/chat/completions", {
      method: "POST", headers: groqHeaders(env), body: JSON.stringify(groqBody),
    });
    if (!res.ok) {
      const t = await res.text();
      let code, retryAfterMs = null;
      try {
        const errObj = JSON.parse(t).error;
        code = errObj.code;
        const m = /try again in ([\d.]+)\s*s/i.exec(errObj.message || "");
        if (m) retryAfterMs = Math.round(parseFloat(m[1]) * 1000);
      } catch {}
      return { ok: false, error: "groq_http_" + res.status, detail: t.slice(0, 300), status: 502, code, groqStatus: res.status, retryAfterMs };
    }
    const j = await res.json();
    const raw = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
    if (!raw) return { ok: false, error: "empty completion", status: 502 };

    let parsed;
    try { parsed = JSON.parse(raw); }
    catch { return { ok: true, reply: raw.trim(), actions: [] }; } // model ignored json mode — degrade to plain text, no actions

    const reply = typeof parsed.reply === "string" ? parsed.reply.trim() : "";
    const actions = sanitizeActions(parsed.actions);
    if (!reply && !actions.length) return { ok: false, error: "empty completion", status: 502 };
    return { ok: true, reply: reply || "Done.", actions };
  } catch (e) {
    return { ok: false, error: "fetch_failed", detail: String(e.message || e).slice(0, 200), status: 502 };
  }
}

/* Bounded on purpose: this account's Groq tier is tight (see CHAT_MODEL
   above), and history tokens compete with everything else in the same
   per-minute budget. A handful of recent turns is enough to resolve "those"
   or "it" — this is not meant to be a full transcript. */
function sanitizeHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter(h => h && (h.role === "user" || h.role === "assistant") && typeof h.content === "string" && h.content.trim())
    .slice(-8)
    .map(h => ({ role: h.role, content: h.content.slice(0, 300) }));
}

/* Defense in depth: the client re-validates independently, but a worker
   should never forward garbage either. Anything not exactly matching the
   allowed shape is dropped rather than passed through. */
function sanitizeActions(actions) {
  if (!Array.isArray(actions)) return [];
  return actions
    .filter(a => a && typeof a === "object")
    .filter(a => ALLOWED_FIELDS.indexOf(a.field) >= 0)
    .filter(a => (a.op === "set" || a.op === "add"))
    .filter(a => typeof a.amount === "number" && isFinite(a.amount) && a.amount >= 0)
    .slice(0, 8)
    .map(a => ({ field: a.field, op: a.op, amount: a.amount }));
}

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status, headers: Object.assign({ "Content-Type": "application/json" }, cors)
  });
}
