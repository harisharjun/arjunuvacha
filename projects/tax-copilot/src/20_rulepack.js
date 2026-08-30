/* ============================================================================
   RULEPACK — rates as data, never in code.
   One object per tax year. Budget changes should be a data edit + a test run.
   ========================================================================== */
const RULEPACKS = {
  '2026-27': {
    taxYear: '2026-27',
    label: 'FY 2026-27 (Tax Year 2026-27)',
    statute: 'Income-tax Act, 2025',
    version: '1.0.0',
    cess: 0.04,
    cessLabel: 'Health & Education cess @ 4%',
    roundingStep: 10,
    regimes: {
      neu: {
        key: 'neu', name: 'New regime', isDefault: true,
        slabs: [[0,400000,0],[400000,800000,.05],[800000,1200000,.10],
                [1200000,1600000,.15],[1600000,2000000,.20],
                [2000000,2400000,.25],[2400000,null,.30]],
        standardDeduction: 75000, stdRule: 's.19 (was s.16(ia))',
        rebate: { limit: 1200000, max: 60000, marginalRelief: true, rule: 's.156 (was 87A)' },
        surcharge: [[5000000,.10],[10000000,.15],[20000000,.25]],
        employerNpsCapPct: 0.14,
        allows: ['employerNps']
      },
      old: {
        key: 'old', name: 'Old regime', isDefault: false,
        slabs: [[0,250000,0],[250000,500000,.05],[500000,1000000,.20],[1000000,null,.30]],
        standardDeduction: 50000, stdRule: 's.19 (was s.16(ia))',
        rebate: { limit: 500000, max: 12500, marginalRelief: false, rule: 's.156 (was 87A)' },
        surcharge: [[5000000,.10],[10000000,.15],[20000000,.25],[50000000,.37]],
        employerNpsCapPct: 0.10,
        allows: ['employerNps','professionalTax','hra','s80C','s80CCD1B','s80D',
                 'homeLoanInterest','s80E','s80G','s80TTA']
      }
    },
    /* Deduction catalogue. The model may SELECT from this; it may never author it. */
    catalogue: [
      { id:'hra', label:'HRA exemption', rule:'s.14 read with Rule 2A (was s.10(13A))',
        max:null, note:'Least of: HRA received · rent paid minus 10% of basic · 50% of basic (metro) or 40%' },
      { id:'s80C', label:'80C — now Section 123', rule:'s.123', max:150000,
        note:'EPF, ELSS, PPF, LIC, tuition fees, home-loan principal, SSY, 5-yr FD' },
      { id:'s80CCD1B', label:'80CCD(1B) — self NPS', rule:'s.124(2)', max:50000,
        note:'Over and above the 80C ceiling' },
      { id:'s80D', label:'80D — now Section 126', rule:'s.126', max:100000,
        note:'₹25,000 self & family (₹50,000 if senior) + ₹25,000 parents (₹50,000 if senior)' },
      { id:'homeLoanInterest', label:'Home-loan interest, self-occupied', rule:'s.22 (was s.24(b))',
        max:200000, note:'Self-occupied property only' },
      { id:'s80E', label:'80E — education loan interest', rule:'s.127', max:null,
        note:'No cap; 8 assessment years from first repayment' },
      { id:'s80G', label:'80G — donations', rule:'s.133', max:null,
        note:'100%-without-limit categories only in this version' },
      { id:'s80TTA', label:'80TTA — savings-account interest', rule:'s.128', max:10000,
        note:'Savings interest only, not fixed deposits' },
      { id:'employerNps', label:"80CCD(2) — employer's NPS contribution", rule:'s.124(3)',
        max:null, bothRegimes:true,
        note:'Capped at 14% of basic in the new regime, 10% in the old' },
      { id:'professionalTax', label:'Professional tax', rule:'s.19 (was s.16(iii))', max:null,
        note:'Old regime only' }
    ]
  }
};
/* FY 2025-26 shares the rate structure but runs on the 1961 Act. */
RULEPACKS['2025-26'] = JSON.parse(JSON.stringify(RULEPACKS['2026-27']));
RULEPACKS['2025-26'].taxYear = '2025-26';
RULEPACKS['2025-26'].label = 'FY 2025-26 (AY 2026-27)';
RULEPACKS['2025-26'].statute = 'Income-tax Act, 1961';
RULEPACKS['2025-26'].regimes.neu.stdRule = 's.16(ia)';
RULEPACKS['2025-26'].regimes.old.stdRule = 's.16(ia)';
RULEPACKS['2025-26'].regimes.neu.rebate.rule = 's.87A';
RULEPACKS['2025-26'].regimes.old.rebate.rule = 's.87A';
RULEPACKS['2025-26'].catalogue.forEach(function (c) {
  const map = { s80C:'s.80C', s80CCD1B:'s.80CCD(1B)', s80D:'s.80D',
                homeLoanInterest:'s.24(b)', s80E:'s.80E', s80G:'s.80G',
                s80TTA:'s.80TTA', employerNps:'s.80CCD(2)',
                professionalTax:'s.16(iii)', hra:'s.10(13A) + Rule 2A' };
  if (map[c.id]) c.rule = map[c.id];
  if (c.id === 's80C') c.label = '80C';
  if (c.id === 's80D') c.label = '80D';
});
