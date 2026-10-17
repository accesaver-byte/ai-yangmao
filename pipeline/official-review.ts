import { postIdentityOffers } from './identity-client';
import { toOffer } from './offer-draft';
import type { Source } from './collectors';
import { fetchPage, relevantText, api } from './lib';
import { extract, modelAvailable, DeferError } from './llm';
import { modelBudget, BudgetExhaustedError, BudgetLedgerError, reserveFixed, settleModel } from './budget';
import { officialTier, officialActivityMismatch, type OfficialPlatform, type OfficialSource } from '../src/shared/official-review';
import { offerIn, type OfferIn } from '../src/shared/ingest';
import { normUrl } from '../src/shared/dedupe';

const SEARCH_URL='https://mcp.exa.ai/mcp';
export function parseSearchResults(body:string):string[] {
  let message:any;
  try { message=JSON.parse(body); }
  catch {
    const messages=body.split(/\r?\n\r?\n/).flatMap(block=>{
      const data=block.split(/\r?\n/).filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trim()).join('\n');
      if(!data)return [];try{return [JSON.parse(data)];}catch{return [];}
    });
    message=messages.find(x=>x.result||x.error);
  }
  if(!message || message.error || message.result?.isError || !Array.isArray(message.result?.content))throw new Error('搜索服务返回错误，不能视为没有官方公告');
  const text=(message.result?.content ?? []).filter((c:any)=>c.type==='text').map((c:any)=>c.text).join('\n');
  if(/rate limit|quota exceeded|API key required/i.test(text))throw new Error('搜索服务额度或访问受限');
  return [...new Set([...text.matchAll(/^URL:\s*(https?:\/\/\S+)/gm)].map(m=>m[1]))].slice(0,10);
}
// Exa 匿名端点很快限流，之后整轮暂停搜索，社区/媒体线索全部转重试（2026-10-15）。限流或出错时改用 OpenRouter 联网搜索插件：
// 免费模型 + web 插件约 $0.007/次，按次预留并入账到同一个月度付费上限，每轮最多 OPENROUTER_SEARCH_PER_RUN 次。
const USD_CNY=7.2;
let openRouterSearchesLeft=Number(process.env.OPENROUTER_SEARCH_PER_RUN??6);
export function openRouterCitations(payload:unknown):string[]{
  const message=(payload as {choices?:{message?:{annotations?:{type?:string;url_citation?:{url?:unknown}}[]}}[]})?.choices?.[0]?.message;
  return [...new Set((message?.annotations??[]).map(a=>a.url_citation?.url).filter((u):u is string=>typeof u==='string'&&/^https?:\/\//.test(u)))];
}
async function searchViaOpenRouter(query:string,deadlineAt:number):Promise<string[]>{
  const key=process.env.OPENROUTER_API_KEY;
  if(!key||openRouterSearchesLeft<=0)throw new Error('搜索服务额度或访问受限');
  openRouterSearchesLeft--;
  const reservation=await reserveFixed('openrouter-web',Number(process.env.OPENROUTER_SEARCH_CNY??0.06));
  let cost=0;
  try{
    const response=await fetch('https://openrouter.ai/api/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${key}`},
      body:JSON.stringify({model:process.env.OPENROUTER_SEARCH_MODEL??'openrouter/free',plugins:[{id:'web',max_results:5}],max_tokens:300,
        messages:[{role:'user',content:`Find the issuer's own official announcement, documentation or official X post for this exact AI benefit. Reply with URLs only.\n${query}`}]}),
      signal:AbortSignal.timeout(Math.max(1,Math.min(30000,deadlineAt-Date.now())))});
    if(!response.ok)throw new Error(`联网搜索 HTTP ${response.status}`);
    const payload=await response.json() as {usage?:{cost?:number}};
    cost=Number(payload.usage?.cost??0)*USD_CNY;
    return openRouterCitations(payload);
  }finally{await settleModel(reservation,'openrouter-web',0,Number.isFinite(cost)?cost:reservation.costCny);}
}
export async function searchOfficial(query:string,deadlineAt:number):Promise<string[]> {
  if(Date.now()>=deadlineAt)throw new DeferError('本轮官方搜索时间不足');
  try{return await searchExa(query,deadlineAt);}
  catch(error){
    if(error instanceof DeferError)throw error;
    // 备用搜索也失败（含预算用尽）时保留原错误：调用方据此暂停本轮搜索并转重试，不当作“没有官方公告”。
    try{return await searchViaOpenRouter(query,deadlineAt);}catch{throw error;}
  }
}
const EXA_OBJECTIVE='Find the issuer’s own official announcement, documentation or official X post for this exact AI benefit. Prefer primary sources. Exclude community reposts and reseller promotions.';
/**
 * Exa /search 请求（build-with-exa 规范：query + type auto；只要结果 URL，正文由管线自己抓取核验，所以不带 contents）。
 * 调用方用 `site:` 写的限定来自后台登记的官方站点与官方 X 账号，是已批准的硬性白名单，按 Exa 文档改成 includeDomains
 *（支持路径前缀，如 x.com/thsottiaux），不留在查询文字里。
 */
export function exaSearchRequest(query:string):{query:string;type:'auto';objective:string;includeDomains?:string[]} {
  const domains:string[]=[];
  const text=query.replace(/(?:\bOR\s+)?\bsite:(\S+)/gi,(_match,target:string)=>{domains.push(target.replace(/\/status\/?$/i,'').replace(/\/+$/,''));return ' ';}).replace(/\s+/g,' ').trim();
  return {query:text||query,type:'auto',objective:EXA_OBJECTIVE,...(domains.length?{includeDomains:[...new Set(domains)]}:{})};
}
async function searchExaApi(query:string,deadlineAt:number,key:string):Promise<string[]> {
  const response=await fetch('https://api.exa.ai/search',{method:'POST',headers:{'Content-Type':'application/json','x-api-key':key},body:JSON.stringify(exaSearchRequest(query)),
    signal:AbortSignal.timeout(Math.max(1,Math.min(20000,deadlineAt-Date.now())))});
  if(!response.ok)throw new Error(`搜索服务 HTTP ${response.status}`);
  const payload=await response.json() as {results?:{url?:unknown}[]};
  if(!Array.isArray(payload.results))throw new Error('搜索服务返回错误，不能视为没有官方公告');
  return [...new Set(payload.results.map(r=>r.url).filter((u):u is string=>typeof u==='string'&&/^https?:\/\//.test(u)))];
}
async function searchExa(query:string,deadlineAt:number):Promise<string[]> {
  if(process.env.EXA_API_KEY)return searchExaApi(query,deadlineAt,process.env.EXA_API_KEY);
  // 没有密钥时用匿名 MCP 端点（很快限流，限流后由 OpenRouter 联网搜索兜底）。
  const response=await fetch(SEARCH_URL,{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream'},
    body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'web_search_exa',arguments:{query,numResults:5,objective:EXA_OBJECTIVE}}}),
    signal:AbortSignal.timeout(Math.max(1,Math.min(20000,deadlineAt-Date.now())))});
  if(!response.ok)throw new Error(`搜索服务 HTTP ${response.status}`);
  const body=await response.text();if(body.length>250000)throw new Error('搜索结果过大');
  return parseSearchResults(body);
}
interface Job {
  claimed:boolean;stageEvidence?:boolean;recovered?:boolean;previousCandidates?:string[];jobId:string;offer:OfferIn & {discoveredAt?:string};platform:OfficialPlatform;sources:OfficialSource[];
}
export interface OfficialReviewStats { checked:number;matched:number;unresolved:number;failed:number;deferred:number;searches:number }
export async function runOfficialReviews(options:{limit:number;deadlineAt:number;dry:boolean;allowPaid:boolean;account:(tokens:number,costCny:number)=>void;canContinue:()=>boolean;log:(...args:unknown[])=>void}):Promise<OfficialReviewStats> {
  const stats:OfficialReviewStats={checked:0,matched:0,unresolved:0,failed:0,deferred:0,searches:0};
  if(options.dry||options.limit<=0)return stats;
  const {jobs}=await api<{jobs:{id:string;recovery?:boolean}[]}>(`/official-reviews/queue?limit=${options.limit}`);
  let searchPaused=false;
  for(const [index,queued] of jobs.entries()) {
    if(!queued.recovery&&(!options.canContinue()||!modelAvailable(options.allowPaid))){stats.deferred+=jobs.length-index;break;}
    const job=await api<Job>(`/official-reviews/${queued.id}/claim`,{});
    if(!job.claimed)continue;
    stats.checked++;
    const queries:string[]=[],candidates:string[]=[],failures:string[]=[];
    let matched=false, chosenUrl:string|undefined, changedFields:string[]=[];
    let failure=false, stop=false, readable=0, searchLimited=searchPaused;
    const started=Date.now(),deadlineAt=Math.min(options.deadlineAt,started+4*60_000);
    try {
      const {corrections}=await api<{corrections:string[]}>(`/corrections?platform=${encodeURIComponent(job.platform.id)}&limit=10`);
      const terms=`${job.platform.name} ${job.offer.title} ${job.offer.valueText}`.slice(0,230);
      const domains=[...new Set([job.platform.site,...job.sources.map(s=>s.url)].filter((url):url is string=>!!url).flatMap(url=>{try{return [new URL(url).hostname];}catch{return [];} }))].slice(0,4);
      const planned=[`${terms} ${domains.map(d=>'site:'+d).join(' OR ')}`.slice(0,350)];
      const handles=[...job.platform.xHandles,...job.platform.staffHandles].slice(0,3);
      if(handles.length)planned.push(`${terms} ${handles.map(h=>'site:x.com/'+h.replace(/^@/,'')+'/status').join(' OR ')}`.slice(0,350));
      // 已知准确出处优先，搜索服务故障不阻断读取这些候选。
      const known=job.offer.steps.flatMap(step=>step.match(/https?:\/\/[^\s<>"）)]+/g) ?? []).map(url=>url.replace(/[.,;，。；]+$/,''));
      const urls:string[]=[job.offer.evidence.url,...known];
      for(const query of planned) {
        if(searchPaused){failure=true;failures.push('本轮搜索服务受限，继续读取已知官方候选');break;}
        queries.push(query);stats.searches++;
        try { urls.push(...await searchOfficial(query,deadlineAt)); }
        catch(error) { failure=true;searchPaused=true;searchLimited=true;failures.push('部分搜索受限，继续读取已知官方候选：'+(error as Error).message.slice(0,100));break; }
      }
      // 搜索摘要和猜测链接只用于发现；实际修改必须重新抓取官方正文。
      urls.push(...job.sources.filter(s=>['site','docs','official'].includes(s.tier)).map(s=>s.url));
      const seen=new Set<string>();
      const previous=new Set((job.previousCandidates??[]).map(normUrl));
      // 每轮推进未读候选；不能五次重复前三个无关页面后就耗尽机会。
      for(const url of [...urls.filter(u=>!previous.has(normUrl(u))),...urls.filter(u=>previous.has(normUrl(u)))]) {
        if(!officialTier(url,job.platform,job.sources)||seen.has(normUrl(url)))continue;
        seen.add(normUrl(url));candidates.push(url);if(candidates.length>=3)break;
      }
      for(const url of candidates) {
        if(!options.canContinue()||Date.now()>=deadlineAt)throw new DeferError('本輪官方复核达到时间或模型预算上限');
        let page:Awaited<ReturnType<typeof fetchPage>>;
        try { page=await fetchPage(url,{timeoutMs:10000,tries:1,minimumTextLength:120}); }
        catch(error){failures.push(`正文不可读：${url}`);continue;}
        const tier=officialTier(page.finalUrl,job.platform,job.sources);
        if(!tier || (page.via==='jina'&&!page.sourceVerified)){failures.push(`来源无法确认：${url}`);continue;}
        readable++;
        const result=await extract(job.platform.name,page.finalUrl,page.text.slice(0,22000),options.log,{allowPaid:options.allowPaid,deadlineAt,evidenceText:page.text,platformIds:[job.platform.id],budget:modelBudget,corrections,
          verificationTarget:JSON.stringify({title:job.offer.title,valueText:job.offer.valueText,type:job.offer.type,tags:job.offer.tags,claimMethod:job.offer.claimMethod,originUrl:job.offer.evidence.url,claimStart:job.offer.claimStart,claimEnd:job.offer.claimEnd})});
        options.account(result.tokens,result.costCny);
        if(result.offers.length!==1){failures.push(`未唯一匹配同一活动：${url}`);continue;}
        const next=result.offers[0];
        const mismatch=officialActivityMismatch(job.offer,next);
        if(mismatch){failures.push(mismatch+'：'+url);continue;}
        if(next.platformId && next.platformId!==job.platform.id){failures.push(`发放方归属需人工确认：${url}`);continue;}
        if(!next.excerpts.benefit || next.excerpts.benefit.trim().length<12){failures.push(`缺少充分权益原文：${url}`);continue;}
        const draft=toOffer({id:job.offer.sourceId??'',platformId:job.platform.id,kind:job.offer.firstChannel??'media',tier} as Source,
          {...next,fixedId:job.offer.id},page.finalUrl,relevantText(page.text),page);
        const candidate=offerIn.safeParse({...draft,officialReviewJobId:job.jobId});
        if(!candidate.success){failures.push(`官方抽取字段未通过校验：${url}`);continue;}
        if(job.stageEvidence){const staged=await api<{staged:boolean;changedFields:string[]}>(`/official-reviews/${queued.id}/draft`,{jobId:job.jobId,candidate:candidate.data});if(staged.staged){chosenUrl=page.finalUrl;changedFields=staged.changedFields;matched=true;break;}}
        const saved=await postIdentityOffers([candidate.data]);
        const record=saved.results.find(r=>r.id===job.offer.id);
        if(!record||record.error||record.skipped){failures.push(`条目更新未应用：${record?.error??record?.skipped??'ID变化'}`);continue;}
        chosenUrl=page.finalUrl;changedFields=record.changed??[];matched=true;break;
      }
    } catch(error) {
      failure=true; failures.push((error as Error).message.slice(0,180));
      stop=error instanceof BudgetExhaustedError||error instanceof BudgetLedgerError||error instanceof DeferError||/搜索服务/.test((error as Error).message);
    }
    if(!matched && candidates.length && !readable)failure=true;
    const result=await api<{status:string}>(`/official-reviews/${queued.id}/result`,{jobId:job.jobId,status:matched?'matched':failure?'failed':'unresolved',
      reason:matched?'已读取发放方原文，AI按同一活动重新抽取；保持待审，需管理员确认'+(searchLimited?'（部分搜索受限，使用已知或已返回候选）':''):(failures.join('；')||'本轮搜索范围内未找到能支持此活动的官方原文').slice(0,500),queries,candidates:[...new Set([...(job.previousCandidates??[]),...candidates])].slice(-10),chosenUrl,changedFields});
    if(result.status==='matched')stats.matched++;else if(result.status==='failed')stats.failed++;else stats.unresolved++;
    options.log(`  官方复核 ${queued.id}：${result.status}`);
    if(stop){if(index+1<jobs.length)stats.deferred+=jobs.length-index-1;break;}
  }
  return stats;
}
