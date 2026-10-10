import type { Evidence } from '../db/schema';
import { officialStatusKey } from './dedupe';

// Formatting and excerpt selection are not changes to the underlying terms.
export const normalizeTerms = (text: string) => text.normalize('NFKC').toLowerCase().replace(/[\s`*_]+/g, '');
const keys = ['benefit', 'eligibility', 'validity'] as const;
export function evidenceClaims(evidence: Evidence): string[] {
  return keys.map(k => normalizeTerms(evidence.excerpts[k] ?? '')).filter(x => x.length >= 8);
}
export function sameEvidencePage(a: string, b: string): boolean {
  try {
    const x = new URL(a), y = new URL(b);
    return x.origin === y.origin && x.pathname.replace(/\/$/, '') === y.pathname.replace(/\/$/, '') && x.search === y.search;
  } catch { return false; }
}
type Facts = Map<string, Set<string>>;
/** Conservative anchors; unrecognized prose requires human judgement, not an automatic reopen. */
function termFacts(value: string, field: typeof keys[number]): Facts {
  const text=value.normalize('NFKC').toLowerCase().replace(/[–—−]/g,'-');
  const facts:Facts=new Map();
  const add=(kind:string,value:string)=>{const values=facts.get(kind)??new Set();values.add(value);facts.set(kind,values);};
  for(const m of text.matchAll(/\b(20\d{2})[./-](\d{1,2})[./-](\d{1,2})\b/g))add('date',`${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`);
  const units:Record<string,string>={积分:'credits',credit:'credits',credits:'credits',point:'credits',points:'credits',token:'tokens',tokens:'tokens',小时:'hours',hour:'hours',hours:'hours',天:'days',day:'days',days:'days',个月:'months',月:'months',month:'months',months:'months',周:'weeks',week:'weeks',weeks:'weeks',次:'uses',use:'uses',uses:'uses',元:'cny',美元:'usd',usd:'usd',dollar:'usd',dollars:'usd',rpm:'rpm',tpm:'tpm'};
  for(const m of text.matchAll(/(\d+(?:,\d{3})*(?:\.\d+)?)\s*(百万|万|k|m)?\s*(积分|credits?|points?|tokens?|小时|hours?|天|days?|个月|月|months?|周|weeks?|次|uses?|美元|元|usd|dollars?|rpm|tpm)(?![a-z])/g)){
    const amount=Number(m[1].replace(/,/g,''))*({百万:1000000,万:10000,k:1000,m:1000000}[m[2]??'']??1);
    add(units[m[3]],String(amount));
    if(['credits','tokens'].includes(units[m[3]]))add('quota',units[m[3]]+':'+amount);
  }
  for(const m of text.matchAll(/([$¥￥€])\s*(\d+(?:,\d{3})*(?:\.\d+)?)/g))add(m[1]==='$'?'usd':m[1]==='€'?'eur':'cny',String(Number(m[2].replace(/,/g,''))));
  if(/每日|每天|daily|every day/.test(text))add('cadence','daily');
  if(/每月|monthly|every month/.test(text))add('cadence','monthly');
  if(/每周|weekly|every week/.test(text))add('cadence','weekly');
  if(/一次性|one[- ]time/.test(text))add('cadence','one_time');
  if(field==='eligibility'){
    const all=/all\s+(?:users|accounts)|every(?:one|\s+user)|new\s+and\s+existing|新老用户|所有用户|全部用户|人人/.test(text);
    if(all)add('eligibility','all');
    else if(/new\s+(?:users|accounts)|新用户|新注册/.test(text))add('eligibility','new');
    if(/students?|学生|在校/.test(text))add('eligibility','student');
    if(/teachers?|教师/.test(text))add('eligibility','teacher');
    if(/paid\s+(?:users|subscribers)|付费会员|付费用户|订阅会员/.test(text))add('eligibility','member');
    if(/invite[- ]only|邀请码|定向名单|仅限受邀/.test(text))add('eligibility','invite_only');
  }
  if(field==='validity'){
    if(facts.has('date'))add('end_mode','date');
    else if(/no(?:\s+published)?\s+end\s+date|截止未|未.*截止/.test(text))add('end_mode','unknown');
    else if(/no expiry|does not expire|长期有效|不会过期|永不过期/.test(text))add('end_mode','standing');
  }
  return facts;
}
function replacedFact(before:Facts,after:Facts):boolean {
  return [...before].some(([kind,values])=>{
    const next=after.get(kind);
    return !!next&&[...values].some(value=>!next.has(value))&&[...next].some(value=>!values.has(value));
  });
}
const fingerprint=(facts:Facts)=>JSON.stringify([...facts].map(([kind,values])=>[kind,[...values].sort()]).sort((a,b)=>String(a[0]).localeCompare(String(b[0]))));
/** A missing old quote alone proves extraction/rendering drift, not a policy change. */
export function changedOfficialTerms(before: Evidence, after: Evidence, sourceText?: string): boolean {
  if (!sourceText || ['media','tested'].includes(before.tier) || ['media','tested'].includes(after.tier)
    || !sameEvidencePage(before.url, after.url) || officialStatusKey(before.url)) return false;
  const text = normalizeTerms(sourceText), old = evidenceClaims(before), next = evidenceClaims(after);
  if (!old.length || !next.length || !next.every(q => text.includes(q))) return false;
  return keys.some(k => {
    const a = normalizeTerms(before.excerpts[k] ?? ''), b = normalizeTerms(after.excerpts[k] ?? '');
    return a.length >= 8 && b.length >= 8 && !text.includes(a) && text.includes(b)
      && replacedFact(termFacts(before.excerpts[k]??'',k),termFacts(after.excerpts[k]??'',k));
  });
}
/** Keep rejected terms remembered across grounded translations and excerpt rewrites. */
export function rejectedTermsStillPresent(rejected: Evidence, incoming: Evidence, sourceText?: string): boolean {
  if (!sourceText || !sameEvidencePage(rejected.url, incoming.url)) return false;
  const quotes = evidenceClaims(rejected), text = normalizeTerms(sourceText);
  if(quotes.length>0&&quotes.every(q=>text.includes(q)))return true;
  const next=evidenceClaims(incoming);
  if(!next.length||!next.every(q=>text.includes(q)))return false;
  let anchored=false;
  for(const key of keys){
    const before=termFacts(rejected.excerpts[key]??'',key),after=termFacts(incoming.excerpts[key]??'',key);
    if(fingerprint(before)!==fingerprint(after))return false;
    anchored ||= before.size>0;
  }
  return anchored;
}

/** Reuse the grounded source-change gate for benefit facts, excluding unrelated eligibility/date changes. */
export function changedOfficialBenefit(before: Evidence, after: Evidence, sourceText?: string): boolean {
  return changedOfficialTerms(
    { ...before, excerpts: { benefit: before.excerpts.benefit } },
    { ...after, excerpts: { benefit: after.excerpts.benefit } },
    sourceText,
  );
}
