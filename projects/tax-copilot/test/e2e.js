const { chromium } = require('playwright');
const path = require('path');

const URL = 'file://' + path.resolve(__dirname, '..', 'dist', 'tax-copilot.html');

async function run() {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const errors = [];
  const page = await browser.newPage({ viewport: { width: 1200, height: 1000 } });
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()); });
  await page.goto(URL);
  await page.waitForTimeout(400);

  const step = async (label, fn) => {
    try { await fn(); console.log('  ok  ' + label); }
    catch (e) { console.log('  FAIL ' + label + ' :: ' + e.message); throw e; }
  };

  console.log('\n== golden suite in the browser ==');
  await step('open tests', async () => {
    await page.click('details summary');
    await page.click('#btn-tests');
    await page.waitForSelector('#screen-tests.active');
  });
  const testTxt = await page.textContent('#test-summary');
  console.log('  ' + testTxt.trim().split('\n')[0]);
  if (!/21 of 21 passed/.test(testTxt)) throw new Error('golden suite did not pass in browser');
  await page.screenshot({ path: 'shot-tests.png', fullPage: false });
  await page.click('#btn-tests-back');

  console.log('\n== payslip -> confirm ==');
  await step('paste sample', async () => {
    await page.click('details summary');            // collapse
    await page.click('.doctype[data-type="monthly"]');
    await page.click('#btn-paste');
    await page.click('#btn-paste-demo');
    await page.click('#btn-paste-go');
    await page.waitForSelector('#screen-confirm.active');
  });
  const gross = await page.textContent('#confirm-gross');
  console.log('  parsed annual gross: ' + gross);
  if (gross !== '₹24,60,000') throw new Error('unexpected gross: ' + gross);
  await page.screenshot({ path: 'shot-confirm.png', fullPage: true });

  console.log('\n== triage -> interview ==');
  await page.click('#btn-confirm-go');
  await page.waitForSelector('#screen-triage.active');
  await page.click('#btn-triage-go');
  await page.waitForSelector('#screen-interview.active');
  await page.waitForTimeout(900);
  console.log('  target: ' + (await page.textContent('#meter-target')));

  // walk the interview: answer with chips, always taking the "yes" path where offered
  let turns = 0;
  const answers = [];
  while (turns < 26) {
    const onResult = await page.isVisible('#screen-result.active');
    if (onResult) break;
    await page.waitForTimeout(420);
    const chips = await page.$$('.chips .chip');
    const amt = await page.$('.amt');
    if (chips.length) {
      const labels = await Promise.all(chips.map(c => c.textContent()));
      // choose the first affirmative option if there is one, else the first
      let i = labels.findIndex(l => /^Yes/i.test(l.trim()));
      if (i < 0) i = 0;
      answers.push(labels[i].trim());
      await chips[i].click();
    } else if (amt) {
      const inputs = await page.$$('.amt input');
      for (const inp of inputs) {
        const t = await inp.getAttribute('type');
        if (t === 'number') await inp.fill('50000');
      }
      const sel = await page.$('.amt select');
      if (sel) await sel.selectOption('1');
      answers.push('[amount 50000]');
      await page.click('.amt button');
    } else {
      await page.waitForTimeout(500);
    }
    turns++;
  }
  await page.waitForTimeout(1200);
  console.log('  answered: ' + answers.join(' | '));
  await page.screenshot({ path: 'shot-interview.png', fullPage: true });

  console.log('\n== result ==');
  await page.waitForSelector('#screen-result.active', { timeout: 6000 });
  console.log('  verdict: ' + (await page.textContent('#verdict-big')));
  console.log('  sub:     ' + (await page.textContent('#verdict-sub')));
  console.log('  robust:  ' + (await page.textContent('#robust-text')).slice(0, 150));
  const rows = await page.$$eval('#sheet tbody tr', rs => rs.map(r =>
    Array.from(r.children).map(c => c.textContent.replace(/\s+/g, ' ').trim().slice(0, 70))));
  console.log('  sheet rows: ' + rows.length);
  rows.forEach(r => console.log('    ' + r[0].padEnd(70) + ' | ' + r[1].padStart(12) + ' | ' + r[2].padStart(12)));
  await page.screenshot({ path: 'shot-result.png', fullPage: true });

  console.log('\n== explainer with no key (must degrade, not break) ==');
  await page.click('#ask-suggest button');
  await page.waitForTimeout(600);
  const out = await page.textContent('#ask-out');
  console.log('  ' + out.replace(/\s+/g, ' ').slice(0, 220));

  console.log('\n== export ==');
  const [dl] = await Promise.all([
    page.waitForEvent('download'), page.click('#btn-export')
  ]);
  console.log('  downloaded: ' + dl.suggestedFilename());

  console.log('\n== dark mode render ==');
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForTimeout(300);
  await page.screenshot({ path: 'shot-result-dark.png', fullPage: true });

  console.log('\n== mobile ==');
  await page.emulateMedia({ colorScheme: 'light' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: 'shot-mobile.png', fullPage: true });
  const hScroll = await page.evaluate(() =>
    document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  console.log('  horizontal body scroll: ' + hScroll);

  await browser.close();
  console.log('\n== console errors ==');
  console.log(errors.length ? errors.join('\n') : '  none');
  if (hScroll) throw new Error('page scrolls horizontally on mobile');
}
run().catch(e => { console.error('\nE2E FAILED:', e.message); process.exit(1); });
