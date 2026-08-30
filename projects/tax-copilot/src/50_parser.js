/* ============================================================================
   DOCUMENT PARSER — deterministic, local, no model.

   Rebuilt against fourteen real documents from four different payroll systems.
   The three things that broke the first version, and what replaced them:

   1. Indian payslips print EARNINGS and DEDUCTIONS as two columns on the same
      physical line ("BASIC 170,834.00  PF  1,800.00"). Matching one label per
      line silently dropped every deduction. Lines are now split into
      label→numbers segments, so both halves are read.

   2. Many payslips carry an annual TDS / Chapter VI-A section further down
      that repeats every earnings label with YEARLY figures. Summing blindly
      added the month and the year together. Sections are now tracked and the
      annual block is read separately, never mixed into monthly earnings.

   3. Amount columns differ per vendor — Rate|Earned|Arrear, Master|Actual,
      twelve months + Grand Total, Monthly|Annual. The column to read is now
      decided from the table's own header row.
   ========================================================================== */

/* ---------------------------------------------------------------- labels */
const LABELS = [
  // --- arrears must be tested BEFORE their base component ---
  { f: '_arrear', w: .8, re: /\barrears?\b/i, side: 'earn' },

  { f: 'basic',   w: 1,  re: /\bbasic(\s*(salary|pay|wage))?\b/i, side: 'earn' },
  { f: 'hra',     w: 1,  re: /\b(h\.?\s?r\.?\s?a\.?\*?|house\s*rent\s*allow\w*)\b/i, side: 'earn' },

  // employer contributions — part of CTC, not of taxable gross salary
  { f: 'employerPf',  w: 1, re: /\b(employer'?s?\s*(p\.?f\.?|provident|contribution\s*to\s*(p\.?f|provident))|company\s*p\.?f\.?)\b/i, side: 'any' },
  { f: 'gratuity',    w: 1, re: /\bgratuit(y|ies)\b/i, side: 'any' },
  { f: 'employerNps', w: 1, re: /\b((employer|company|corporate)\s*)?(n\.?p\.?s\.?|national\s*pension)\b/i, side: 'any' },

  { f: 'employeePf', w: .95, re: /\b(p\.?\s?f\.?(\s*(amount|employee\s*contribution|contribution|deduction))?|provident\s*fund|epf)\b/i,
    not: /employer|company|voluntary|\b(no|number|uan|account|a\/c|id)\b/i, side: 'any' },
  { f: 'professionalTax', w: 1, re: /\b(prof(essional)?\.?\s*tax|p\.?\s?tax\b|\bptax\b|prof\s*tax|professional\s*tax\s*\(pt\))/i, side: 'any' },
  { f: 'medicalInsurance', w: .8, re: /\b((medical|parental|health)\s*insurance|mediclaim|parental\s*insurance\s*premium)/i, side: 'any' },
  { f: 'incomeTax', w: .8, re: /\b(income\s*tax|t\.?d\.?s\.?|tax\s*deduct\w*(\s*amount)?)\b/i, side: 'ded' },

  // totals — used to reconcile, never as components
  { f: 'totalEarnings', w: 1, re: /\b(total\s*earn\w*|gross\s*(earnings?|salary|total|pay)\b|earnings?\s*total)\b/i, side: 'earn' },
  { f: 'grossCtc',      w: 1, re: /\b(gross\s*ctc|gross\b(?!\s*(salary|earning|total|pay)))/i, side: 'earn' },
  { f: 'totalCtc',      w: 1, re: /\b(total\s*(cost\s*to\s*company|ctc)|fixed\s*ctc|tctc|cost\s*to\s*company)\b/i, side: 'earn' },
  { f: 'baseSalary',    w: 1, re: /\bbase\s*salary\b|\btotal\s*salary\b/i, side: 'earn' },
  { f: 'totalDeduction',w: 1, re: /\btotal\s*deduct\w*/i, side: 'ded' },
  { f: 'netPay',        w: .8, re: /\bnet\s*pay\b|\btake\s*home\b/i, side: 'any' },

  // bonuses — taxable when paid, but not part of the monthly run-rate
  { f: '_bonus', w: .9, re: /\b((joining|retention|referr?al|performance|annual|standard|statutory|variable|special)\s*)?(bonus|incentive|ex[\s-]?gratia)\b|\bperformance\s*pay\b|\bvariable\s*pay\b/i,
    not: /deduction|eligible|payable\s+(only|subject)|policy|clause/i, side: 'earn' },

  // everything else that is salary → allowances
  { f: '_allow', w: .75, re: /\b(special\s*allow\w*(\s*\(sa\))?|conveyance|transport|medical\s*allow\w*|city\s*compensat\w*|education\s*allow\w*|children\s*education|food\s*(coupons?|allow\w*)|meal\s*(coupons?|voucher)|broadband|telephone|internet|mobile(\s*and\s*internet)?|fuel|driver|helper|attire|uniform|books?\s*(and|&)\s*(periodicals?|journals?)|professional\s*development|communication|flexible?\s*benefit|\bfbp\b|other\s*allow\w*|leave\s*travel(\s*allow\w*)?|\bl\.?t\.?a\.?\*?\b|shift\s*allow\w*|site\s*allow\w*|dearness|\bspl\.?\s*allow\w*|hold\s*salary|\bmedical\b|\bhousing\b|\bwashing\b)\b/i,
    not: /deduction|recover|insurance|premium|\breimburse/i, side: 'earn' }
];

/* Components that belong to CTC but are NOT taxable salary income. */
const NON_SALARY = ['employerPf', 'gratuity', 'medicalInsurance'];

/* Section markers: everything after one of these is an annual/YTD block on a
   monthly payslip, and must not be read as this month's earnings. */
const ANNUAL_SECTION = /\b(tds\s*details|deduction\s*under\s*chapter|chapter\s*vi\s*-?\s*a|tax\s*paid\s*details|income\s*tax\s*deduction|projected\s*(income|tax)|annual\s*tax\s*(statement|computation)|perquisite)\b/i;
const TABLE_HEADER   = /\b(earnings?|heads?|components?|particulars?|compensation\s*breakup|description)\b/i;

/* ------------------------------------------------------- line segmenting */
const NUMTOK = /(\d[\d,]*(?:\.\d{1,2})?)/;

/* Split "BASIC 170,834.00 PF 1,800.00" into
   [{label:'BASIC', nums:[170834]}, {label:'PF', nums:[1800]}]           */
function segmentLine(line) {
  const parts = line.split(/(\d[\d,]*(?:\.\d{1,2})?)/);
  const segs = [];
  let cur = null;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p === '' || p === undefined) continue;
    if (NUMTOK.test(p) && /^\d/.test(p)) {
      const v = parseFloat(p.replace(/,/g, ''));
      if (isNaN(v)) continue;
      if (!cur) cur = { label: '', nums: [] };
      cur.nums.push(v);
    } else {
      // a run of text with at least one letter starts a new segment
      if (/[A-Za-z]{2}/.test(p)) {
        if (cur && cur.nums.length) segs.push(cur);
        cur = { label: p.trim(), nums: [] };
      } else if (cur) {
        // punctuation or spaces between numbers — keep the run together
      }
    }
  }
  if (cur && cur.nums.length) segs.push(cur);
  return segs;
}

/* --------------------------------------------------- column policy ----- */
function columnPolicy(text) {
  const t = text.toLowerCase();
  if (/grand\s*total/.test(t)) return { pick: 'last', name: 'Grand Total column' };
  if (/\bper\s*annum\b|\bannual(ly)?\s*\(?inr\)?\b|monthly\s*annual/.test(t) && /monthly/.test(t))
    return { pick: 'last', name: 'Annual column' };
  if (/\bper\s*annum\b/.test(t) && !/monthly/.test(t)) return { pick: 'first', name: 'Per Annum column' };
  if (/\bmaster\b.*\bactual\b/.test(t)) return { pick: 'first', name: 'Master (full-month) column' };
  if (/\brate\b.*\bearned\b/.test(t)) return { pick: 'first', name: 'Rate column' };
  return { pick: 'first', name: 'first amount column' };
}

/* ---------------------------------------------------- document typing -- */
function detectDocType(text) {
  const t = text.toLowerCase();
  if (/ytd\s*summary|year\s*to\s*date|grand\s*total/.test(t)) return 'annual';
  if (/ctc\s*break\s*-?\s*up|cost\s*to\s*company|annual\s*compensation|total\s*annual\s*ctc|salary\s*structure|compensation\s*breakup|letter\s*of\s*(offer|appointment)|offer\s*letter/.test(t))
    return 'offer';
  if (/pay\s*-?\s*slip|payslip|salary\s*slip|salary\s*advice/.test(t)) return 'monthly';
  return 'monthly';
}

const DOC_TYPES = {
  monthly: { key: 'monthly', label: 'One month\'s payslip', multiplier: 12,
             note: 'Monthly figures multiplied by twelve.' },
  annual:  { key: 'annual',  label: 'Annual / YTD salary statement', multiplier: 1,
             note: 'Figures taken as they are — already for the year.' },
  offer:   { key: 'offer',   label: 'Offer letter or CTC breakup', multiplier: 1,
             note: 'Annual column of the CTC table.' }
};

/* A table row label is short and name-like. Prose sentences in an offer
   letter contain numbers too ("the retention bonus ... in 2026"), and header
   blocks carry account numbers, UANs and dates — neither is an amount. */
function isTableLabel(label) {
  const t = label.trim();
  if (!t || t.length > 48) return false;
  if (t.split(/\s+/).length > 6) return false;
  if (/[.;:]\s+[a-z]/.test(t)) return false;              // mid-sentence prose
  if (/\b(no|number|account|a\/c|pan|uan|gir|esi|ifsc|code|id|date|days|dob|month\s*days|paid\s*days)\b\.?\s*:?\s*$/i.test(t)) return false;
  if (/\b(pan|uan|ifsc|esi)\b/i.test(t)) return false;
  return true;
}

/* ------------------------------------------------------------- parsing - */
function sum0(a) { return a.reduce(function (x, y) { return x + y.value; }, 0); }

function parsePayslipText(text, forcedType) {
  const rawLines = text.split(/\r?\n/).map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const detectedType = detectDocType(text);
  const docType = forcedType || detectedType;
  const policy = columnPolicy(text);

  const hits = {};
  const parts = { allow: [], bonus: [], arrear: [] };
  let section = 'head';
  let annualBlock = false;
  const warnings = [];

  const record = (f, value, conf, line) => {
    if (!(value > 0)) return;
    if (f === '_allow' || f === '_bonus' || f === '_arrear') {
      const bucket = f === '_allow' ? 'allow' : f === '_bonus' ? 'bonus' : 'arrear';
      parts[bucket].push({ label: line.slice(0, 46), value });
      return;
    }
    if (!hits[f] || hits[f].confidence < conf) hits[f] = { value, confidence: conf, line };
  };

  /* Wrapped rows: a label with no amounts followed by amounts with no label
     is one row the PDF happened to draw in two passes. Rejoin them. */
  const lines = [];
  for (let i = 0; i < rawLines.length; i++) {
    const a = rawLines[i], b = rawLines[i + 1];
    const labelOnly = /[A-Za-z]{3}/.test(a) && !NUMTOK.test(a);
    const numsOnly = b && !/[A-Za-z]{3}/.test(b) && NUMTOK.test(b);
    if (labelOnly && numsOnly && isTableLabel(a)) { lines.push(a + ' ' + b); i++; }
    else lines.push(a);
  }

  let monthsCovered = null;
  const cutAtAnnual = docType === 'monthly';
  for (const line of lines) {
    if (cutAtAnnual && ANNUAL_SECTION.test(line)) { annualBlock = true; continue; }
    if (annualBlock) continue;                 // fix #2: never mix year into month
    if (section === 'head' && TABLE_HEADER.test(line) && !NUMTOK.test(line)) section = 'table';

    const segs = segmentLine(line);
    for (const seg of segs) {
      if (!seg.label || !seg.nums.length) continue;
      const label = seg.label;
      if (!isTableLabel(label)) continue;

      for (const def of LABELS) {
        if (!def.re.test(label)) continue;
        if (def.not && def.not.test(label)) continue;
        // account numbers, UANs, PAN digits and dates are not amounts
        const nums = seg.nums.filter(n => n >= 1 && n < 1e10 &&
                                     String(Math.round(n)).length <= 9);
        if (!nums.length) break;
        let v = policy.pick === 'last' ? nums[nums.length - 1] : nums[0];
        // a zero/blank leading column means the value sits further right
        if (!(v > 0)) v = nums.find(n => n > 0) || 0;
        if (def.f === 'totalEarnings' && policy.pick === 'last' && nums.length > 2)
          monthsCovered = nums.length - 1;      // twelve month columns + a total
        record(def.f, v, def.w, label);
        break;                                  // one label per SEGMENT, not per line
      }
    }
  }

  /* Period sanity — three ways one document misleads about a full year. */
  const flat = lines.join(' \n ');
  const lop = /\blop\b\s*(days)?\s*:?\s*(\d+)/i.exec(flat);
  if (lop && parseInt(lop[2], 10) > 0)
    warnings.push('This payslip shows ' + lop[2] + ' days of loss of pay, so the month is short. ' +
      'Multiplying it by twelve understates your year — correct the figures below.');
  const wd = /effective\s*work\s*days\s*:?\s*(\d+)/i.exec(flat);
  const dm = /days\s*in\s*month\s*:?\s*(\d+)/i.exec(flat);
  if (docType === 'monthly' && wd && dm && parseInt(wd[1], 10) < parseInt(dm[1], 10) && policy.pick !== 'first')
    warnings.push('Only ' + wd[1] + ' of ' + dm[1] + ' days were worked in this month.');
  if (parts.arrear.length)
    warnings.push('This month includes arrears (' + fmt(sum0(parts.arrear)) +
      '). Arrears are a one-off catch-up, so multiplying this month by twelve overstates your year.');
  if (forcedType && detectedType !== forcedType)
    warnings.push('You said this is ' + DOC_TYPES[forcedType].label.toLowerCase() +
      ', but it reads like ' + DOC_TYPES[detectedType].label.toLowerCase() +
      '. If the total below looks wrong by roughly twelve times, that is why — switch it above.');
  if (monthsCovered && monthsCovered < 12)
    warnings.push('This statement covers ' + monthsCovered + ' months, not twelve. ' +
      'If you were paid for the whole year elsewhere too, the annual figure below is understated.');

  const sum = arr => arr.reduce((a, x) => a + x.value, 0);
  return {
    docType, detectedType, policy, hits, parts, rawLines: lines, warnings, monthsCovered,
    allowances: sum(parts.allow) + sum(parts.arrear),
    bonuses: sum(parts.bonus)
  };
}

/* --------------------------------------------------- parsed → profile -- */
function parsedToProfile(parsed, taxYear) {
  const p = emptyProfile();
  p.taxYear = taxYear;
  p.source = parsed.docType;
  const mult = DOC_TYPES[parsed.docType].multiplier;
  const g = f => (parsed.hits[f] ? parsed.hits[f].value : 0);

  p.salary.basic = g('basic') * mult;
  p.salary.hra = g('hra') * mult;
  p.salary.otherAllowances = parsed.allowances * mult;
  p.salary.employerNps = g('employerNps') * mult;
  p.salary.employeePf = g('employeePf') * mult;
  p.salary.professionalTax = g('professionalTax') * mult;
  // Bonuses on an offer letter or a YTD statement are already annual amounts;
  // a bonus that lands in one month's payslip must not be multiplied by twelve.
  p.salary.bonus = parsed.bonuses * (parsed.docType === 'monthly' ? 1 : 1);

  p.meta = {
    docType: parsed.docType,
    column: parsed.policy.name,
    employerPf: g('employerPf') * mult,
    gratuity: g('gratuity') * mult,
    medicalInsurance: g('medicalInsurance') * mult,
    incomeTaxDeducted: g('incomeTax') * mult,
    netPay: g('netPay') * mult
  };

  const notes = [];

  /* Offer letters state employer PF but rarely the employee's own share, which
     is the one that fills part of the 80C ceiling. They are equal in almost
     every Indian structure, so seed it and flag it rather than losing it. */
  if (parsed.docType === 'offer' && !p.salary.employeePf && p.meta.employerPf) {
    p.salary.employeePf = p.meta.employerPf;
    p.estimates.employeePf = true;
    notes.push('Your own PF contribution was assumed equal to the employer\'s (' +
      fmt(p.meta.employerPf) + ') — that is how nearly every Indian structure works, but check it.');
  }
  if (p.meta.medicalInsurance > 0) {
    p.hints = p.hints || {};
    p.hints.s80D = p.meta.medicalInsurance;
    notes.push('A health-insurance deduction of ' + fmt(p.meta.medicalInsurance) +
      ' appears on the document — it will be offered as your 80D figure later.');
  }

  /* Reconcile against a printed total, but only against a like-for-like one.
     A payslip's "Total Earnings" IS the gross. An offer letter's "Total CTC"
     is NOT — it includes employer PF and gratuity, which are not your income. */
  const printedGross = g('totalEarnings') * mult;
  const summed = p.salary.basic + p.salary.hra + p.salary.otherAllowances +
                 p.salary.bonus + p.salary.employerNps;
  if (printedGross > 0) {
    const diff = printedGross - summed;
    if (Math.abs(diff) > Math.max(1000, printedGross * 0.005)) {
      if (diff > 0) {
        p.salary.otherAllowances += diff;
        notes.push('The components read came to ' + fmt(summed) + ' but the document prints ' +
          fmt(printedGross) + '. The difference was added to other allowances so nothing is lost.');
      } else {
        notes.push('The components read (' + fmt(summed) + ') exceed the printed total of ' +
          fmt(printedGross) + '. Something was probably counted twice — check the fields below.');
      }
    }
  } else if (parsed.docType === 'offer' && g('grossCtc')) {
    const grossCtc = g('grossCtc') * mult;
    const diff = grossCtc - summed;
    if (diff > Math.max(1000, grossCtc * 0.005)) {
      p.salary.otherAllowances += diff;
      notes.push('Balanced to the "Gross" line on the offer (' + fmt(grossCtc) + ').');
    }
  }
  if (parsed.docType === 'offer' && g('totalCtc')) {
    const ctc = g('totalCtc') * mult;
    notes.push('Your CTC of ' + fmt(ctc) + ' includes employer PF' +
      (p.meta.gratuity ? ', gratuity' : '') + ' and other costs that are not taxable income to you. ' +
      'This works from the salary you are actually paid, which is why the figure below is lower.');
  }

  p.parserNotes = notes;
  p.parsed = parsed;
  p.confidence = {};
  ['basic','hra','employerNps','employeePf','professionalTax'].forEach(f => {
    p.confidence[f] = parsed.hits[f] ? parsed.hits[f].confidence : 0;
  });
  p.confidence.otherAllowances = parsed.parts.allow.length ? 0.75 : 0;
  p.confidence.bonus = parsed.parts.bonus.length ? 0.9 : 0;
  return p;
}

/* ------------------------------------------------------------ pdf text - */
async function extractPdfText(file, password) {
  if (typeof pdfjsLib === 'undefined') throw new Error('PDF reader unavailable');
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf, password: password || '' }).promise;
  const lines = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const items = [];
    content.items.forEach(it => {
      if (!it.str || !it.str.trim()) return;
      items.push({ x: it.transform[4], y: it.transform[5],
                   w: it.width || it.str.length * 4.5, h: it.height || 9, s: it.str });
    });
    lines.push.apply(lines, assembleLines(items));
  }
  return lines.join('\n');
}

/* Group text items into visual rows and rebuild each row as a string.

   Two things break naive grouping, and both showed up in every real payslip:
   items in one row differ in baseline by a pixel or two, so a fixed rounding
   grid splits a row in half (the label on one line, its amounts on the next);
   and a single number is sometimes drawn as several runs ("7" + "3,000.00"),
   so a space between them corrupts the value. Cluster by baseline with a
   tolerance derived from the text height, then join by the real horizontal
   gap: touching runs concatenate, a normal gap is a space, a wide gap is a
   column break. */
function assembleLines(items) {
  if (!items.length) return [];
  const heights = items.map(i => i.h).sort((a, b) => a - b);
  const medianH = heights[Math.floor(heights.length / 2)] || 9;
  const tol = Math.max(2.5, medianH * 0.55);

  const sorted = items.slice().sort((a, b) => b.y - a.y || a.x - b.x);
  const rows = [];
  let cur = null;
  sorted.forEach(it => {
    if (cur && Math.abs(cur.y - it.y) <= tol) {
      cur.items.push(it);
      cur.y = (cur.y * (cur.items.length - 1) + it.y) / cur.items.length;
    } else {
      cur = { y: it.y, items: [it] };
      rows.push(cur);
    }
  });

  return rows.map(r => {
    const its = r.items.sort((a, b) => a.x - b.x);
    let line = '', end = null;
    its.forEach(it => {
      if (end !== null) {
        const gap = it.x - end;
        if (gap < 1.5) line += '';          // same number split across runs
        else if (gap < 10) line += ' ';
        else line += '   ';                  // column break
      }
      line += it.s;
      end = it.x + it.w;
    });
    return line.replace(/[ \t]+/g, ' ').trim();
  }).filter(Boolean);
}

if (typeof module !== 'undefined') module.exports = { parsePayslipText, parsedToProfile, segmentLine, detectDocType, DOC_TYPES };
