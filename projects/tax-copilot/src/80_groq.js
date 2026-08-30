/* ============================================================================
   EXPLANATION + EDIT LAYER — the only part that touches a network, and the
   only part that may be switched off without breaking anything.

   What it never receives: the payslip, the uploaded file, any name, PAN, UAN,
   employee code or bank detail. The parser runs locally and those fields are
   never even extracted. What it does receive: the computed numbers and the
   current value of every editable input — the same numbers already on screen.

   What the model may never do: arithmetic. It classifies what the person
   wants (a question vs. an instruction to change something) and, for a
   change, extracts the field and the amount they stated — but the amount is
   copied verbatim, and applying it (set vs. add to the current value) is
   done by this app's own code in 70_ui.js, never by the model. See
   applyActions() there and ALLOWED_FIELDS in the worker for the shared
   contract.
   ========================================================================== */

/* A small Cloudflare Worker holds the real Groq key server-side (see
   /worker/tax-copilot-groq in the arjunuvacha repo) so a visitor gets a
   working chat with zero setup, and the key is never shipped to the browser.
   The system prompt and response schema live there, not here, so most
   behaviour tweaks are a worker deploy, not a rebuild of this file. */
const TAXCOPILOT_WORKER = 'https://tax-copilot-groq.harisharjun127.workers.dev';

/* Every editable figure this person has entered so far, at its current
   value — sent alongside the computed numbers so the model can both answer
   "what's my declared ELSS" accurately and reason about edits without ever
   being asked to invent or recall a number itself. */
function editableInputs(p) {
  const b = p.deductions.s80C_breakdown || {};
  const s80cOther = b.other != null ? b.other : (p.deductions.s80C_other || 0);
  return {
    bonus: p.salary.bonus,
    homeLoanInterest: p.deductions.homeLoanInterest,
    s80D: p.deductions.s80D,
    s80CCD1B: p.deductions.s80CCD1B,
    s80E: p.deductions.s80E,
    s80G: p.deductions.s80G,
    s80C: {
      elss: b.elss || 0, ppf: b.ppf || 0, lic: b.lic || 0,
      tuition: b.tuition || 0, homeLoanPrincipal: b.homeLoanPrincipal || 0,
      other: s80cOther
    },
    savingsInterest: p.otherIncome.savingsInterest,
    fdInterest: p.otherIncome.fdInterest,
    rentPaid: p.deductions.rentPaid,
    rentMonthly: Math.round((p.deductions.rentPaid || 0) / 12),
    metro: !!p.deductions.metro
  };
}

/* A PII-free snapshot: numbers only, nothing that identifies a person. */
function explainContext(state) {
  const c = state.comparison, pack = state.pack;
  const line = r => ({
    regime: r.regimeName,
    grossSalary: r.gross,
    standardDeduction: r.standardDeduction,
    otherIncome: r.otherIncome,
    deductions: r.deductions.map(d => ({ name: d.label, rule: d.rule, allowed: d.amount, claimed: d.claimed, capped: d.capped })),
    totalDeductions: r.deductionTotal,
    taxableIncome: r.taxableIncome,
    taxBeforeRebate: r.baseTax,
    rebate: r.rebate,
    surcharge: r.surcharge,
    cess: r.cess,
    totalTax: r.total
  });
  return {
    taxYear: pack.taxYear,
    statute: pack.statute,
    verdict: c.winner === 'neu' ? 'New regime' : 'Old regime',
    annualSaving: c.saving,
    monthlySaving: Math.round(c.monthlySaving),
    breakEvenDeductionsNeeded: state.breakEven ? state.breakEven.needed : null,
    deductionsFound: c.old.deductionTotal,
    robustness: state.robust ? {
      verdictHoldsAcrossIncomeBand: state.robust.stable,
      bandLow: Math.round(state.robust.low),
      bandHigh: Math.round(state.robust.high),
      flipsAtGrossIncome: state.robust.flipAt ? Math.round(state.robust.flipAt) : null
    } : null,
    newRegime: line(c.neu),
    oldRegime: line(c.old),
    outOfScope: state.profile.outOfScope,
    inputs: editableInputs(state.profile)
  };
}

/* Returns { ok, text, actions } on success — actions is always an array
   (empty for a plain question), never trusted further than "a candidate
   the caller must still validate" (see applyActions() in 70_ui.js).
   Returns { ok:false, reason, ... } on any failure so the caller can fall
   back to the offline regex parser and canned reference text. */
async function askExplainer(state, userQuestion, history) {
  try {
    const res = await fetch(TAXCOPILOT_WORKER, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: userQuestion,
        history: history || [],
        context: explainContext(state)
      })
    });
    if (!res.ok) {
      const t = await res.text();
      return { ok: false, reason: 'http', status: res.status, detail: t.slice(0, 400) };
    }
    const j = await res.json();
    if (!j.reply) return { ok: false, reason: 'empty' };
    return { ok: true, text: j.reply.trim(), actions: Array.isArray(j.actions) ? j.actions : [] };
  } catch (e) {
    return { ok: false, reason: 'network', detail: String(e.message || e) };
  }
}

/* Pre-written fallbacks. The product must read correctly with the model off. */
function fallbackExplain(topicId, pack) {
  const c = (pack.catalogue || []).find(x => x.id === topicId);
  if (c) return c.label + ' — ' + c.rule + '. ' + c.note;
  return 'The explanation layer needs the backend reachable. Everything else on this page is computed locally and is unaffected.';
}
