import { computeCollectedValuation, type ValuationCollectedSource } from '../src/shared/valuation-intake';
import { sha256 } from '../src/shared/identity/normalize';
import { VALUATION_PRICE_CATALOG, valuationPriceIsFresh } from '../src/shared/valuation-catalog';
import type { Extracted } from './llm';

export interface FactorRepairIssue { index:number;key:string;errors:string[];valuationFactors:unknown }
/** Pure shape/source preflight. Its temporary fetch binding is validation-only and never leaves this function. */
export async function valuationRepairIssues(offers:Extracted[],context:{url:string;text:string;platformIds?:Array<string|null|undefined>;valuationSources:ValuationCollectedSource[]}):Promise<FactorRepairIssue[]> {
  const now=new Date().toISOString(),contentHash=await sha256(context.text);
  const issues:FactorRepairIssue[]=[];
  for(const [index,offer] of offers.entries()){
    const raw=offer.valuationFactors;
    const recipe=Array.isArray(raw)&&raw.length===1?raw[0]:raw;
    const platformId=(offer as Extracted&{platformId?:string}).platformId??context.platformIds?.find(id=>!!id)??'';
    if(!recipe||typeof recipe!=='object'||Array.isArray(recipe)||!('kind' in recipe)||recipe.kind==='unknown'){
      // Only ask to recover evidence already present. This is not a pricing decision:
      // repaired factors still pass the identical source/units/policy checks below and at intake.
      const benefit=offer.excerpts?.benefit?.trim()??'';
      const grounded=benefit.length>=12&&context.text.includes(benefit);
      const directMoney=/(?:USD\s*[\d,]+|[\d,]+\s*(?:USD|美元))/i.test(benefit);
      const matchedPrice=VALUATION_PRICE_CATALOG.some(price=>valuationPriceIsFresh(price,now)&&(price.platformId===platformId||price.kind==='token_model'&&(offer.models??[]).some(model=>model.toLowerCase()===price.model.toLowerCase())));
      const quantity=/\d[\d,.]*\s*(?:credits?|tokens?|积分|点数|次|个月|天|days?|months?)/i.test(benefit);
      if(grounded&&(directMoney||matchedPrice&&quantity))issues.push({index,key:offer.key,errors:['Missing actionable valuationFactors: recover only from the original benefit and matching trusted prices; remain unknown if evidence is insufficient'],valuationFactors:raw??null});
      continue;
    }
    const result=await computeCollectedValuation({platformId,type:offer.type,models:offer.models,tags:offer.tags,valuationFactors:raw,valuationSources:context.valuationSources,
      sourceText:context.text,sourceFetch:{originalUrl:context.url,finalUrl:context.url,fetchedUrl:context.url,method:'direct',sourceVerified:true,truncated:false,contentHash},
      evidence:{url:context.url,tier:'official',capturedAt:now,excerpts:offer.excerpts??{}}},now);
    if(result.valuation?.status==='priced'||result.valuation?.status==='provisional')continue;
    // Availability, expired prices, missing FX and unknown policy are genuine gaps, not prompt-format failures.
    const errors=result.errors.filter(error=>!/Unknown trusted catalog|fresh.*missing|Stale|expired|Missing matched FX|缺少有效官方汇率|未匹配受控|没有价格|真实上限|未抽取可计算因子/i.test(error)
      &&/Invalid input|Unrecognized|expected|Source .*quote|Source USD entitlement|actual entitlement requires|numeric value|not bound|unbound_factor_source|reference plan|priced row|currency.*context|denomination.*context/i.test(error));
    if(errors.length)issues.push({index,key:offer.key,errors,valuationFactors:raw});
  }
  return issues;
}

/** Repairs may change factors only; identity, eligibility, public text and original excerpts stay frozen. */
export function applyFactorRepairs(offers:Extracted[],issues:FactorRepairIssue[],value:unknown):Extracted[]{
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>key!=='repairs')||!('repairs' in value)||!Array.isArray(value.repairs))throw new Error('factor repair response must contain only repairs');
  const expected=new Map(issues.map(issue=>[issue.key,issue.index])),seen=new Set<string>();
  const next=[...offers];
  for(const repair of value.repairs){
    if(!repair||typeof repair!=='object'||Array.isArray(repair)||Object.keys(repair).some(key=>!['key','valuationFactors'].includes(key))||typeof repair.key!=='string'||!expected.has(repair.key)||seen.has(repair.key)||!('valuationFactors' in repair))throw new Error('factor repair changed unauthorized fields or candidate identity');
    seen.add(repair.key);const index=expected.get(repair.key)!;next[index]={...next[index],valuationFactors:repair.valuationFactors};
  }
  return next;
}

/**
 * Snap each factor quote/excerpt to the exact page span it matches when only whitespace differs, so binding checks
 * see verbatim page text. Text that is not on the page is left untouched (and still fails binding).
 */
export function snapFactorQuotes(factors:unknown,page:string):unknown {
  // Collapse whitespace runs to one space while remembering each kept character's page index.
  let flat='';const at:number[]=[];
  for(let i=0;i<page.length;i++){const space=/\s/.test(page[i]);if(space&&flat.endsWith(' '))continue;flat+=space?' ':page[i];at.push(i);}
  const snap=(text:string)=>{
    if(page.includes(text))return text;
    const needle=text.replace(/\s+/g,' ').trim(),hit=needle?flat.indexOf(needle):-1;
    return hit<0?text:page.slice(at[hit],at[hit+needle.length-1]+1);
  };
  const walk=(v:unknown):unknown=>Array.isArray(v)?v.map(walk):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,x])=>[k,(k==='quote'||k==='excerpt')&&typeof x==='string'?snap(x):walk(x)])):v;
  return walk(factors);
}

/** Deterministic factor tidy before preflight: lift a component-level coverageDays to the recipe, then snap quotes. */
export function normalizeFactors(factors:unknown,page:string):unknown {
  // 模型有时把整个估值对象回给我们：{usdEstimate,usdMax,valuationFactors:{kind…}}（2026-10-26 起快速上架 21 条中 8 条），
  // 外层没有 kind，校验失败后估值被整体丢弃、条目无估值上架。只解开这一层，不改写因子内容。
  while(factors&&typeof factors==='object'&&!Array.isArray(factors)&&!('kind' in factors)&&'valuationFactors' in factors)factors=(factors as {valuationFactors:unknown}).valuationFactors;
  if(factors&&typeof factors==='object'&&!Array.isArray(factors)){
    const f={...(factors as Record<string,unknown>)},components=Array.isArray(f.components)?f.components as Record<string,unknown>[]:[];
    const days=components.map(c=>c&&typeof c==='object'?c.coverageDays:undefined).filter(Boolean);
    if(days.length===1&&f.coverageDays===undefined){f.coverageDays=days[0];f.components=components.map(c=>{const {coverageDays:_d,...rest}=c;return rest;});}
    factors=f;
  }
  return snapFactorQuotes(factors,page);
}
