import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {BudgetExhaustedError} from '../pipeline/budget';
import {computeCollectedValuation} from '../src/shared/valuation-intake';
import {sha256} from '../src/shared/identity/normalize';
const url='https://vendor.example/grant';
const text='All new accounts receive a one-time grant of USD 12 API credits. No payment is required.';
const source=(quote=text,sourceUrl=url)=>({id:'benefit',url:sourceUrl,checkedAt:new Date().toISOString(),excerpt:quote,priceBasis:'Official grant terms'});
const facts=(quote=text)=>({kind:'direct_usd',amount:{value:12,sourceId:'benefit',quote},sources:[source()]});
const offer=(valuationFactors:unknown)=>({key:'gift',title:'新用户 API 赠额',platformId:'vendor',type:'new',modalities:['text'],claimMethod:'signup',requirements:['none'],audience:'new',valueText:'注册赠送12美元API额度',usdEstimate:999,usdMax:999,endKind:'unknown',sourceTz:'UTC',steps:[],excerpts:{benefit:text},valuationFactors});
const response=(value:unknown,tokens=100)=>new Response(JSON.stringify({candidates:[{content:{parts:[{text:JSON.stringify(value)}]}}],usageMetadata:{totalTokenCount:tokens}}));
beforeEach(()=>{vi.resetModules();vi.stubEnv('GEMINI_API_KEY','fixture-key');vi.stubEnv('OPENROUTER_API_KEY','');vi.stubEnv('GLM_API_KEY','');vi.stubEnv('DEEPSEEK_API_KEY','');vi.stubEnv('LLM_MIN_GAP_MS','0');});
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();vi.unstubAllEnvs();vi.restoreAllMocks();});
async function valueOf(value:any,body=text,sourceUrl=url){return computeCollectedValuation({...value,platformId:value.platformId??'vendor',sourceText:body,sourceFetch:{originalUrl:sourceUrl,finalUrl:sourceUrl,fetchedUrl:sourceUrl,method:'direct',sourceVerified:true,truncated:false,contentHash:await sha256(body)},evidence:{url:sourceUrl,tier:'official',capturedAt:new Date().toISOString(),excerpts:value.excerpts}});}
it('uses the same provider once to extend a source-bound money quote, with exact independent budget settlements and no business writes',async()=>{
 const calls:Array<{url:string;body:any}>=[];vi.stubGlobal('fetch',vi.fn(async(input,init)=>{calls.push({url:String(input),body:JSON.parse(String(init?.body))});return calls.length===1?response({offers:[offer(facts('USD 12'))],leadAssessment:{outcome:'unresolved',reason:'保持原线索待审'}}):response({repairs:[{key:'gift',valuationFactors:facts()}]},70);}));
 const reserve=vi.fn(async()=>({id:reserve.mock.calls.length,tokens:1000,costCny:0})),settle=vi.fn(async()=>{});
 const {extract}=await import('../pipeline/llm');const result=await extract('Vendor',url,text,undefined,{platformIds:['vendor'],leadTarget:'fixed lead target',verificationTarget:'fixed activity target',deadlineAt:Date.now()+10000,budget:{reserve,settle}});
 expect(calls).toHaveLength(2);expect(calls[0].url).toBe(calls[1].url);expect(calls.every(call=>call.url.includes('googleapis'))).toBe(true);
 expect(calls[1].body.systemInstruction.parts[0].text).toContain('catalogId Fact只能为 {catalogId}');expect(calls[1].body.contents[0].parts[0].text).toContain('actual entitlement requires');
 expect(reserve).toHaveBeenCalledTimes(2);expect(settle.mock.calls).toEqual([[{id:1,tokens:1000,costCny:0},'gemini',100,0],[{id:2,tokens:1000,costCny:0},'gemini',70,0]]);expect(result.tokens).toBe(170);
 expect(result.leadAssessment).toMatchObject({outcome:'unresolved',reason:'保持原线索待审'});expect(result.offers[0]).toMatchObject({platformId:'vendor',title:'新用户 API 赠额',usdEstimate:null,usdMax:null,excerpts:{benefit:text}});expect(result.offers[0]).not.toHaveProperty('sourceFetch');expect(result.offers[0]).not.toHaveProperty('sourceText');expect((await valueOf(result.offers[0])).valuation?.usdEstimate).toBe(12);
});
it('repairs strict catalog Fact structure without altering the activity or substituting a model amount',async()=>{
 // Catalog prices are dated (30-day life); pin the clock inside their window so the test does not expire.
 vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-10-20T12:00:00Z'));
 const sourceUrl='https://elevenlabs.io/free',body='Free plan: all registered accounts receive 10,000 credits monthly.';
 const recipe={kind:'credits',cadence:'month',benchmark:'entry_plan',entitlementUnits:{value:10000,sourceId:'benefit',quote:body},packageUnits:{catalogId:'elevenlabs-starter.packageUnits'},packagePrice:{catalogId:'elevenlabs-starter.amount',sourceId:'benefit',quote:body},sources:[source(body,sourceUrl)]};
 const corrected={...recipe,packagePrice:{catalogId:'elevenlabs-starter.amount'}};let modelCalls=0;
 vi.stubGlobal('fetch',vi.fn(async input=>{expect(String(input)).toContain('googleapis');return ++modelCalls===1?response({offers:[{...offer(recipe),platformId:'elevenlabs',type:'standing',valueText:'每月10000积分',endKind:'standing',excerpts:{benefit:body}}]}):response({repairs:[{key:'gift',valuationFactors:corrected}]});}));
 const {extract}=await import('../pipeline/llm');const result=await extract('ElevenLabs',sourceUrl,body);expect(modelCalls).toBe(2);expect((await valueOf(result.offers[0],body,sourceUrl)).valuation?.usdEstimate).toBe(2);
});
it('makes at most one repair call even when the repaired factor remains invalid',async()=>{
 let count=0;vi.stubGlobal('fetch',vi.fn(async()=>++count===1?response({offers:[offer(facts('USD 12'))]}):response({repairs:[{key:'gift',valuationFactors:facts('USD 12')}]})));
 const {extract}=await import('../pipeline/llm');const result=await extract('Vendor',url,text);expect(count).toBe(2);expect(result.tokens).toBe(200);expect((await valueOf(result.offers[0])).valuation?.status).toBe('needs_judgment');
});
it('does not retry unknown without actionable evidence or unavailable pricing recipes',async()=>{
 const recipes=[{kind:'unknown',sources:[source()]},{kind:'plan',price:{catalogId:'missing.amount'},billingPeriod:'month',sources:[source()]}];let count=0;vi.stubGlobal('fetch',vi.fn(async()=>response({offers:[{...offer(recipes[count++]),excerpts:{benefit:'Free access is available.'}}]})));
 const {extract}=await import('../pipeline/llm');await extract('Vendor',url,text);await extract('Vendor',url,text);expect(count).toBe(2);
});
it('degrades without a repair request when additional budget is unavailable',async()=>{
 const fetcher=vi.fn(async()=>response({offers:[offer(facts('USD 12'))]}));vi.stubGlobal('fetch',fetcher);const reserve=vi.fn(async()=>{if(reserve.mock.calls.length===2)throw new BudgetExhaustedError('No extra model quota');return {id:1,tokens:1000,costCny:0};}),settle=vi.fn(async()=>{});
 const {extract}=await import('../pipeline/llm');const result=await extract('Vendor',url,text,undefined,{budget:{reserve,settle}});expect(fetcher).toHaveBeenCalledTimes(1);expect(settle).toHaveBeenCalledTimes(1);expect(result.offers[0].usdEstimate).toBeNull();expect((await valueOf(result.offers[0])).valuation?.status).toBe('needs_judgment');
});
it('does not reserve or call for repair after the deadline',async()=>{
 const originalNow=Date.now(),deadline=originalNow+1000;const fetcher=vi.fn(async()=>{vi.spyOn(Date,'now').mockReturnValue(deadline+1);return response({offers:[offer(facts('USD 12'))]});});vi.stubGlobal('fetch',fetcher);const reserve=vi.fn(async()=>({id:1,tokens:1000,costCny:0})),settle=vi.fn(async()=>{});
 const {extract}=await import('../pipeline/llm');const result=await extract('Vendor',url,text,undefined,{deadlineAt:deadline,budget:{reserve,settle}});expect(fetcher).toHaveBeenCalledTimes(1);expect(reserve).toHaveBeenCalledTimes(1);expect(result.tokens).toBe(100);
});
it('rejects repair output that changes public fields or candidate identity',async()=>{
 let count=0;vi.stubGlobal('fetch',vi.fn(async()=>++count===1?response({offers:[offer(facts('USD 12'))]}):response({repairs:[{key:'gift',valuationFactors:facts(),title:'Injected replacement'}]})));
 const {extract}=await import('../pipeline/llm');const result=await extract('Vendor',url,text);expect(count).toBe(2);expect(result.offers[0].title).toBe('新用户 API 赠额');expect((await valueOf(result.offers[0])).valuation?.status).toBe('needs_judgment');
});
it('keeps an ambiguous repair usage reservation occupied without a second settlement or refund',async()=>{
 let count=0;vi.stubGlobal('fetch',vi.fn(async()=>++count===1?response({offers:[offer(facts('USD 12'))]}):new Response(JSON.stringify({candidates:[{content:{parts:[{text:JSON.stringify({repairs:[{key:'gift',valuationFactors:facts()}]})}]}}]}))));
 const reserve=vi.fn(async()=>({id:reserve.mock.calls.length,tokens:1000,costCny:0.25})),settle=vi.fn(async()=>{});const {extract}=await import('../pipeline/llm');const result=await extract('Vendor',url,text,undefined,{budget:{reserve,settle}});
 expect(count).toBe(2);expect(reserve).toHaveBeenCalledTimes(2);expect(settle).toHaveBeenCalledTimes(1);expect(result.tokens).toBe(1100);expect(result.costCny).toBe(0.25);expect((await valueOf(result.offers[0])).valuation?.usdEstimate).toBe(12);
});
it('halts rather than bypassing a failed repair budget settlement',async()=>{
 let count=0;vi.stubGlobal('fetch',vi.fn(async()=>++count===1?response({offers:[offer(facts('USD 12'))]}):response({repairs:[{key:'gift',valuationFactors:facts()}]})));
 const {BudgetLedgerError}=await import('../pipeline/budget');const reserve=vi.fn(async()=>({id:reserve.mock.calls.length,tokens:1000,costCny:0}));const settle=vi.fn(async()=>{if(settle.mock.calls.length===2)throw new BudgetLedgerError('Ledger unavailable');});const {extract}=await import('../pipeline/llm');
 await expect(extract('Vendor',url,text,undefined,{budget:{reserve,settle}})).rejects.toThrow('Ledger unavailable');expect(count).toBe(2);expect(settle).toHaveBeenCalledTimes(2);
});

it.each([undefined,{kind:'unknown',sources:[]}])('repairs omitted or unknown factors when the original benefit names a concrete USD grant: %j',async recipe=>{
 let count=0;vi.stubGlobal('fetch',vi.fn(async()=>++count===1?response({offers:[offer(recipe)]}):response({repairs:[{key:'gift',valuationFactors:facts()}]})));
 const {extract}=await import('../pipeline/llm');const result=await extract('Vendor',url,text);expect(count).toBe(2);expect((await valueOf(result.offers[0])).valuation?.usdEstimate).toBe(12);
});
it('repairs unknown credits using an available matching price without choosing an amount in the preflight',async()=>{
 vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-10-11T12:00:00Z'));
 const sourceUrl='https://elevenlabs.io/free',body='Free plan: all registered accounts receive 10,000 credits monthly.';
 const recipe={kind:'credits',cadence:'month',benchmark:'entry_plan',entitlementUnits:{value:10000,sourceId:'benefit',quote:body},packageUnits:{catalogId:'elevenlabs-starter.packageUnits'},packagePrice:{catalogId:'elevenlabs-starter.amount'},sources:[source(body,sourceUrl)]};
 let count=0;vi.stubGlobal('fetch',vi.fn(async()=>++count===1?response({offers:[{...offer({kind:'unknown',sources:[source(body,sourceUrl)]}),platformId:'elevenlabs',type:'standing',valueText:'每月10000积分',endKind:'standing',excerpts:{benefit:body}}]}):response({repairs:[{key:'gift',valuationFactors:recipe}]})));
 const {extract}=await import('../pipeline/llm');const result=await extract('ElevenLabs',sourceUrl,body);expect(count).toBe(2);expect((await valueOf(result.offers[0],body,sourceUrl)).valuation?.usdEstimate).toBe(2);
});
it('does not spend a repair call for omitted factors with an invented money excerpt',async()=>{
 const fetcher=vi.fn(async()=>response({offers:[{...offer(undefined),excerpts:{benefit:'All new accounts receive USD 999 API credits.'}}]}));vi.stubGlobal('fetch',fetcher);
 const {extract}=await import('../pipeline/llm');await extract('Vendor',url,text);expect(fetcher).toHaveBeenCalledTimes(1);
});
it('keeps truncation as a failure and records safe provider completion diagnostics without retrying it',async()=>{
 const fetcher=vi.fn(async()=>new Response(JSON.stringify({candidates:[{finishReason:'MAX_TOKENS',content:{parts:[{text:'{"offers":['}]}}],usageMetadata:{totalTokenCount:4096}})));vi.stubGlobal('fetch',fetcher);
 const log=vi.fn();const {extract}=await import('../pipeline/llm');await expect(extract('Vendor',url,text,log)).rejects.toThrow('截断');expect(fetcher).toHaveBeenCalledTimes(1);expect(log.mock.calls.flat().join(' ')).toContain('finish=MAX_TOKENS，chars=11，tokens=4096');
});
