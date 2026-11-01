// Paperfold level generator. Solves every fold of each sheet, counts the distinct
// puzzles and picks the 25-level ladder. `node generate-levels.mjs --write` updates
// static/games/paperfold/levels.js; copy it to public/ as with every other static file.
import fs from 'fs';
const K=(x,y)=>x+','+y,P=k=>k.split(',').map(Number);
const flip=(l,ax)=>({i:l.i,f:!l.f,x:ax===0?!l.x:l.x,y:ax===1?!l.y:l.y});
const ls=l=>`${l.i}${l.f?'F':'B'}${l.x?1:0}${l.y?1:0}`;
function start(rows){const m=new Map();let i=0;rows.forEach((r,y)=>[...r].forEach((c,x)=>{if(c==='#')m.set(K(x,y),[{i:i++,f:true,x:false,y:false}])}));return m}
function bb(m){let a=1e9,b=1e9,c=-1e9,d=-1e9;for(const k of m.keys()){const[x,y]=P(k);a=Math.min(a,x);b=Math.min(b,y);c=Math.max(c,x);d=Math.max(d,y)}return{a,b,w:c-a+1,h:d-b+1}}
const stateKey=m=>{const{a,b}=bb(m);return[...m].map(([k,v])=>{const[x,y]=P(k);return K(x-a,y-b)+':'+v.map(ls).join('.')}).sort().join('|')};
const topKey=(m,pose=true)=>{const{a,b}=bb(m);return[...m].map(([k,v])=>{const[x,y]=P(k);const l=v[0];return K(x-a,y-b)+':'+(pose?ls(l):l.i+(l.f?'F':'B'))}).sort().join('|')};
function moves(m){const out=[],c=[...m.keys()].map(P);for(const ax of[0,1]){const vs=c.map(p=>p[ax]),lo=Math.min(...vs),hi=Math.max(...vs);for(let k=lo+1;k<=hi;k++)for(const side of[0,1]){const mv=c.filter(p=>side===0?p[ax]<k:p[ax]>=k),set=new Set(mv.map(p=>K(p[0],p[1]))),n=new Map();for(const[kk,v]of m)if(!set.has(kk))n.set(kk,v);for(const p of mv){const q=[p[0],p[1]];q[ax]=2*k-1-p[ax];const f=[...m.get(K(p[0],p[1]))].reverse().map(l=>flip(l,ax)),kk=K(q[0],q[1]);n.set(kk,f.concat(n.get(kk)||[]))}out.push({ax,k,side,m:n,moved:mv.length,stay:c.length-mv.length})}}return out}
function explore(rows,maxd){let m=start(rows);let layer=new Map([[stateKey(m),{m,paths:1,seq:[]}]]);const seen=new Set(layer.keys());const T=new Map(),PF=new Map();
 for(let d=1;d<=maxd;d++){const next=new Map();for(const{m:s,paths,seq}of layer.values())for(const mv of moves(s)){const t=topKey(mv.m),pf=topKey(mv.m,false),q=seq.concat({ax:mv.ax,k:mv.k,side:mv.side,moved:mv.moved,stay:mv.stay});
   if(!T.has(t))T.set(t,{d,paths,m:mv.m,seq:q,sk:t});else if(T.get(t).d===d)T.get(t).paths+=paths;
   if(!PF.has(pf))PF.set(pf,new Set());PF.get(pf).add(t);
   const kk=stateKey(mv.m);if(seen.has(kk))continue;const e=next.get(kk);if(e)e.paths+=paths;else next.set(kk,{m:mv.m,paths,seq:q})}
  for(const k of next.keys())seen.add(k);layer=next}
 for(const e of T.values())e.pfN=PF.get(topKey(e.m,false)).size;return T}
function firstOk(rows,e,maxd){const m=start(rows);let ok=0,tot=0;for(const mv of moves(m)){tot++;if(reach(mv.m,e.sk,e.d-1))ok++}return{ok,tot}}
function reach(m,t,d){if(topKey(m)===t)return true;if(d<=0)return false;for(const mv of moves(m))if(reach(mv.m,t,d-1))return true;return false}
const SH={r23:['##','##','##'],r32:['###','###'],r24:['##','##','##','##'],r42:['####','####'],r33:['###','###','###'],r43:['####','####','####'],r34:['###','###','###','###'],r44:['####','####','####','####'],L:['##..','##..','####','####'],T:['####','####','.##.','.##.'],plus:['.##.','####','####','.##.'],S:['###.','####','.###'],U:['#..#','#..#','####','####'],C:['###','##.','##.','###'],step:['##..','###.','.###','..##']};
const RECT=new Set(['r23','r32','r24','r42','r33','r43','r34','r44']);
function canon(rows,e){ // distinct under rotation and reflection of the whole puzzle
 const cells=[];rows.forEach((r,y)=>[...r].forEach((c,x)=>{if(c==='#')cells.push([x,y])}));const b=bb(e.m);const tops=[...e.m].map(([k,v])=>{const[x,y]=P(k);return[x-b.a,y-b.b,v[0].i,v[0].f]});
 const W=Math.max(...cells.map(c=>c[0])),H=Math.max(...cells.map(c=>c[1]));const tf=[(x,y,w,h)=>[x,y],(x,y,w,h)=>[w-x,y],(x,y,w,h)=>[x,h-y],(x,y,w,h)=>[w-x,h-y],(x,y,w,h)=>[y,x],(x,y,w,h)=>[h-y,x],(x,y,w,h)=>[y,w-x],(x,y,w,h)=>[h-y,w-x]];
 let best=null;for(const t of tf){const sh=cells.map(c=>t(c[0],c[1],W,H).join(',')).sort().join(' ');const pos=tops.map(q=>{const a=t(q[0],q[1],b.w-1,b.h-1);const src=t(cells[q[2]][0],cells[q[2]][1],W,H);return a.join(',')+'<'+src.join(',')+(q[3]?'F':'B')}).sort().join(' ');const s=sh+'#'+pos;if(best===null||s<best)best=s}return best}
const counts={},all=[];const seenC=new Set();
for(const[name,rows]of Object.entries(SH)){const T=explore(rows,4);for(const e of T.values()){const b=bb(e.m);const rect=e.m.size===b.w*b.h&&b.w>=2&&b.h>=2&&Math.max(b.w,b.h)<=4;if(!rect||e.pfN>1)continue;const tops=[...e.m.values()].map(v=>v[0].f);const both=tops.some(x=>x)&&tops.some(x=>!x);const c=canon(rows,e);if(seenC.has(c))continue;seenC.add(c);counts[e.d]=(counts[e.d]||0)+1;all.push({name,rows,e,b,both,rect:RECT.has(name)})}}
console.log('distinct good puzzles by folds',counts,'total',all.length);
const perp=e=>e.seq[0].ax!==e.seq[1].ax,same=e=>e.seq[0].ax===e.seq[1].ax;
const sel=(n,f,sort)=>{const c=all.filter(f).filter(x=>!used.has(x));c.sort(sort);const out=[];const names={};const pick=[];for(const x of c){const key=x.name+x.b.w+'x'+x.b.h;if((names[key]||0)>=1)continue;names[key]=1;pick.push(x);if(pick.length===n)break}for(const x of c){if(pick.length>=n)break;if(!pick.includes(x))pick.push(x)}pick.forEach(x=>used.add(x));console.log('stage candidates',c.length,'picked',pick.length);return pick};
const used=new Set();const bySize=(a,b)=>a.e.m.size===b.e.m.size?0:0;
const big=(a,b)=>(b.b.w*b.b.h)-(a.b.w*a.b.h)||a.name.localeCompare(b.name);
const small=(a,b)=>a.rows.join('').length-b.rows.join('').length||big(a,b);
const stages=[
 sel(3,x=>x.e.d===1&&x.rect&&x.e.seq[0].moved<x.e.seq[0].stay&&x.both,small),
 sel(3,x=>x.e.d===1&&x.rect&&x.e.seq[0].moved>x.e.seq[0].stay,small),
 sel(3,x=>x.e.d===2&&x.rect&&same(x.e)&&x.e.paths>=2,small),
 sel(3,x=>x.e.d===2&&x.rect&&same(x.e)&&x.e.paths===1,small),
 sel(4,x=>x.e.d===2&&!x.rect,small),
 sel(4,x=>x.e.d===2&&perp(x.e)&&x.e.paths===1,(a,b)=>big(a,b)||small(a,b)),
 sel(5,x=>x.e.d===3&&x.e.paths<=3,(a,b)=>big(a,b)||a.e.paths-b.e.paths||small(a,b)),
];
const ART={s:['circle','diamond','heart','star','moon','sun'],p:['stripes','zigzag','dots','waves','chevrons','scales'],w:['boat','hills','mountain','fish','whale'],t:['tree','lighthouse','rocket','flower','kite'],q:['house','bird','flower','boat','fish']};
const pools={s:[...ART.s],p:[...ART.p],w:[...ART.w],t:[...ART.t],q:[...ART.q]};const take=(o)=>{const p=pools[o];const a=p.shift();p.push(a);return a};
const out=[];const proof=[];stages.forEach((st,si)=>st.forEach(x=>{const e=x.e,b=x.b;const fin={};for(const[k,v]of e.m){const[px,py]=P(k);const l=v[0];fin[l.i+(l.f?'F':'B')]=[px-b.a,py-b.b,l.x?1:0,l.y?1:0]}
 const ratio=b.w/b.h;const n=out.length+1;let art;if(n<=9)art=take('s');else if(n<=16)art=take('p');else art=take(ratio>1.2?'w':ratio<.84?'t':'q');
 const f=firstOk(x.rows,e);out.push({sheet:x.rows,par:e.d,w:b.w,h:b.h,art,fin});proof.push({lvl:n,stage:si+1,sheet:x.name,par:e.d,routes:e.paths,first:f.ok+'/'+f.tot,final:b.w+'x'+b.h,art,seq:e.seq.map(s=>[s.ax,s.k,s.side])})}));
out[0].demo=(({ax,k,side})=>({ax,k,side}))(stages[0][0].e.seq[0]);
if(process.argv[2]==='--write'){const body=out.map(x=>'  '+JSON.stringify(x)).join(',\n');fs.writeFileSync(new URL('../../static/games/paperfold/levels.js',import.meta.url),`// The 25 levels, from projects/paperfold/generate-levels.mjs. Do not edit by hand:\n// \`fin\` says where each visible face ends up, as "<cell><F|B>": [x, y, flipX, flipY].\nexport const LEVELS = [\n${body}\n];\n`)}
for(const p of proof)console.log(p.lvl,'st'+p.stage,p.sheet,'folds',p.par,'routes',p.routes,'firstOK',p.first,p.final,p.art,JSON.stringify(p.seq));
