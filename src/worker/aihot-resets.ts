import {Hono} from 'hono';
import {aiHotEventSchema,aiHotResetInput,buildAiHotReset,AIHOT_RESET_SOURCE,AIHOT_RESET_URL,AIHOT_RESET_ACTOR,type AiHotResetInput} from '../shared/aihot-reset';
import {officialStatusKey} from '../shared/dedupe';
import {withMembershipFacts} from '../shared/identity/membership';
import {formatMembership,type MembershipRequirement} from '../shared/membership';
import {sha256,stableJson} from '../shared/identity/normalize';
import type {Env} from './index';
import {IdentityStore,IdentityError} from './identity/store';
import {IdentityService} from './identity/service';
import {verifyFetchProvenance} from './identity/fetch-provenance';
import {IdentityQueryBudgetError} from './identity/budget';
import {aggregateIdentityLead} from './identity/leads';
import {readMembershipCatalog} from './membership';
interface Result {outcome:string;candidateId?:string;offerId?:string;reason?:string}
async function requirePolicy(env:Env){
 const source=await env.DB.prepare('SELECT kind,url,enabled,auto_publish FROM sources WHERE id=?').bind(AIHOT_RESET_SOURCE).first<{kind:string;url:string;enabled:number;auto_publish:number}>();
 if(!source?.enabled||!source.auto_publish||source.kind!=='aihot'||source.url!==AIHOT_RESET_URL)throw new IdentityError(409,'AIHOT Codex reset 自动上架未启用');
 if(env.IDENTITY_MODE!=='enforce'||!(env.IDENTITY_CANARY_PLATFORMS??'').split(',').some(p=>['*','openai'].includes(p.trim())))throw new IdentityError(409,'OpenAI 身份去重未启用');
}
async function peers(env:Env,url:string,eventDay:string,exclude=''){
 const rows=await env.DB.prepare("SELECT id,review_state,evidence FROM offers WHERE platform_id='openai' AND tags LIKE '%reset%' AND id<>? AND (claim_start=? OR json_extract(evidence,'$.url')=?) LIMIT 41").bind(exclude,eventDay,url).all<{id:string;review_state:string;evidence:string}>();
 const exact=rows.results.find(p=>officialStatusKey(JSON.parse(p.evidence).url)===officialStatusKey(url));
 return {exact,ambiguous:rows.results.length>0};
}
export async function prepareAiHotReset(env:Env,raw:AiHotResetInput):Promise<Result>{
 await requirePolicy(env);const input=aiHotResetInput.parse(raw),offer=buildAiHotReset(input);
 const proof=await verifyFetchProvenance(input.sourceFetch,input.url,input.url,input.sourceText);
 if(!proof.valid||!proof.direct||input.sourceFetch.method!=='first_party_embed')throw new IdentityError(400,'官方原帖抓取证明无效');
 const lead=await env.DB.prepare("SELECT id,status,resolution FROM leads WHERE url=? AND origin='aihot'").bind(input.url).first<{id:number;status:string;resolution:string|null}>();
 if(!lead||lead.status==='rejected')throw new IdentityError(409,'没有可处理的 AIHOT 线索，或线索已有拒绝决定');
 const existing=await env.DB.prepare("SELECT c.id,o.id offerId,o.review_state FROM intake_candidates c LEFT JOIN benefit_entities e ON e.id=c.entity_id LEFT JOIN offers o ON o.id=e.canonical_offer_id WHERE c.extraction_version='aihot-codex-reset-v1' AND json_extract(c.raw_candidate_json,'$.candidate.id')=? AND json_extract(c.raw_candidate_json,'$.candidate.sourceId')=? LIMIT 1").bind(offer.id,AIHOT_RESET_SOURCE).first<{id:string;offerId:string|null;review_state:string|null}>();
 if(existing){if(existing.review_state==='approved'&&lead.status!=='linked')await aggregateIdentityLead(env.DB,lead.id,false,{preserveRejected:true});return {outcome:existing.review_state==='approved'?'published':'resume',candidateId:existing.id,...(existing.offerId?{offerId:existing.offerId}:{})};}
 const prior=await peers(env,input.url,offer.claimStart!);
 if(prior.exact){
  if(prior.exact.review_state==='approved'){
   // An exact official URL is sufficient to associate this new discovery without changing reviewed fields.
   const old=lead.resolution?JSON.parse(lead.resolution):null;
   if(old?.identityTaskIds?.length)return {outcome:'manual',reason:'线索仍有独立身份任务，不能整体覆盖'};
   if(lead.status!=='linked'){const resolution={status:'linked',jobId:'aihot-reset-known:'+lead.id,attempts:0,inconclusive:0,checkedAt:input.capturedAt,nextAttemptAt:null,reason:'AIHOT 员工原帖与已上架重置证据相同',queries:[],candidates:[],offerIds:[prior.exact.id],originOfferIds:[prior.exact.id]};await env.DB.prepare("UPDATE leads SET status='linked',offer_id=?,resolution=? WHERE id=? AND status=? AND coalesce(resolution,'')=coalesce(?, '')").bind(prior.exact.id,JSON.stringify(resolution),lead.id,lead.status,lead.resolution).run();}
   return {outcome:'published',offerId:prior.exact.id};
  }
  return {outcome:'manual',reason:'同原帖已有未批准记录，沿用既有审核决定'};
 }
 if(prior.ambiguous)return {outcome:'manual',reason:'同日已有重置，需区分同轮次进度与独立发放'};
 // The recurring policy authorizes only facts that this official announcement states explicitly.
 const paid=/\bpaid\s+(?:accounts|users|subscribers|subscriptions)\b/i.test(input.sourceText);
 const planClauses=input.sourceText.split(/[.!?;\n]/).filter(clause=>/\b(?:subscribers?|users?|accounts?|members?|plans?|only|for|ChatGPT)\b/i.test(clause)).join('\n');
 const named=[...planClauses.matchAll(/\b(?:ChatGPT\s+)?(Plus|Pro(?:\s?(?:100|200|500))?|Go|Business(?:\s+Premium)?|Enterprise|Edu)\b/gi)].filter(m=>m[1].toLowerCase()!=='go'||/^ChatGPT\s+Go/i.test(m[0])||/^\s+(?:users?|subscribers?|accounts?|members?|plans?)\b/i.test(planClauses.slice(m.index!+m[0].length))||/\b(?:for|only|on)\s*$/i.test(planClauses.slice(Math.max(0,m.index!-20),m.index))).map(m=>m[1].replaceAll(' ','').toLowerCase());
 // "Only" restricts eligibility when its clause names who is eligible; "it only takes 15 mins" (Day 17) does not.
 const onlyAudience=/\bonly\b[^.!?;\n]*\b(?:users?|subscribers?|accounts?|members?|plans?|tiers?)\b|\b(?:users?|subscribers?|accounts?|members?|plans?|tiers?)\b[^.!?;\n]*\bonly\b/i.test(input.sourceText);
 if(/(?:selected|some|certain|eligible)\s+(?:accounts|users|subscribers)|(?:accounts|users|reset).{0,35}(?:except|excluding)/i.test(input.sourceText)||onlyAudience&&!paid&&!named.length)return {outcome:'manual',reason:'原帖含尚未结构化的资格限制'};
 if(paid||named.length){
  const catalog=await readMembershipCatalog(env.DB),product=catalog.products.find(p=>p.name==='ChatGPT'&&p.status==='verified');
  if(!product)return {outcome:'manual',reason:'付费账号资格尚无已核实的 ChatGPT 会员目录'};
  const broad=paid&&(!named.length||/\b(?:including|such as)\b/i.test(input.sourceText));
  const plans=catalog.plans.filter(p=>p.productId===product.id&&p.status==='verified'&&p.billing==='paid');
  const match=(wanted:string,p:typeof plans[number])=>[p.name,...p.aliases].some(name=>{const key=name.replace(/^ChatGPT\s*/i,'').replaceAll(' ','').toLowerCase();return key===wanted||wanted==='pro'&&/^pro(?:100|200|500)?$/.test(key);});
  if(!broad&&named.some(name=>!plans.some(p=>match(name,p))))return {outcome:'manual',reason:'原帖具体套餐没有已核实的会员目录'};
  const selected=plans.filter(p=>named.some(name=>match(name,p))).map(p=>p.id);
  const membership:MembershipRequirement={schemaVersion:'membership-v1',status:'confirmed',catalogRevision:catalog.revision,anyOf:[{allOf:[{productId:product.id,scope:broad?'any_paid':'plans',planIds:broad?[]:selected,excludePlanIds:[]}]}],evidenceUrls:[input.url]};
  offer.membershipRequirement=membership;offer.requirements.push('member:'+formatMembership(membership,catalog));offer.identityFacts=withMembershipFacts(offer.identityFacts!,membership,['benefit']);
 }

 const store=new IdentityStore(env.DB),request='aihot-reset:'+await sha256(stableJson(input));
 const obs=await store.recordObservation({requestId:request,originalUrl:input.url,finalUrl:input.url,text:input.sourceText,fetchKind:'direct',issuerProductId:'openai',observedAt:input.capturedAt,truncated:false,fetchEvidence:input.sourceFetch});
 const trust=await env.DB.prepare('SELECT trust_json FROM source_observations WHERE id=?').bind(obs.observationId).first<{trust_json:string}>();
 if(!trust||JSON.parse(trust.trust_json).sourceVerified!==true||JSON.parse(trust.trust_json).productId!=='openai')throw new IdentityError(400,'原帖不是 OpenAI 已登记的官方或员工来源');
 const quote=offer.evidence.excerpts.benefit!,start=input.sourceText.indexOf(quote);
 if(start<0)throw new IdentityError(400,'原文摘录未绑定');
 offer.leadId=lead.id;
 const receipts=await store.recordCandidates({requestId:request+':candidate',observationId:obs.observationId,sourceFetchId:obs.fetchId,extractionVersion:'aihot-codex-reset-v1',extractionComplete:true,leadIds:[lead.id],candidates:[{inputId:offer.id,span:{start,end:start+quote.length,quote},quotes:[{id:'benefit',start,end:start+quote.length,quote},{id:'publication',start:input.sourceText.indexOf(input.sourceText.split('\n')[1]),end:input.sourceText.indexOf(input.sourceText.split('\n')[1])+input.sourceText.split('\n')[1].length,quote:input.sourceText.split('\n')[1]}],facts:offer.identityFacts!,rawCandidate:{...offer,...(input.aihotEvent?{_aihotEvent:input.aihotEvent}:{})}}]});
 return {outcome:'received',candidateId:receipts[0].candidateId};
}
export async function advanceAiHotReset(env:Env,candidateId:string):Promise<Result>{
 await requirePolicy(env);
 const manual=async(reason:string):Promise<Result>=>{await env.DB.prepare('UPDATE intake_candidates SET last_error=? WHERE id=?').bind('aihot-policy-manual:'+reason,candidateId).run();return {outcome:'manual',candidateId,reason};};
 const row=await env.DB.prepare("SELECT c.*,o.text,o.final_url,coalesce(f.provenance_json,o.fetch_provenance_json) provenance FROM intake_candidates c JOIN source_observations o ON o.id=c.observation_id LEFT JOIN source_observation_fetches f ON f.id=c.source_fetch_id WHERE c.id=? AND c.extraction_version='aihot-codex-reset-v1'").bind(candidateId).first<any>();
 if(!row)throw new IdentityError(404,'没有此 AIHOT 重置候选');
 const display=JSON.parse(row.raw_candidate_json).candidate;
 // The AIHOT event the candidate was admitted with is stored beside it, so resumption re-checks the same reading.
 const aihotEvent=display._aihotEvent===undefined?undefined:aiHotEventSchema.parse(display._aihotEvent);
 const expected=buildAiHotReset({url:row.final_url,sourceText:row.text,sourceFetch:display.sourceFetch,capturedAt:display.evidence.capturedAt,aihotEvent});
 const basis=aihotEvent?'AIHOT 事件类型、状态、时间与中文备注判定为独立重置，员工原帖已绑定作者与时间':'员工原帖判定为独立重置';
 if(display.id!==expected.id||display.sourceId!==AIHOT_RESET_SOURCE||JSON.parse(row.provenance).sourceVerified!==true||JSON.parse(row.provenance).productId!=='openai')throw new IdentityError(409,'候选不属于授权自动上架范围');
 const lead=await env.DB.prepare("SELECT id,status,resolution FROM leads WHERE id=? AND origin='aihot'").bind(display.leadId??0).first<{id:number;status:string;resolution:string|null}>();
 if(!lead||lead.status==='rejected')return manual('原线索已由管理员关闭');
 const service=new IdentityService(env.DB);
 const offer=row.entity_id?await env.DB.prepare('SELECT o.id,o.review_state,o.withdrawn_at,e.publication_revision FROM benefit_entities e JOIN offers o ON o.id=e.canonical_offer_id WHERE e.id=?').bind(row.entity_id).first<any>():null;
 if(offer?.review_state==='approved'&&!offer.withdrawn_at){
  if(display.leadId)await aggregateIdentityLead(env.DB,display.leadId,false,{preserveRejected:true});
  return {outcome:'published',candidateId,offerId:offer.id};
 }
 if(offer?.publication_revision||row.state==='resolved_rejected')return manual('已有人工作出的历史或可见性决定');
 const task=row.task_id?await env.DB.prepare('SELECT * FROM review_tasks WHERE id=?').bind(row.task_id).first<any>():null;
 if(task&&task.kind==='identity'&&['open','manual'].includes(task.state)){
  if(task.material_revision!==1)return manual('身份卡已有多来源或人工变更');
  const other=await peers(env,expected.evidence.url,expected.claimStart!,offer?.id);
  if(other.ambiguous)return manual('同日已有重置记录，保留身份核对');
  const receipt=await service.resolveIdentityTask(task.id,{requestId:`aihot-reset-new:${candidateId}:${task.revision}`,expectedRevision:task.revision,action:'new',candidateId,facts:JSON.parse(row.facts_json),reason:`管理员授权 AIHOT Codex reset 自动发布：${basis}；同日无其他重置，保留既有拒绝与人工决定。`,actor:AIHOT_RESET_ACTOR});
  return {outcome:receipt.outcome==='created_pending'?'pending_initial':receipt.outcome,candidateId,offerId:receipt.canonicalOfferId??undefined};
 }
 if(task?.kind==='initial'&&offer&&['open','manual'].includes(task.state)){
  if((await peers(env,expected.evidence.url,expected.claimStart!,offer.id)).ambiguous)return manual('出现同日重置，需核对轮次');
  const edit=await env.DB.prepare("SELECT 1 FROM offer_revisions WHERE offer_id=? AND author='admin' LIMIT 1").bind(offer.id).first();
  if(edit||task.material_revision!==1)return manual('审核草稿已有人工修改');
  await service.decideTask(task.id,{requestId:`aihot-reset-approve:${candidateId}:${task.revision}`,expectedRevision:task.revision,action:'approve',actor:AIHOT_RESET_ACTOR,role:'admin',reason:`按管理员2026-10-18授权（2026-10-22 起以 AIHOT 判定）自动上架 AIHOT Codex 独立重置事件；${basis}，身份、字段和历史拒绝守卫通过。`},{sql:"EXISTS(SELECT 1 FROM leads WHERE id=? AND status=? AND coalesce(resolution,'')=coalesce(?,'')) AND EXISTS(SELECT 1 FROM sources WHERE id=? AND enabled=1 AND auto_publish=1)",args:[lead.id,lead.status,lead.resolution,AIHOT_RESET_SOURCE]});
  return {outcome:'approved',candidateId,offerId:offer.id};
 }
 if(task&&['resolved','cancelled'].includes(task.state))return manual('审核已有结案决定');
 const receipt=await service.resolveCandidate(candidateId,'aihot-reset-resolve:'+candidateId);
 return {outcome:receipt.outcome==='created_pending'?'pending_initial':receipt.outcome,candidateId,offerId:receipt.canonicalOfferId??undefined};
}
export async function pendingAiHotResets(env:Env){
 await requirePolicy(env);
 const candidates=await env.DB.prepare("SELECT c.id candidateId FROM intake_candidates c JOIN leads l ON l.id=json_extract(c.raw_candidate_json,'$.candidate.leadId') LEFT JOIN review_tasks t ON t.id=c.task_id LEFT JOIN benefit_entities e ON e.id=c.entity_id LEFT JOIN offers o ON o.id=e.canonical_offer_id WHERE c.extraction_version='aihot-codex-reset-v1' AND l.status<>'rejected' AND c.state IN ('received','deferred','pending_identity','pending_initial') AND coalesce(c.last_error,'') NOT LIKE 'aihot-policy-manual:%' AND ((o.review_state='approved' AND (l.status<>'linked' OR l.offer_id IS NOT o.id)) OR (coalesce(o.review_state,'')<>'approved' AND (t.id IS NULL OR t.state IN ('open','manual')))) ORDER BY c.rowid LIMIT 4").all<{candidateId:string}>();
 return {candidates:candidates.results};
}
export const aiHotResetRoutes=new Hono<{Bindings:Env}>();
aiHotResetRoutes.onError((e,c)=>e instanceof IdentityQueryBudgetError?c.json({outcome:'retry',reason:'按请求预算续传'},202):e instanceof IdentityError?c.json({error:e.message},e.status):c.json({error:e.message},400));
aiHotResetRoutes.get('/pending',async c=>c.json(await pendingAiHotResets(c.env)));
aiHotResetRoutes.post('/',async c=>c.json(await prepareAiHotReset(c.env,aiHotResetInput.parse(await c.req.json()))));
aiHotResetRoutes.post('/:candidateId/advance',async c=>c.json(await advanceAiHotReset(c.env,c.req.param('candidateId'))));
