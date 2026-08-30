/* Drive the REAL pdf.js path in a browser with the actual PDFs.
   The sandbox blocks cdnjs, so pdf.js is served from node_modules and routed
   in — everything else runs exactly as it would on the user's machine. */
const { chromium } = require('playwright');
const fs = require('fs'), path = require('path');
const EXE = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const APP = path.resolve(__dirname, '..', 'dist', 'tax-copilot.html');

const CASES = [
  ['017e3d52-Payslip_Nov_2022.pdf',        'monthly', '₹39,79,800'],
  ['225e492e-Arjun__Oct_2023_Payslip.pdf', 'monthly', '₹24,53,904'],
  ['76a17a04-2021_03_Payslip_Mar_2021.pdf','monthly', '₹24,56,400'],
  ['2f3624df-ED111194_2019_11_sslip.pdf',  'monthly', '₹5,28,204'],
  ['bfc19ae5-Darwinbox_offer_letter.pdf',  'offer',   '₹34,78,400'],
  ['b77e5d7a-Offer_Letter__Karakkayala_Harish_Arjun1258.pdf', 'offer', '₹43,79,800'],
  ['81215767-Arjun_Offer_Letter__Implementation_Specialist.pdf','offer','₹25,57,904'],
  ['ee48a941-YTD_Payslip20222023.pdf',     'annual',  '₹21,00,670'],
];

(async () => {
  const browser = await chromium.launch({ executablePath: EXE });
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 1000 } });
  // serve pdf.js locally in place of the blocked CDN
  await ctx.route('**/cdnjs.cloudflare.com/**', route => {
    const u = route.request().url();
    const f = u.includes('worker') ? 'pdf.worker.min.js' : 'pdf.min.js';
    route.fulfill({ status: 200, contentType: 'application/javascript',
      body: fs.readFileSync(path.join(__dirname, '..', 'node_modules/pdfjs-dist/build', f)) });
  });
  await ctx.route('**/fonts.googleapis.com/**', r => r.fulfill({ status: 200, contentType: 'text/css', body: '' }));

  let pass = 0, fail = 0;
  for (const [file, type, wantGross] of CASES) {
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', e => errs.push(e.message));
    await page.goto('file://' + APP);
    await page.waitForTimeout(250);
    await page.click(`.doctype[data-type="${type}"]`);
    await page.setInputFiles('#file', path.join(__dirname, '..', 'slips', file));
    let got = 'TIMEOUT', warn = '';
    try {
      await page.waitForSelector('#screen-confirm.active', { timeout: 12000 });
      got = (await page.textContent('#confirm-gross')).trim();
      warn = (await page.textContent('#confirm-msg')).replace(/\s+/g, ' ').trim().slice(0, 110);
    } catch (e) { got = 'FAILED: ' + (await page.textContent('#parse-msg')).slice(0, 90); }
    const name = file.replace(/^[0-9a-f]{8}-/, '').replace('.pdf', '');
    const ok = got === wantGross && !errs.length;
    ok ? pass++ : fail++;
    console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${name.padEnd(44)} ${got.padStart(13)}  (want ${wantGross})${errs.length ? ' ERRORS: ' + errs.join(';') : ''}`);
    if (warn) console.log(`        note: ${warn}`);
    if (file === CASES[0][0]) {
      await page.screenshot({ path: 'shot-confirm-real.png', fullPage: true });
      await page.click('#btn-show-parts'); await page.waitForTimeout(200);
      await page.screenshot({ path: 'shot-parts.png', fullPage: true });
    }
    await page.close();
  }

  // switching the document type re-reads the same file
  console.log('\n  -- switching type on the confirm screen --');
  const page = await ctx.newPage();
  await page.goto('file://' + APP);
  await page.click('.doctype[data-type="monthly"]');
  await page.setInputFiles('#file', path.join(__dirname, '..', 'slips', 'ee48a941-YTD_Payslip20222023.pdf'));
  await page.waitForSelector('#screen-confirm.active', { timeout: 12000 });
  console.log('  read as monthly (wrong on purpose): ' + (await page.textContent('#confirm-gross')).trim());
  await page.selectOption('#sel-doctype', 'annual');
  await page.waitForTimeout(500);
  console.log('  switched to annual:                 ' + (await page.textContent('#confirm-gross')).trim());
  await page.screenshot({ path: 'shot-switch.png', fullPage: true });
  await page.close();

  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed through the real pdf.js path`);
  process.exit(fail ? 1 : 0);
})();
