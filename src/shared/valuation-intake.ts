import { calculateValuationV2, deriveEcbValuationFx } from './valuation-engine';
import { getValuationFactCatalog, VALUATION_PRICE_CATALOG } from './valuation-catalog';
import type { Valuation } from './valuation';
import { sourceFetchSchema, type SourceFetch } from './identity/fetch-evidence';
import {z} from 'zod';
import { sha256 } from './identity/normalize';

export const valuationSourceSchema=z.object({id:z.string().min(1).max(200),url:z.url(),text:z.string().min(1).max(250000),sourceFetch:sourceFetchSchema,checkedAt:z.string(),role:z.enum(['price','fx'])});
export type ValuationCollectedSource=z.infer<typeof valuationSourceSchema>;
export interface ValuationIntakeInput {
  platformId:string; type:string; sourceId?:string|null; models?:string[]; tags?:string[]; valuationFactors?:unknown;
  valuationSources?:ValuationCollectedSource[];
  sourceText?:string; sourceFetch?:SourceFetch;
  evidence:{url:string;tier:string;capturedAt:string;excerpts:{benefit?:string}};
}
export function automaticValuation(value:unknown):boolean {
  return !!value&&typeof value==='object'&&!Array.isArray(value)
    && (value as Valuation).version==='v2'&&(value as Valuation).inputs?.calculationEngine==='v2-auto';
}
export function protectedValuationFields(previous:{valuation?:unknown;usdEstimate?:number|null;usdMax?:number|null},manualFields:Iterable<string>=[]):Set<string> {
  const fields=new Set(manualFields);
  if(previous.valuation&&!automaticValuation(previous.valuation)||!previous.valuation&&(previous.usdEstimate!=null||previous.usdMax!=null)||fields.has('valuation')||fields.has('usdEstimate')||fields.has('usdMax')) {
    fields.add('valuation');fields.add('usdEstimate');fields.add('usdMax');
  }
  return fields;
}
/** Authenticate source bindings and independently compute every collector result. No business writes. */
export async function computeCollectedValuation(input:ValuationIntakeInput,now=new Date().toISOString()):Promise<{valuation:Valuation|null;errors:string[]}> {
  const cited=input.evidence.excerpts.benefit?.trim();
  const quote=cited&&(!input.sourceText||input.sourceText.includes(cited))?cited:input.sourceText?.slice(0,500)||'No source text available.';
  const sources=[{id:'benefit',url:input.evidence.url,checkedAt:input.evidence.capturedAt||now,excerpt:quote,priceBasis:'本次采集的权益原文'}];
  const unknown=(reason:string,errors:string[]=[])=>{
    const result=calculateValuationV2({kind:'unknown',reason:'金额未知，不按零计算。',sources}, {now,sourceTexts:{benefit:input.sourceText??quote}});
    return {...result,valuation:result.valuation?{...result.valuation,period:input.type==='apply'?'apply_max':result.valuation.period}:null,errors:[reason,...errors,...result.errors]};
  };
  if(!input.sourceText||!input.sourceFetch?.sourceVerified||input.sourceFetch.truncated||input.evidence.tier==='media'||input.evidence.tier==='tested')return unknown('完整官方正文及可靠抓取证明尚未齐备');
  if(input.sourceFetch.finalUrl!==input.evidence.url||await sha256(input.sourceText)!==input.sourceFetch.contentHash)return unknown('抓取正文与所引来源未绑定',['source_binding_mismatch']);
  const resetSentence=quote.split(/[。！？!?；;\n]/).find(sentence=>
    /(?:发放|赠送|获得).{0,35}(?:1|一)\s*(?:次|张).{0,20}(?:额外|独立).{0,12}重置|(?:额外|独立).{0,12}(?:发放|赠送).{0,12}(?:1|一)\s*(?:次|张).{0,12}重置|(?:receive|get|grant|give|giving|issue|issuing|offer).{0,45}(?:1|one|a single)\s+(?:extra|additional|independent|banked|bonus).{0,25}reset/i.test(sentence)
    && !/every\s*(?:day|week|month)|daily|monthly|每(?:天|周|月)|进度|执行中|正在执行|progress|rollout|processing|status update/i.test(sentence)
    && !/(?:不会|没有|不再|取消|未)(?:.{0,16})(?:发放|赠送|获得|额外|重置)|\b(?:not|never|won't|cannot|no)\b.{0,45}(?:receive|grant|give|extra|additional|reset)/i.test(sentence));
  // 2026-10-18 管理员授权的 AIHOT Codex reset 通道：员工原帖的直接重置（“today is a reset”）同样按 Plus 月价四分之一参照；
  // 只认本通道的程序生成候选（sourceId、reset 标签、员工证据、X 第一方抓取证明），模型抽取的重置仍须原文写明额外一次。
  const aihotReset=input.platformId==='openai'&&input.sourceId==='aihot-resets'&&!!input.tags?.includes('reset')&&input.evidence.tier==='staff'&&input.sourceFetch?.method==='first_party_embed';
  const singleReset=input.platformId==='openai'&&(!!resetSentence||aihotReset);
  const glmTrialCard=input.platformId==='zhipu'&&input.type!=='apply'&&/GLM\s+Coding\s+Plan/i.test(quote)
    &&/(?:7|七)\s*天.{0,12}(?:免费)?体验卡|(?:免费)?体验卡.{0,12}(?:7|七)\s*天|7[- ]day.{0,20}free trial card/i.test(quote)
    &&/免费|free/i.test(quote)&&!/[2-9]\d*\s*张|[二三四五六七八九十]\s*张|多张|multiple cards|(?:two|several)\s+(?:trial )?cards/i.test(quote)
    &&!/不(?:再|提供|赠送).{0,16}(?:体验卡|免费)|not.{0,16}free/i.test(quote);
  const medicalRule=input.platformId==='baichuan'&&input.type==='apply'&&/海纳百川/i.test(quote)
    &&/Baichuan[-\s]+M3[-\s]+Plus/i.test(quote)&&/医疗机构|medical institution/i.test(quote)
    &&/永久免费|permanently free|free forever/i.test(quote)&&/API/i.test(quote)
    &&!/并非|不是永久免费|不(?:再|提供).{0,16}(?:免费|API)|not.{0,16}(?:free|API)/i.test(quote);
  if(!input.valuationFactors&&!singleReset&&!glmTrialCard&&!medicalRule)return unknown('未抽取可计算因子，等待补证');
  if(Array.isArray(input.valuationFactors)&&input.valuationFactors.length!==1)return unknown('多个计算方案不能自动合并',['multiple_valuation_recipes']);
  const raw=Array.isArray(input.valuationFactors)&&input.valuationFactors.length===1?input.valuationFactors[0]:input.valuationFactors;
  let selectedFactors:unknown=raw&&typeof raw==='object'?structuredClone(raw):raw;
  const selectionRules:string[]=[];
  // Authorized V2 reset convention is selected by code, never fabricated as a source number.
  if(singleReset){
    // Quantity 1 is grounded above; price and quarter denominator are independently controlled.
    selectedFactors={kind:'plan',price:{catalogId:'chatgpt-plus.amount'},billingPeriod:'month',benchmark:'plan_fraction',referencePlan:'ChatGPT Plus',denominator:{ruleId:'plan_fraction_quarter'},sources};
    selectionRules.push('official_single_extra_reset_plus_quarter');
  }
  if(glmTrialCard){
    selectedFactors={kind:'plan',currency:'CNY',price:{catalogId:'glm-coding-lite.amount'},billingPeriod:'month',benchmark:'plan_fraction',referencePlan:'GLM Coding Lite',denominator:{ruleId:'plan_fraction_quarter'},sources};
    selectionRules.push('glm_coding_plan_single_seven_day_trial_quarter');
  }
  if(medicalRule){
    const supplied=selectedFactors as Record<string,unknown>|undefined;
    let maximum:unknown=supplied?.kind==='apply'?supplied.maximum:undefined;
    let maxCurrency=supplied?.kind==='apply'?supplied.currency:undefined;
    const profileSources=[...sources];
    const citeAmount=(value:unknown,id:string)=>{
      if(!value||typeof value!=='object'||!('quote' in value)||!input.sourceText!.includes(String(value.quote)))return undefined;
      profileSources.push({id,url:input.evidence.url,checkedAt:input.evidence.capturedAt||now,excerpt:String(value.quote),priceBasis:'本次官方原文的申请额度及释放安排'});
      return {...value,sourceId:id};
    };
    const first30Maximum=supplied?.kind==='apply'?citeAmount(supplied.first30Maximum,'first30-release'):undefined;
    if(maximum&&typeof maximum==='object'&&'quote' in maximum&&input.sourceText.includes(String(maximum.quote))){
      maximum=citeAmount(maximum,'maximum');
      if(!maxCurrency)maxCurrency=/CNY|RMB|人民币/i.test(String((maximum as {quote?:string})?.quote))?'CNY':'USD';
    }else{
      maximum=undefined;
      for(const [currency,name] of [['USD','USD|美元'],['CNY','CNY|RMB|人民币']] as const){
        const expression=new RegExp(`(?:最高|上限|up to|maximum)[^。;\\n]{0,24}(?:(?:${name})\\s*([0-9][0-9,]*(?:\\.[0-9]+)?)|([0-9][0-9,]*(?:\\.[0-9]+)?)\\s*(?:${name}))`,'i');
        const match=expression.exec(quote);
        if(match){maximum={value:Number((match[1]??match[2]).replaceAll(',','')),sourceId:'benefit',quote:match[0]};maxCurrency=currency;break;}
      }
    }
    selectedFactors={kind:'apply',currency:maximum?maxCurrency??'USD':'CNY',...(maximum?{maximum}:{}),...(first30Maximum?{first30Maximum}:{}),sources:profileSources,
      scenario:{kind:'scenario',benchmark:'substitute_model',referenceModel:'Baichuan-M3-Plus',usageMultiplier:{ruleId:'baichuan_medical_usage_30'},components:[{scenario:'text',models:[{id:'Baichuan-M3-Plus',currency:'CNY',inputPrice:{catalogId:'baichuan-m3-plus.inputPrice'},outputPrice:{catalogId:'baichuan-m3-plus.outputPrice'},tokenPriceUnits:{catalogId:'baichuan-m3-plus.tokenPriceUnits'}}]}]}};
    selectionRules.push('baichuan_haina_medical_m3_plus_text_workload_30');
  }
  const factors=selectedFactors as {sources?:Array<{id:string;url:string;excerpt:string}>;kind?:string};
  const sourceTexts:Record<string,string>={};
  const runtimeCatalog:ReturnType<typeof getValuationFactCatalog>={};
  const allowedUrls=VALUATION_PRICE_CATALOG.filter(p=>p.platformId===input.platformId||p.kind==='token_model'&&(input.models??[]).some(m=>m.toLowerCase()===p.model.toLowerCase())).flatMap(p=>p.sources.map(s=>s.url));
  const validSources:ValuationCollectedSource[]=[];
  for(const source of input.valuationSources??[]){
    if(source.sourceFetch.finalUrl!==source.url||!source.sourceFetch.sourceVerified||source.sourceFetch.truncated||await sha256(source.text)!==source.sourceFetch.contentHash)continue;
    if(source.role==='price'&&!allowedUrls.includes(source.url))continue;
    if(source.role==='fx'){
      if(source.url!=='https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml')continue;
      const date=/\btime=['"](\d{4}-\d{2}-\d{2})['"]/.exec(source.text)?.[1];
      if(!date||date>now.slice(0,10)||Date.parse(now)-Date.parse(date)>7*86400000)continue;
      const parsed=deriveEcbValuationFx(source.text,source.checkedAt,now);
      if(!parsed)continue;Object.assign(runtimeCatalog,parsed.catalog);
    }
    validSources.push(source);
  }
  if(!Array.isArray(factors.sources)||!factors.sources.length||factors.sources.some(s=>!s||!(s.url===input.evidence.url&&input.sourceText!.includes(s.excerpt)||validSources.some(v=>v.url===s.url&&v.text.includes(s.excerpt)))))return unknown('因子引用未绑定本次正文',['unbound_factor_source']);
  const actualFact=(value:unknown)=>!value||typeof value==='object'&&'value' in value&&'sourceId' in value&&factors.sources!.some(s=>s.id===(value as {sourceId:string}).sourceId&&s.url===input.evidence.url);
  const recipe=factors as unknown as Record<string,unknown>;
  for(const key of ['amount','maximum','fullAmount','first30Maximum','entitlementUnits','totalTokens','monthlyCap','months','multiplier','coverageDays'])if(!actualFact(recipe[key]))return unknown('实际赠额与权益数量必须来自本次活动原文',['entitlement_source_mismatch']);
  if(recipe.denominator&&!singleReset&&!glmTrialCard)return unknown('当前权益未匹配受控套餐分数约定',['unsupported_fraction_policy']);
  if((input.type==='apply')!==(factors.kind==='apply')&&factors.kind!=='unknown')return unknown('申请制与计算周期不一致',['valuation_type_mismatch']);
  const available={...getValuationFactCatalog(now),...runtimeCatalog};
  // Model names are matched without spaces/punctuation: “DeepSeek V4.1 Flash” on a page is DeepSeek-V4.1-Flash (2026-10-18).
  const nameKey=(v:string)=>v.toLowerCase().replace(/[^a-z0-9]/g,''),pageKey=nameKey(input.sourceText??'');
  const permitted=VALUATION_PRICE_CATALOG.filter(p=>p.kind!=='token_model'?p.platformId===input.platformId:p.platformId===input.platformId||pageKey.includes(nameKey(p.model))&&(input.models??[]).some(m=>nameKey(m)===nameKey(p.model)));
  const catalog=Object.fromEntries(Object.entries(available).filter(([id])=>id.startsWith('ecb-')||permitted.some(p=>id.startsWith(p.id+'.'))));
  const latestFx=(currency:string)=>{
    const rates=Object.entries(catalog).filter(([id,entry])=>entry.kind==='fx'&&entry.currency===currency&&/^ecb-\d{4}-\d{2}-\d{2}\./.test(id)).sort(([a],[b])=>b.localeCompare(a));
    return rates[0]?{currency,date:rates[0][0].slice(4,14),usdRate:{catalogId:rates[0][0]}}:null;
  };
  // Models sometimes cite the fetched ECB source by its source id (usdRate.catalogId="valuation-fx") instead of the
  // dated fact (2026-10-28: GLM trial card). Bind it to the one ECB fact fetched this run for that currency; never invent a rate.
  const bindFx=(node:unknown):void=>{
    if(!node||typeof node!=='object')return;
    if(Array.isArray(node)){node.forEach(bindFx);return;}
    const record=node as Record<string,unknown>,fx=record.fx as {currency?:string;usdRate?:{catalogId?:string}}|undefined;
    if(fx&&typeof fx==='object'&&typeof fx.currency==='string'&&fx.usdRate?.catalogId&&!catalog[fx.usdRate.catalogId]){
      const fresh=latestFx(fx.currency);
      if(fresh){record.fx={...fx,...fresh};if(!selectionRules.includes('fx_reference_bound_to_fetched_ecb'))selectionRules.push('fx_reference_bound_to_fetched_ecb');}
    }
    // A CNY/INR price with no fx at all (2026-10-28: GLM trial card) takes the same fetched ECB fact.
    if(!fx&&(record.currency==='CNY'||record.currency==='INR')&&('price' in record||'amount' in record)){
      const fresh=latestFx(record.currency);
      if(fresh){record.fx=fresh;if(!selectionRules.includes('fx_reference_bound_to_fetched_ecb'))selectionRules.push('fx_reference_bound_to_fetched_ecb');}
    }
    for(const value of Object.values(record))if(value!==fx&&value!==record.fx)bindFx(value);
  };
  bindFx(selectedFactors);
  if(glmTrialCard||medicalRule){
    const fx=latestFx('CNY');if(!fx)return unknown('已授权权益缺少有效官方汇率',['fresh_profile_fx_missing']);
    if(glmTrialCard||recipe.currency==='CNY')recipe.fx=fx;
    if(medicalRule)((recipe.scenario as {components:Array<Record<string,unknown>>}).components[0]).fx=fx;
  }
  const scenario=(factors.kind==='token_grant'?{components:[recipe]}:factors.kind==='scenario'?factors:(factors as {scenario?:unknown}).scenario) as {benchmark?:string;components?:Array<{models?:Array<Record<string,unknown>>}>}|undefined;
  if(scenario?.components)for(const component of scenario.components){
    for(const cap of Object.values((component as {caps?:Record<string,unknown>}).caps??{}))if(!actualFact(cap))return unknown('实际免费用量上限必须来自本次活动原文',['entitlement_source_mismatch']);
    for(const model of component.models??[]){
    const normalize=(s:string)=>s.toLowerCase().replace(/[^a-z0-9]/g,'');
    const exact=permitted.find(p=>p.kind==='token_model'&&p.platformId===input.platformId
      &&[p.id,p.model].some(name=>normalize(name)===normalize(String(model.canonicalId??model.id??'')))
      &&pageKey.includes(nameKey(p.model)));
    if(exact?.kind==='token_model'&&(model.currency===undefined||model.currency===exact.currency)
      &&(model.specification===undefined||model.specification===exact.specification)
      &&catalog[exact.id+'.inputPrice']&&catalog[exact.id+'.outputPrice']&&catalog[exact.id+'.tokenPriceUnits']){
      const prices=[model.inputPrice??model.inputPerMillion,model.outputPrice??model.outputPerMillion];
      const boundLiteral=(v:unknown)=>!!v&&typeof v==='object'&&'value' in v&&'sourceId' in v&&'quote' in v
        &&factors.sources!.some(source=>source.id===(v as {sourceId:string}).sourceId&&source.excerpt.includes(String((v as {quote:string}).quote))
          &&(source.url===input.evidence.url?input.sourceText!:validSources.find(s=>s.url===source.url)?.text??'').includes(String((v as {quote:string}).quote))
          &&[...String((v as {quote:string}).quote).matchAll(/(?<![\w.])\d+(?:,\d{3})*(?:\.\d+)?(?![\w.])/g)].some(m=>Number(m[0].replaceAll(',',''))===(v as {value:number}).value));
      const invalidCatalog=prices.some((v,index)=>v&&typeof v==='object'&&'catalogId' in v
        &&v.catalogId!==exact.id+(index===0?'.inputPrice':'.outputPrice'));
      const unresolvedLiterals=prices.some(v=>v&&typeof v==='object'&&'value' in v&&!boundLiteral(v));
      const anyActualPrice=prices.some(boundLiteral);
      const invalidUnitCatalog=model.tokenPriceUnits&&typeof model.tokenPriceUnits==='object'&&'catalogId' in model.tokenPriceUnits&&model.tokenPriceUnits.catalogId!==exact.id+'.tokenPriceUnits';
      const knownUnitString=model.tokenPriceUnits==='million_tokens'&&exact.tokenPriceUnits===1_000_000;
      if(!invalidCatalog&&!invalidUnitCatalog&&!anyActualPrice&&(unresolvedLiterals||knownUnitString)){
        delete model.inputPerMillion;delete model.outputPerMillion;
        model.inputPrice={catalogId:exact.id+'.inputPrice'};model.outputPrice={catalogId:exact.id+'.outputPrice'};model.tokenPriceUnits={catalogId:exact.id+'.tokenPriceUnits'};
        model.currency=exact.currency;model.specification=exact.specification;model.sourceType=exact.authority;
        const componentRecord=component as unknown as Record<string,unknown>;
        if(exact.currency!=='USD'&&!componentRecord.fx&&!recipe.fx){
          const rates=Object.entries(catalog).filter(([id,entry])=>entry.kind==='fx'&&entry.currency===exact.currency&&/^ecb-\d{4}-\d{2}-\d{2}\./.test(id))
            .sort(([a],[b])=>b.localeCompare(a));
          if(rates[0])componentRecord.fx={currency:exact.currency,date:rates[0][0].slice(4,14),usdRate:{catalogId:rates[0][0]}};
        }
        selectionRules.push('same_model_verified_catalog:'+exact.id);
      }else if(knownUnitString&&!invalidCatalog&&!invalidUnitCatalog){
        model.tokenPriceUnits={catalogId:exact.id+'.tokenPriceUnits'};selectionRules.push('same_model_verified_token_unit:'+exact.id);
      }
    }
    const names=Object.values(model).flatMap(v=>v&&typeof v==='object'&&'catalogId' in v?[String(v.catalogId)]:[]);
    const used=VALUATION_PRICE_CATALOG.filter(p=>p.kind==='token_model'&&names.some(id=>id.startsWith(p.id+'.')));
    if(used.length>1)return unknown('不同模型价格不能混算',['model_catalog_mismatch']);
    const chosen=used[0];
    if(chosen?.kind==='token_model'){
      const normalize=(s:string)=>s.toLowerCase().replace(/[^a-z0-9]/g,'');
      if(![chosen.id,chosen.model].some(name=>normalize(name)===normalize(String(model.id??''))))return unknown('计算型号与可信目录型号不一致',['model_catalog_mismatch']);
      const proxy=scenario.benchmark==='substitute_model'&&chosen.genericProxyEligible&&chosen.platformId===input.platformId;
      if(!proxy&&!pageKey.includes(nameKey(chosen.model))&&!(medicalRule&&chosen.id==='baichuan-m3-plus'))return unknown('权益原文未确认此模型免费',['model_entitlement_unproven']);
      if(chosen.tokenPriceUnits!==1_000_000&&('inputPerMillion' in model||'outputPerMillion' in model))return unknown('模型价格的原始计费单位不同',['model_unit_mismatch']);
    }else if(!nameKey(String(model.id??''))||!pageKey.includes(nameKey(String(model.id??''))))return unknown('权益原文未确认此模型免费',['model_entitlement_unproven']);
  }
  }

  const context={catalog,platformId:input.platformId,allowedRuleIds:medicalRule?['baichuan_medical_usage_30']:[]};
  for(const source of factors.sources){sourceTexts[source.id]=source.url===input.evidence.url?input.sourceText:validSources.find(v=>v.url===source.url)!.text;}
  if(factors.kind==='unknown')return unknown((factors as {reason?:string}).reason??'当前事实不足以自动定价');
  const result=calculateValuationV2(selectedFactors,{...context,sourceTexts,now});
  if(!result.valuation)return unknown('计算因子未通过验证',result.errors);
  return {valuation:{...result.valuation,inputs:{...result.valuation.inputs,calculationEngine:'v2-auto',...(selectionRules.length?{ruleIds:[...(Array.isArray(result.valuation.inputs.ruleIds)?result.valuation.inputs.ruleIds:[]),...selectionRules]}:{})},assumptions:[...result.valuation.assumptions,...(selectionRules.length?['采用已核验同型号价格目录及适用的受控权益计算约定。']:[])]},errors:result.errors};
}
/** Transport details never become public offer fields or canonical identity facts. */
export function stripValuationTransport<T extends Record<string,unknown>>(input:T) {
  const {valuationFactors:_recipe,valuationSources:_prices,sourceText:_text,sourceFetch:_fetch,...display}=input;
  return display;
}
