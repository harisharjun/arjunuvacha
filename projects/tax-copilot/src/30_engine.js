/* ============================================================================
   ENGINE — pure functions. No DOM, no network, no model. Given a TaxProfile
   and a rulepack it returns a computation sheet. Everything in the product
   that produces a number goes through here.
   ========================================================================== */

function emptyProfile() {
  return {
    taxYear: '2026-27',
    source: 'manual',
    salary: {                 // annual rupee amounts
      basic: 0, hra: 0, otherAllowances: 0, bonus: 0,
      employerNps: 0, employeePf: 0, professionalTax: 0
    },
    otherIncome: { savingsInterest: 0, fdInterest: 0 },
    deductions: {             // user-declared, old-regime relevant
      rentPaid: 0, metro: false,
      s80C_other: 0, s80CCD1B: 0, s80D: 0,
      homeLoanInterest: 0, s80E: 0, s80G: 0
    },
    flags: { ownsHome: false, paysRent: null, hasHomeLoan: false },
    estimates: {},            // fieldName -> true when the value was guessed
    answered: {},             // questionId -> true
    outOfScope: []
  };
}

function grossSalary(p) {
  const s = p.salary;
  return s.basic + s.hra + s.otherAllowances + s.bonus + s.employerNps;
}

function slabTax(taxable, slabs) {
  let t = 0;
  for (const [lo, hi, rate] of slabs) {
    if (taxable <= lo) break;
    const top = hi === null ? taxable : Math.min(taxable, hi);
    t += (top - lo) * rate;
  }
  return t;
}

function surchargeRate(income, bands) {
  let r = 0;
  for (const [threshold, rate] of bands) if (income > threshold) r = rate;
  return r;
}

/* Surcharge with marginal relief: the extra tax+surcharge from crossing a
   threshold can never exceed the income that crossed it. */
function surchargeWithRelief(taxable, baseTax, bands, slabs) {
  const rate = surchargeRate(taxable, bands);
  if (rate === 0) return { amount: 0, rate: 0, relief: 0 };
  let sc = baseTax * rate;
  const crossed = bands.filter(b => taxable > b[0]).map(b => b[0]);
  const threshold = Math.max.apply(null, crossed);
  const taxAt = slabTax(threshold, slabs);
  const totalAt = taxAt + taxAt * surchargeRate(threshold, bands);
  const excess = taxable - threshold;
  let relief = 0;
  if ((baseTax + sc) - totalAt > excess) {
    const capped = Math.max(0, totalAt + excess - baseTax);
    relief = sc - capped;
    sc = capped;
  }
  return { amount: sc, rate: rate, relief: relief };
}

function hraExemption(hraReceived, basic, annualRent, metro) {
  if (!(annualRent > 0) || !(hraReceived > 0)) return 0;
  return Math.max(0, Math.min(
    hraReceived,
    annualRent - 0.10 * basic,
    (metro ? 0.50 : 0.40) * basic
  ));
}

/* Returns every old-regime deduction with its cap applied and its provenance. */
function deductionLines(p, regime, pack) {
  const d = p.deductions, s = p.salary;
  const cat = id => pack.catalogue.find(c => c.id === id);
  const out = [];
  const add = (id, claimed, sourceLabel) => {
    const c = cat(id);
    const allowed = c.max === null ? claimed : Math.min(claimed, c.max);
    out.push({
      id, label: c.label, rule: c.rule, claimed,
      amount: allowed, capped: c.max !== null && claimed > c.max,
      cap: c.max, source: sourceLabel,
      estimated: !!p.estimates[id]
    });
  };

  // 80CCD(2) — the one deduction that survives in both regimes
  if (s.employerNps > 0) {
    const cap = s.basic * regime.employerNpsCapPct;
    const allowed = Math.min(s.employerNps, cap);
    out.push({
      id: 'employerNps', label: cat('employerNps').label, rule: cat('employerNps').rule,
      claimed: s.employerNps, amount: allowed,
      capped: s.employerNps > cap, cap: Math.round(cap),
      source: 'Payslip', estimated: !!p.estimates.employerNps,
      bothRegimes: true
    });
  }
  if (regime.key === 'neu') return out;   // new regime stops here

  if (s.professionalTax > 0) add('professionalTax', s.professionalTax, 'Payslip');

  const hra = hraExemption(s.hra, s.basic, d.rentPaid, d.metro);
  if (hra > 0) {
    out.push({
      id: 'hra', label: cat('hra').label, rule: cat('hra').rule,
      // Not "capped" in the ceiling sense (cap is null) — it's the lowest of
      // three figures, which `workings` below already explains; showing the
      // generic "Capped at — you claimed more" line here is just confusing.
      claimed: s.hra, amount: hra, capped: false, cap: null,
      source: 'Payslip + rent you entered', estimated: !!p.estimates.rentPaid,
      workings: [
        ['HRA received', s.hra],
        ['Rent paid minus 10% of basic', Math.max(0, d.rentPaid - 0.10 * s.basic)],
        [(d.metro ? '50%' : '40%') + ' of basic', (d.metro ? 0.5 : 0.4) * s.basic]
      ]
    });
  }
  const c80 = s.employeePf + d.s80C_other;
  if (c80 > 0) add('s80C', c80, s.employeePf > 0 ? 'EPF from payslip + your answer' : 'Your answer');
  if (d.s80CCD1B > 0) add('s80CCD1B', d.s80CCD1B, 'Your answer');
  if (d.s80D > 0) add('s80D', d.s80D, 'Your answer');
  if (d.homeLoanInterest > 0) add('homeLoanInterest', d.homeLoanInterest, 'Your answer');
  if (d.s80E > 0) add('s80E', d.s80E, 'Your answer');
  if (d.s80G > 0) add('s80G', d.s80G, 'Your answer');
  if (p.otherIncome.savingsInterest > 0)
    add('s80TTA', p.otherIncome.savingsInterest, 'Your answer');
  return out;
}

function computeRegime(p, regimeKey, pack) {
  const regime = pack.regimes[regimeKey];
  const gross = grossSalary(p);
  const std = Math.min(regime.standardDeduction, gross);
  const other = p.otherIncome.savingsInterest + p.otherIncome.fdInterest;
  const netSalary = gross - std;
  const gti = netSalary + other;

  const deds = deductionLines(p, regime, pack);
  const dedTotal = deds.reduce((a, x) => a + x.amount, 0);

  const rawTaxable = Math.max(0, gti - dedTotal);
  const taxable = Math.floor(rawTaxable / pack.roundingStep) * pack.roundingStep;

  const base = slabTax(taxable, regime.slabs);

  let rebate = 0, rebateNote = '';
  if (taxable <= regime.rebate.limit) {
    rebate = Math.min(base, regime.rebate.max);
    if (rebate > 0) rebateNote = 'Full rebate — taxable income is within ' + fmt(regime.rebate.limit);
  } else if (regime.rebate.marginalRelief) {
    const excess = taxable - regime.rebate.limit;
    if (base > excess) {
      rebate = base - excess;
      rebateNote = 'Marginal relief — tax capped at the income above ' + fmt(regime.rebate.limit);
    }
  }
  const afterRebate = base - rebate;
  const sc = afterRebate > 0
    ? surchargeWithRelief(taxable, afterRebate, regime.surcharge, regime.slabs)
    : { amount: 0, rate: 0, relief: 0 };
  const cess = (afterRebate + sc.amount) * pack.cess;
  const totalRaw = afterRebate + sc.amount + cess;
  const total = Math.round(totalRaw / pack.roundingStep) * pack.roundingStep;

  return {
    regimeKey, regimeName: regime.name,
    gross, standardDeduction: std, stdRule: regime.stdRule,
    otherIncome: other, grossTotalIncome: gti,
    deductions: deds, deductionTotal: dedTotal,
    taxableIncome: taxable,
    baseTax: base, rebate, rebateNote, rebateRule: regime.rebate.rule,
    surcharge: sc.amount, surchargeRate: sc.rate, surchargeRelief: sc.relief,
    cess, total, monthly: total / 12
  };
}

function compareRegimes(p, pack) {
  const neu = computeRegime(p, 'neu', pack);
  const old = computeRegime(p, 'old', pack);
  const winner = neu.total <= old.total ? 'neu' : 'old';
  return {
    neu, old, winner,
    saving: Math.abs(neu.total - old.total),
    monthlySaving: Math.abs(neu.total - old.total) / 12
  };
}

/* ---------------------------------------------------------------------------
   The gap: how much more old-regime deduction would it take to beat the new
   regime? Solved by bisection on the actual engine, so it is always consistent
   with the rules rather than an algebraic approximation that can drift.
   ------------------------------------------------------------------------- */
function breakEvenDeductions(p, pack) {
  const target = computeRegime(p, 'neu', pack).total;
  const probe = extra => {
    const q = JSON.parse(JSON.stringify(p));
    q.deductions.s80E += extra;          // 80E is uncapped — a clean probe lever
    return computeRegime(q, 'old', pack).total;
  };
  if (probe(0) <= target) return { needed: 0, reachable: true, alreadyAhead: true };
  let lo = 0, hi = grossSalary(p) + 100000;
  if (probe(hi) > target) return { needed: null, reachable: false, alreadyAhead: false };
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (probe(mid) > target) lo = mid; else hi = mid;
  }
  return { needed: Math.ceil(hi / 10) * 10, reachable: true, alreadyAhead: false };
}

function currentOldDeductions(p, pack) {
  return computeRegime(p, 'old', pack).deductionTotal;
}

/* Maximum additional deduction still theoretically available, used for the
   early-exit rule: if this cannot close the gap, stop asking questions. */
function headroom(p, pack) {
  const q = JSON.parse(JSON.stringify(p));
  const s = q.salary, d = q.deductions;
  let room = 0;
  const cap = id => pack.catalogue.find(c => c.id === id).max;
  if (!q.answered.rent && s.hra > 0)
    room += Math.min(s.hra, 0.5 * s.basic);
  if (!q.answered.s80C) room += Math.max(0, cap('s80C') - s.employeePf - d.s80C_other);
  if (!q.answered.s80CCD1B) room += cap('s80CCD1B') - d.s80CCD1B;
  if (!q.answered.s80D) room += cap('s80D') - d.s80D;
  if (!q.answered.homeLoan) room += cap('homeLoanInterest') - d.homeLoanInterest;
  if (!q.answered.s80E) room += 200000;      // uncapped, but bounded for sanity
  if (!q.answered.s80G) room += 100000;
  return Math.max(0, room);
}

/* ---------------------------------------------------------------------------
   Robustness: re-run the verdict across a plausible annual-income band so the
   answer can be stated without knowing the bonus exactly.
   ------------------------------------------------------------------------- */
function robustness(p, pack, spreadDown, spreadUp) {
  spreadDown = spreadDown === undefined ? 0.75 : spreadDown;
  spreadUp = spreadUp === undefined ? 1.40 : spreadUp;
  const baseGross = grossSalary(p);
  const results = [];
  const steps = 25;
  for (let i = 0; i <= steps; i++) {
    const f = spreadDown + (spreadUp - spreadDown) * (i / steps);
    const q = JSON.parse(JSON.stringify(p));
    const scale = f;
    q.salary.basic *= scale; q.salary.hra *= scale;
    q.salary.otherAllowances *= scale; q.salary.bonus *= scale;
    q.salary.employerNps *= scale; q.salary.employeePf *= scale;
    const c = compareRegimes(q, pack);
    results.push({ factor: f, gross: baseGross * scale, winner: c.winner,
                   neu: c.neu.total, old: c.old.total, saving: c.saving });
  }
  const winners = new Set(results.map(r => r.winner));
  let flipAt = null;
  if (winners.size > 1) {
    for (let i = 1; i < results.length; i++)
      if (results[i].winner !== results[i - 1].winner) { flipAt = results[i].gross; break; }
  }
  return {
    stable: winners.size === 1,
    winner: results[Math.floor(results.length / 2)].winner,
    flipAt, low: results[0].gross, high: results[results.length - 1].gross, results
  };
}

function fmt(n) {
  if (n === null || n === undefined || isNaN(n)) return '—';
  const neg = n < 0; n = Math.round(Math.abs(n));
  const s = n.toString();
  let out;
  if (s.length <= 3) out = s;
  else {
    const last3 = s.slice(-3);
    let rest = s.slice(0, -3);
    rest = rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',');
    out = rest + ',' + last3;
  }
  return (neg ? '−₹' : '₹') + out;
}
function fmtLakh(n) {
  const a = Math.abs(n);
  if (a >= 10000000) return '₹' + (n / 10000000).toFixed(2).replace(/\.00$/, '') + ' cr';
  if (a >= 100000) return '₹' + (n / 100000).toFixed(2).replace(/\.00$/, '') + ' L';
  return fmt(n);
}

if (typeof module !== 'undefined') module.exports = {
  emptyProfile, grossSalary, slabTax, surchargeWithRelief, hraExemption,
  computeRegime, compareRegimes, breakEvenDeductions, headroom, robustness,
  currentOldDeductions, fmt, fmtLakh
};
