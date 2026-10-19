import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import * as s from '../db/schema';
import { canonicalOffers, resolveCanonicalOffer } from './identity/canonical';
import { readMembershipCatalog } from './membership';
import { quotaFailure, snapshotActive, snapshotResponse } from './public-snapshot';
import { agentSearchSchema, qualifyOffer, searchAgentOffers, type AgentOffer, type AgentSearch } from '../shared/agent-query';
import { liveStatus } from '../shared/lifecycle';
import { normalizeModelNames, MODEL_NAMES_VERSION } from '../shared/model-names';
import { publicSafeValuation, valuationMatchesAmounts } from '../shared/valuation';
import type { MembershipCatalog } from '../shared/membership';
import { readLatestDaily } from './daily';
import {readCollectionStatus} from './collection-status';
import {quotaCircuitOpen,tripQuotaCircuit} from './quota-circuit';
import type { Env } from './index';

const SITE='https://ai-yangmao.com';
export type AgentContext=Pick<ExecutionContext,'waitUntil'>;
export class AgentError extends Error { constructor(message:string,public status=400,public code=status===404?'not_found':status>=500?'temporarily_unavailable':'invalid_request'){super(message);} }
type Platform={id:string;name:string;type:string;site:string|null};
type Dataset={offers:AgentOffer[];platforms:Platform[];catalog:MembershipCatalog;degraded:boolean;snapshotAt:string|null;
  fetchedAt:string;lastSuccessfulCollect:string|null;lastCollectedAt:string|null;lastCollectionAttemptAt:string|null;coverageDegraded:boolean};
// Explicit projection is shared by normal reads and snapshot fallback; no internal spread.
function publicOffer(o:any,platform:string):AgentOffer {
  const valuation=publicSafeValuation(o.valuation);
  return {id:o.id,platformId:o.platformId,platform,title:o.title,type:o.type,valueText:o.valueText,
    usdEstimate:o.usdEstimate??null,usdMax:o.usdMax??null,valuation:valuation&&valuationMatchesAmounts(valuation,o)?valuation:null,
    modalities:o.modalities??[],models:normalizeModelNames(o.models),tags:o.tags??[],claimMethod:o.claimMethod,requirements:o.requirements??[],
    audience:o.audience,steps:o.steps??[],creditValidity:o.creditValidity??null,membershipRequirement:o.membershipRequirement??null,
    claimStart:o.claimStart??null,claimEnd:o.claimEnd??null,endKind:o.endKind,sourceTz:o.sourceTz,
    discoveredAt:o.discoveredAt,lastVerifiedAt:o.lastVerifiedAt??null,verifyResult:o.verifyResult??null,withdrawnAt:o.withdrawnAt??null,
    evidence:{tier:o.evidence.tier,url:o.evidence.url,excerpts:{benefit:o.evidence.excerpts?.benefit,eligibility:o.evidence.excerpts?.eligibility,claim:o.evidence.excerpts?.claim,validity:o.evidence.excerpts?.validity}},
    link:`${SITE}/#offer-${encodeURIComponent(o.id)}`};
}
async function snapshot(env:Env):Promise<Dataset>{
  const read=async(path:string)=>{const r=await snapshotResponse(new Request(SITE+path),env.ASSETS);if(!r?.ok)throw new AgentError('公开快照暂不可用，请稍后重试',503);return r.json() as Promise<any>;};
  const [offers,platforms]=await Promise.all([read('/api/offers?view=all'),read('/api/platforms')]);
  const list:Platform[]=platforms.platforms.map((p:any)=>({id:p.id,name:p.name,type:p.type,site:p.site??null}));
  return {offers:offers.offers.map((o:any)=>({...publicOffer(o,list.find(p=>p.id===o.platformId)?.name??o.platformId),sourceDegraded:true})),platforms:list,
    catalog:{revision:0,products:[],plans:[]},degraded:true,snapshotAt:offers.snapshotAt,fetchedAt:new Date().toISOString(),lastSuccessfulCollect:null,lastCollectedAt:null,lastCollectionAttemptAt:null,coverageDegraded:true};
}
const inFlight=new WeakMap<D1Database,Promise<Dataset>>();
export async function loadAgentDataset(env:Env,ctx?:AgentContext):Promise<Dataset>{
  const key=env.AGENT_READ_KEY??env.DB,existing=inFlight.get(key);if(existing)return existing;
  const pending=readDataset(env,ctx);inFlight.set(key,pending);
  try{return await pending;}finally{if(inFlight.get(key)===pending)inFlight.delete(key);}
}
async function readDataset(env:Env,ctx?:AgentContext):Promise<Dataset>{
  if(env.AGENT_FORCE_SNAPSHOT||snapshotActive(env.D1_PUBLIC_SNAPSHOT_UNTIL)||quotaCircuitOpen())return snapshot(env);
  const cache=typeof caches==='undefined'?null:(caches as CacheStorage&{default:Cache}).default;
  try {
    const state=await env.DB.prepare('SELECT generation FROM identity_public_state WHERE id=1').first<{generation:number}>();
    const key=new Request(`${SITE}/api/agent/__dataset?schema=agent-v2&models=${MODEL_NAMES_VERSION}&generation=${state?.generation??'none'}`);
    try{const hit=state?await cache?.match(key):null;if(hit)return await hit.json() as Dataset;}catch{/* Optional cache failures must not prevent a DB read. */}
    const d=drizzle(env.DB,{schema:s});
    const [platforms,rows,catalog,collection]=await Promise.all([
      d.select({id:s.platforms.id,name:s.platforms.name,type:s.platforms.type,site:s.platforms.site}).from(s.platforms).where(eq(s.platforms.status,'approved')),
      d.select().from(s.offers).where(and(eq(s.offers.reviewState,'approved'),canonicalOffers)),readMembershipCatalog(env.DB),
      readCollectionStatus(env.DB),
    ]);
    const names=new Map(platforms.map(p=>[p.id,p.name]));
    const data:Dataset={offers:rows.filter(o=>names.has(o.platformId)).map(o=>publicOffer(o,names.get(o.platformId)!)),platforms,
      catalog:{...catalog,products:catalog.products.filter(p=>p.status!=='pending'),plans:catalog.plans.filter(p=>p.status!=='pending'&&catalog.products.some(product=>product.id===p.productId&&product.status!=='pending'))},
      degraded:false,snapshotAt:null,fetchedAt:new Date().toISOString(),...collection};
    if(cache&&ctx&&state)ctx.waitUntil(cache.put(key,new Response(JSON.stringify(data),{headers:{'Content-Type':'application/json','Cache-Control':'public,max-age=60'}})).catch(()=>{}));
    return data;
  } catch(error){if(quotaFailure(error)){tripQuotaCircuit();return snapshot(env);}throw error;}
}
const metadata=(data:Dataset)=>({degraded:data.degraded,snapshotAt:data.snapshotAt,dataFetchedAt:data.fetchedAt,lastSuccessfulCollect:data.lastSuccessfulCollect,
  lastCollectedAt:data.lastCollectedAt,lastCollectionAttemptAt:data.lastCollectionAttemptAt,
  coverageDegraded:data.coverageDegraded,readOnly:true,warnings:data.degraded?['当前读取批准快照；资格和有效性需到官方页面再次确认，会员目录暂不可用。']:data.coverageDegraded?['最近采集覆盖不完整；仅代表已收录的权益。']:[]});
type Match=ReturnType<typeof searchAgentOffers>['offers'][number];
const clip=(text:string,max:number)=>text.length>max?text.slice(0,max)+'…':text;
function summary(o:Match){
  return {id:o.id,title:clip(o.title,200),platformId:o.platformId,platform:clip(o.platform,100),type:o.type,status:o.status,
    claimable:['active','ending','standing'].includes(o.status),valueText:clip(o.valueText,360),
    requirements:o.requirements.slice(0,6).map(r=>clip(r,120)),claimMethod:o.claimMethod,audience:o.audience,
    claimEnd:o.claimEnd,endKind:o.endKind,sourceTz:o.sourceTz,lastVerifiedAt:o.lastVerifiedAt,score:o.score,
    eligibility:{status:o.eligibility.status,reasons:o.eligibility.reasons.slice(0,6).map(r=>clip(r,120))},
    link:o.link,detailUrl:`${SITE}/api/agent/offers/${encodeURIComponent(o.id)}`,summary:true};
}
export async function agentSearch(env:Env,input:unknown,ctx?:AgentContext){
  const parsed=agentSearchSchema.safeParse(input);if(!parsed.success)throw new AgentError('筛选参数不正确：'+parsed.error.issues.map(i=>`${i.path.join('.')}: ${i.message}`).join('；'));
  const data=await loadAgentDataset(env,ctx),result=searchAgentOffers(data.offers,data.catalog,parsed.data);
  const offers:ReturnType<typeof summary>[]=[];let bytes=0;
  for(const match of result.offers){const item=summary(match),size=new TextEncoder().encode(JSON.stringify(item)).length;
    if(offers.length&&bytes+size>40*1024)break;offers.push(item);bytes+=size;}
  return {...metadata(data),total:result.total,counts:result.counts,offset:result.offset,limit:result.limit,
    nextOffset:result.offset+offers.length<result.total?result.offset+offers.length:null,pageLimitedBySize:offers.length<result.offers.length,
    offers,groups:{eligible:offers.filter(o=>o.eligibility.status==='eligible').map(o=>o.id),ineligible:offers.filter(o=>o.eligibility.status==='ineligible').map(o=>o.id),unknown:offers.filter(o=>o.eligibility.status==='unknown').map(o=>o.id)}};
}
export async function agentOffer(env:Env,id:string,profile?:AgentSearch['profile'],ctx?:AgentContext){
  const data=await loadAgentDataset(env,ctx);
  let offer=data.offers.find(o=>o.id===id);
  if(!offer&&!data.degraded){try{const route=await resolveCanonicalOffer(env.DB,id);offer=data.offers.find(o=>o.id===route.offerId);}catch(error){if(quotaFailure(error)){tripQuotaCircuit();throw new AgentError('条目身份查询暂不可用，请稍后重试',503);}if(!(error instanceof Error)||!('status'in error)||error.status!==404)throw error;}}
  if(!offer)throw new AgentError('没有这条公开羊毛；请先搜索获得完整 ID',404);
  const eligibility=qualifyOffer(offer,profile,data.catalog);
  if(data.degraded&&eligibility.status==='eligible'){eligibility.status='unknown';eligibility.reasons.push('只读快照中的资格待重新确认');}
  return {...metadata(data),offer:{...offer,status:liveStatus(offer),eligibility}};
}
export async function agentCatalog(env:Env,ctx?:AgentContext){const data=await loadAgentDataset(env,ctx);return {...metadata(data),platforms:data.platforms,
  models:[...new Set(data.offers.flatMap(o=>o.models))].sort(),memberships:data.catalog};}
export async function agentDaily(env:Env){
  if(env.AGENT_FORCE_SNAPSHOT||snapshotActive(env.D1_PUBLIC_SNAPSHOT_UNTIL)||quotaCircuitOpen())throw new AgentError('日报存储暂不可用，请稍后重试；查询不会生成新日报。',503,'data_unavailable');
  let report;try{report=await readLatestDaily(env);}catch(error){if(quotaFailure(error)){tripQuotaCircuit();throw new AgentError('日报存储额度暂不可用，请稍后重试',503,'data_unavailable');}throw error;}
  const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  return {readOnly:true,available:!!report,isToday:report?.day===today,report,message:!report?'暂无已生成的日报；查询不会触发生成或发送。':report.day===today?'最新日报':`当天尚未生成日报，以下为最近一期（${report.day}）。`};
}
export function agentMarkdown(result:any):string{
  if('report'in result)return `${result.message}\n\n${result.report?.markdown??''}\n\n日报是生成时的固定内容；领取前请查当前详情和官方页面。`;
  const warnings=(result.warnings??[]).map((s:string)=>`提示：${s}`).join('\n');
  if('platforms'in result)return warnings+'\n\n'+JSON.stringify(result,null,2);
  const offers=result.offer?[result.offer]:result.offers??[];
  return `${warnings}\n\n${result.total!==undefined?`匹配 ${result.total} 条，本页 ${offers.length} 条；下一页 offset=${result.nextOffset??'无'}。\n`:''}`+offers.map((o:any)=>{
    const e=o.eligibility;const base=`## [${o.title}](${o.link})\n${o.platform} · ${o.status} · 薅度 ${o.score??'—'}\n权益：${o.valueText}\n资格：${e.status==='eligible'?'符合条件':e.status==='ineligible'?'不符合条件':'资格还需确认'}${e.reasons.length?'（'+e.reasons.join('、')+'）':''}\n门槛：${o.requirements.join('、')}；适用：${o.audience}\n截止：${o.claimEnd??(o.endKind==='standing'?'长期':'官方未写明')}（${o.sourceTz}）\n核验：${o.lastVerifiedAt??'暂无记录'}`;
    if(o.summary)return base+`\n这是清单摘要；[完整资格、步骤与原文](${o.detailUrl})`;
    return base+`\n额度有效期：${o.creditValidity??'官方未写明'}\n领取：${o.steps.join('；')||o.claimMethod}\n[来源](${o.evidence.url})\n原语言摘录：${JSON.stringify(o.evidence.excerpts)}\n估值：${o.valuation?JSON.stringify(o.valuation):'暂无可靠价格，价值待定'}`;
  }).join('\n\n');
}
