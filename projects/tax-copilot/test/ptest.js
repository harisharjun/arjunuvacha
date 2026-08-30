const fs=require('fs');
const src = ['20_rulepack.js','30_engine.js','50_parser.js'].map(f=>fs.readFileSync(require('path').join(__dirname,'..','src',f),'utf8')).join('\n')
  .replace(/if \(typeof module !== 'undefined'\) module\.exports = \{[^}]*\};/g,'');
const api = new Function(src + '\nreturn {parsePayslipText,parsedToProfile,detectDocType,grossSalary,fmt,DOC_TYPES,emptyProfile};')();
const {parsePayslipText,parsedToProfile,grossSalary,fmt,DOC_TYPES}=api;
const texts=JSON.parse(fs.readFileSync(require('path').join(__dirname,'..','slips_text.json'),'utf8'));
for(const [name,text] of Object.entries(texts)){
  if(text.startsWith('ERROR')){console.log(name,text);continue;}
  const parsed=parsePayslipText(text);
  const p=parsedToProfile(parsed,'2026-27');
  console.log('\n=== '+name.replace(/^[0-9a-f]{8}-/,''));
  console.log('   type: '+parsed.docType+'  ('+DOC_TYPES[parsed.docType].label+')   column: '+parsed.policy.name);
  console.log('   basic '+fmt(p.salary.basic)+' | hra '+fmt(p.salary.hra)+' | allow '+fmt(p.salary.otherAllowances)
    +' | bonus '+fmt(p.salary.bonus)+' | EPF '+fmt(p.salary.employeePf)+' | ptax '+fmt(p.salary.professionalTax));
  console.log('   ANNUAL GROSS: '+fmt(grossSalary(p)));
  if(p.meta) console.log('   meta: employerPF '+fmt(p.meta.employerPf)+' gratuity '+fmt(p.meta.gratuity)
    +' medIns '+fmt(p.meta.medicalInsurance)+' TDS '+fmt(p.meta.incomeTaxDeducted));
  console.log('   allow parts: '+parsed.parts.allow.map(a=>a.label.trim()+'='+a.value).join(', ').slice(0,200));
  if(parsed.parts.bonus.length) console.log('   bonus parts: '+parsed.parts.bonus.map(a=>a.label.trim()+'='+a.value).join(', ').slice(0,160));
  (p.parserNotes||[]).forEach(n=>console.log('   note: '+n));
}
