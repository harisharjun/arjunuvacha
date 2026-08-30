const { chromium } = require('playwright');
const path = require('path');
const URL = 'file://' + path.resolve(__dirname, '..', 'dist', 'tax-copilot.html');
const EXE = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

async function fresh(browser) {
  const page = await browser.newPage({ viewport: { width: 1200, height: 1000 } });
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  await page.goto(URL); await page.waitForTimeout(300);
  page._errs = errs;
  return page;
}

async function walk(page, pick) {
  // pick(labels) -> index, or 'amount' handling is automatic
  const asked = [];
  for (let i = 0; i < 26; i++) {
    if (await page.isVisible('#screen-result.active')) break;
    await page.waitForTimeout(400);
    const chips = await page.$$('.chips .chip');
    const amt = await page.$('.amt');
    if (chips.length) {
      const labels = await Promise.all(chips.map(c => c.textContent()));
      const q = await page.$$eval('.bub.bot', b => b[b.length - 1].firstChild.textContent);
      asked.push(q.slice(0, 62));
      await chips[pick(labels)].click();
    } else if (amt) {
      for (const inp of await page.$$('.amt input')) await inp.fill('0');
      await page.click('.amt button');
    } else await page.waitForTimeout(400);
  }
  await page.waitForTimeout(1000);
  return asked;
}

async function main() {
  const browser = await chromium.launch({ executablePath: EXE });

  /* ---- 1. early exit: say no to everything ---- */
  console.log('\n=== EARLY EXIT (answers all "no") ===');
  let page = await fresh(browser);
  await page.click('.doctype[data-type="monthly"]'); await page.click('#btn-paste'); await page.click('#btn-paste-demo'); await page.click('#btn-paste-go');
  await page.waitForSelector('#screen-confirm.active');
  await page.click('#btn-confirm-go');
  await page.click('#btn-triage-go');
  await page.waitForTimeout(900);
  const asked = await walk(page, labels => {
    const i = labels.findIndex(l => /^(No|Nothing)/i.test(l.trim()));
    return i < 0 ? 0 : i;
  });
  console.log('questions asked: ' + asked.length);
  asked.forEach((q, i) => console.log('  ' + (i + 1) + '. ' + q + '…'));
  const sys = await page.$$eval('.sysline', n => n.map(x => x.textContent));
  console.log('system lines:'); sys.forEach(s => console.log('  · ' + s));
  await page.waitForSelector('#screen-result.active');
  console.log('verdict: ' + (await page.textContent('#verdict-big')).trim());
  console.log('assumptions:');
  console.log((await page.textContent('#assumptions')).replace(/\s+/g, ' ').slice(0, 420));
  await page.screenshot({ path: 'shot-earlyexit.png', fullPage: true });
  console.log('errors: ' + (page._errs.length ? page._errs.join(';') : 'none'));

  /* ---- 2. triage out of scope ---- */
  console.log('\n=== TRIAGE: out of scope ===');
  page = await fresh(browser);
  await page.click('.doctype[data-type="monthly"]'); await page.click('#btn-paste'); await page.click('#btn-paste-demo'); await page.click('#btn-paste-go');
  await page.click('#btn-confirm-go');
  await page.check('.triage-cb[value="capgains"]');
  await page.check('.triage-cb[value="business"]');
  await page.click('#btn-triage-go');
  await page.waitForSelector('#screen-scope.active');
  console.log((await page.textContent('#screen-scope')).replace(/\s+/g, ' ').slice(0, 500));
  await page.screenshot({ path: 'shot-scope.png', fullPage: true });
  console.log('errors: ' + (page._errs.length ? page._errs.join(';') : 'none'));

  /* ---- 3. manual entry, low income (rebate to zero) ---- */
  console.log('\n=== MANUAL ENTRY: 9L, nil tax expected under new ===');
  page = await fresh(browser);
  await page.click('#btn-manual');
  await page.waitForSelector('#screen-manual.active');
  const ins = await page.$$('#manual-fields input');
  await ins[0].fill('450000');   // basic
  await ins[1].fill('225000');   // hra
  await ins[2].fill('225000');   // other
  console.log('gross shows: ' + (await page.textContent('#manual-gross')));
  await page.click('#btn-manual-go');
  await page.click('#btn-triage-go');
  await page.waitForTimeout(800);
  await walk(page, labels => { const i = labels.findIndex(l => /^(No|Nothing)/i.test(l.trim())); return i < 0 ? 0 : i; });
  await page.waitForSelector('#screen-result.active');
  console.log('verdict: ' + (await page.textContent('#verdict-big')).trim());
  console.log('sub: ' + (await page.textContent('#verdict-sub')).trim());
  const stats = await page.$$eval('.stat', s => s.map(x => x.querySelector('.k').textContent + ' = ' + x.querySelector('.v').textContent));
  stats.forEach(s => console.log('  ' + s));
  console.log('errors: ' + (page._errs.length ? page._errs.join(';') : 'none'));

  /* ---- 4. pdf unavailable -> graceful fallback ---- */
  console.log('\n=== PDF READER UNAVAILABLE (as in the sandboxed Artifact) ===');
  page = await fresh(browser);
  await page.click('.doctype[data-type="monthly"]');
  await page.setInputFiles('#file', { name: 'payslip.pdf', mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.4 not really a pdf') });
  await page.waitForTimeout(800);
  console.log('message: ' + (await page.textContent('#parse-msg')).trim());
  console.log('paste area revealed: ' + !(await page.getAttribute('#paste-area', 'hidden') !== null ? false : true));
  console.log('errors: ' + (page._errs.length ? page._errs.join(';') : 'none'));

  /* ---- 5. session round-trip ---- */
  console.log('\n=== SESSION EXPORT -> IMPORT ===');
  const json = await page.evaluate(() => {
    S.profile = emptyProfile(); S.profile.salary.basic = 900000; S.profile.salary.hra = 450000;
    S.profile.salary.otherAllowances = 450000; S.profile.answered = { rent: true };
    S.profile.deductions.rentPaid = 480000; S.profile.deductions.metro = true;
    return JSON.stringify({ app: 'tax-regime-copilot', version: 1, profile: S.profile });
  });
  const out = await page.evaluate(t => { importSession(t); return document.querySelector('#verdict-big').textContent; }, json);
  console.log('re-imported straight to result: ' + out.trim());
  console.log('errors: ' + (page._errs.length ? page._errs.join(';') : 'none'));

  await browser.close();
}
main().catch(e => { console.error('FAILED', e); process.exit(1); });
