import {officialTier} from '../../shared/official-review';
import {z} from 'zod';
import {offerIn} from '../../shared/ingest';
import {sourceFetchSchema} from '../../shared/identity/fetch-evidence';
import {canonicalTermsSchema} from '../../shared/identity/types';
import {sha256,stableJson,normalizeDocumentUrl} from '../../shared/identity/normalize';
import {taskSourcesCte} from './task-sources';
import {IdentityStore,IdentityError} from './store';
import {MutationBuilder,commitIdentityMutation,readIdentityReceipt} from './commit';

type Task={id:string;kind:string;state:string;revision:number;suggestion_json:string|null;lease_until:string|null};
type Source={id:string;revision:number;raw_candidate_json:string;facts_json:string;observation_id:string;trust_json:string;text_truncated:number;final_url?:string};
type Entry={entityId:string;revision:number;offerId:string|null;title:string;valueText:string;reviewState:string|null;sourceUrl:string|null;sameSource:boolean};
type Preparation={kind:'identity_preparation_v1';status:'scanning'|'ready'|'needs_source'|'history_unusable'|'source_unverifiable';productId:string|null;cursor:string|null;scanned:number;entries:Entry[];sourceObservationId:string|null;sourceOriginalObservationId?:string|null;sourceCandidateId?:string|null;sourceReverifications?:Array<{candidateId:string;originalObservationId:string;replacementObservationId:string;fetchId:string}>;sourceUrl:string|null;reason:string;nextAttemptAt:string|null;previousModelSuggestion?:unknown;modelResult?:unknown;manualHint?:{kind:'suspected_duplicate'|'previously_rejected';reason:string;actor:string;at:string}};
const empty=(status:Preparation['status'],reason:string,productId:string|null=null):Preparation=>({kind:'identity_preparation_v1',status,productId,cursor:null,scanned:0,entries:[],sourceObservationId:null,sourceUrl:null,reason,nextAttemptAt:null});
function readPreparation(value:string|null):Preparation|null{if(!value)return null;const raw=JSON.parse(value);return raw.kind==='identity_preparation_v1'?raw as Preparation:null;}
const sourceIsVerified=(source:{trust_json:string;text_truncated:number})=>{const trust=JSON.parse(source.trust_json);return trust.sourceVerified===true&&!source.text_truncated&&typeof trust.productId==='string';};
export function identityUrgency(rawCandidates:string[],factCandidates:string[]=[]){
 const now=Date.now();let earliest=Number.POSITIVE_INFINITY,deadline:string|null=null,hinted=false,expired=false;
 for(const [index,raw] of rawCandidates.entries()){const candidate=JSON.parse(raw).candidate??{},facts=factCandidates[index]?JSON.parse(factCandidates[index]):null;
  const structured=facts?.claimWindow?.state==='known'?facts.claimWindow.value?.endsAt:null;
  const date=typeof candidate.claimEnd==='string'?candidate.claimEnd:typeof structured==='string'?structured:null;
  const end=date?Date.parse(date+(date.length===10?'T23:59:59Z':'')):NaN;
  if(Number.isFinite(end)&&end>=now&&end<earliest){earliest=end;deadline=date;}
  if(Number.isFinite(end)&&end<now)expired=true;
  if(/限时|免费期|截止|体验卡|limited[ -]?time|deadline|expires?/i.test(String(candidate.title??'')))hinted=true;
 }
 const remaining=earliest-now;
 return {deadline,urgency:remaining<=3*86400_000?'imminent' as const:remaining<=7*86400_000?'time_limited' as const:deadline?'dated' as const:expired?'expired' as const:hinted?'time_limited' as const:null};
}
function evidenceRetryDelay(rawCandidates:string[],factCandidates:string[]){const urgency=identityUrgency(rawCandidates,factCandidates).urgency;return urgency==='imminent'?30*60_000:urgency==='time_limited'?60*60_000:6*60*60_000;}
export async function preparationQueue(db:D1Database,products:string[]){
 const now=new Date().toISOString(),selected=JSON.stringify(products);
 const eligible=`FROM review_tasks task WHERE kind IN ('identity','merge_conflict') AND (state IN ('open','manual') OR (state='checking' AND lease_until<?1)) AND EXISTS(SELECT 1 FROM task_candidates tc WHERE tc.task_id=task.id) AND NOT EXISTS(SELECT 1 FROM task_candidates tc JOIN intake_candidates c ON c.id=tc.candidate_id WHERE tc.task_id=task.id AND ((json_extract(c.raw_candidate_json,'$.candidate.platformId') IS NOT NULL AND NOT EXISTS(SELECT 1 FROM json_each(?2) choice WHERE choice.value='*' OR choice.value=json_extract(c.raw_candidate_json,'$.candidate.platformId'))) OR (json_extract(c.facts_json,'$.issuerProductId.state')='known' AND NOT EXISTS(SELECT 1 FROM json_each(?2) choice WHERE choice.value='*' OR choice.value=json_extract(c.facts_json,'$.issuerProductId.value'))))) AND (suggestion_json IS NULL OR json_extract(suggestion_json,'$.kind') IS NOT 'identity_preparation_v1' OR (json_extract(suggestion_json,'$.status') NOT IN ('ready','history_unusable') AND (json_extract(suggestion_json,'$.nextAttemptAt') IS NULL OR json_extract(suggestion_json,'$.nextAttemptAt')<=?1)))`;
 const source=`FROM task_candidates pt JOIN intake_candidates c ON c.id=pt.candidate_id WHERE pt.task_id=task.id`;
 const deadline=`coalesce(json_extract(c.raw_candidate_json,'$.candidate.claimEnd'),CASE WHEN json_extract(c.facts_json,'$.claimWindow.state')='known' THEN json_extract(c.facts_json,'$.claimWindow.value.endsAt') END)`;
 const days=`(julianday(${deadline})+CASE WHEN length(${deadline})=10 THEN 1 ELSE 0 END-julianday(?1))`;
 const hint=`(instr(json_extract(c.raw_candidate_json,'$.candidate.title'),'限时')>0 OR instr(json_extract(c.raw_candidate_json,'$.candidate.title'),'免费期')>0 OR instr(json_extract(c.raw_candidate_json,'$.candidate.title'),'截止')>0 OR instr(json_extract(c.raw_candidate_json,'$.candidate.title'),'体验卡')>0 OR lower(json_extract(c.raw_candidate_json,'$.candidate.title')) LIKE '%limited%')`;
 const priority=`CASE WHEN EXISTS(SELECT 1 ${source} AND ${days} BETWEEN 0 AND 3) THEN 0 WHEN EXISTS(SELECT 1 ${source} AND ${days} BETWEEN 0 AND 7) THEN 1 WHEN json_extract(task.suggestion_json,'$.manualHint.kind') IS NOT NULL THEN 2 WHEN EXISTS(SELECT 1 ${source} AND ${hint} AND (${deadline} IS NULL OR ${days}>=0)) THEN 3 WHEN EXISTS(SELECT 1 ${source} AND ${days}>7) THEN 4 ELSE 5 END`;
 const top=(await db.prepare(`SELECT id,revision ${eligible} ORDER BY ${priority},created_at,id LIMIT 4`).bind(now,selected).all<{id:string;revision:number}>()).results;
 const oldest=await db.prepare(`SELECT id,revision ${eligible} ORDER BY created_at,id LIMIT 1`).bind(now,selected).first<{id:string;revision:number}>();
 const tasks=oldest&&!top.slice(0,3).some(task=>task.id===oldest.id)?[...top.slice(0,3),oldest]:top;
 return {tasks};
}
/** Whether the system may fetch this source to verify it: an official address of an approved vendor. */
async function officialFetchable(db:D1Database,finalUrl:string,rawCandidate:string){
 const offer=offerIn.safeParse(JSON.parse(rawCandidate).candidate);const productId=offer.success?offer.data.platformId:null;
 const platform=productId?await db.prepare('SELECT id,name,site,x_handles,staff_handles,status FROM platforms WHERE id=?').bind(productId).first<{id:string;name:string;site:string|null;x_handles:string;staff_handles:string;status:string}>():null;
 const sources=platform?(await db.prepare('SELECT url,tier FROM sources WHERE platform_id=? ORDER BY id LIMIT 21').bind(platform.id).all<{url:string;tier:string}>()).results:[];
 return {productId,allowed:!!platform&&platform.status==='approved'&&sources.length<=20&&!!officialTier(finalUrl,{id:platform.id,name:platform.name,site:platform.site,xHandles:JSON.parse(platform.x_handles),staffHandles:JSON.parse(platform.staff_handles)},sources)};
}
export async function preparationSource(db:D1Database,taskId:string){
 const task=await db.prepare("SELECT id FROM review_tasks WHERE id=? AND kind IN ('identity','merge_conflict') AND state IN ('open','manual','checking')").bind(taskId).first();if(!task)throw new IdentityError(404,'identity task missing');
 const rows=(await db.prepare(taskSourcesCte+" SELECT c.raw_candidate_json,o.final_url,coalesce(f.provenance_json,o.trust_json) trust_json,coalesce(json_extract(f.provenance_json,'$.truncated'),o.text_truncated) text_truncated FROM task_candidates tc JOIN intake_candidates c ON c.id=tc.candidate_id JOIN source_observations o ON o.id=c.observation_id LEFT JOIN source_observation_fetches f ON f.id=c.source_fetch_id AND f.observation_id=o.id WHERE tc.task_id IN (SELECT id FROM task_sources) ORDER BY c.id LIMIT 11").bind(taskId).all<{raw_candidate_json:string;final_url:string;trust_json:string;text_truncated:number}>()).results;
 const row=rows.find(source=>!sourceIsVerified(source))??rows[0];if(!row||rows.length>10)throw new IdentityError(409,'task source missing or unbounded');
 const raw=JSON.parse(row.raw_candidate_json),offer=offerIn.safeParse(raw.candidate),trust=JSON.parse(row.trust_json);
 const productId=offer.success?offer.data.platformId:null;const platform=productId?await db.prepare('SELECT id,name,site,x_handles,staff_handles,status FROM platforms WHERE id=?').bind(productId).first<{id:string;name:string;site:string|null;x_handles:string;staff_handles:string;status:string}>():null;
 const sources=platform?(await db.prepare('SELECT url,tier FROM sources WHERE platform_id=? ORDER BY id LIMIT 21').bind(platform.id).all<{url:string;tier:string}>()).results:[];
 const allowed=!!platform&&platform.status==='approved'&&sources.length<=20&&!!officialTier(row.final_url,{id:platform.id,name:platform.name,site:platform.site,xHandles:JSON.parse(platform.x_handles),staffHandles:JSON.parse(platform.staff_handles)},sources);
 return {url:row.final_url,issuerProductHint:productId,sourceId:trust.sourceId??(offer.success?offer.data.sourceId??null:null),sourceVerified:trust.sourceVerified===true,officialSource:allowed,quoteCount:Array.isArray(raw.quotes)?raw.quotes.length:0};
}

export async function scanIdentityTask(db:D1Database,taskId:string,raw:unknown){
 const input=z.strictObject({requestId:z.string().min(1).max(160),expectedRevision:z.number().int().nonnegative(),freshSource:z.strictObject({sourceText:z.string().min(20).max(250000),sourceFetch:sourceFetchSchema}).optional()}).parse(raw);
 const command='prepare-identity:'+input.requestId,hash=await sha256(stableJson({taskId,...input}));
 const replay=await readIdentityReceipt(db,command,hash);if(replay){if(replay.status==='conflict')throw new IdentityError(409,'preparation request changed');return replay.value;}
 const task=await db.prepare("SELECT id,kind,state,revision,suggestion_json,lease_until FROM review_tasks WHERE id=? AND kind IN ('identity','merge_conflict')").bind(taskId).first<Task>();
 if(!task||task.revision!==input.expectedRevision||!['open','manual','checking'].includes(task.state)||(task.state==='checking'&&task.lease_until&&Date.parse(task.lease_until)>Date.now()))throw new IdentityError(409,'identity task changed or leased');
 const sources=(await db.prepare(taskSourcesCte+" SELECT c.id,c.revision,c.raw_candidate_json,c.facts_json,c.observation_id,o.final_url,coalesce(f.provenance_json,o.trust_json) trust_json,coalesce(json_extract(f.provenance_json,'$.truncated'),o.text_truncated) text_truncated FROM task_candidates tc JOIN intake_candidates c ON c.id=tc.candidate_id JOIN source_observations o ON o.id=c.observation_id LEFT JOIN source_observation_fetches f ON f.id=c.source_fetch_id AND f.observation_id=o.id WHERE tc.task_id IN (SELECT id FROM task_sources) ORDER BY c.id LIMIT 11").bind(taskId).all<Source>()).results;
 if(!sources.length||sources.length>10)throw new IdentityError(409,'identity task needs a bounded candidate set');
 const retryAt=()=>new Date(Date.now()+evidenceRetryDelay(sources.map(source=>source.raw_candidate_json),sources.map(source=>source.facts_json))).toISOString();
 let freshObservationId:string|null=null,freshFetchId:string|null=null,unverifiable:string|null=null;
 const sourceToRefresh=sources.find(source=>!sourceIsVerified(source))??sources[0];
 if(input.freshSource){const source=sourceToRefresh,candidate=JSON.parse(source.raw_candidate_json),offer=offerIn.safeParse(candidate.candidate);if(!offer.success)throw new IdentityError(400,'source candidate has no valid offer fields');
  const proof=input.freshSource.sourceFetch,text=input.freshSource.sourceText;const quotes=(candidate.quotes??[]).map((q:{quote:string})=>q.quote).filter(Boolean);const normalized=(v:string)=>v.normalize('NFKC').replace(/\s+/g,' ').trim();if(!quotes.some((q:string)=>normalized(text).includes(normalized(q)))||proof.sourceVerified!==true||proof.truncated||proof.method==='jina'||proof.originalUrl!==source.final_url)unverifiable=proof.method==='jina'?'官方页面只能经第三方渲染读取，不能作为核验来源':'重新读取的官方页面上找不到候选摘录的原文';
  if(!unverifiable){const trust=JSON.parse(source.trust_json);const observed=await new IdentityStore(db).recordObservation({requestId:'prepare-ob:'+input.requestId,originalUrl:proof.originalUrl,finalUrl:proof.finalUrl,text,fetchKind:'direct',sourceId:trust.sourceId??offer.data.sourceId,issuerProductId:offer.data.platformId,observedAt:new Date().toISOString(),fetchEvidence:proof});
  const verified=await db.prepare('SELECT o.trust_json,o.text_truncated,f.provenance_json FROM source_observations o JOIN source_observation_fetches f ON f.observation_id=o.id AND f.id=? WHERE o.id=?').bind(observed.fetchId??'',observed.observationId).first<{trust_json:string;text_truncated:number;provenance_json:string}>();
  const official=verified?JSON.parse(verified.trust_json):null;if(!verified||verified.text_truncated||official?.sourceVerified!==true||official.productId!==offer.data.platformId||JSON.parse(verified.provenance_json).sourceVerified!==true)unverifiable='重新读取的页面不是该发放产品已登记的官方来源';
  else{freshObservationId=observed.observationId;freshFetchId=observed.fetchId??null;}}
 }
 const trusted=[...new Set(sources.filter(s=>!s.text_truncated).map(s=>JSON.parse(s.trust_json)).filter(v=>v.sourceVerified===true&&typeof v.productId==='string').map(v=>String(v.productId)))];
 const prior=readPreparation(task.suggestion_json);
 const preparedObservationId=freshObservationId??prior?.sourceObservationId??null;
 if(preparedObservationId){const observed=await db.prepare('SELECT trust_json,text_truncated FROM source_observations WHERE id=?').bind(preparedObservationId).first<{trust_json:string;text_truncated:number}>();const proof=observed?JSON.parse(observed.trust_json):null;if(proof?.sourceVerified===true&&!observed?.text_truncated&&typeof proof.productId==='string')trusted.push(proof.productId);}
 const products=[...new Set(trusted)];
 let next:Preparation;
 if(products.length!==1||sources.some(source=>!sourceIsVerified(source)&&!(freshObservationId&&source.id===sourceToRefresh.id))){next=empty('needs_source','仍有候选来源未核实发放产品；系统需逐条重新核验官方原文。');next.nextAttemptAt=retryAt();}
 else {
  const product=products[0],parsedCandidates=sources.map(s=>offerIn.safeParse(JSON.parse(s.raw_candidate_json).candidate)),declared=parsedCandidates.filter(v=>v.success).map(v=>v.data.platformId);
  if(parsedCandidates.some(v=>!v.success)){next=empty('needs_source','候选活动字段不完整，需要先恢复可核对的原始资料。');next.nextAttemptAt=retryAt();}
  else if(declared.some(id=>id!==product)){next=empty('needs_source','候选记录的发放产品与已核实的官方来源不一致，不能据此合并或建立新活动。');next.nextAttemptAt=retryAt();}
  else {
  const platform=await db.prepare('SELECT status FROM platforms WHERE id=?').bind(product).first<{status:string}>();
  if(platform?.status!=='approved'){next=empty('needs_source','发放产品尚未准入，不能判断是否重复。',product);next.nextAttemptAt=retryAt();}
  else {
   const basis=prior?.productId===product&&prior.sourceObservationId===(preparedObservationId??sources[0].observation_id)?prior:empty('scanning','正在逐页读取该产品的历史活动。',product);
   const facts=canonicalTermsSchema.parse(JSON.parse(sources[0].facts_json));
   const page=await new IdentityStore(db).retrieveCandidates(product,facts,basis.cursor??undefined);
   const ids=JSON.stringify(page.entities.map(e=>e.id));
   const rows=(await db.prepare("SELECT e.id,e.business_revision,e.canonical_offer_id,o.title,o.value_text,o.review_state,json_extract(o.evidence,'$.url') source_url FROM benefit_entities e LEFT JOIN offers o ON o.id=e.canonical_offer_id WHERE e.id IN (SELECT value FROM json_each(?))").bind(ids).all<{id:string;business_revision:number;canonical_offer_id:string|null;title:string|null;value_text:string|null;review_state:string|null;source_url:string|null}>()).results;
   const rawOffer=offerIn.safeParse(JSON.parse(sources[0].raw_candidate_json).candidate),candidateUrl=rawOffer.success?normalizeDocumentUrl(rawOffer.data.evidence.url):null;
   const entries=[...basis.entries,...rows.map(r=>({entityId:r.id,revision:r.business_revision,offerId:r.canonical_offer_id,title:r.title??'历史条目资料不全',valueText:r.value_text??'',reviewState:r.review_state,sourceUrl:r.source_url,sameSource:!!candidateUrl&&!!r.source_url&&normalizeDocumentUrl(r.source_url)===candidateUrl}))];
   const unique=[...new Map(entries.map(e=>[e.entityId,e])).values()].sort((a,b)=>Number(b.sameSource)-Number(a.sameSource)||a.entityId.localeCompare(b.entityId));
   const scanned=basis.scanned+page.entities.length;
   const status=!page.complete?'scanning':scanned>0&&unique.some(e=>!e.offerId)?'history_unusable':'ready';
   const reason=status==='ready'?(scanned>200?'同平台历史活动较多，请逐页核对完整列表，再作身份判断。':unique.some(e=>e.sameSource)?'同一官方页面已有历史活动，建议优先核对是否为同一次发放；同页不等于同权益。':unique.length?'已读取同发放产品的历史活动。建议核对领取机制与活动轮次，再选择对应条目。':'未找到同发放产品的活动；仍需核对旧拒绝决定及原文后才能建立新待审活动。'):status==='scanning'?'历史查重仍在继续；当前不能作同一或独立的决定。':'历史身份缺少可展示的活动内容，暂不能交给人工判断。';
   next={kind:'identity_preparation_v1',status,productId:product,cursor:status==='scanning'?page.nextCursor:null,scanned,entries:unique.slice(0,200),sourceObservationId:preparedObservationId??sources[0].observation_id,sourceOriginalObservationId:freshObservationId?sourceToRefresh.observation_id:prior?.sourceOriginalObservationId??null,sourceCandidateId:freshObservationId?sourceToRefresh.id:prior?.sourceCandidateId??null,sourceUrl:input.freshSource?.sourceFetch.finalUrl??prior?.sourceUrl??sources[0].final_url??null,reason,nextAttemptAt:null};
  }
  }
 }
  // A source that is not a registered official address is never fetched for verification, so it could never leave
  // needs_source either; the owner decides those too.
 if(next.status==='needs_source'&&!unverifiable&&!freshObservationId&&prior?.status!=='source_unverifiable'&&!sourceIsVerified(sourceToRefresh)&&!(await officialFetchable(db,sourceToRefresh.final_url??'',sourceToRefresh.raw_candidate_json)).allowed)unverifiable='来源不是该厂商已登记的官方地址，系统不能据此核实';
  // 2026-10-16: a source the system cannot re-verify used to throw and leave the card locked in needs_source for days
  // (the owner's buttons stay hidden until "ready"). Hand it to the owner instead, and re-check every few days.
 if(next.status==='needs_source'&&(unverifiable||(prior?.status==='source_unverifiable'&&!freshObservationId))){
  const why=unverifiable??prior?.reason??'官方页面无法核实这段原文';
  next=empty('source_unverifiable',(unverifiable?`系统无法自动核实：${why}。`:why.startsWith('系统无法')?why:`系统无法自动核实：${why}。`)+'请点开来源核对：属实用 ⚡ 快速上架或建立待审活动，重复或不收就拒绝。',prior?.productId??null);
  next.sourceUrl=sourceToRefresh.final_url??null;next.nextAttemptAt=new Date(Date.now()+3*86400_000).toISOString();
  // Most of these are repeats of listed perks: give the owner the vendor's activities to pick "same as" from.
  const declared=offerIn.safeParse(JSON.parse(sourceToRefresh.raw_candidate_json).candidate);
  if(declared.success){
   const rows=(await db.prepare("SELECT e.id,e.business_revision,e.canonical_offer_id,o.title,o.value_text,o.review_state,json_extract(o.evidence,'$.url') source_url FROM benefit_entities e JOIN offers o ON o.id=e.canonical_offer_id WHERE e.platform_id=? AND e.state='active' ORDER BY o.updated_at DESC LIMIT 200").bind(declared.data.platformId).all<{id:string;business_revision:number;canonical_offer_id:string|null;title:string|null;value_text:string|null;review_state:string|null;source_url:string|null}>()).results;
   const url=normalizeDocumentUrl(declared.data.evidence.url);
   next.productId=declared.data.platformId;next.scanned=rows.length;
   next.entries=rows.map(r=>({entityId:r.id,revision:r.business_revision,offerId:r.canonical_offer_id,title:r.title??'历史条目资料不全',valueText:r.value_text??'',reviewState:r.review_state,sourceUrl:r.source_url,sameSource:!!r.source_url&&normalizeDocumentUrl(r.source_url)===url})).sort((a,b)=>Number(b.sameSource)-Number(a.sameSource));
  }
 }
 const originalSuggestion=task.suggestion_json?JSON.parse(task.suggestion_json):null;
 next.sourceReverifications=[...(prior?.sourceReverifications??[]),...(freshObservationId&&freshFetchId?[{candidateId:sourceToRefresh.id,originalObservationId:sourceToRefresh.observation_id,replacementObservationId:freshObservationId,fetchId:freshFetchId}]:[])].slice(0,10);
 if(next.sourceReverifications.length){const latest=next.sourceReverifications.at(-1)!;next.sourceCandidateId=latest.candidateId;next.sourceOriginalObservationId=latest.originalObservationId;next.sourceObservationId=latest.replacementObservationId;}
 next.previousModelSuggestion=prior?.previousModelSuggestion??(originalSuggestion&&!prior?originalSuggestion:undefined);
 next.modelResult=prior?.modelResult;
 next.manualHint=prior?.manualHint;
 const builder=new MutationBuilder(db,command,hash);builder.require("EXISTS(SELECT 1 FROM review_tasks WHERE id=? AND revision=? AND state IN ('open','manual','checking'))",[task.id,task.revision]);builder.require('EXISTS(SELECT 1 FROM intake_candidates WHERE id=? AND observation_id=? AND revision=?)',[sourceToRefresh.id,sourceToRefresh.observation_id,sourceToRefresh.revision]);
 if(freshObservationId&&freshFetchId){builder.update('intake_candidates',{observation_id:freshObservationId,source_fetch_id:freshFetchId,revision:sourceToRefresh.revision+1},'id=?',[sourceToRefresh.id]);}
 const firstFacts=canonicalTermsSchema.parse(JSON.parse(sources[0].facts_json));
 const modelReady=next.status==='ready'&&task.kind==='identity'&&task.state==='open'&&next.scanned<=8&&firstFacts.issuerProductId.state==='known'&&firstFacts.mechanism.state==='known';
 builder.update('review_tasks',{state:modelReady?'open':'manual',revision:task.revision+1,lease_token:null,lease_until:null,suggestion_json:JSON.stringify(next)},'id=?',[task.id]);
 const result=await commitIdentityMutation(db,builder.plan([{kind:'task',id:task.id,revision:task.revision}],{status:next.status,scanned:next.scanned,revision:task.revision+1}));if(result.status==='conflict')throw new IdentityError(409,'identity preparation changed');return result.value;
}
export async function recordIdentityHint(db:D1Database,taskId:string,raw:unknown,actor:string){
 const input=z.strictObject({requestId:z.string().min(1).max(160),expectedRevision:z.number().int().nonnegative(),kind:z.enum(['suspected_duplicate','previously_rejected']),reason:z.string().trim().min(8).max(2000)}).parse(raw);
 const command='identity-hint:'+input.requestId,hash=await sha256(stableJson({taskId,...input,actor}));
 const replay=await readIdentityReceipt(db,command,hash);if(replay){if(replay.status==='conflict')throw new IdentityError(409,'manual hint request changed');return replay.value;}
 const task=await db.prepare("SELECT id,kind,state,revision,suggestion_json FROM review_tasks WHERE id=? AND kind IN ('identity','merge_conflict') AND state IN ('open','manual')").bind(taskId).first<Task>();
 if(!task||task.revision!==input.expectedRevision)throw new IdentityError(409,'identity task changed');
 const previous=readPreparation(task.suggestion_json),saved=task.suggestion_json?JSON.parse(task.suggestion_json):null;
 const sources=(await db.prepare(taskSourcesCte+" SELECT coalesce(f.provenance_json,o.trust_json) trust_json,coalesce(json_extract(f.provenance_json,'$.truncated'),o.text_truncated) text_truncated FROM task_candidates tc JOIN intake_candidates c ON c.id=tc.candidate_id JOIN source_observations o ON o.id=c.observation_id LEFT JOIN source_observation_fetches f ON f.id=c.source_fetch_id AND f.observation_id=o.id WHERE tc.task_id IN (SELECT id FROM task_sources) ORDER BY c.id LIMIT 11").bind(taskId).all<{trust_json:string;text_truncated:number}>()).results;
 if(!sources.length||sources.length>10)throw new IdentityError(409,'identity task needs a bounded candidate set');
 const verified=sources.every(sourceIsVerified);
 const next=previous??empty(verified?'scanning':'needs_source','已记录人工线索，系统继续核对来源与历史活动。');
 if(saved&&!previous)next.previousModelSuggestion=saved;
 next.manualHint={kind:input.kind,reason:input.reason,actor,at:new Date().toISOString()};next.nextAttemptAt=null;
 const builder=new MutationBuilder(db,command,hash);
 builder.require("EXISTS(SELECT 1 FROM review_tasks WHERE id=? AND revision=? AND state IN ('open','manual'))",[task.id,task.revision]);
 builder.update('review_tasks',{revision:task.revision+1,suggestion_json:JSON.stringify(next)},'id=?',[task.id]);
 const result=await commitIdentityMutation(db,builder.plan([{kind:'task',id:task.id,revision:task.revision}],{revision:task.revision+1,state:task.state}));
 if(result.status==='conflict')throw new IdentityError(409,'identity task changed');return result.value;
}
export function preparationView(raw:unknown){const parsed=raw&&typeof raw==='object'&&'kind' in raw&&raw.kind==='identity_preparation_v1'?raw as Preparation:null;return parsed?{status:parsed.status,productId:parsed.productId,scanned:parsed.scanned,reason:parsed.reason,entries:parsed.entries,nextAttemptAt:parsed.nextAttemptAt,sourceObservationId:parsed.sourceObservationId,sourceCandidateId:parsed.sourceCandidateId??null,sourceOriginalObservationId:parsed.sourceOriginalObservationId??null,sourceReverifiedCandidateIds:(parsed.sourceReverifications??[]).map(item=>item.candidateId),sourceUrl:parsed.sourceUrl,modelResult:parsed.modelResult??null,manualHint:parsed.manualHint??null}:null;}
