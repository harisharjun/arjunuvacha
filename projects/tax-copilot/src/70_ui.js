/* ============================================================================
   UI — screens, the scripted chat, and rendering. Every number it displays
   comes from the engine; this file never computes tax.
   ========================================================================== */

/* Only one tax year is offered right now, so there's nothing for a user to
   pick — this is the single source of truth instead of a one-option dropdown. */
const CURRENT_TAX_YEAR = '2026-27';

const S = { profile: null, pack: null, comparison: null, breakEven: null,
            robust: null, pendingQ: null, baselineGap: null, chatHistory: [] };

const $ = id => document.getElementById(id);
const el = (tag, cls, txt) => { const n = document.createElement(tag);
  if (cls) n.className = cls; if (txt !== undefined) n.textContent = txt; return n; };

/* ---------------------------------------------------------- glossary ---- */
/* Plain-English, example-led explanations for anyone who has never filed a
   return before. Keyed by the same ids used as `topic` on interview
   QUESTIONS and as salary field keys. */
const GLOSSARY = {
  basic: { term: 'Basic salary', body:
    'The fixed core of your pay before any allowances. It usually doesn\'t change month to month, and it is the number several other things are calculated from — like how much of your HRA is tax-free, or how much your employer can put into NPS.' },
  hra: { term: 'HRA (House Rent Allowance)', body:
    'An allowance your employer pays you towards rent, shown as a separate line on your payslip. If you actually pay rent, part of it can be tax-free — but the tax-free part is often less than the full HRA on your payslip, because the rule takes the smallest of three numbers: the HRA you receive, your rent minus 10% of basic, and 40% (or 50% in a metro) of basic.\n\nExample: HRA ₹10,000/month, rent ₹12,000/month, basic ₹20,000/month, non-metro. The three numbers are ₹10,000, ₹10,000 (12,000 − 2,000), and ₹8,000 (40% of 20,000). The smallest is ₹8,000 — so only ₹8,000/month is tax-free, not the full ₹10,000.' },
  otherAllowances: { term: 'Other allowances', body:
    'Everything else on your payslip that isn\'t basic, HRA or bonus — special allowance, conveyance, LTA, food coupons, internet/phone reimbursement and similar. Almost all of it is fully taxable in both regimes, so it just adds to your gross income.' },
  bonus: { term: 'Bonus / variable pay', body:
    'Money paid on top of your regular monthly salary — a yearly bonus, a performance payout, or a sales incentive. It is taxed exactly like salary, just usually paid once or twice a year instead of monthly. A single payslip can\'t see it, which is why this tool asks separately.' },
  employerNps: { term: "Employer's NPS contribution", body:
    'Money your company puts into your National Pension System account on your behalf — separate from what you might put in yourself. Unusually, this is one of the very few deductions that survives in the New regime too (capped at 14% of your basic salary), while most old-regime deductions don\'t.' },
  employeePf: { term: 'Your PF (Provident Fund) contribution', body:
    'The slice of your own salary that goes into your retirement PF account every month — usually 12% of basic. It\'s a deduction you never see as take-home pay, but it counts towards the ₹1,50,000 Section 123 (old 80C) limit automatically, often filling a large part of it before you invest anything else.' },
  professionalTax: { term: 'Professional tax', body:
    'A small state-government tax on your employment, usually ₹200/month or less, deducted straight from your payslip. It\'s fully deductible, but only under the Old regime.' },
  s80C: { term: 'Section 123 (old name: 80C)', body:
    'A basket of common long-term investments and payments that together reduce your taxable income by up to ₹1,50,000 a year, only under the Old regime. Your own PF contribution usually already sits inside this basket without you doing anything.\n\nExample: PF of ₹90,000 (from your payslip) + PPF of ₹40,000 + LIC premium of ₹20,000 = ₹1,50,000 — the ceiling is full, so any more in this basket earns you nothing extra.' },
  s80CCD1B: { term: '80CCD(1B) — your own NPS contribution', body:
    'If you personally invest in NPS (not what your employer contributes), up to ₹50,000 of it is deductible — and this is on top of, not inside, the ₹1,50,000 Section 123 basket. It only applies under the Old regime.' },
  s80D: { term: 'Section 126 (old name: 80D) — health insurance premiums', body:
    'Premiums you pay for health insurance. Up to ₹25,000 for yourself and your family, plus another ₹25,000 for your parents\' policy — and each of those becomes ₹50,000 if the person insured is a senior citizen (60+). A company-paid group policy you don\'t pay for doesn\'t count. Old regime only.' },
  homeLoanInterest: { term: 'Home loan interest (Section 22, old name: 24(b))', body:
    'If you have a home loan on the house you actually live in, the interest portion of your EMI (not the principal, and not the full EMI) is deductible up to ₹2,00,000 a year. Your bank\'s provisional interest certificate shows the interest and principal split separately. Old regime only.' },
  s80E: { term: '80E — education loan interest', body:
    'Interest on an education loan for yourself, your spouse or your children is fully deductible with no upper limit, for up to 8 years from when you start repaying. Only the interest counts, not the principal. Old regime only.' },
  s80G: { term: '80G — donations', body:
    'Donations to certain funds (like the PM relief fund or other notified funds) can be 100% deductible with no cap. This tool only handles that "100%, no limit" category — donations to other charities are often only partly deductible up to a percentage of your income, and need a CA to work out. Old regime only.' },
  otherIncome: { term: 'Savings & FD interest', body:
    'Interest your bank pays you on your savings account or fixed deposits. It\'s ordinary taxable income under both regimes — not a deduction — and it\'s one of the most commonly forgotten items, because the tax department already sees it via your AIS (Annual Information Statement) even if you don\'t declare it yourself.' },
  oldRegime: { term: 'Old regime', body:
    'The original tax system with more deductions (HRA, 80C, home loan interest, and more) but higher effective rates before those deductions. It tends to win for people with large deductions — typically renters with a home loan, or big investors in tax-saving schemes.' },
  newRegime: { term: 'New regime', body:
    'The default, simpler system: lower rates, but almost no deductions to claim (only the standard deduction and employer NPS survive). No paperwork, no proofs to submit. It tends to win for people with few deductions.' },
  grossSalary: { term: 'Gross salary', body:
    'Everything your employer pays you as salary, added up — basic, HRA, allowances, bonus, and employer NPS — before any deductions are taken out. It is not the same as CTC: employer PF and gratuity are part of your CTC but are not counted here because they are not paid to you as salary.' },
  standardDeduction: { term: 'Standard deduction (Section 19, old name: 16(ia))', body:
    'A flat amount every salaried person can subtract from their salary before tax, no bills or proof needed. It is bigger under the New regime (₹75,000) than the Old regime (₹50,000) this year — one of the few things that actually favours the New regime.' },
  grossTotalIncome: { term: 'Gross total income', body:
    'Your salary after the standard deduction, plus any other income like bank interest. This is the number deductions (HRA, 80C, 80D and the rest) are subtracted from next, under the Old regime.' },
  taxableIncome: { term: 'Taxable income', body:
    'What is actually left to be taxed — gross total income minus every deduction you are allowed. This is the figure the tax slabs are applied to, and it is usually very different between the two regimes since the Old regime allows far more deductions.' },
  taxOnSlabs: { term: 'Tax on slabs', body:
    'India taxes income in slices, not as one flat rate on everything — for example, under the New regime the first ₹4,00,000 is taxed at 0%, the next ₹4,00,000 at 5%, and so on upward. This row is what those slices add up to before any rebate is applied.' },
  rebate: { term: 'Rebate (Section 156, old name: 87A)', body:
    'A discount that can wipe out your tax completely if your taxable income is low enough — up to ₹12,00,000 under the New regime, or ₹5,00,000 under the Old regime. Just above that threshold, "marginal relief" softens the jump so a few thousand rupees of extra income does not suddenly cost you the whole rebate.' },
  surcharge: { term: 'Surcharge', body:
    'An extra charge on top of your tax, but only once your taxable income crosses a high threshold — starting at ₹50,00,000. Most salaried people never see this row at all; it only appears here because it might apply to you.' },
  cess: { term: 'Health & education cess', body:
    'A flat 4% add-on charged on your tax itself (tax + surcharge), not on your income — it funds health and education spending. Everyone pays it, in both regimes, with no exemption.' },
  totalTax: { term: 'Total tax payable', body:
    'The final amount: tax on slabs, minus any rebate, plus surcharge (if it applies) and the 4% cess. This is what actually gets deducted from your salary across the year via TDS.' },
  s80TTA: { term: '80TTA — savings account interest', body:
    'Up to ₹10,000 of the interest your savings account (not a fixed deposit) earns in a year is deductible under the Old regime. Anything above ₹10,000, and all fixed-deposit interest, is fully taxable regardless.' }
};

function openGlossary(topic) {
  const g = GLOSSARY[topic];
  if (!g) return;
  $('glossary-term').textContent = g.term;
  $('glossary-body').textContent = g.body;
  $('glossary-backdrop').hidden = false;
  $('glossary-modal').hidden = false;
}
function closeGlossary() {
  $('glossary-backdrop').hidden = true;
  $('glossary-modal').hidden = true;
}
/* A small inline "what's this?" button wired to the glossary modal. */
function whatsThisBtn(topic) {
  if (!GLOSSARY[topic]) return null;
  const b = el('button', 'whatsthis', 'What\'s this?');
  b.type = 'button';
  b.addEventListener('click', e => { e.preventDefault(); openGlossary(topic); });
  return b;
}
/* Same thing, compact — a "(?)" circle rather than a full pill, for dense
   contexts like the computation table where a labelled button on every
   row would overwhelm the row itself. */
function whatsThisIcon(topic) {
  if (!GLOSSARY[topic]) return null;
  const b = el('button', 'whatsthis-icon', '?');
  b.type = 'button';
  b.setAttribute('aria-label', 'What is ' + GLOSSARY[topic].term + '?');
  b.addEventListener('click', e => { e.preventDefault(); openGlossary(topic); });
  return b;
}

const PREV_SCREEN = {
  'screen-confirm': 'screen-start',
  'screen-triage': 'screen-confirm',
  'screen-scope': 'screen-triage',
  'screen-interview': 'screen-triage',
  'screen-result': 'screen-interview',
  'screen-manual': 'screen-start'
};
/* Screens where the persistent AI bar makes sense — anything after a document
   or manual entry is underway. Hidden on the very first screen (nothing to
   ask about yet) and on the standalone tests screen. */
const AI_BAR_SCREENS = ['screen-confirm', 'screen-triage', 'screen-scope', 'screen-interview', 'screen-result'];
/* The topbar is now two rows (brand+restart, then Back on its own line when
   present) so its real height varies — the sticky meter below it needs to
   know that height exactly, or it either overlaps or leaves a gap. */
function syncTopbarHeight() {
  const tb = document.querySelector('.topbar');
  if (tb) document.documentElement.style.setProperty('--topbar-h', tb.offsetHeight + 'px');
}
function show(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.toggle('active', s.id === id));
  window.scrollTo({ top: 0, behavior: 'auto' });
  const back = $('btn-back');
  if (back) back.hidden = !PREV_SCREEN[id];
  const bar = $('ai-bar');
  if (bar) bar.hidden = AI_BAR_SCREENS.indexOf(id) < 0;
  syncTopbarHeight();
}
function currentScreenId() {
  const s = document.querySelector('.screen.active');
  return s ? s.id : null;
}
/* Back retains every value already entered — it just re-renders the previous
   step from the same S.profile / S state, rather than resetting anything. */
function goBack() {
  const cur = currentScreenId();
  const prev = PREV_SCREEN[cur];
  if (!prev) return;
  if (prev === 'screen-confirm') return goConfirm(S.profile, S.parsed);
  if (prev === 'screen-triage') return renderTriage();
  if (prev === 'screen-interview') return show('screen-interview'); // chat log stays exactly as it was
  if (prev === 'screen-start') return show('screen-start');
}
function pack() { return RULEPACKS[S.profile.taxYear]; }

/* ---------------------------------------------------------- salary fields */
const SALARY_FIELDS = [
  { k: 'basic', label: 'Basic salary', hint: 'Drives HRA and the NPS caps' },
  { k: 'hra', label: 'House rent allowance', hint: 'What your payslip pays you, not what you claim' },
  { k: 'otherAllowances', label: 'All other allowances', hint: 'Special, conveyance, LTA, flexible benefits' },
  { k: 'bonus', label: 'Bonus / variable pay', hint: 'Annual, if any' },
  { k: 'employerNps', label: "Employer's NPS contribution", hint: 'Counts in both regimes' },
  { k: 'employeePf', label: 'Your PF contribution', hint: 'Already counts inside the ₹1.5L ceiling' },
  { k: 'professionalTax', label: 'Professional tax', hint: 'Old regime only' }
];

function renderFieldGrid(container, profile, onChange, showConfidence) {
  container.innerHTML = '';
  SALARY_FIELDS.forEach(f => {
    const wrap = el('div', 'field');
    const lbl = el('div', 'lbl');
    lbl.appendChild(el('label', null, f.label));
    const wt = whatsThisBtn(f.k);
    if (wt) lbl.appendChild(wt);
    if (showConfidence) {
      const c = (profile.confidence || {})[f.k];
      if (c === undefined) { /* nothing */ }
      else if (c >= 0.8 && profile.salary[f.k] > 0) lbl.appendChild(el('span', 'flagchip ok', 'read'));
      else if (profile.salary[f.k] > 0) lbl.appendChild(el('span', 'flagchip', 'check'));
      else lbl.appendChild(el('span', 'flagchip', 'not found'));
    }
    wrap.appendChild(lbl);
    const inp = el('input'); inp.type = 'number'; inp.min = '0'; inp.step = '1';
    inp.value = Math.round(profile.salary[f.k]) || '';
    inp.setAttribute('aria-label', f.label);
    inp.addEventListener('input', () => {
      profile.salary[f.k] = parseFloat(inp.value) || 0;
      profile.confidence = profile.confidence || {}; profile.confidence[f.k] = 1;
      onChange();
    });
    wrap.appendChild(inp);
    wrap.appendChild(el('div', 'tiny muted', f.hint));
    container.appendChild(wrap);
  });
}

/* ------------------------------------------------------------- confirm */
function goConfirm(profile, parsed) {
  S.profile = profile; S.pack = pack(); S.parsed = parsed;
  $('pill-year').textContent = 'FY ' + profile.taxYear;

  const type = parsed ? parsed.docType : null;
  $('typeswitch-card').hidden = !parsed;
  if (parsed) {
    $('confirm-period').textContent = DOC_TYPES[type].label;
    $('doctype-note').textContent = DOC_TYPES[type].note +
      ' Amounts taken from the ' + parsed.policy.name + '.';
  }
  $('confirm-sub').textContent = parsed
    ? (type === 'monthly'
        ? 'Anything marked “check” was found but is worth a glance; “not found” means it was not on the document at all.'
        : 'These are annual figures taken straight from the document. Correct anything that looks off.')
    : 'Enter or adjust anything below.';

  const msg = $('confirm-msg'); msg.innerHTML = '';
  const addNote = (html, warn) => {
    const n = el('div', 'note' + (warn ? ' warn' : '')); n.innerHTML = html; msg.appendChild(n);
  };
  (parsed ? parsed.warnings : []).forEach(w => addNote('<b>Worth a look.</b> ' + w, true));
  (profile.parserNotes || []).forEach(n => addNote(n, false));
  if (parsed && type === 'monthly' && !parsed.warnings.length)
    addNote('<b>One month can\'t see a year.</b> Bonus, appraisals and arrears are invisible here — ' +
            'you\'ll be asked about the bonus next, and the result will say whether the answer even depends on it.');
  if (parsed && type === 'offer')
    addNote('<b>Offer letters are the best input.</b> These are real annual figures, so the projection ' +
            'below does not depend on guessing a bonus.');

  const redraw = () => $('confirm-gross').textContent = fmt(grossSalary(profile));
  renderFieldGrid($('confirm-fields'), profile, redraw, !!parsed);
  redraw();
  $('confirm-error').hidden = true;
  const hadParts = renderParts(parsed);
  $('btn-show-parts').hidden = !hadParts;
  if (parsed) {
    $('confirm-raw').hidden = false;
    $('raw-lines').textContent = parsed.rawLines.slice(0, 80).join('\n');
  } else $('confirm-raw').hidden = true;
  show('screen-confirm');
}

/* Show the individual lines the parser actually recognised. The confirm card
   is the trust moment; "here is every line I read and what I did with it"
   is what makes a wrong number findable instead of mysterious. */
function renderParts(parsed) {
  const box = $('confirm-parts');
  if (!parsed) { box.innerHTML = ''; return false; }
  const rows = [];
  const push = (group, items) => items.forEach(i =>
    rows.push([group, i.label.replace(/\s+/g, ' ').trim(), i.value, 1]));
  push('Allowance', parsed.parts.allow);
  push('Arrears', parsed.parts.arrear);
  push('Bonus', parsed.parts.bonus);
  const KIND = {
    basic: ['Basic', 1], hra: ['HRA', 1],
    employeePf: ['Your PF → 80C', 1],
    professionalTax: ['Prof. tax → deduction', 1],
    employerNps: ['Employer NPS → both regimes', 1],
    employerPf: ['Employer PF — not your income', 0],
    gratuity: ['Gratuity — not your income', 0],
    medicalInsurance: ['Health premium → 80D', 0],
    incomeTax: ['Tax already deducted — not income', 0],
    totalEarnings: ['Printed total — used to cross-check', 0]
  };
  Object.keys(parsed.hits).forEach(k => {
    if (['totalDeduction','netPay','grossCtc','totalCtc','baseSalary'].indexOf(k) >= 0) return;
    const kind = KIND[k] || ['Read', 1];
    rows.push([kind[0], parsed.hits[k].line.replace(/\s+/g, ' ').trim(),
               parsed.hits[k].value, kind[1]]);
  });
  if (!rows.length) { box.innerHTML = ''; return false; }
  const mult = DOC_TYPES[parsed.docType].multiplier;
  rows.sort((a, b) => b[3] - a[3]);
  let html = '<div class="tablewrap"><table><thead><tr><th>What it is</th><th>Line on the document</th>' +
             '<th class="n">As read</th><th class="n">Counted as</th></tr></thead><tbody>';
  rows.forEach(r => {
    html += '<tr' + (r[3] ? '' : ' class="sub"') + '><td>' + esc(r[0]) + '</td><td>' + esc(r[1]) +
            '</td><td class="n">' + fmt(r[2]) + '</td><td class="n">' +
            (r[3] ? fmt(r[2] * mult) : '—') + '</td></tr>';
  });
  html += '</tbody></table></div>';
  box.innerHTML = html;
  return true;
}
function esc(t) { const d = document.createElement('div'); d.textContent = t; return d.innerHTML; }

/* ------------------------------------------------- "what was read" popover */
function openPartsDrawer() {
  $('parts-backdrop').hidden = false;
  $('parts-drawer').hidden = false;
}
function closePartsDrawer() {
  $('parts-backdrop').hidden = true;
  $('parts-drawer').hidden = true;
}

/* -------------------------------------------------------------- triage */
function renderTriage() {
  const box = $('triage-list'); box.innerHTML = '';
  const already = (S.profile && S.profile.outOfScope) || [];
  TRIAGE.forEach(t => {
    const row = el('label', 'triage-row');
    const cb = el('input'); cb.type = 'checkbox'; cb.value = t.id;
    cb.checked = already.indexOf(t.id) >= 0;
    cb.className = 'triage-cb';
    const txt = el('div');
    txt.appendChild(el('div', 'triage-row-label', t.label));
    txt.appendChild(el('div', 'tiny muted', t.note));
    row.appendChild(cb); row.appendChild(txt);
    box.appendChild(row);
  });
  const none = el('div', 'tiny muted', 'Tick nothing if none apply — that is the common case.');
  none.style.marginTop = '4px';
  box.appendChild(none);
  show('screen-triage');
}

/* ----------------------------------------------------------- interview */
function botSay(html, why) {
  const b = el('div', 'bub bot'); b.innerHTML = html;
  if (why) { const w = el('span', 'why', why); b.appendChild(w); }
  $('chat').appendChild(b); scrollChat(); return b;
}
function userSay(text) {
  const b = el('div', 'bub usr', text); $('chat').appendChild(b); scrollChat(); return b;
}
function sysSay(text) {
  const b = el('div', 'sysline', text); $('chat').appendChild(b); scrollChat(); return b;
}
function scrollChat() {
  requestAnimationFrame(() => window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' }));
}
function clearInputs() {
  $('chat').querySelectorAll('.chips,.amt').forEach(n => n.remove());
}

/* ------------------------------------------------ full breakdown, on demand */
/* A floating button that opens the same line-by-line sheet from anywhere —
   mid-interview (based on what's answered so far) or on the result screen —
   so nobody has to scroll to the verdict page to see it. */
function renderBreakdownDrawer() {
  if (!S.profile || !S.pack) return;
  const c = compareRegimes(S.profile, S.pack);
  renderSheet(c, 'breakdown-sheet');
  const onResult = currentScreenId() === 'screen-result';
  $('breakdown-note').textContent = onResult
    ? 'This is the same table as below, for quick reference.'
    : 'Based on what you\'ve entered so far — this updates as you answer more questions.';
}
function openBreakdown() {
  renderBreakdownDrawer();
  $('breakdown-backdrop').hidden = false;
  $('breakdown-drawer').hidden = false;
}
function closeBreakdown() {
  $('breakdown-backdrop').hidden = true;
  $('breakdown-drawer').hidden = true;
}

function updateMeter() {
  const c = compareRegimes(S.profile, S.pack);
  const be = breakEvenDeductions(S.profile, S.pack);
  S.comparison = c; S.breakEven = be;
  const found = c.old.deductionTotal;

  // The one thing to know before anything else on this screen: which regime
  // is ahead right now, given everything answered so far — updates live as
  // the interview goes, since an answer can flip it.
  const winName = c.winner === 'neu' ? 'New Regime' : 'Old Regime';
  const loseName = c.winner === 'neu' ? 'Old Regime' : 'New Regime';
  $('meter-headline').innerHTML = c.saving === 0
    ? 'Both regimes cost the same right now'
    : '<span class="win">' + winName + '</span> is better than ' + loseName + ' — by ' + fmt(c.saving) + ' a year';

  if (be.alreadyAhead) {
    $('meter-k').textContent = 'Old regime is already ahead by';
    $('meter-target').textContent = fmt(c.saving) + ' a year';
    $('meter-bar').style.width = '100%';
  } else if (be.needed === null) {
    $('meter-k').textContent = 'The old regime cannot catch up at this income';
    $('meter-target').textContent = '—';
    $('meter-bar').style.width = '0%';
  } else {
    // be.needed is the EXTRA deduction still required from here, not the
    // total — breakEvenDeductions() bisects starting from what's already
    // found, so it's already net of it. The total target for the label and
    // the bar is found + be.needed; dividing found by be.needed alone (the
    // old code) compared two different baselines and could show 100% full
    // well before the gap was actually closed.
    const total = found + be.needed;
    $('meter-k').textContent = 'Deductions needed for the old regime to win';
    $('meter-target').textContent = fmt(total);
    $('meter-bar').style.width = Math.min(100, (found / total) * 100).toFixed(1) + '%';
  }
  $('meter-found').textContent = fmt(found);
}

function askNext() {
  clearInputs();
  updateMeter();
  const q = nextQuestion(S.profile, S.pack);
  if (!q) return finishInterview();
  S.pendingQ = q;

  if (S.profile.earlyExit && !S.profile.earlyExitShown) {
    S.profile.earlyExitShown = true;
    sysSay('Stopping the deduction questions here — everything still unasked adds up to at most ' +
      fmt(S.profile.earlyExit.roomLeft) + ', and the gap is ' + fmt(S.profile.earlyExit.gap) + '. It cannot close.');
  }

  const text = typeof q.ask === 'function' ? q.ask(S.profile) : q.ask;
  const bub = botSay(text, q.why);
  const wt = whatsThisBtn(q.topic);
  if (wt) { wt.style.marginLeft = '0'; wt.style.marginTop = '8px'; wt.style.display = 'inline-block'; bub.appendChild(document.createElement('br')); bub.appendChild(wt); }

  renderAnsweredPanel();
  if (q.type === 'two-amounts') return renderTwoAmounts(q);
  renderChips(q);
}

function renderChips(q) {
  const box = el('div', 'chips');
  q.chips.forEach(ch => {
    const b = el('button', 'chip', ch.label);
    b.addEventListener('click', () => {
      userSay(ch.label);
      clearInputs();
      if (ch.value === 'ask') {
        if (q.type === 'chips-then-multi-amount') return renderMultiAmounts(q);
        return renderAmount(q);
      }
      if (ch.value === 'estimate') { answer(q, q.estimateValue, true); return; }
      if (ch.value === 'yes' && q.id === 'rent') return renderRent(q);
      answer(q, ch.value);
    });
    box.appendChild(b);
  });
  $('chat').appendChild(box); scrollChat();
}

/* Section 123 etc. as separate itemised fields rather than one clubbed
   amount — each investment type gets its own box, summed on submit. */
function renderMultiAmounts(q) {
  const box = el('div', 'amt');
  const inputs = {};
  q.fields.forEach(f => {
    box.appendChild(el('label', null, f.label));
    const i = el('input'); i.type = 'number'; i.min = '0'; i.placeholder = '0';
    box.appendChild(i); inputs[f.key] = i;
  });
  const btn = el('button', 'btn small', 'That\'s it');
  btn.addEventListener('click', () => {
    const v = {}; let sum = 0;
    q.fields.forEach(f => { v[f.key] = parseFloat(inputs[f.key].value) || 0; sum += v[f.key]; });
    userSay(sum > 0 ? fmt(sum) + ' in total' : 'None');
    clearInputs(); answer(q, v);
  });
  box.appendChild(btn);
  $('chat').appendChild(box); scrollChat();
}

function renderAmount(q) {
  const box = el('div', 'amt');
  box.appendChild(el('label', null, q.amountLabel || 'Amount for the year'));
  const inp = el('input'); inp.type = 'number'; inp.min = '0'; inp.placeholder = '0';
  box.appendChild(inp);
  const btn = el('button', 'btn small', 'That\'s it');
  btn.addEventListener('click', () => {
    const v = parseFloat(inp.value) || 0;
    userSay(fmt(v)); clearInputs(); answer(q, v);
  });
  inp.addEventListener('keydown', e => { if (e.key === 'Enter') btn.click(); });
  box.appendChild(btn);
  $('chat').appendChild(box); inp.focus(); scrollChat();
}

function renderRent(q) {
  const box = el('div', 'amt');
  box.appendChild(el('label', null, 'Roughly how much rent per month? A ballpark is fine — it gets flagged as an estimate.'));
  const inp = el('input'); inp.type = 'number'; inp.min = '0'; inp.placeholder = 'e.g. 30000';
  box.appendChild(inp);
  const lbl = el('label', null, 'Which city?'); lbl.style.marginTop = '4px';
  box.appendChild(lbl);
  const sel = el('select');
  [['1', 'Delhi, Mumbai, Kolkata or Chennai — 50% of basic'],
   ['0', 'Anywhere else — 40% of basic']].forEach(o => {
    const op = el('option', null, o[1]); op.value = o[0]; sel.appendChild(op);
  });
  box.appendChild(sel);
  const btn = el('button', 'btn small', 'Done');
  btn.addEventListener('click', () => {
    const m = parseFloat(inp.value) || 0;
    S.profile.deductions.rentPaid = m * 12;
    S.profile.deductions.metro = sel.value === '1';
    S.profile.estimates.rentPaid = true;
    userSay(fmt(m) + ' a month, ' + (sel.value === '1' ? 'metro' : 'non-metro'));
    clearInputs();
    const ex = hraExemption(S.profile.salary.hra, S.profile.salary.basic,
                            S.profile.deductions.rentPaid, S.profile.deductions.metro);
    if (ex <= 0) {
      sysSay('That rent works out below 10% of your basic, so the HRA exemption comes to nothing.');
    } else if (ex < S.profile.salary.hra) {
      sysSay('HRA exemption: ' + fmt(ex) + ' of the ' + fmt(S.profile.salary.hra) +
             ' you receive — the formula takes the lowest of three figures, and it is rarely the full amount.');
    }
    answer(q, 'yes', false, true);
  });
  box.appendChild(btn);
  $('chat').appendChild(box); inp.focus(); scrollChat();
}

function renderTwoAmounts(q) {
  const box = el('div', 'amt');
  const inputs = {};
  q.fields.forEach(f => {
    box.appendChild(el('label', null, f.label));
    const i = el('input'); i.type = 'number'; i.min = '0'; i.placeholder = '0';
    box.appendChild(i); inputs[f.key] = i;
  });
  const btn = el('button', 'btn small', 'Finish');
  btn.addEventListener('click', () => {
    const v = {}; let sum = 0;
    q.fields.forEach(f => { v[f.key] = parseFloat(inputs[f.key].value) || 0; sum += v[f.key]; });
    userSay(sum > 0 ? fmt(sum) + ' in total' : 'None');
    clearInputs(); answer(q, v);
  });
  box.appendChild(btn);
  $('chat').appendChild(box); scrollChat();
}

function answer(q, value, isEstimate, alreadyApplied) {
  if (!alreadyApplied) q.apply(S.profile, value);
  if (isEstimate) S.profile.estimates[q.id] = true;
  S.profile.answered[q.id] = true;
  const before = S.comparison ? S.comparison.old.deductionTotal : 0;
  updateMeter();
  const after = S.comparison.old.deductionTotal;
  if (after > before) sysSay('+' + fmt(after - before) + ' towards the old regime.');
  renderAnsweredPanel();
  setTimeout(askNext, 260);
}

/* ------------------------------------------------- edit a given answer -- */
/* Lets someone correct an earlier answer without restarting the interview —
   from the "answers so far" panel mid-interview, or from the "review & edit"
   panel after the verdict, where it recomputes and redraws in place. */
function currentAmountFor(q) {
  const d = S.profile.deductions, s = S.profile.salary;
  if (q.id === 'bonus') return s.bonus;
  if (q.id === 'homeLoan') return d.homeLoanInterest;
  if (q.id === 's80CCD1B') return d.s80CCD1B;
  if (q.id === 's80D') return d.s80D;
  if (q.id === 's80E') return d.s80E;
  if (q.id === 's80G') return d.s80G;
  return 0;
}

function describeAnswer(q) {
  const p = S.profile;
  if (q.id === 'bonus') return p.bonusUnknown ? 'Unknown for now — flagged as an estimate' : fmt(p.salary.bonus) + ' a year';
  if (q.id === 'rent') return p.flags.ownsHome ? 'Owns the home' :
    (p.deductions.rentPaid > 0 ? fmt(p.deductions.rentPaid) + '/yr (' + (p.deductions.metro ? 'metro' : 'non-metro') + ')' : 'No rent paid');
  if (q.id === 'homeLoan') return p.deductions.homeLoanInterest > 0 ? fmt(p.deductions.homeLoanInterest) : 'None';
  if (q.id === 's80C') return p.deductions.s80C_other > 0 ? fmt(p.deductions.s80C_other) + ' total' : 'Nothing else';
  if (q.id === 's80CCD1B') return p.deductions.s80CCD1B > 0 ? fmt(p.deductions.s80CCD1B) : 'None';
  if (q.id === 's80D') return p.deductions.s80D > 0 ? fmt(p.deductions.s80D) : 'None';
  if (q.id === 's80E') return p.deductions.s80E > 0 ? fmt(p.deductions.s80E) : 'None';
  if (q.id === 's80G') return p.deductions.s80G > 0 ? fmt(p.deductions.s80G) : 'None';
  if (q.id === 'otherIncome') return fmt((p.otherIncome.savingsInterest || 0) + (p.otherIncome.fdInterest || 0)) + ' interest';
  return '—';
}

/* opts.autoApply: no Save button — each field applies itself (debounced) as
   the user types, for the full-page review overlay where nothing should
   need a click to "commit". Without it, a Save button is used instead (the
   compact mid-interview "answers so far" panel). */
function renderInlineEditor(q, box, opts) {
  opts = opts || {};
  box.innerHTML = '';
  const commit = (mutate) => { mutate(); afterEdit(q); };
  const debounced = (inputs, mutate) => {
    let t;
    inputs.forEach(i => i.addEventListener('input', () => {
      clearTimeout(t); t = setTimeout(() => commit(mutate), 450);
    }));
  };
  const saveButton = (mutate) => {
    const btn = el('button', 'btn small', 'Save');
    btn.addEventListener('click', () => commit(mutate));
    box.appendChild(btn);
  };

  if (q.type === 'two-amounts') {
    const inputs = {};
    q.fields.forEach(f => {
      box.appendChild(el('label', null, f.label));
      const i = el('input'); i.type = 'number'; i.min = '0';
      i.value = S.profile.otherIncome[f.key] || '';
      box.appendChild(i); inputs[f.key] = i;
    });
    const mutate = () => q.apply(S.profile, Object.fromEntries(
      q.fields.map(f => [f.key, parseFloat(inputs[f.key].value) || 0])));
    opts.autoApply ? debounced(Object.values(inputs), mutate) : saveButton(mutate);
  } else if (q.type === 'chips-then-multi-amount') {
    const inputs = {};
    // No itemised breakdown on file (e.g. it arrived as one chat-edited
    // total) — seed the catch-all field with the existing total rather than
    // showing blank fields that would zero it out the moment one is touched.
    const cur = S.profile.deductions.s80C_breakdown ||
      (S.profile.deductions.s80C_other > 0 ? { other: S.profile.deductions.s80C_other } : {});
    q.fields.forEach(f => {
      box.appendChild(el('label', null, f.label));
      const i = el('input'); i.type = 'number'; i.min = '0';
      i.value = cur[f.key] || '';
      box.appendChild(i); inputs[f.key] = i;
    });
    const mutate = () => q.apply(S.profile, Object.fromEntries(
      q.fields.map(f => [f.key, parseFloat(inputs[f.key].value) || 0])));
    opts.autoApply ? debounced(Object.values(inputs), mutate) : saveButton(mutate);
  } else if (q.id === 'rent') {
    box.appendChild(el('label', null, 'Monthly rent'));
    const i = el('input'); i.type = 'number'; i.min = '0';
    i.value = S.profile.deductions.rentPaid ? Math.round(S.profile.deductions.rentPaid / 12) : '';
    box.appendChild(i);
    box.appendChild(el('label', null, 'City'));
    const sel = el('select');
    [['1', 'Metro — 50% of basic'], ['0', 'Non-metro — 40% of basic']].forEach(o => {
      const op = el('option', null, o[1]); op.value = o[0]; sel.appendChild(op);
    });
    sel.value = S.profile.deductions.metro ? '1' : '0';
    box.appendChild(sel);
    const mutate = () => {
      const m = parseFloat(i.value) || 0;
      S.profile.deductions.rentPaid = m * 12;
      S.profile.deductions.metro = sel.value === '1';
      if (m > 0) S.profile.flags.ownsHome = false;
    };
    if (opts.autoApply) { debounced([i], mutate); sel.addEventListener('change', () => commit(mutate)); }
    else saveButton(mutate);
  } else {
    box.appendChild(el('label', null, q.amountLabel || 'Amount for the year'));
    const i = el('input'); i.type = 'number'; i.min = '0';
    i.value = currentAmountFor(q) || '';
    box.appendChild(i);
    const mutate = () => q.apply(S.profile, parseFloat(i.value) || 0);
    opts.autoApply ? debounced([i], mutate) : saveButton(mutate);
  }
}

function afterEdit(q) {
  S.profile.answered[q.id] = true;
  updateMeter();
  renderAnsweredPanel();
  if (currentScreenId() === 'screen-result') renderResult();
}

/* Every deduction that could plausibly apply to this profile, whether or not
   the interview actually got around to asking it — the early-exit stopping
   rule skips questions that can't change the verdict, but "review & edit"
   should still offer them, since someone may want to add one anyway. */
function reviewableQuestions() {
  return QUESTIONS.filter(q => !q.when || q.when(S.profile));
}

/* Builds one "question / current value [/ Edit]" list into any container —
   used by the compact mid-interview panel (click Edit, then Save; answered
   questions only) and the full-page review overlay (every applicable
   question, fields always open, apply as you type). */
function renderQuestionRows(container, questions, opts) {
  opts = opts || {};
  container.innerHTML = '';
  questions.forEach(q => {
    const row = el('div', 'ans-row');
    const info = el('div');
    const qtext = typeof q.ask === 'function' ? q.ask(S.profile) : q.ask;
    info.appendChild(el('div', 'small', qtext));
    row.appendChild(info);
    if (opts.autoApply) {
      row.style.flexDirection = 'column'; row.style.alignItems = 'stretch';
      const editorBox = el('div', 'ans-editor');
      renderInlineEditor(q, editorBox, { autoApply: true });
      row.appendChild(editorBox);
      container.appendChild(row);
    } else {
      info.appendChild(el('div', 'tiny muted mono', describeAnswer(q)));
      const editBtn = el('button', 'linkbtn', 'Edit');
      row.appendChild(editBtn);
      const editorBox = el('div', 'ans-editor'); editorBox.hidden = true;
      editBtn.addEventListener('click', () => {
        editorBox.hidden = !editorBox.hidden;
        editBtn.textContent = editorBox.hidden ? 'Edit' : 'Cancel';
        if (!editorBox.hidden) renderInlineEditor(q, editorBox);
      });
      container.appendChild(row);
      container.appendChild(editorBox);
    }
  });
}
function renderAnsweredPanel() {
  const panel = $('answered-panel'); if (!panel) return;
  const answeredQs = QUESTIONS.filter(q => S.profile.answered[q.id]);
  panel.hidden = !answeredQs.length;
  if (answeredQs.length) renderQuestionRows($('answered-list'), answeredQs);
}

/* Full-page "review & edit" overlay — opened from the result screen. Every
   applicable deduction is listed, answered or not, with fields always
   editable and applying themselves; there is deliberately no Save button.
   The persistent AI bar stays on top (higher z-index) so chat-driven edits
   work from here too. */
function openReviewOverlay() {
  renderQuestionRows($('review-overlay-list'), reviewableQuestions(), { autoApply: true });
  $('review-overlay').hidden = false;
  window.scrollTo({ top: 0, behavior: 'auto' });
}
function closeReviewOverlay() {
  $('review-overlay').hidden = true;
}

function finishInterview() {
  clearInputs();
  sysSay('That\'s everything that could change the answer.');
  setTimeout(() => renderResult(), 420);
}

function startInterview() {
  $('chat').innerHTML = '';
  S.pack = pack();
  updateMeter();
  renderAnsweredPanel();
  const c = S.comparison, be = S.breakEven;
  botSay('Before any questions about deductions — here is where you stand with none at all.');
  const gross = grossSalary(S.profile);
  const cheaper = c.winner === 'neu' ? 'New' : 'Old', costlier = c.winner === 'neu' ? 'Old' : 'New';
  if (c.saving === 0) {
    botSay('With zero deductions, on a gross of <b>' + fmt(gross) + '</b>, both regimes cost exactly the same: <b>' + fmt(c.neu.total) + '</b>.');
  } else {
    botSay('With zero deductions, on a gross of <b>' + fmt(gross) + '</b>: you\'d pay <b>' + fmt(c.saving) +
      ' more tax</b> in the ' + costlier + ' regime compared to the ' + cheaper + ' regime. <b>The ' + cheaper +
      ' regime is the best option for you</b> right now.');
  }
  if (be.alreadyAhead) {
    botSay('The old regime is already ahead before we start, which is unusual. Let\'s see how far ahead it gets.');
  } else if (be.needed === null) {
    botSay('At this income the old regime cannot catch up whatever you claim. I\'ll still ask about other income, since that affects both.');
  } else {
    // be.needed is the extra still required from here, not the grand total —
    // add what's already found so this matches the meter's own total exactly.
    const total = c.old.deductionTotal + be.needed;
    S.baselineGap = total;
    botSay('So the whole question is one number: <b>you would need ' + fmt(total) +
      ' of deductions</b> for the old regime to be worth choosing. Everything I ask now is about getting there — and I\'ll stop the moment it becomes impossible.',
      'The meter above tracks it. Most people are asked four to six questions, not thirty.');
  }
  setTimeout(askNext, 500);
  show('screen-interview');
}

/* -------------------------------------------------------------- result */
function renderResult() {
  const c = compareRegimes(S.profile, S.pack);
  const be = breakEvenDeductions(S.profile, S.pack);
  const rb = robustness(S.profile, S.pack);
  S.comparison = c; S.breakEven = be; S.robust = rb;

  const winNew = c.winner === 'neu';
  const winName = winNew ? 'New regime' : 'Old regime';
  const loseName = winNew ? 'Old regime' : 'New regime';
  if (c.saving === 0) {
    $('verdict-big').innerHTML = 'Choose the <b>New regime</b>.';
    $('verdict-sub').textContent = 'Both regimes cost exactly the same here, so pick the new regime — it needs no proofs and no paperwork.';
  } else {
    $('verdict-big').innerHTML = 'You pay <b>' + fmt(c.saving) + ' more tax</b> in the ' + loseName + '.';
    $('verdict-sub').innerHTML = 'Selecting the <b>' + winName + '</b> is the best option for you — that\'s ' +
      fmt(c.monthlySaving) + ' more in hand every month.';
  }

  // Old regime always on the left, new regime always on the right — regardless
  // of which one wins — so the pairing stays legible instead of swapping sides.
  const stats = [
    { k: 'Tax under old', v: fmt(c.old.total), s: winNew ? 'The one to avoid' : 'Including 4% cess' },
    { k: 'Tax under new', v: fmt(c.neu.total), s: winNew ? 'Including 4% cess' : 'The one to avoid' },
    { k: 'Monthly difference', v: fmt(c.monthlySaving), s: 'In your hand' },
    { k: 'Deductions found', v: fmt(c.old.deductionTotal), s: be.needed ? 'Break-even was ' + fmt(c.old.deductionTotal + be.needed) : 'Old regime already ahead' }
  ];
  const sr = $('statrow'); sr.innerHTML = '';
  stats.forEach(s => {
    const d = el('div', 'stat');
    d.appendChild(el('div', 'k', s.k));
    d.appendChild(el('div', 'v', s.v));
    d.appendChild(el('div', 's', s.s));
    sr.appendChild(d);
  });

  renderRobust(rb, c);
  renderTaxTips(c);
  renderSheet(c);
  renderAssumptions(c, be);
  renderNextSteps(c, be, rb);
  renderBreakdownDrawer();
  show('screen-result');
}

function renderRobust(rb, c) {
  const gross = grossSalary(S.profile);
  const txt = $('robust-text');
  if (rb.stable) {
    txt.innerHTML = 'This verdict does not depend on getting your income exactly right. ' +
      '<b>' + (rb.winner === 'neu' ? 'The new regime wins' : 'The old regime wins') +
      ' anywhere between ' + fmtLakh(rb.low) + ' and ' + fmtLakh(rb.high) + ' of annual gross</b> — ' +
      'so even if your bonus lands very differently from what we assumed, the answer holds.';
  } else {
    txt.innerHTML = '<b>This one is close.</b> The verdict flips at roughly ' + fmtLakh(rb.flipAt) +
      ' of annual gross. Below that, ' + (rb.results[0].winner === 'neu' ? 'the new regime' : 'the old regime') +
      ' wins; above it, the other one does. Your projection is ' + fmtLakh(gross) +
      ' — worth pinning down your bonus before you declare, or re-running this once you know it.';
  }
  // band strip: which regime wins across the plausible income range
  const w = 700, h = 74, x0 = 8, x1 = w - 8;
  const px = g => x0 + (g - rb.low) / (rb.high - rb.low) * (x1 - x0);
  let segs = '', prev = rb.results[0], start = rb.results[0].gross;
  const parts = [];
  rb.results.forEach((r, i) => {
    if (r.winner !== prev.winner || i === rb.results.length - 1) {
      parts.push({ from: start, to: r.gross, winner: prev.winner });
      start = r.gross; prev = r;
    }
  });
  parts.forEach(p => {
    segs += '<rect x="' + px(p.from).toFixed(1) + '" y="20" width="' +
      Math.max(1, px(p.to) - px(p.from)).toFixed(1) + '" height="18" rx="3" fill="' +
      (p.winner === 'neu' ? 'var(--s-new)' : 'var(--s-old)') + '"/>';
    const mid = (px(p.from) + px(p.to)) / 2;
    if (px(p.to) - px(p.from) > 150)
      segs += '<text x="' + mid.toFixed(1) + '" y="14" text-anchor="middle" font-size="11.5" font-weight="600" fill="' +
        (p.winner === 'neu' ? 'var(--s-new)' : 'var(--s-old)') + '" font-family="Public Sans,sans-serif">' +
        (p.winner === 'neu' ? 'New regime wins' : 'Old regime wins') + '</text>';
  });
  const mx = px(gross);
  const marker = '<line x1="' + mx.toFixed(1) + '" y1="14" x2="' + mx.toFixed(1) +
    '" y2="44" stroke="var(--ink)" stroke-width="2"/>' +
    '<text x="' + Math.min(x1 - 60, Math.max(x0 + 60, mx)).toFixed(1) + '" y="60" text-anchor="middle" font-size="11.5" fill="var(--ink)" font-family="IBM Plex Mono,monospace">your projection ' + fmtLakh(gross) + '</text>';
  const axis = '<text x="' + x0 + '" y="60" font-size="11" fill="var(--faint)" font-family="IBM Plex Mono,monospace">' + fmtLakh(rb.low) + '</text>' +
    '<text x="' + x1 + '" y="60" text-anchor="end" font-size="11" fill="var(--faint)" font-family="IBM Plex Mono,monospace">' + fmtLakh(rb.high) + '</text>';
  const legend = '<div class="rowh" style="gap:16px;margin-top:6px">' +
    '<span class="tiny" style="display:flex;align-items:center;gap:6px"><span style="width:11px;height:11px;border-radius:3px;background:var(--s-new);display:inline-block"></span>New regime wins</span>' +
    '<span class="tiny" style="display:flex;align-items:center;gap:6px"><span style="width:11px;height:11px;border-radius:3px;background:var(--s-old);display:inline-block"></span>Old regime wins</span></div>';
  $('robust-chart').innerHTML =
    '<div style="overflow-x:auto"><svg viewBox="0 0 ' + w + ' ' + h + '" style="width:100%;min-width:300px;height:auto;display:block" role="img" aria-label="Which regime wins across a plausible range of annual income">' +
    segs + marker + axis + '</svg></div>' + legend;
}

/* ------------------------------------------------------- tax-saving tips */
/* Rule-based, not a model call — every rupee figure comes from cloning the
   profile and re-running the real engine (or, for perquisites the engine has
   no field for, from the engine's own marginal-rate function), so a tip can
   never promise a saving the arithmetic doesn't back up. */
function marginalRate(taxable, regime, pack) {
  const step = 10000;
  const a = slabTax(taxable, regime.slabs);
  const b = slabTax(taxable + step, regime.slabs);
  return Math.max(0, (b - a) / step) * (1 + pack.cess);
}
function taxDelta(profile, pack, regimeKey, mutate) {
  const before = computeRegime(profile, regimeKey, pack).total;
  const q = JSON.parse(JSON.stringify(profile));
  mutate(q);
  const after = computeRegime(q, regimeKey, pack).total;
  return before - after;
}
function renderTaxTips(c) {
  const card = $('tax-tips-card'), box = $('tax-tips');
  const p = S.profile, pack = S.pack;
  const winner = c.winner; // 'neu' or 'old'
  const regime = pack.regimes[winner];
  const tips = [];

  // Employer NPS top-up — 80CCD(2) survives in both regimes; ask HR.
  // Modelled as restructuring existing (fully-taxable) allowance into employer
  // NPS, not conjuring new money — adding straight to employerNps alone would
  // inflate gross salary by the same amount it deducts back out and net to
  // zero, which understates the real saving from an actual CTC restructure.
  const npsCap = p.salary.basic * regime.employerNpsCapPct;
  const npsRoomCap = Math.max(0, npsCap - p.salary.employerNps);
  const npsShiftable = Math.min(npsRoomCap, p.salary.otherAllowances);
  if (npsShiftable > 10000) {
    const saved = taxDelta(p, pack, winner, q => {
      q.salary.otherAllowances -= npsShiftable;
      q.salary.employerNps += npsShiftable;
    });
    if (saved > 500) tips.push({
      title: 'Ask HR to route more of your CTC through employer NPS',
      detail: 'Employer contributions to NPS (80CCD(2)) are tax-free up to ' +
        Math.round(regime.employerNpsCapPct * 100) + '% of your basic — in both regimes — but most companies only do this if you specifically ask for it in your CTC structure. Shifting ' + fmt(npsShiftable) + ' of your existing taxable allowances there is realistic given your current pay structure.',
      saved
    });
  }

  // Tax-free meal card (Sodexo/Pluxee) — a perquisite valuation rule, not a
  // Chapter VI-A deduction, so the new regime doesn't knock it out.
  const hasMealCard = S.parsed && S.parsed.parts && S.parsed.parts.allow &&
    S.parsed.parts.allow.some(a => /food|meal|coupon|sodexo|pluxee/i.test(a.label));
  if (!hasMealCard) {
    const mealAnnual = 26400; // ~₹2,200/month — a common employer meal-card ceiling
    const rate = marginalRate(computeRegime(p, winner, pack).taxableIncome, regime, pack);
    const saved = Math.round(mealAnnual * rate);
    if (saved > 500) tips.push({
      title: 'Ask HR for a meal card (Sodexo / Pluxee) in your CTC',
      detail: 'Up to about ' + fmt(mealAnnual) + ' a year routed through a meal card is tax-free as a perquisite — a valuation rule, not a Chapter VI-A deduction, so it works under both regimes. It didn\'t show up on your payslip, so you may not have this yet.',
      saved
    });
  }

  // Old-regime-only levers (80C, 80CCD(1B), 80D) reduce nothing if the New
  // regime is what's actually being paid — they only count when Old is the
  // regime in force. Suggesting them otherwise would be honest-sounding but
  // wrong: filling them wouldn't change what this person actually owes.
  if (winner === 'old') {
    const cat = id => pack.catalogue.find(x => x.id === id);
    const s80cRoom = Math.max(0, cat('s80C').max - p.salary.employeePf - p.deductions.s80C_other);
    if (s80cRoom > 5000) {
      const saved = taxDelta(p, pack, 'old', q => { q.deductions.s80C_other += s80cRoom; });
      if (saved > 500) tips.push({
        title: 'Top up ELSS, PPF or another Section 123 investment',
        detail: 'You have ' + fmt(s80cRoom) + ' of room left in the ₹1,50,000 Section 123 (old 80C) ceiling. ELSS has the shortest lock-in — 3 years — of the options that qualify.',
        saved
      });
    }
    const nps1bRoom = Math.max(0, cat('s80CCD1B').max - p.deductions.s80CCD1B);
    if (nps1bRoom > 5000) {
      const saved = taxDelta(p, pack, 'old', q => { q.deductions.s80CCD1B += nps1bRoom; });
      if (saved > 500) tips.push({
        title: 'Put ' + fmt(nps1bRoom) + ' into NPS yourself',
        detail: '80CCD(1B) gives up to ₹50,000 of deduction for your own NPS contribution — on top of, not inside, the Section 123 ceiling.',
        saved
      });
    }
    const d80Room = Math.max(0, cat('s80D').max - p.deductions.s80D);
    if (d80Room > 5000) {
      const saved = taxDelta(p, pack, 'old', q => { q.deductions.s80D += d80Room; });
      if (saved > 500) tips.push({
        title: 'Check your health insurance premium is fully claimed',
        detail: 'Up to ' + fmt(cat('s80D').max) + ' is deductible for health insurance for yourself, family and parents (more if a parent is a senior citizen). You still have ' + fmt(d80Room) + ' of headroom here.',
        saved
      });
    }
  }

  tips.sort((a, b) => b.saved - a.saved);
  const top = tips.slice(0, 5);
  card.hidden = !top.length;
  box.innerHTML = '';
  top.forEach(t => {
    const d = el('div');
    const h = el('div', 'rowh'); h.style.justifyContent = 'space-between';
    h.appendChild(el('h3', null, t.title));
    h.appendChild(el('span', 'mono', '+' + fmt(t.saved) + '/yr'));
    d.appendChild(h);
    d.appendChild(el('p', 'small muted', t.detail));
    box.appendChild(d);
  });
}

function sheetRows(c) {
  const rows = [];
  const R = (label, oldV, newV, opts) => rows.push(Object.assign({ label, oldV, newV }, opts || {}));
  R('Gross salary', c.old.gross, c.neu.gross, { src: S.profile.source === 'payslip' ? 'From your payslip' : 'You entered it', topic: 'grossSalary' });
  R('Standard deduction', -c.old.standardDeduction, -c.neu.standardDeduction, { rule: c.neu.stdRule, sub: true, topic: 'standardDeduction' });
  if (c.old.otherIncome > 0) R('Other income (interest)', c.old.otherIncome, c.neu.otherIncome, { src: 'Your answer', sub: true, topic: 'otherIncome' });
  R('Gross total income', c.old.grossTotalIncome, c.neu.grossTotalIncome, { strongish: true, topic: 'grossTotalIncome' });

  const ids = new Set();
  c.old.deductions.forEach(d => ids.add(d.id));
  c.neu.deductions.forEach(d => ids.add(d.id));
  ids.forEach(id => {
    const o = c.old.deductions.find(d => d.id === id);
    const n = c.neu.deductions.find(d => d.id === id);
    const any = o || n;
    R(any.label, o ? -o.amount : null, n ? -n.amount : null, {
      rule: any.rule, src: any.source, sub: true,
      capped: (o && o.capped) || (n && n.capped),
      cap: (o && o.cap) || (n && n.cap),
      estimated: any.estimated,
      workings: o && o.workings,
      topic: id
    });
  });
  R('Taxable income', c.old.taxableIncome, c.neu.taxableIncome, { strongish: true, topic: 'taxableIncome' });
  R('Tax on slabs', c.old.baseTax, c.neu.baseTax, { sub: true, topic: 'taxOnSlabs' });
  if (c.old.rebate > 0 || c.neu.rebate > 0)
    R('Rebate', -c.old.rebate, -c.neu.rebate, { sub: true, rule: c.neu.rebateRule,
      src: c.neu.rebateNote || c.old.rebateNote, topic: 'rebate' });
  if (c.old.surcharge > 0 || c.neu.surcharge > 0)
    R('Surcharge', c.old.surcharge, c.neu.surcharge, { sub: true,
      src: (c.neu.surchargeRelief > 0 || c.old.surchargeRelief > 0) ? 'Marginal relief applied' : '', topic: 'surcharge' });
  R('Health & education cess @ 4%', c.old.cess, c.neu.cess, { sub: true, topic: 'cess' });
  R('Total tax payable', c.old.total, c.neu.total, { total: true, topic: 'totalTax' });
  R('Per month', c.old.total / 12, c.neu.total / 12, { sub: true });
  return rows;
}

function renderSheet(c, targetId) {
  const t = $(targetId || 'sheet'); t.innerHTML = '';
  const thead = el('thead');
  const tr = el('tr');
  ['Line', 'Old regime', 'New regime'].forEach((h, i) => {
    const th = el('th', i ? 'n' : null, h); tr.appendChild(th);
  });
  thead.appendChild(tr); t.appendChild(thead);
  const tb = el('tbody');
  sheetRows(c).forEach(r => {
    const row = el('tr', (r.total ? 'total' : '') + (r.sub ? ' sub' : ''));
    const td = el('td');
    td.appendChild(document.createTextNode(r.label));
    const wt = whatsThisIcon(r.topic);
    if (wt) td.appendChild(wt);
    if (r.capped) {
      const s = el('span', 'src', 'Capped at ' + fmt(r.cap) + ' — you claimed more');
      td.appendChild(s);
    }
    if (r.estimated) td.appendChild(el('span', 'src', 'Estimated, not confirmed'));
    if (r.src) td.appendChild(el('span', 'src', r.src));
    if (r.workings) {
      const w = el('span', 'src', 'Lowest of: ' + r.workings.map(x => x[0] + ' ' + fmt(x[1])).join(' · '));
      td.appendChild(w);
    }
    if (r.rule) td.appendChild(el('span', 'rule', r.rule));
    row.appendChild(td);
    [r.oldV, r.newV].forEach((v, i) => {
      const c2 = el('td', 'n', v === null || v === undefined ? '—' : fmt(v));
      if (r.total) {
        const winnerIsOld = c.winner === 'old';
        if ((i === 0 && winnerIsOld) || (i === 1 && !winnerIsOld)) c2.className = 'n win';
      }
      row.appendChild(c2);
    });
    tb.appendChild(row);
  });
  t.appendChild(tb);
}

function renderAssumptions(c, be) {
  const box = $('assumptions'); box.innerHTML = '';
  const items = [];
  const est = Object.keys(S.profile.estimates || {});
  if (S.profile.source === 'monthly')
    items.push({ ok: false, b: 'Annualised from one payslip.',
      t: 'Bonus, appraisals, arrears and any earlier employer are not in this unless you entered them.' });
  if (est.indexOf('rentPaid') >= 0)
    items.push({ ok: false, b: 'Rent was a ballpark.', t: 'The HRA exemption moves rupee-for-rupee with it above 10% of basic.' });
  if (est.indexOf('homeLoanInterest') >= 0)
    items.push({ ok: false, b: 'Home-loan interest assumed at the ₹2,00,000 ceiling.',
      t: 'Your bank\'s provisional certificate has the real split between principal and interest.' });
  if (S.profile.bonusUnknown)
    items.push({ ok: false, b: 'Bonus unknown.', t: 'Which is why the confidence band above matters more than the exact figure.' });
  if (c.old.otherIncome === 0)
    items.push({ ok: false, b: 'No interest income entered.',
      t: 'Savings and FD interest is taxable under both regimes and the department already has it from your AIS.' });
  items.push({ ok: true, b: 'Rates from the FY ' + S.pack.taxYear + ' rulepack.',
    t: S.pack.statute + ', version ' + S.pack.version + '. Slabs, cess, surcharge, rebate and every cap come from data, not code.' });
  items.push({ ok: true, b: 'Arithmetic checked against 21 golden profiles.',
    t: 'Expected values from a second, independently written implementation.' });
  if (!items.some(i => !i.ok))
    items.unshift({ ok: true, b: 'Nothing here was guessed.', t: 'Every figure came from your payslip or your own answers.' });
  items.forEach(i => {
    const d = el('div', 'item');
    d.appendChild(el('span', 'dot' + (i.ok ? ' ok' : '')));
    const s = el('span'); s.innerHTML = '<b>' + i.b + '</b> ' + i.t;
    d.appendChild(s); box.appendChild(d);
  });
}

function renderNextSteps(c, be, rb) {
  const box = $('nextsteps'); box.innerHTML = '';
  const winNew = c.winner === 'neu';
  const add = (title, body) => {
    const d = el('div');
    d.appendChild(el('h3', null, title));
    const p = el('p', 'small muted'); p.innerHTML = body; d.appendChild(p);
    box.appendChild(d);
  };

  add('On your company\'s declaration portal',
    winNew
      ? 'Select <b>New regime</b>. There is nothing to declare and no proofs to submit — the ' +
        fmt(c.neu.standardDeduction) + ' standard deduction is automatic, and your employer\'s NPS contribution is already in their records. That is the whole task.'
      : 'Select <b>Old regime</b> and declare these, which are the figures this computation used:<br>' +
        c.old.deductions.filter(d => ['professionalTax','employerNps','s80TTA'].indexOf(d.id) < 0)
          .map(d => '&nbsp;&nbsp;• ' + d.label + ' — <b>' + fmt(d.amount) + '</b>' +
               (d.capped ? ' <span style="color:var(--muted)">(you claimed ' + fmt(d.claimed) + '; the ceiling caps it here)</span>' : '')).join('<br>') +
        '<br>Your employer will ask for proofs around January, so keep rent receipts, premium receipts and the bank\'s interest certificate.');

  if (winNew && !be.alreadyAhead && be.needed !== null) {
    // be.needed is already the shortfall from here (bisected from the
    // current profile) — subtracting deductionTotal again would double-count
    // it and could understate how far away break-even really is.
    const shortfall = be.needed;
    if (shortfall > 0) {
      const room80c = Math.max(0, 150000 - S.profile.salary.employeePf - S.profile.deductions.s80C_other);
      const roomNps = Math.max(0, 50000 - S.profile.deductions.s80CCD1B);
      const closable = room80c + roomNps;
      add('Could more investment flip this?',
        closable >= shortfall
          ? 'Yes, but only just. You are ' + fmt(shortfall) + ' short, and you still have ' + fmt(room80c) +
            ' of Section 123 room plus ' + fmt(roomNps) + ' of 80CCD(1B). Filling both would flip the verdict — worth it only if you wanted to make those investments anyway. <b>Never buy an investment purely to save tax that is smaller than the investment.</b>'
          : 'No. You are ' + fmt(shortfall) + ' short and only ' + fmt(closable) +
            ' of investment room remains, so it cannot close. <b>Stay on the new regime and don\'t buy anything for tax reasons this year</b> — that is a real answer, and it saves you the paperwork as well as the money.');
    }
  }

  add('When you file', 'Salaried filers with no business income choose the regime <b>afresh every year, at filing</b>. ' +
    'If the declaration you give your employer turns out wrong, it only changes how much TDS comes out monthly — you correct it in the return and get the difference back. ' +
    'File by 31 July though: a belated return can cost you the old-regime option.');

  add('Before you rely on this', 'Check the figures above against your Form 16 Part B when it arrives in June, and against your AIS on the e-filing portal — ' +
    'that is where interest income and anything you forgot will show up. This is an estimate to check, not tax advice, and not a filed return.');
}


function localAnswer(q) {
  const s = q.toLowerCase();
  const c = S.comparison;
  if (/hra/.test(s)) {
    const d = c.old.deductions.find(x => x.id === 'hra');
    return d
      ? 'HRA exemption is the <em>lowest</em> of three figures, not the HRA on your payslip: ' +
        d.workings.map(w => w[0] + ' (' + fmt(w[1]) + ')').join(', ') + '. The lowest is ' + fmt(d.amount) + ', so that is what was allowed.'
      : 'No HRA exemption applied here — either your payslip has no HRA component, or no rent was entered.';
  }
  if (/80ccd|nps/.test(s))
    return 'There are two separate NPS deductions. 80CCD(1B) is your own contribution, up to ₹50,000, and it sits on top of the ₹1,50,000 Section 123 ceiling. 80CCD(2) is your employer\'s contribution — that one survives in the new regime too, capped at 14% of basic.';
  if (/why.*(new|old|this)\s*regime|which regime|why.*win|winner/.test(s))
    return (c.winner === 'neu' ? 'The new regime' : 'The old regime') + ' won by ' + fmt(c.saving) +
      '. Its taxable income came to ' + fmt(c.winner === 'neu' ? c.neu.taxableIncome : c.old.taxableIncome) +
      ' against ' + fmt(c.winner === 'neu' ? c.old.taxableIncome : c.neu.taxableIncome) +
      ' on the other side, and the slab rates did the rest. The line-by-line table above shows every step.';
  if (/80c|123/.test(s))
    return 'Section 123 is what used to be 80C — a ₹1,50,000 ceiling covering EPF, ELSS, PPF, LIC premiums, tuition fees and home-loan principal together. Your own EPF usually fills a large part of it before you invest anything extra.';
  if (/rebate|87a|156|12 lakh/.test(s))
    return 'The rebate (Section 156, formerly 87A) wipes out tax entirely if taxable income is ₹12,00,000 or less under the new regime. Just above that, marginal relief caps the tax at the amount by which you crossed — so earning ₹12,05,000 costs ₹5,000 of tax, not the full slab amount.';
  return 'That one needs the explainer — check the line-by-line table, which shows the source and the rule behind every number.';
}

/* ------------------------------------------------- floating chat widget */
/* "Ask the Copilot" — discoverable by default (bottom-right, on the result
   screen), and can apply edits to any input on request ("add ELSS of
   50,000"). The model classifies intent and extracts the field + amount;
   this file is the only thing that ever actually changes a number, and it
   always does so by adding to or replacing the CURRENT stored value — the
   model's job is understanding what the person meant, never arithmetic. */

/* Primary path: the shared worker (see /worker/tax-copilot-groq) decides
   whether a message is a question or an edit, and for an edit returns
   { field, op, amount } — amount copied verbatim from what the person typed.
   applyActions() re-validates every action against this exact whitelist
   before touching the profile; anything else is silently dropped. */
const FIELD_SETTERS = {
  bonus:            { get: p => p.salary.bonus,               set: (p, v) => { p.salary.bonus = v; p.bonusUnknown = false; },        qid: 'bonus' },
  homeLoanInterest: { get: p => p.deductions.homeLoanInterest,set: (p, v) => { p.deductions.homeLoanInterest = v; p.flags.hasHomeLoan = v > 0; }, qid: 'homeLoan' },
  s80D:             { get: p => p.deductions.s80D,            set: (p, v) => { p.deductions.s80D = v; },            qid: 's80D' },
  s80CCD1B:         { get: p => p.deductions.s80CCD1B,        set: (p, v) => { p.deductions.s80CCD1B = v; },        qid: 's80CCD1B' },
  s80E:             { get: p => p.deductions.s80E,            set: (p, v) => { p.deductions.s80E = v; },            qid: 's80E' },
  s80G:             { get: p => p.deductions.s80G,            set: (p, v) => { p.deductions.s80G = v; },            qid: 's80G' },
  savingsInterest:  { get: p => p.otherIncome.savingsInterest,set: (p, v) => { p.otherIncome.savingsInterest = v; }, qid: 'otherIncome' },
  fdInterest:       { get: p => p.otherIncome.fdInterest,     set: (p, v) => { p.otherIncome.fdInterest = v; },     qid: 'otherIncome' },
  rentPaid:         { get: p => p.deductions.rentPaid,        set: (p, v) => { p.deductions.rentPaid = v; if (v > 0) p.flags.ownsHome = false; }, qid: 'rent' },
  // Monthly, not annual — the ×12 happens here, deterministically, never in
  // the model's head. See ALLOWED_FIELDS comment in the worker for why both exist.
  rentMonthly:      { get: p => Math.round((p.deductions.rentPaid || 0) / 12), set: (p, v) => { p.deductions.rentPaid = v * 12; if (v > 0) p.flags.ownsHome = false; }, qid: 'rent' },
  's80C.elss':               s80cFieldSetter('elss'),
  's80C.ppf':                s80cFieldSetter('ppf'),
  's80C.lic':                s80cFieldSetter('lic'),
  's80C.tuition':            s80cFieldSetter('tuition'),
  's80C.homeLoanPrincipal':  s80cFieldSetter('homeLoanPrincipal'),
  's80C.other':              s80cFieldSetter('other')
};
function s80cFieldSetter(key) {
  return {
    get: p => (p.deductions.s80C_breakdown || {})[key] || (key === 'other' ? (p.deductions.s80C_other || 0) : 0),
    set: (p, v) => {
      const base = { elss: 0, ppf: 0, lic: 0, tuition: 0, homeLoanPrincipal: 0, other: 0 };
      const prior = p.deductions.s80C_breakdown ||
        (p.deductions.s80C_other > 0 ? { other: p.deductions.s80C_other } : {});
      const b = Object.assign(base, prior);
      b[key] = v;
      p.deductions.s80C_breakdown = b;
      p.deductions.s80C_other = Object.keys(b).reduce((a, k) => a + (b[k] || 0), 0);
    },
    qid: 's80C'
  };
}
/* Re-validates independently of the worker's own sanitising — field must be
   on the whitelist, amount must be a finite non-negative number. The model
   never supplies the resulting total; this always computes it from what's
   already stored. */
function applyActions(actions) {
  const applied = [];
  (actions || []).forEach(a => {
    if (!a || typeof a.field !== 'string') return;
    const f = FIELD_SETTERS[a.field];
    if (!f) return;
    const amount = Number(a.amount);
    if (!isFinite(amount) || amount < 0) return;
    const current = f.get(S.profile) || 0;
    f.set(S.profile, a.op === 'add' ? current + amount : amount);
    if (S.profile.answered) S.profile.answered[f.qid] = true;
    applied.push(a.field);
  });
  return applied;
}

/* Offline fallback only — used when the worker can't be reached at all, so
   the bar still does something useful with no model reachable. Deliberately
   narrower than the LLM path (fixed verbs, one field per message). */
const EDIT_KEYWORDS = [
  { field: 'bonus',   re: /\bbonus\b/i },
  { field: 'homeLoanInterest', re: /\bhome[\s-]?loan|housing\s*loan\b/i },
  { field: 's80D',    re: /\b(80\s?d|health\s*insurance|mediclaim|medical\s*insurance)\b/i },
  { field: 's80CCD1B',re: /\b(nps|80\s?ccd)\b/i },
  { field: 's80E',    re: /\beducation\s*loan|80\s?e\b/i },
  { field: 's80G',    re: /\bdonation|80\s?g\b/i },
  { field: 's80C.elss', re: /\belss\b/i },
  { field: 's80C.ppf',  re: /\bppf\b/i },
  { field: 's80C.lic',  re: /\blic\b|life\s*insurance/i },
  { field: 's80C.other',re: /\b(80\s?c|section\s*123)\b/i },
  { field: 'savingsInterest', re: /\b(savings|fixed\s*deposit|\bfd\b)\s*interest\b/i }
];
const EDIT_SET_VERBS = /\b(change|update|set|make|edit)\b/i;
const EDIT_ADD_VERBS = /\b(add|put|invest|top\s*-?\s*up|increase|contribute)\b/i;
function parseRupeeAmount(text) {
  const m = text.match(/₹?\s?([\d][\d,]*(?:\.\d+)?)\s*(lakh|lakhs|lac|l|crore|cr|k)?/i);
  if (!m) return null;
  let v = parseFloat(m[1].replace(/,/g, ''));
  const unit = (m[2] || '').toLowerCase();
  if (/^(lakh|lakhs|lac|l)$/.test(unit)) v *= 100000;
  else if (/^(crore|cr)$/.test(unit)) v *= 10000000;
  else if (unit === 'k') v *= 1000;
  return isNaN(v) ? null : v;
}
/* Only fires on an explicit change/add-style verb, so an ordinary question
   like "what is my bonus" is never misread as an edit. */
function tryApplyEdit(text) {
  const isAdd = EDIT_ADD_VERBS.test(text);
  const isSet = EDIT_SET_VERBS.test(text);
  if (!isAdd && !isSet) return null;
  const v = parseRupeeAmount(text);
  if (v === null) return null;
  const hit = EDIT_KEYWORDS.find(k => k.re.test(text));
  if (!hit) return null;
  const applied = applyActions([{ field: hit.field, op: isAdd ? 'add' : 'set', amount: v }]);
  return applied.length ? hit : null;
}

const AI_BAR_EXAMPLE = 'Update my ELSS Mutual Fund amount to 50,000';
let _tcMsgCount = 0;

function tcExpandLog() {
  $('tc-log').classList.remove('collapsed');
  const t = $('ai-log-toggle'); t.hidden = false; t.classList.remove('collapsed');
}
function tcBubble(cls, html) {
  const b = el('div', 'bub ' + cls); b.innerHTML = html;
  $('tc-log').appendChild(b);
  _tcMsgCount++;
  $('ai-log-toggle').textContent = _tcMsgCount + (_tcMsgCount === 1 ? ' message' : ' messages');
  tcExpandLog();
  requestAnimationFrame(() => { const l = $('tc-log'); l.scrollTop = l.scrollHeight; });
  return b;
}
/* Recompute + redraw everything downstream of a profile change, wherever
   the edit came from (chat action or offline fallback). */
function refreshAfterEdit() {
  updateMeter();
  renderAnsweredPanel();
  if (currentScreenId() === 'screen-result') {
    renderResult();
    if (!$('review-overlay').hidden) renderQuestionRows($('review-overlay-list'), reviewableQuestions(), { autoApply: true });
  }
}

/* Kept short on purpose — this account's Groq tier is rate-limited (see the
   worker), and history tokens compete with everything else in that budget.
   A handful of recent turns is plenty to resolve "those"/"it"/a short reply
   like "I don't have those" against what was just discussed. */
const CHAT_HISTORY_LIMIT = 8;
function rememberChatTurn(userText, replyText) {
  S.chatHistory.push({ role: 'user', content: userText }, { role: 'assistant', content: replyText });
  S.chatHistory = S.chatHistory.slice(-CHAT_HISTORY_LIMIT);
}

async function tcSend() {
  const text = $('tc-input').value.trim();
  if (!text || !S.profile || !S.pack) return;
  if (!S.comparison) S.comparison = compareRegimes(S.profile, S.pack);
  tcBubble('usr', esc(text));
  $('tc-input').value = '';

  const wait = tcBubble('bot', 'Thinking…');
  const res = await askExplainer(S, text, S.chatHistory);

  if (res.ok) {
    const applied = applyActions(res.actions);
    if (applied.length) refreshAfterEdit();
    wait.innerHTML = res.text;
    rememberChatTurn(text, res.text);
    return;
  }

  // Worker unreachable or erroring — degrade to the deterministic offline
  // parser (narrower: one field per message, fixed verbs) so the bar still
  // does something useful, per the "works with the model off" rule.
  const edit = tryApplyEdit(text);
  if (edit) {
    refreshAfterEdit();
    const msg = 'Done — updated and recalculated (offline mode). <b>' +
      (S.comparison.winner === 'neu' ? 'New regime' : 'Old regime') + '</b> now wins by ' + fmt(S.comparison.saving) + '.';
    wait.innerHTML = msg;
    rememberChatTurn(text, 'Updated ' + edit.field + '.');
    return;
  }
  // Not recorded into history below — this reply is our canned local text,
  // never something the model actually said, so it shouldn't be fed back
  // to it as if it were.
  if (res.reason === 'network') {
    wait.innerHTML = localAnswer(text) +
      '<span class="why">The backend could not be reached (offline, or this page is running as a sandboxed Artifact). Everything else here is computed locally and unaffected.</span>';
  } else if (isRateLimitError(res.detail)) {
    wait.innerHTML = localAnswer(text) +
      '<span class="why">The free model reached its limit — try again in a minute or two. Everything else here is computed locally and unaffected.</span>';
  } else {
    wait.innerHTML = localAnswer(text) +
      '<span class="why">The explainer backend replied ' + (res.status || 'with an error') + ', so here\'s the built-in reference instead.</span>';
  }
}
/* The worker forwards Groq's own error body verbatim in `detail` — sniff it
   for the rate-limit case so people see "try again shortly", the true and
   actionable reason, rather than a bare, alarming HTTP status code. */
function isRateLimitError(detail) {
  if (!detail) return false;
  return /groq_http_429|rate limit/i.test(detail);
}
function wireChatWidget() {
  $('tc-form').addEventListener('submit', e => { e.preventDefault(); tcSend(); });
  $('ai-log-toggle').addEventListener('click', () => {
    const collapsed = $('tc-log').classList.toggle('collapsed');
    $('ai-log-toggle').classList.toggle('collapsed', collapsed);
  });
  // On focus with nothing typed yet, show a worked example as the placeholder
  // rather than a static hint — reverts once the field is empty and blurred.
  const input = $('tc-input');
  input.addEventListener('focus', () => { if (!input.value) input.placeholder = 'e.g. ' + AI_BAR_EXAMPLE; });
  input.addEventListener('blur', () => { if (!input.value) input.placeholder = 'Use AI to fill/ask'; });
}

/* ------------------------------------------------------- export/import */
function exportSession() {
  const json = JSON.stringify({
    app: 'tax-regime-copilot', version: 1, savedAt: new Date().toISOString(),
    profile: S.profile
  }, null, 2);
  let downloaded = false;
  try {
    const blob = new Blob([json], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'tax-session-' + S.profile.taxYear + '.json';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    downloaded = true;
  } catch (e) { downloaded = false; }
  // Some sandboxes (a hosted Artifact, for one) refuse page-initiated downloads
  // silently, so always offer the text as well rather than appearing to work.
  $('export-fallback').hidden = false;
  $('export-text').value = json;
  $('export-note').textContent = downloaded
    ? 'If no file appeared, this page is running somewhere that blocks downloads — copy the text below and save it as a .json file yourself.'
    : 'Downloads are blocked here. Copy the text below and save it as a .json file.';
}

function importSession(text) {
  try {
    const j = JSON.parse(text);
    if (!j.profile) throw new Error('not a session file');
    S.profile = Object.assign(emptyProfile(), j.profile);
    S.pack = pack();
    $('pill-year').textContent = 'FY ' + S.profile.taxYear;
    if (Object.keys(S.profile.answered || {}).length) { renderResult(); }
    else goConfirm(S.profile, null);
  } catch (e) {
    const msg = $('parse-msg');
    msg.hidden = false; msg.style.color = 'var(--flag)';
    msg.textContent = 'That file could not be read as a saved session.';
  }
}

/* ---------------------------------------------------------------- tests */
function showTests() {
  const r = runGoldenSuite();
  const sum = $('test-summary'); sum.innerHTML = '';
  const d = el('div', 'note' + (r.fail ? ' warn' : ''));
  d.innerHTML = '<b>' + r.pass + ' of ' + r.total + ' passed' + (r.fail ? ', ' + r.fail + ' FAILED' : '') +
    '.</b> Each case checks taxable income, slab tax, rebate, surcharge and the total, under both regimes.';
  sum.appendChild(d);
  const rows = $('test-rows'); rows.innerHTML = '';
  r.rows.forEach(row => {
    const el2 = el('div', 'testrow');
    el2.appendChild(el('span', 'tick ' + (row.ok ? 'p' : 'f'), row.ok ? 'OK' : 'XX'));
    const nm = el('span');
    nm.appendChild(document.createTextNode(row.name));
    if (!row.ok) row.failures.forEach(f =>
      nm.appendChild(el('div', 'tiny', f.regime + '.' + f.field + ': expected ' + f.exp + ', got ' + f.got)));
    el2.appendChild(nm);
    el2.appendChild(el('span', 'mono tiny muted', 'new ' + fmt(row.neu) + ' · old ' + fmt(row.old)));
    rows.appendChild(el2);
  });
  show('screen-tests');
}

/* ----------------------------------------------------------------- wire */
/* Two-column earnings|deductions, the layout every Indian payroll system uses. */
const SAMPLE = `Payslip for the month of July 2026
Earnings                        Amount   Deductions              Amount
BASIC                       100,000.00   PF                    1,800.00
HRA                          50,000.00   PROF TAX                200.00
FOOD COUPONS                  2,200.00   INCOME TAX           24,500.00
BROADBAND ALLOWANCE           2,000.00
LTA                           8,300.00
SPECIAL ALLOWANCE            42,500.00
Total Earnings              205,000.00   Total Deduction      26,500.00
Net Pay for the month : 178,500.00`;

const SAMPLE_OFFER = `Annexure A - Salary Structure
Your total annual CTC will be INR 30,00,000.
CTC BREAK-UP
Components                              Monthly        Per Annum
Basic                                 100,000.00      12,00,000
HRA                                    50,000.00       6,00,000
LTA                                     8,300.00         99,600
Professional Development Allowance      4,000.00         48,000
Special Allowance                      42,500.00       5,10,000
Gross Salary                          204,800.00      24,57,600
Employer PF                             1,800.00         21,600
Gratuity                                4,808.00         57,700
Fixed CTC                                            25,36,900
Performance Bonus                                     2,50,000
Total CTC                                            27,86,900`;

function ingestText(text, forcedType) {
  const parsed = parsePayslipText(text, forcedType || S.forcedType || undefined);
  const found = Object.keys(parsed.hits).length + parsed.parts.allow.length;
  const msg = $('parse-msg'); msg.hidden = false;
  if (found < 2) {
    msg.style.color = 'var(--flag)';
    msg.textContent = 'Only ' + found + ' line(s) recognised — not enough to work from. ' +
      'Type the numbers instead; it takes a minute.';
    return false;
  }
  msg.style.color = 'var(--muted)';
  msg.textContent = found + ' lines recognised.';
  S.lastText = text;
  goConfirm(parsedToProfile(parsed, CURRENT_TAX_YEAR), parsed);
  return true;
}

/* Plain-language line shown under the doc-type tabs for whichever is picked. */
const DOCTYPE_TAB_INFO = {
  monthly: 'Any month. Figures get multiplied by twelve, and you\'ll be warned if that month was unusual — arrears, loss of pay, a bonus.',
  annual: 'A year-to-date summary or annual salary breakup. Read as-is, and checked for whether it covers all twelve months.',
  offer: 'The most accurate start. Annual figures straight from the salary structure, with employer PF and gratuity correctly left out.'
};

function showFieldError(id, msg) {
  const n = $(id); n.textContent = msg; n.hidden = false;
}
function clearFieldError(id) { const n = $(id); n.hidden = true; n.textContent = ''; }

/* Shared by the desktop tab strip and the mobile <select> — picking a
   document type either way does exactly the same thing. */
function selectDocType(type, opts) {
  S.forcedType = type;
  document.querySelectorAll('.doctype').forEach(o =>
    o.setAttribute('aria-pressed', String(o.dataset.type === type)));
  $('sel-doctype-mobile').value = type;
  $('doctype-sub').textContent = DOCTYPE_TAB_INFO[type] || '';
  $('drop').hidden = false;
  $('drop-label').textContent = 'Drop your ' +
    (type === 'monthly' ? 'payslip' : type === 'offer' ? 'offer letter' : 'statement') +
    ' here, or';
  if (!opts || !opts.silent) $('drop').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function wire() {
  document.querySelectorAll('.doctype').forEach(b => {
    b.addEventListener('click', () => selectDocType(b.dataset.type));
  });
  $('sel-doctype-mobile').addEventListener('change', e => selectDocType(e.target.value));
  // Pre-pick monthly payslip by default (desktop and mobile alike) rather
  // than making everyone pick a tab just to reach the upload step — it's
  // the most common starting document, and changing it is one click away.
  selectDocType('monthly', { silent: true });

  $('btn-pick').addEventListener('click', () => $('file').click());
  $('btn-paste').addEventListener('click', () => {
    const a = $('paste-area'); a.hidden = !a.hidden; if (!a.hidden) $('paste-text').focus();
  });
  // Clicking anywhere outside the open paste box (and not its own toggle
  // button) hides it again, so it doesn't sit open once someone's moved on.
  document.addEventListener('click', e => {
    const a = $('paste-area');
    if (a.hidden) return;
    if (a.contains(e.target) || e.target === $('btn-paste')) return;
    a.hidden = true;
  });
  $('btn-paste-demo').addEventListener('click', () => {
    $('paste-text').value = S.forcedType === 'offer' ? SAMPLE_OFFER : SAMPLE;
  });
  $('btn-show-parts').addEventListener('click', openPartsDrawer);
  $('btn-parts-close').addEventListener('click', closePartsDrawer);
  $('parts-backdrop').addEventListener('click', closePartsDrawer);
  $('btn-paste-go').addEventListener('click', () => {
    const t = $('paste-text').value.trim();
    if (t) ingestText(t);
  });
  $('file').addEventListener('change', e => {
    if (e.target.files[0]) handleFile(e.target.files[0]);
    e.target.value = ''; // reset so choosing the same file again still fires 'change'
  });

  const drop = $('drop');
  ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => {
    e.preventDefault(); drop.classList.add('over');
  }));
  ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => {
    e.preventDefault(); drop.classList.remove('over');
  }));
  drop.addEventListener('drop', e => { if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]); });

  $('btn-manual').addEventListener('click', () => {
    S.profile = emptyProfile(); S.profile.taxYear = CURRENT_TAX_YEAR; S.pack = pack();
    S.parsed = null; S.forcedType = null;
    const redraw = () => $('manual-gross').textContent = fmt(grossSalary(S.profile));
    renderFieldGrid($('manual-fields'), S.profile, redraw, false);
    redraw(); clearFieldError('manual-error'); show('screen-manual');
  });
  $('btn-manual-go').addEventListener('click', () => {
    if (grossSalary(S.profile) <= 0) return showFieldError('manual-error', 'Enter at least a basic salary before continuing.');
    clearFieldError('manual-error');
    renderTriage();
  });
  $('btn-confirm-go').addEventListener('click', () => {
    if (grossSalary(S.profile) <= 0) return showFieldError('confirm-error', 'Gross salary reads as zero — fix the fields above first.');
    clearFieldError('confirm-error');
    renderTriage();
  });
  $('btn-triage-go').addEventListener('click', () => {
    const ticked = Array.from(document.querySelectorAll('.triage-cb:checked')).map(c => c.value);
    S.profile.outOfScope = ticked;
    if (ticked.length) return renderScope(ticked);
    startInterview();
  });
  $('btn-scope-anyway').addEventListener('click', startInterview);
  $('btn-scope-ca').addEventListener('click', () => { $('scope-ca-msg').hidden = false; });
  $('btn-back').addEventListener('click', goBack);
  $('btn-tests').addEventListener('click', showTests);
  $('btn-tests-back').addEventListener('click', () => show('screen-start'));
  $('btn-restart').addEventListener('click', () => {
    if (S.profile && !confirm('Start over? Everything you\'ve entered will be cleared.')) return;
    S.profile = null; S.parsed = null; S.forcedType = null; S.lastText = null;
    S.chatHistory = []; $('tc-log').innerHTML = ''; _tcMsgCount = 0;
    $('chat').innerHTML = ''; $('parse-msg').hidden = true;
    $('paste-area').hidden = true; $('paste-text').value = ''; $('drop').hidden = true;
    $('file').value = ''; // otherwise re-picking the same file after restart silently does nothing
    $('scope-ca-msg').hidden = true;
    selectDocType('monthly', { silent: true });
    show('screen-start');
  });
  $('btn-export').addEventListener('click', exportSession);
  $('btn-copy').addEventListener('click', async () => {
    const t = $('export-text');
    try { await navigator.clipboard.writeText(t.value); }
    catch (e) { t.select(); try { document.execCommand('copy'); } catch (e2) {} }
    $('copy-msg').textContent = 'Copied.';
    setTimeout(() => $('copy-msg').textContent = '', 2500);
  });
  $('btn-print').addEventListener('click', () => window.print());
  $('btn-edit').addEventListener('click', openReviewOverlay);
  $('btn-review-close').addEventListener('click', closeReviewOverlay);
  $('btn-import').addEventListener('click', () => $('file-import').click());
  $('file-import').addEventListener('change', e => {
    const f = e.target.files[0]; if (!f) return;
    const r = new FileReader(); r.onload = () => importSession(r.result); r.readAsText(f);
  });

  $('glossary-close').addEventListener('click', closeGlossary);
  $('glossary-backdrop').addEventListener('click', closeGlossary);
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    closeGlossary(); closeBreakdown(); closePartsDrawer();
    if (!$('review-overlay').hidden) closeReviewOverlay();
  });

  $('btn-breakdown-inline').addEventListener('click', openBreakdown);
  $('btn-breakdown-close').addEventListener('click', closeBreakdown);
  $('breakdown-backdrop').addEventListener('click', closeBreakdown);

  wireChatWidget();
  window.addEventListener('resize', syncTopbarHeight);
  syncTopbarHeight();
}

function renderScope(ids) {
  const box = $('scope-list'); box.innerHTML = '';
  outOfScopeNote(ids).forEach(t => {
    const d = el('div');
    d.appendChild(el('h3', null, t.label));
    d.appendChild(el('p', 'small muted', t.note));
    box.appendChild(d);
  });
  const c = compareRegimes(S.profile, S.pack);
  $('scope-summary').innerHTML =
    '<div class="small muted" style="margin-top:8px">Gross salary <b class="mono">' + fmt(grossSalary(S.profile)) +
    '</b> · salary-only tax under the old regime <b class="mono">' + fmt(c.old.total) +
    '</b>, under the new regime <b class="mono">' + fmt(c.neu.total) + '</b>, before anything you ticked above.</div>';
  show('screen-scope');
}

async function handleFile(file) {
  const msg = $('parse-msg'); msg.hidden = false; msg.style.color = 'var(--muted)';
  msg.textContent = 'Reading ' + file.name + '…';
  try {
    let text;
    if (/\.pdf$/i.test(file.name) || file.type === 'application/pdf') text = await extractPdfText(file);
    else text = await file.text();
    if (!text || text.replace(/\s/g, '').length < 30) throw new Error('No text layer found');
    ingestText(text);
  } catch (e) {
    msg.style.color = 'var(--flag)';
    msg.textContent = 'Could not read that file — it is probably a scan or password-protected. ' +
      'Paste the text instead, or enter the numbers manually. (' + (e.message || e) + ')';
    $('paste-area').hidden = false;
  }
}

let _wired = false;
function bootOnce() { if (_wired) return; _wired = true; wire(); show(currentScreenId() || 'screen-start'); }
document.addEventListener('DOMContentLoaded', bootOnce);
if (document.readyState !== 'loading') bootOnce();
