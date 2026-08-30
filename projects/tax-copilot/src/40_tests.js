/* ============================================================================
   GOLDEN SUITE — 21 hand-specified salary profiles with expected values from
   an independently written reference implementation. If the engine and the
   reference disagree, one of them is wrong and neither ships.
   Run in the browser from the "Run the test suite" link on the front page.
   ========================================================================== */
const GOLDEN_CASES = __CASES__;

function caseToProfile(c) {
  const p = emptyProfile();
  p.taxYear = '2026-27';
  p.salary.basic = c.basic;
  p.salary.hra = c.hra;
  p.salary.otherAllowances = c.other;
  p.salary.bonus = c.bonus;
  p.salary.employerNps = c.enps;
  p.salary.employeePf = c.epf;
  p.salary.professionalTax = c.ptax;
  p.otherIncome.savingsInterest = c.savings;
  p.otherIncome.fdInterest = c.fd;
  p.deductions.rentPaid = c.rent;
  p.deductions.metro = c.metro;
  p.deductions.s80C_other = c.c80;
  p.deductions.s80CCD1B = c.ccd1b;
  p.deductions.s80D = c.d80;
  p.deductions.homeLoanInterest = c.hli;
  p.deductions.s80E = c.e80;
  p.deductions.s80G = c.g80;
  return p;
}

function runGoldenSuite() {
  const pack = RULEPACKS['2026-27'];
  const rows = [];
  let pass = 0, fail = 0;
  for (const gc of GOLDEN_CASES) {
    const p = caseToProfile(gc.profile);
    const checks = [];
    for (const rk of ['neu', 'old']) {
      const got = computeRegime(p, rk, pack);
      const exp = gc.expected[rk];
      const near = (a, b) => Math.abs(a - b) < 1;
      checks.push({ regime: rk, field: 'taxable', exp: exp.taxable, got: got.taxableIncome, ok: near(exp.taxable, got.taxableIncome) });
      checks.push({ regime: rk, field: 'baseTax',  exp: exp.base,    got: got.baseTax,      ok: near(exp.base, got.baseTax) });
      checks.push({ regime: rk, field: 'rebate',   exp: exp.rebate,  got: got.rebate,       ok: near(exp.rebate, got.rebate) });
      checks.push({ regime: rk, field: 'surcharge',exp: exp.surcharge, got: got.surcharge,  ok: near(exp.surcharge, got.surcharge) });
      checks.push({ regime: rk, field: 'total',    exp: exp.total,   got: got.total,        ok: near(exp.total, got.total) });
    }
    const bad = checks.filter(c => !c.ok);
    if (bad.length) fail++; else pass++;
    rows.push({ name: gc.name, ok: !bad.length, failures: bad,
                neu: gc.expected.neu.total, old: gc.expected.old.total });
  }
  return { pass, fail, total: GOLDEN_CASES.length, rows };
}

if (typeof module !== 'undefined') module.exports = { runGoldenSuite, caseToProfile, GOLDEN_CASES };
