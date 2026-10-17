import {publicationError} from './publication';
import {liveStatus} from '../shared/lifecycle';
import {offerIn} from '../shared/ingest';
import {computeCollectedValuation,protectedValuationFields} from '../shared/valuation-intake';
import {officialActivityMismatch} from '../shared/official-review';
import {canonicalTermsSchema} from '../shared/identity/types';
import {hasKnownTerms} from './identity/reviewed-legacy';
import {sha256,stableJson} from '../shared/identity/normalize';
import {MutationBuilder,commitIdentityMutation,readIdentityReceipt} from './identity/commit';
import {IdentityStore,IdentityError} from './identity/store';
import {needsEvidence} from '../shared/review-preparation';
import {canonicalOffers} from './identity/canonical';
import { Hono } from 'hono';
import { drizzle } from 'drizzle-orm/d1';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import * as s from '../db/schema';
import { leadPriority } from '../shared/leads';
import { claimEndAt } from '../shared/lifecycle';
import { officialTier, officialReviewDue, OFFICIAL_REVIEW_LEASE_MS, type OfficialReview } from '../shared/official-review';
import type { Env } from './index';
import { readUrgentReviews, urgentFirst } from './screening/urgent-review';
const db=(env:Env)=>drizzle(env.DB,{schema:s});
export const officialReviewRoutes=new Hono<{Bindings:Env}>();
async function context(env:Env,id:string) {
  const d=db(env),[offer]=await d.select().from(s.offers).where(and(eq(s.offers.id,id),canonicalOffers));
  if(!offer)return null;
  const [proposal]=await d.select().from(s.offerProposals).where(eq(s.offerProposals.offerId,id));
  let target=proposal?{...offer,...proposal.candidate} as typeof offer:offer;
  const draft=await env.DB.prepare("SELECT t.id,t.revision,t.material_revision,t.entity_id,t.version_id,t.suggestion_json,v.facts_json,v.display_candidate_json FROM review_tasks t JOIN benefit_entities e ON e.id=t.entity_id JOIN benefit_versions v ON v.id=t.version_id AND v.entity_id=e.id WHERE e.canonical_offer_id=? AND e.state='active' AND e.current_approved_version_id IS NULL AND t.kind='initial' AND t.state IN ('open','manual') LIMIT 2").bind(id).all<{id:string;revision:number;material_revision:number;entity_id:string;version_id:string;suggestion_json:string|null;facts_json:string;display_candidate_json:string}>();
  const evidenceDraft=offer.reviewState==='pending'&&!proposal&&draft.results.length===1&&!hasKnownTerms(canonicalTermsSchema.parse(JSON.parse(draft.results[0].facts_json)))?draft.results[0]:null;
  if(evidenceDraft)target={...offer,...JSON.parse(evidenceDraft.display_candidate_json),...(evidenceDraft.suggestion_json&&JSON.parse(evidenceDraft.suggestion_json).kind==='official_evidence'?{verifyResult:null}:{})};
  const [platform]=await d.select().from(s.platforms).where(eq(s.platforms.id,target.platformId));
  const sources=await d.select({url:s.sources.url,tier:s.sources.tier}).from(s.sources).where(eq(s.sources.platformId,target.platformId));
  const identity=await env.DB.prepare('SELECT business_revision FROM benefit_entities WHERE canonical_offer_id=?').bind(offer.id).first<{business_revision:number}>();
  return {offer,target,platform,sources,evidenceDraft,identityRevision:identity?.business_revision,version:`${offer.updatedAt}|${proposal?.updatedAt??''}`,eligible:!offer.withdrawnAt&&!!platform&&platform.status==='approved'&&needsEvidence(target)&&(offer.reviewState==='pending'||(offer.reviewState==='approved'&&!!proposal))};
}
const proposalVersion = (id:string, version?:string) => version
  ? sql`EXISTS (SELECT 1 FROM offer_proposals WHERE offer_id=${id} AND updated_at=${version})`
  : sql`NOT EXISTS (SELECT 1 FROM offer_proposals WHERE offer_id=${id})`;
officialReviewRoutes.get('/queue',async c=>{
  const d=db(c.env),limit=Math.max(1,Math.min(20,Number(c.req.query('limit'))||8)),now=Date.now();
  const urgency = new Map((await readUrgentReviews(c.env.DB,new Date(now))).filter(r=>r.offerId).map(r=>[r.offerId!,r]));
  const approved=new Set((await d.select({id:s.platforms.id}).from(s.platforms).where(eq(s.platforms.status,'approved'))).map(p=>p.id));
  const rows=await d.select().from(s.offers).where(and(inArray(s.offers.reviewState,['pending','approved']),canonicalOffers));
  const proposals=await d.select().from(s.offerProposals),byId=new Map(proposals.map(p=>[p.offerId,p]));
  const draftRows=(await c.env.DB.prepare("SELECT e.canonical_offer_id,t.suggestion_json,v.display_candidate_json FROM benefit_entities e JOIN review_tasks t ON t.entity_id=e.id JOIN benefit_versions v ON v.id=t.version_id AND v.entity_id=e.id WHERE e.state='active' AND e.current_approved_version_id IS NULL AND t.kind='initial' AND t.state IN ('open','manual')").all<{canonical_offer_id:string;suggestion_json:string|null;display_candidate_json:string}>()).results;
  const drafts=new Map(draftRows.map(r=>[r.canonical_offer_id,{...JSON.parse(r.display_candidate_json),...(r.suggestion_json&&JSON.parse(r.suggestion_json).kind==='official_evidence'?{verifyResult:null}:{})}]));
  const candidates=rows.map(o=>{
    const p=byId.get(o.id),target=p?{...o,...p.candidate} as typeof o:drafts.has(o.id)?{...o,...drafts.get(o.id)}:o;
    const recovery=o.officialReview?.status==='checking'&&now-Date.parse(o.officialReview.checkedAt)>=OFFICIAL_REVIEW_LEASE_MS&&!needsEvidence(target);
    return {o,target,recovery,eligible:!o.withdrawnAt&&(recovery||(approved.has(target.platformId)&&needsEvidence(target)&&(o.reviewState==='pending'||!!p)&&officialReviewDue(o.officialReview,now,`${o.updatedAt}|${p?.updatedAt??''}`)))};
  }).filter(x=>x.eligible&&(x.recovery||!urgency.get(x.o.id)?.expired));
  const rank=(x:typeof candidates[number])=>{
    if(x.recovery)return -1;
    const end=claimEndAt(x.target)?.getTime();
    return end!=null&&end>=now&&end-now<48*3600_000?0:1+leadPriority({id:0,origin:'aihot',title:x.target.title,raw:x.target.valueText});
  };
  candidates.sort((a,b)=>{const ua=urgency.get(a.o.id),ub=urgency.get(b.o.id);return Number(b.recovery)-Number(a.recovery)||(ua&&ub?urgentFirst(ua,ub):0)||rank(a)-rank(b)||(a.o.officialReview?.attempts??0)-(b.o.officialReview?.attempts??0)||a.o.discoveredAt.localeCompare(b.o.discoveredAt);});
  const selected=candidates.slice(0,limit);
  // 与初抽一样保留积压名额，持续到来的重置/赠额不能饿死旧草稿。
  if(limit>=5&&candidates.length>limit){
    const oldest=[...candidates].sort((a,b)=>a.o.discoveredAt.localeCompare(b.o.discoveredAt))[0];
    if(!selected.includes(oldest))selected[selected.length-1]=oldest;
  }
  return c.json({jobs:selected.map(x=>({id:x.o.id,title:x.target.title,recovery:x.recovery})),remaining:candidates.length});
});
officialReviewRoutes.post('/:id/claim',async c=>{
  const state=await context(c.env,c.req.param('id')),now=Date.now();
  if(!state)return c.json({claimed:false});
  const old=state.offer.officialReview;
  const expected=old?JSON.stringify(old):null;
  const guard=and(eq(s.offers.id,state.offer.id),eq(s.offers.updatedAt,state.offer.updatedAt),proposalVersion(state.offer.id,state.version.split('|')[1]||undefined),sql`COALESCE(${s.offers.officialReview},'')=COALESCE(${expected},'')`);
  // 业务写入已成功、结果回执丢失：结束过期占位并清楚交给管理员，不凭状态推断再次验证成功。
  if(old?.status==='checking'&&now-Date.parse(old.checkedAt)>=OFFICIAL_REVIEW_LEASE_MS&&!needsEvidence(state.target)){
    const changed=await db(c.env).update(s.offers).set({officialReview:{...old,status:'unresolved',inputVersion:state.version,checkedAt:new Date(now).toISOString(),nextAttemptAt:null,reason:'上次任务回执中断；条目已有官方证据，保留当前内容，请管理员核对后审核'}}).where(guard).returning({id:s.offers.id});
    return c.json({claimed:false,recovered:changed.length>0});
  }
  if(!state.eligible || !officialReviewDue(old,now,state.version))return c.json({claimed:false});
  if((await readUrgentReviews(c.env.DB,new Date(now))).find(r=>r.offerId===state.offer.id)?.expired)return c.json({claimed:false});
  const review:OfficialReview={identityRevision:state.identityRevision,status:'checking',jobId:crypto.randomUUID(),inputVersion:state.version,originUrl:state.target.evidence.url,attempts:(state.offer.officialReview && state.offer.officialReview.inputVersion===state.version ? state.offer.officialReview.attempts : 0)+1,checkedAt:new Date(now).toISOString(),nextAttemptAt:null,reason:'正在搜索官方出处并核对原文',queries:[],candidates:[]};
  review.unresolvedAttempts=old?.inputVersion===state.version?(old.unresolvedAttempts??(old.status==='unresolved'?old.attempts:0)):0;
  const changed=await db(c.env).update(s.offers).set({officialReview:review}).where(guard).returning({id:s.offers.id});
  return c.json(changed.length?{claimed:true,jobId:review.jobId,stageEvidence:!!state.evidenceDraft,previousCandidates:old?.inputVersion===state.version?old.candidates:[],offer:state.target,platform:state.platform,sources:state.sources}:{claimed:false});
});
officialReviewRoutes.post('/:id/result',async c=>{
  const parsed=z.object({jobId:z.string().uuid(),status:z.enum(['matched','unresolved','failed']),reason:z.string().max(500),queries:z.array(z.string().max(350)).max(4),candidates:z.array(z.url()).max(10),chosenUrl:z.url().optional(),changedFields:z.array(z.string().max(60)).max(35)}).safeParse(await c.req.json().catch(()=>null));
  if(!parsed.success)return c.json({error:'官方复核结果格式不正确'},400);
  const state=await context(c.env,c.req.param('id'));
  if(!state||state.offer.officialReview?.jobId!==parsed.data.jobId)return c.json({error:'官方复核任务已失效'},409);
  if(state.offer.officialReview.status!=='checking')return c.json({ok:true,status:state.offer.officialReview.status,nextAttemptAt:state.offer.officialReview.nextAttemptAt});
  if(state.identityRevision!==undefined&&state.offer.officialReview.identityRevision!==state.identityRevision)return c.json({error:'身份版本已更新，旧官方复核结果已失效'},409);
  const old=state.offer.officialReview,now=Date.now();
  let {status,reason}=parsed.data;
  if(status==='matched'&&(!state.platform || state.target.evidence.url!==parsed.data.chosenUrl || needsEvidence(state.target) || !officialTier(state.target.evidence.url,state.platform,state.sources))) {
    status='unresolved';reason='已找到候选官方证据，但字段保护或状态变化使结果未应用，请管理员核对';
  }
  // 技术故障不等于证据不足：搜索/抓取服务恢复后仍可自动继续。
  const unresolvedAttempts=(old.unresolvedAttempts??0)+(status==='unresolved'?1:0);
  const end=claimEndAt(state.target)?.getTime();
  const delayHours=end!=null&&end>now&&end-now<48*3600_000?1:Math.min(24,2**Math.min(5,old.attempts-1));
  const retry=status==='matched'||(status==='unresolved'&&unresolvedAttempts>=5)?null:new Date(now+delayHours*3600_000).toISOString();
  const review:OfficialReview={...parsed.data,inputVersion:status==='matched'?state.version:old.inputVersion,originUrl:old.originUrl,status,reason,attempts:old.attempts,unresolvedAttempts,checkedAt:new Date(now).toISOString(),nextAttemptAt:retry};
  const changed=await db(c.env).update(s.offers).set({officialReview:review}).where(and(eq(s.offers.id,state.offer.id),eq(s.offers.updatedAt,state.offer.updatedAt),proposalVersion(state.offer.id,state.version.split('|')[1]||undefined),sql`json_extract(${s.offers.officialReview},'$.jobId')=${old.jobId}`,sql`json_extract(${s.offers.officialReview},'$.status')='checking'`)).returning({id:s.offers.id});
  return changed.length?c.json({ok:true,status,nextAttemptAt:retry}):c.json({error:'官方复核任务已更新'},409);
});

/** Provisional legacy draft enrichment, never a publication or identity merge. */
officialReviewRoutes.post('/:id/draft',async c=>{
 const parsed=z.object({jobId:z.string().uuid(),candidate:offerIn}).safeParse(await c.req.json().catch(()=>null));if(!parsed.success)return c.json({error:'invalid evidence supplement payload'},400);const input=parsed.data;
 const command='official-evidence:'+input.jobId,hash=await sha256(stableJson(input));
 const replay=await readIdentityReceipt(c.env.DB,command,hash);if(replay)return c.json(replay.status==='conflict'?{error:'evidence payload changed'}:replay.value,replay.status==='conflict'?409:200);
 const state=await context(c.env,c.req.param('id')),candidate=input.candidate;
 const computed=await computeCollectedValuation(candidate);candidate.valuation=computed.valuation;candidate.usdEstimate=computed.valuation?.usdEstimate??null;candidate.usdMax=computed.valuation?.usdMax??null;
 if(!state?.evidenceDraft||state.offer.withdrawnAt||state.offer.reviewState!=='pending'||!state.platform||state.platform.status!=='approved')return c.json({error:'only an active provisional pending draft can receive evidence'},409);
 const task=state.evidenceDraft,job=state.offer.officialReview;
 if(!job||job.status!=='checking'||job.jobId!==input.jobId||job.inputVersion!==state.version||job.identityRevision!==state.identityRevision)return c.json({error:'official review version changed'},409);
 const fetch=candidate.sourceFetch,text=candidate.sourceText;
 if(candidate.id!==state.offer.id||candidate.platformId!==state.offer.platformId||candidate.evidence.tier==='tested'||needsEvidence(candidate)||officialActivityMismatch(state.target,candidate)||!officialTier(candidate.evidence.url,state.platform,state.sources)||!fetch?.sourceVerified||fetch.truncated||fetch.finalUrl!==candidate.evidence.url||!text||await sha256(text)!==fetch.contentHash||Object.values(candidate.evidence.excerpts).some(q=>q&&!text.includes(q)))return c.json({error:'official evidence is incomplete, ungrounded or for another activity'},400);
 const edits=await c.env.DB.prepare("SELECT diff FROM offer_revisions WHERE offer_id=? AND author='admin' ORDER BY id LIMIT 1001").bind(state.offer.id).all<{diff:string}>();if(edits.results.length>1000)return c.json({error:'manual field history requires reconciliation'},409);
 const protectedFields=protectedValuationFields(state.target,edits.results.flatMap(r=>JSON.parse(r.diff).map((d:{field:string})=>d.field)));
 const {sourceText:_text,sourceFetch:_fetch,identityFacts:_facts,identityRequestId:_request,officialReviewJobId:_job,leadReviewJobId:_lead,valuationFactors:_recipe,valuationSources:_prices,...raw}=candidate;
 const display=offerIn.parse({...raw,...Object.fromEntries([...protectedFields].filter(k=>k in state.target).map(k=>[k,(state.target as Record<string,unknown>)[k]]))});
 if(needsEvidence(display))return c.json({error:'protected manual evidence cannot be replaced automatically'},409);
 const protectedChanges=[...protectedFields].filter(k=>k in state.target&&k in raw&&stableJson((state.target as Record<string,unknown>)[k])!==stableJson((raw as Record<string,unknown>)[k]));
 const issue=await publicationError(c.env,{...state.offer,...display,verifyResult:null});
 const verdict=issue||protectedChanges.length?'judge':liveStatus({...state.offer,...display})==='ended'?'history':'approve';
 const reason=issue?'建议暂缓收录：'+issue:protectedChanges.length?'建议人工核对：已保留 '+protectedChanges.length+' 项人工字段，补证候选与其不同。请对照官方原文，确认后再决定。':verdict==='history'?'建议作为历史收录：权益已经结束，官方依据已补齐；仍需你确认。':'建议通过当前草稿：已补齐官方权益及领取依据。请最后核对适用条件及是否为同一活动；尚未上架。';
 const observation=await new IdentityStore(c.env.DB).recordObservation({requestId:command,originalUrl:fetch.originalUrl,finalUrl:fetch.finalUrl,text,fetchKind:fetch.method==='jina'?'indirect':'direct',issuerProductId:display.platformId,observedAt:display.evidence.capturedAt,fetchEvidence:fetch});
 const builder=new MutationBuilder(c.env.DB,command,hash),revision=state.identityRevision!+1;
 builder.require("EXISTS(SELECT 1 FROM offers WHERE id=? AND review_state='pending' AND withdrawn_at IS NULL AND updated_at=? AND official_review=?)",[state.offer.id,state.offer.updatedAt,JSON.stringify(job)]);
 builder.require('NOT EXISTS(SELECT 1 FROM offer_proposals WHERE offer_id=?)',[state.offer.id]);
 builder.require("(SELECT count(*) FROM offer_revisions WHERE offer_id=? AND author='admin')=?",[state.offer.id,edits.results.length]);
 builder.update('benefit_versions',{display_candidate_json:JSON.stringify(display)},'id=? AND entity_id=?',[task.version_id,task.entity_id]);
 builder.update('review_tasks',{revision:task.revision+1,material_revision:task.material_revision+1,state:'manual',suggestion_json:JSON.stringify({kind:'official_evidence',jobId:input.jobId,observationId:observation.observationId,verdict,reason}),lease_token:null,lease_until:null},'id=?',[task.id]);
 builder.update('benefit_entities',{business_revision:revision},'id=?',[task.entity_id]);builder.acknowledgeOfficialJob(state.offer.id,JSON.stringify(job),revision);
 builder.insert('offer_revisions',{offer_id:state.offer.id,author:'pipeline',diff:JSON.stringify([{field:'pendingEvidenceDraft',from:JSON.parse(task.display_candidate_json),to:display}]),evidence_before:JSON.stringify(state.target.evidence),evidence_after:JSON.stringify(display.evidence)});
 const result=await commitIdentityMutation(c.env.DB,builder.plan([{kind:'task',id:task.id,revision:task.revision},{kind:'entity',id:task.entity_id,revision:state.identityRevision!}],{ok:true,staged:true,changedFields:['evidence'],taskId:task.id}));return c.json(result.status==='conflict'?{error:'review changed during evidence preparation'}:result.value,result.status==='conflict'?409:200);
});
