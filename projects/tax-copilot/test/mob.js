const {chromium}=require('playwright');const path=require('path');
(async()=>{
const b=await chromium.launch({executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome'});
const p=await b.newPage({viewport:{width:390,height:844}});
await p.goto('file://'+path.resolve(__dirname,'..','dist','tax-copilot.html'));
await p.click('.doctype[data-type="monthly"]');await p.click('#btn-paste');await p.click('#btn-paste-demo');await p.click('#btn-paste-go');
await p.click('#btn-confirm-go');await p.click('#btn-triage-go');
for(let i=0;i<26;i++){
  if(await p.isVisible('#screen-result.active'))break;
  await p.waitForTimeout(400);
  const c=await p.$$('.chips .chip'); const a=await p.$('.amt');
  if(c.length){
    const L=await Promise.all(c.map(x=>x.textContent()));
    let j=L.findIndex(l=>/^(No|Nothing)/i.test(String(l).trim()));
    await c[j<0?0:j].click();
  } else if(a){ for(const i2 of await p.$$('.amt input')) await i2.fill('0'); await p.click('.amt button'); }
}
await p.waitForTimeout(1200);
await p.screenshot({path:'shot-mobile2.png',fullPage:true});
const tw=await p.$eval('#sheet',t=>t.scrollWidth); const cw=await p.$eval('#sheet',t=>t.parentElement.clientWidth);
console.log('table',tw,'container',cw,'-> fits without sideways scroll:',tw<=cw+1);
console.log('body h-scroll:',await p.evaluate(()=>document.documentElement.scrollWidth>document.documentElement.clientWidth+1));
await b.close();})()
