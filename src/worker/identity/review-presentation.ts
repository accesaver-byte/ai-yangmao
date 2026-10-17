import {identityUrgency,preparationView} from './preparation';
import {offerIn} from '../../shared/ingest';
import type {CanonicalTermsV1} from '../../shared/identity/types';

type ReviewSource={candidateId?:string;raw_candidate_json:string;trust_json:string|null;facts_json:string;text_truncated:number|string|null;observationId?:string};
export function identityReviewPresentation(task:{kind:string;suggestion_json?:string|null},sources:ReviewSource[]){
 const source=sources[0],raw=source?JSON.parse(source.raw_candidate_json).candidate:null;
 const parsed=offerIn.safeParse(raw);
 const candidateDisplay=parsed.success?{
  id:parsed.data.id,title:parsed.data.title,valueText:parsed.data.valueText,type:parsed.data.type,
  platformId:parsed.data.platformId,claimMethod:parsed.data.claimMethod,audience:parsed.data.audience,
  requirements:parsed.data.requirements,evidenceUrl:parsed.data.evidence.url,
 }:null;
 const provenance=sources.map(row=>{const p=JSON.parse(row.trust_json??'{}');return {sourceVerified:p.sourceVerified===true,productId:typeof p.productId==='string'?p.productId:null,truncated:!!row.text_truncated||p.truncated===true};});
 const facts=source?JSON.parse(source.facts_json) as CanonicalTermsV1:null;
 const suggestion=task.suggestion_json?JSON.parse(task.suggestion_json):null;
 const prepared=preparationView(suggestion);
 const temporal=identityUrgency(sources.map(row=>row.raw_candidate_json),sources.map(row=>row.facts_json));
 const sourceReverified=prepared?.status==='ready'&&!!prepared.sourceCandidateId&&!!prepared.sourceOriginalObservationId;
 const needsSource=!provenance.some(p=>p.sourceVerified&&!p.truncated);
 const needsFacts=!facts||facts.issuerProductId.state!=='known'||facts.mechanism.state!=='known'||!facts.benefitPools.length;
 const incomplete=!!suggestion&&suggestion.retrievalComplete===false;
 const state=task.kind==='identity'||task.kind==='merge_conflict'
  ?needsSource?'needs_source':needsFacts?'needs_system_review':incomplete?'history_incomplete':'needs_system_review'
  :'ready';
 const effectiveState=prepared?prepared.status==='ready'?'ready':prepared.status==='source_unverifiable'||prepared.status==='history_unusable'?'source_unverifiable':prepared.status==='needs_source'?'needs_source':prepared.status==='scanning'?'history_incomplete':'needs_system_review':state;
 const reason=prepared?.status==='history_unusable'?'历史活动资料不全，系统无法完成查重；请你核对后决定：重复就结案，属实用 ⚡ 快速上架。':prepared?.reason??(state==='needs_source'?'官方原文尚未核实，系统需重新核验来源后才能查重。'
  :state==='history_incomplete'?'历史活动尚未查完，不能根据当前结果确认是否独立。'
  :state==='needs_system_review'?'系统仍在提取领取机制并核对历史活动；现在不需要你猜测内部身份 ID。'
  :'候选来源与历史范围已经核对，可以继续人工审核。');
 return {candidateDisplay,provenance,historyOptions:prepared?.entries??[],reviewPreparation:{state:effectiveState,reason,canDecide:effectiveState==='ready'||effectiveState==='source_unverifiable',deadline:temporal.deadline,urgency:temporal.urgency,scanned:prepared?.scanned??0,productId:prepared?.productId??null,nextAttemptAt:prepared?.nextAttemptAt??null,sourceReverified,sourceCandidateId:prepared?.sourceCandidateId??null,sourceReverifiedCandidateIds:prepared?.sourceReverifiedCandidateIds??[],sourceUrl:prepared?.sourceUrl??null,modelResult:prepared?.modelResult??null,manualHint:prepared?.manualHint??null}};
}
