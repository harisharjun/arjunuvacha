/* ============================================================================
   INTERVIEW — a declarative decision tree, not a model. Fifteen nodes, ordered
   by expected rupee impact, with a numeric stopping rule: as soon as every
   remaining question added together cannot close the gap to the new regime,
   the interview ends. That is what keeps it four to six questions instead of
   thirty, and it is why the chat can be scripted without feeling like a form.
   ========================================================================== */

const TRIAGE = [
  { id: 'business',  label: 'Business, freelance or professional income',
    note: 'This tool only handles salary. Freelance or business income is reported on different forms (ITR-3 or ITR-4) with their own rules — a CA needs to be involved.' },
  { id: 'capgains',  label: 'Sold shares, mutual funds or property this year',
    note: 'Profit from selling an investment is called a "capital gain" — for example, buying a stock for ₹1,00,000 and selling it for ₹1,30,000 is a ₹30,000 gain. Unlike salary, it is not added to your slab and taxed at 5%/20%/30% — it gets its own flat rate depending on how long you held it, and that calculation needs its own schedule this tool doesn\'t cover.' },
  { id: 'foreign',   label: 'Foreign assets, or ESOPs of a company listed abroad',
    note: 'Owning a foreign bank account, stock, or ESOPs from a company listed outside India means you must file "Schedule FA" — missing it carries steep penalties, so this needs a CA.' },
  { id: 'nri',       label: 'Non-resident or RNOR for this year',
    note: 'Your residency status (how many days you spent in India) changes which of your income is even taxable here — this tool assumes a normal Indian resident.' },
  { id: 'employers', label: 'More than two employers this year',
    note: 'If you switched jobs more than once, your salary and TDS from every employer has to be added together correctly first — this tool only reads one document at a time.' }
];

const QUESTIONS = [
  {
    id: 'bonus',
    when: p => p.source === 'monthly' && p.salary.bonus === 0,
    always: true,   // moves BOTH regimes, so never skipped by the stopping rule
    tier: 2,
    topic: 'bonus',
    ask: 'Does your annual pay include a bonus or variable component that is not on this payslip?',
    why: 'One payslip can only see one month. This is the single biggest reason a projection goes wrong.',
    type: 'chips-then-amount',
    chips: [
      { label: 'No, my pay is fixed', value: 0 },
      { label: 'Yes — I know roughly', value: 'ask' },
      { label: "I'm not sure yet", value: 'unknown' }
    ],
    amountLabel: 'Roughly how much for the full year?',
    apply: (p, v) => {
      if (v === 'unknown') { p.estimates.bonus = true; p.bonusUnknown = true; }
      else { p.salary.bonus = v; if (v > 0) p.estimates.bonus = true; }
    }
  },
  {
    id: 'rent',
    when: p => p.salary.hra > 0 && !p.flags.ownsHome,
    impact: p => Math.min(p.salary.hra, 0.5 * p.salary.basic),
    topic: 'hra',
    ask: 'Your payslip has an HRA component, so this one is worth checking. Do you pay rent?',
    why: 'HRA exemption is usually the largest single deduction available to a salaried renter.',
    type: 'chips-then-rent',
    chips: [
      { label: 'Yes, I rent', value: 'yes' },
      { label: 'No', value: 'no' },
      { label: 'I own the home I live in', value: 'own' }
    ],
    apply: (p, v) => {
      if (v === 'own') p.flags.ownsHome = true;
      if (v !== 'yes') p.deductions.rentPaid = 0;
    }
  },
  {
    id: 'homeLoan',
    impact: () => 200000,
    topic: 'homeLoanInterest',
    ask: 'Are you paying interest on a home loan for a property you live in?',
    why: 'Up to ₹2,00,000 of interest is deductible under the old regime — Section 22, formerly 24(b).',
    type: 'chips-then-amount',
    chips: [
      { label: 'No', value: 0 },
      { label: 'Yes — I know the interest', value: 'ask' },
      { label: "Yes, but I don't know the figure", value: 'estimate' }
    ],
    amountLabel: 'Interest paid this year (not the full EMI — your bank\'s provisional certificate shows it separately)',
    estimateValue: 200000,
    apply: (p, v) => {
      p.deductions.homeLoanInterest = v;
      if (v === 200000) p.estimates.homeLoanInterest = true;
      if (v > 0) p.flags.hasHomeLoan = true;
    }
  },
  {
    id: 's80C',
    impact: p => Math.max(0, 150000 - p.salary.employeePf - p.deductions.s80C_other),
    topic: 's80C',
    ask: p => {
      const pf = p.salary.employeePf;
      const left = Math.max(0, 150000 - pf);
      return pf > 0
        ? 'Your EPF of ' + fmt(pf) + ' already counts towards the ₹1,50,000 Section 123 ceiling — most people don\'t realise that. Do you have anything else in there? ' +
          (left > 0 ? 'You have ' + fmt(left) + ' of room left.' : 'The ceiling is already full, so this one can\'t grow.')
        : 'Do you have any Section 123 investments — ELSS, PPF, LIC premiums, children\'s tuition fees, home-loan principal?';
    },
    why: 'Section 123 is what used to be 80C. The ceiling is ₹1,50,000 across everything in it — added together, not each on its own.',
    type: 'chips-then-multi-amount',
    chips: [
      { label: 'Nothing else', value: 0 },
      { label: 'Yes, let me enter it', value: 'ask' }
    ],
    fields: [
      { key: 'elss', label: 'ELSS mutual funds' },
      { key: 'ppf', label: 'PPF' },
      { key: 'lic', label: 'LIC / life insurance premiums' },
      { key: 'tuition', label: "Children's tuition fees" },
      { key: 'homeLoanPrincipal', label: 'Home loan principal repaid' },
      { key: 'other', label: 'Anything else under Section 123' }
    ],
    apply: (p, v) => {
      const sum = typeof v === 'object'
        ? Object.keys(v).reduce((a, k) => a + (parseFloat(v[k]) || 0), 0)
        : v;
      p.deductions.s80C_other = sum;
      p.deductions.s80C_breakdown = typeof v === 'object' ? v : null;
    }
  },
  {
    id: 's80CCD1B',
    impact: () => 50000,
    topic: 's80CCD1B',
    ask: 'Do you put money into NPS yourself, separate from anything your employer contributes?',
    why: 'Your own NPS contribution gets ₹50,000 on top of the Section 123 ceiling — 80CCD(1B).',
    type: 'chips-then-amount',
    chips: [
      { label: 'No', value: 0 },
      { label: 'Yes — ₹50,000 or more', value: 50000 },
      { label: 'Yes, a smaller amount', value: 'ask' }
    ],
    amountLabel: 'How much for the year?',
    apply: (p, v) => { p.deductions.s80CCD1B = v; }
  },
  {
    id: 's80D',
    impact: () => 100000,
    topic: 's80D',
    ask: 'Do you pay health insurance premiums for yourself, your family or your parents?',
    why: 'Section 126 (was 80D): ₹25,000 for yourself and family, plus another ₹25,000 for parents — each becomes ₹50,000 if the person insured is a senior citizen.',
    type: 'chips-then-amount',
    chips: [
      { label: 'No', value: 0 },
      { label: 'Yes, let me enter it', value: 'ask' }
    ],
    amountLabel: 'Total premiums for the year (a company group policy you don\'t pay for doesn\'t count)',
    apply: (p, v) => { p.deductions.s80D = v; }
  },
  {
    id: 's80E',
    impact: () => 150000,
    topic: 's80E',
    ask: 'Are you repaying an education loan for yourself, your spouse or your children?',
    why: 'The interest is fully deductible with no ceiling for eight years — Section 127, was 80E.',
    type: 'chips-then-amount',
    chips: [{ label: 'No', value: 0 }, { label: 'Yes', value: 'ask' }],
    amountLabel: 'Interest paid this year',
    apply: (p, v) => { p.deductions.s80E = v; }
  },
  {
    id: 's80G',
    impact: () => 50000,
    topic: 's80G',
    ask: 'Did you make any donations that qualify for 100% deduction — a PM relief fund, or a notified fund?',
    why: 'Only the 100%-without-limit categories are handled here; the percentage-limited ones need your CA.',
    type: 'chips-then-amount',
    chips: [{ label: 'No', value: 0 }, { label: 'Yes', value: 'ask' }],
    amountLabel: 'Total donated (only 100%-deduction categories)',
    apply: (p, v) => { p.deductions.s80G = v; }
  },
  {
    id: 'otherIncome',
    always: true,          // affects both regimes, so it is never skipped
    topic: 'otherIncome',
    ask: 'Last one. Roughly how much interest did you earn from savings accounts and fixed deposits this year?',
    why: 'This is taxable under both regimes and it is the single most commonly forgotten head — the tax department already has it from your AIS.',
    type: 'two-amounts',
    fields: [
      { key: 'savingsInterest', label: 'Savings account interest' },
      { key: 'fdInterest', label: 'Fixed deposit interest' }
    ],
    apply: (p, v) => {
      p.otherIncome.savingsInterest = v.savingsInterest || 0;
      p.otherIncome.fdInterest = v.fdInterest || 0;
    }
  }
];

/* The stopping rule. Returns the next question, or null when the remaining
   catalogue provably cannot change the verdict. */
function nextQuestion(p, pack) {
  const asked = p.answered;
  const remaining = QUESTIONS.filter(q => !asked[q.id] && (!q.when || q.when(p)));
  if (!remaining.length) return null;

  const cmp = compareRegimes(p, pack);
  const be = breakEvenDeductions(p, pack);

  // Once the old regime is already ahead, every further deduction only widens
  // it — but "always" questions still run because they move both regimes.
  const alwaysLeft = remaining.filter(q => q.always);
  if (be.alreadyAhead) return alwaysLeft[0] || null;

  // be.needed is already "how much MORE deduction, on top of what's found
  // right now, would close the gap" — breakEvenDeductions() bisects from the
  // current profile, so it's self-relative already. Subtracting the current
  // total again here would double-count it and understate the real gap,
  // making the early-exit rule below fire sooner than it honestly should.
  const gap = be.needed === null ? Infinity : be.needed;
  const roomLeft = remaining.filter(q => !q.always)
    .reduce((a, q) => a + (q.impact ? q.impact(p) : 0), 0);

  if (roomLeft < gap) {
    p.earlyExit = { gap: gap, roomLeft: roomLeft };
    return alwaysLeft[0] || null;
  }
  return remaining[0];
}

function outOfScopeNote(ids) {
  return TRIAGE.filter(t => ids.indexOf(t.id) >= 0);
}

if (typeof module !== 'undefined') module.exports = { QUESTIONS, TRIAGE, nextQuestion };
