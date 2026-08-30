# Tax Regime Copilot

A chat-driven old-vs-new tax regime calculator for salaried Indians who don't have
a CA. Upload a payslip, offer letter or annual statement; answer four to six
questions; get an auditable line-by-line computation, a regime verdict, and the
exact figures to enter on an employer's declaration portal.

Everything runs in the browser. No server, no database, no account, no analytics.

**Status:** working v1.1. Engine 21/21 golden, parser 14/14 against real
documents, full flow green in headless Chromium.

---

## Quick start

```bash
python3 build.py                      # concatenates src/ -> dist/
open dist/tax-copilot.html            # that's the whole app
```

There is no bundler, no npm dependency at runtime, and no build step beyond
`build.py`, which just concatenates `src/` into two single-file outputs:

| Output | For |
|---|---|
| `dist/tax-copilot.html` | full document — open locally or host it. **The Groq explainer only works here.** |
| `dist/tax-copilot-artifact.html` | same page without `<!doctype>/<html>/<head>/<body>` for publishing as a Claude Artifact. Its sandbox blocks outbound fetch and downloads, so the explainer degrades to canned text and the session export falls back to copy-paste. |

Node + Playwright are needed only to run the test suites.

---

## The four rules the design hangs off

Break any of these and the product stops being trustworthy.

1. **The LLM never does arithmetic.** It explains, in prose, numbers the engine
   already computed. A deterministic engine fed a versioned rulepack produces
   every rupee. This is the whole value proposition for someone using this
   *instead of* a CA.
2. **Rates live in data, not code.** `src/20_rulepack.js` holds slabs, standard
   deduction, rebate, surcharge bands, cess and every cap, keyed by tax year.
   Budget 2027 should be a data edit plus a test run.
3. **The model never sees the document.** The parser is deterministic and local;
   no name, PAN, UAN or bank detail is even extracted. Groq receives only the
   computed numbers — which are already on screen. That is what makes the privacy
   claim architecturally true rather than a promise.
4. **The product works with the model switched off.** Upload, confirm, triage,
   interview, verdict, computation sheet, next steps, export — all deterministic.
   No key, no network: everything still works. Treat this as a test, not an accident.

---

## File map

```
build.py                  concatenates src/ into dist/ (also inlines cases.json into the test suite)
src/
  00_head.html            <title>, Google Fonts link, all CSS (light/dark tokens)
  10_body.html            all markup: start, confirm, triage, out-of-scope,
                          interview, result, manual entry, tests screens
  20_rulepack.js          RULEPACKS['2026-27'] and ['2025-26'] — rates + deduction catalogue
  30_engine.js            pure functions: computeRegime, compareRegimes,
                          breakEvenDeductions, headroom, robustness, fmt
  40_tests.js             golden runner; `__CASES__` is replaced by test/cases.json at build
  50_parser.js            document parser + pdf.js text extraction (assembleLines)
  60_interview.js         TRIAGE list, QUESTIONS tree, nextQuestion() stopping rule
  70_ui.js                screens, scripted chat, rendering. Computes nothing.
  80_groq.js              explanation layer — the only code that touches a network
test/
  ref.py                  independent Python reference implementation of the tax rules
  gen_cases.py            builds cases.json from ref.py (regenerate after a rulepack change)
  cases.json              21 golden cases, synthetic figures
  extract.py              mirror of assembleLines() in Python; feeds real PDFs to the JS parser
  ptest.js                parser explorer — prints what it read from each document
  e2e.js                  full happy path + export + dark mode + mobile
  e2e2.js                 early exit, triage, manual entry, PDF-unavailable, session round-trip
  e2e-pdf.js              real PDFs through the real pdf.js path in a browser
  mob.js                  mobile layout assertions
local-only/               real-salary regression test — gitignored, see its README
```

---

## Commands

```bash
python3 build.py                     # build

# engine
node -e "eval(require('fs').readFileSync('src/20_rulepack.js','utf8')+ \
  require('fs').readFileSync('src/30_engine.js','utf8'))"   # syntax check
python3 test/gen_cases.py > test/cases.json                 # regenerate golden expectations

# browser suites (need: npm i -D playwright pdfjs-dist@3.11.174)
node test/e2e.js
node test/e2e2.js
node test/mob.js
node test/e2e-pdf.js                 # needs PDFs in slips/

# parser against real documents
python3 test/extract.py              # slips/*.pdf -> slips_text.json
node test/ptest.js                   # what was read from each
node local-only/ptest2.js            # asserts the annual gross of each document
```

The golden suite also runs **in the browser** from the app's own
"Run the test suite" link on the front page. If you change the engine, that link
is the fastest check.

Playwright in a sandbox may need an explicit Chromium path:
`chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' })`.

---

## Domain facts that shaped the code

- **Two statutes are live.** The Income-tax Act 2025 took effect 1 Apr 2026 and
  governs FY 2026-27 onward; FY 2025-26 still runs on the 1961 Act. Sections were
  renumbered: 80C → **s.123**, 80D → **s.126**, standard deduction → **s.19**,
  home-loan interest → **s.22**, rebate → **s.156**. Users, HR portals and every
  blog still say "80C", so the UI says both. The rulepack carries per-year labels.
- **FY 2026-27 rates.** New regime: nil to ₹4L, then 5/10/15/20/25/30% at
  ₹4/8/12/16/20/24L; standard deduction ₹75,000; 87A rebate ₹60,000 up to ₹12L
  taxable **with marginal relief above it**. Old regime: nil to ₹2.5L, 5/20/30% at
  ₹2.5/5/10L; standard deduction ₹50,000; rebate ₹12,500 up to ₹5L, no marginal
  relief. Cess 4%. Surcharge 10/15/25% above ₹50L/₹1cr/₹2cr, plus 37% above ₹5cr
  in the old regime only, all with marginal relief at each threshold.
- **The regimes are asymmetric, and that asymmetry is the engine.** New regime
  allows essentially only the standard deduction and employer NPS under 80CCD(2)
  (capped at 14% of basic, vs 10% in the old regime). Old regime allows HRA, 80C,
  80D, home-loan interest, 80CCD(1B), 80E, 80G, 80TTA and professional tax.
- **CTC is not taxable income.** Employer PF, gratuity and employer-paid mediclaim
  are in CTC and out of gross salary. The parser excludes them and the UI says so.
- **The regime choice is reversible.** A salaried filer with no business income
  chooses afresh every year at filing; a wrong declaration to the employer only
  distorts monthly TDS. Say it — it defuses most of the anxiety. Caveat: filing
  late can cost the old-regime option.
- **Marginal relief is where naive slab code breaks.** Test ₹12.75L, ₹12.80L and
  ₹13.00L gross under the new regime, and ₹50.75L / ₹51.75L for surcharge.

---

## The design ideas worth preserving

**Compute the gap before asking about deductions.** With zero deductions, run both
regimes. The whole interview then becomes one legible target — *"you'd need
₹6,16,660 of deductions for the old regime to win"* — instead of a form.
`breakEvenDeductions()` solves this by bisection on the real engine, so it can
never drift from the rules.

**Stop when the remaining questions can't close the gap.** `nextQuestion()` sums
the maximum each unasked question could still contribute (`headroom`) and ends the
interview when that is less than the gap, saying so with the actual numbers:

> Stopping the deduction questions here — everything still unasked adds up to at
> most ₹4,10,000, and the gap is ₹4,21,590. It cannot close.

Typically 3–6 questions instead of thirty. Questions marked `always: true` (bonus,
other income) are exempt because they move *both* regimes.

**Report a robustness band, not a point estimate.** `robustness()` re-runs the
verdict across ±income and reports what holds: *"the new regime wins anywhere
between ₹16L and ₹24L, so you don't need to know your bonus to decide."* When it
does flip inside the band, it names the income where it turns. This is what makes
a payslip-only v1 defensible, and a generic tax calculator can't do it.

**Every number shows its parent.** The computation sheet carries, per row, the
input it came from and the rule that shaped it, plus an assumptions panel listing
everything guessed. Auditable or nobody acts on it.

**Refuse early and warmly.** Triage in three questions: business/freelance income,
capital gains, foreign assets or foreign-parent ESOPs, NRI/RNOR, property sold,
more than two employers. Those get a "what to tell your CA" summary instead of a
wrong answer. Capital gains are out of scope *only because this is regime mode* —
they're taxed at flat rates outside the slab in both regimes, so they rarely move
the verdict. They come back in filing mode.

---

## The parser, and the four bugs real documents exposed

The first version was tested against synthetic payslips and got almost everything
wrong on real ones. What fixed it:

1. **Two-column rows.** Every Indian payslip prints earnings and deductions side by
   side on one physical line — `BASIC 170,834.00  PF  1,800.00`. Matching one label
   per line dropped every deduction. `segmentLine()` now splits a line into
   label→numbers segments and reads both halves.
2. **Annual TDS sections double-counted.** Several payslips carry a Chapter VI-A /
   TDS annexure lower down that repeats every earnings label with *yearly* figures.
   Summing blindly added the month and the year together — this was the "extracting
   all wrong values" symptom. `ANNUAL_SECTION` cuts there, **but only on monthly
   payslips**: an offer letter says "perquisite" in prose long before its salary
   table, and cutting there lost the whole document.
3. **Per-vendor amount columns.** Rate|Earned|Arrear, Master|Actual, twelve months
   + Grand Total, Monthly|Annual. `columnPolicy()` decides from the table's own
   header row. Preferring Master/Rate over Actual is what makes a 3-work-day month
   still annualise correctly.
4. **PDF rows split by sub-pixel baselines.** Items in one visual row differ in
   baseline by 1–2px, so a fixed rounding grid put the label on one line and its
   amounts on the next. Some numbers are drawn as separate glyph runs (`7` +
   `3,000.00`) and a space between them corrupts the value. `assembleLines()` now
   clusters rows by baseline with a tolerance derived from median text height, and
   joins by real horizontal gap: `<1.5px` concatenate, `<10px` space, else column
   break. **This was the single highest-value fix — do not regress it.**

Also handled: PF account numbers and UANs being read as PF amounts (numbers >9
digits are rejected, and identifier labels are filtered by `isTableLabel()`);
"FOOD COUPONS DEDUCTION" counted as an allowance; prose sentences in offer letters
matching the bonus pattern.

### Three document types

The front screen asks what you're starting from, because auto-detection alone was
silently wrong and the three sources need different handling.

| Type | × | Handling |
|---|---|---|
| One month's payslip | 12 | Prefers Master/Rate over Actual; warns on LOP, part-month and arrears |
| Offer letter / CTC breakup | 1 | Annual column; employer PF, gratuity and mediclaim excluded from gross; employee PF seeded from employer PF and flagged |
| Annual / YTD statement | 1 | Grand Total column; counts month columns carrying data and warns when fewer than twelve |

The confirm screen shows the detected type in a dropdown — re-parsing is free
because everything is local — and warns when the chosen type disagrees with what
the document looks like.

---

## Verification status

- **Engine 21/21.** Expected values come from `test/ref.py`, a Python
  implementation written independently of the JS engine; two implementations
  agreeing is the check. Covers the ₹12L rebate ceiling, marginal relief at ₹12.05L
  and ₹13L, old-regime 87A, the ₹50L surcharge boundary with marginal relief, the
  15/25/37% bands, employer-NPS caps differing by regime, non-metro HRA, rent below
  10% of basic, a profile **ten rupees** from break-even, and two profiles where
  the old regime wins.
- **Parser 14/14** against real documents from four payroll systems (Terrals,
  Tabulera, Cue Learn, Brain4ce) — nine monthly payslips, one YTD summary, four
  offer letters — each reconciling *exactly* to the annual gross the document
  itself prints. Expected values derived from each PDF's printed total, never from
  the parser.
- **8/8 through the real pdf.js path** in a browser with the actual PDFs.
- **End-to-end**: upload → confirm → triage → interview → result → export, plus
  early exit, out-of-scope, manual entry, PDF-unavailable fallback, session
  round-trip, document-type switching. No page errors. Light and dark. No
  horizontal body scroll at 390px.

---

## Known limits and the obvious next moves

- **Text-layer PDFs only.** Scans and password-protected files fall back to paste
  or manual entry. Deliberate — OCR is multi-megabyte WASM and the fallback is
  needed anyway.
- **Label dictionary is hardened against four payroll systems.** Zoho, greytHR,
  SAP, Keka and RazorpayX are untested. Collecting ten more real slips is the
  highest-value hour of work available.
- **80G handles only the 100%-without-limit categories.** The percentage-limited
  ones need income-dependent qualifying amounts.
- **FY 2025-26 rulepack** shares the rate structure but reverts section labels to
  the 1961 Act; not separately golden-tested.
- **Filing mode is v2** — backward-looking, needs actuals, AIS reconciliation, and
  brings capital gains back into scope with their own rate schedule.
- **The 80D hint is captured but not yet pre-filled** into the interview question
  (`p.hints.s80D` is set from a payslip's medical-insurance deduction).
- **Rates must be verified against the Income Tax Department** before anyone acts
  on this. It's an estimate and a checklist — not advice, not a filed return, and
  filing on someone's behalf would need ERI registration.

---

## Privacy

`slips/`, `slips_text.json` and `local-only/` are gitignored and must stay that
way — `local-only/ptest2.js` asserts against real annual salary figures, and
pushing it to a public portfolio repo publishes a salary history. The shipped app
contains only synthetic samples.
