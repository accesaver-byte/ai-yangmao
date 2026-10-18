import {assertOfficialLeadRejection} from '../official-lead-policy';
import type {LeadResolution} from '../../shared/lead-review';
import type {ReviewReasonCode} from '../../shared/screening/types';
import {sha256,stableJson} from '../../shared/identity/normalize';
import {unknownIdentityTerms} from './adapters';
import {IdentityStore,IdentityError} from './store';
import {MutationBuilder,commitIdentityMutation} from './commit';
import {RULES_VERSION} from '../../shared/identity/compare';
/** Preserve the existing grounded lead closure as observation-only refusal memory.
 * It grants no offer approval and no product-wide rejection authority. */
export async function closeIdentityLead(db:D1Database,lead:{id:number;url:string;status:string;raw:string|null;title:string|null;resolution:LeadResolution|null;offerId:string|null},resolution:LeadResolution,sourceText:string,options:{actor?:string;raw?:string|null;reasonCode?:ReviewReasonCode}={}){
 await assertOfficialLeadRejection(db,{url:lead.url,text:sourceText,reason:resolution.reason,reasonCode:options.reasonCode});
 const row=await db.prepare('SELECT resolution FROM leads WHERE id=?').bind(lead.id).first<{resolution:string|null}>();
 if(!row||stableJson(JSON.parse(row.resolution??'null'))!==stableJson(lead.resolution))throw new IdentityError(409,'lead review changed');
 const command='lead-close:'+lead.id+':'+resolution.jobId,hash=await sha256(stableJson({leadId:lead.id,resolution,sourceText,actor:options.actor??'pipeline:lead-review'}));
 const observedAt=resolution.checkedAt??new Date().toISOString();
 const ob=await new IdentityStore(db).recordObservation({requestId:command,originalUrl:lead.url,finalUrl:lead.url,text:sourceText,fetchKind:'indirect',observedAt});
 const candidateId='lead-refusal-'+await sha256(command),decisionId='lead-refusal-decision-'+await sha256(command),facts=unknownIdentityTerms(),quote=sourceText.slice(0,20000),builder=new MutationBuilder(db,command,hash);
 builder.require("EXISTS(SELECT 1 FROM leads WHERE id=? AND status=? AND resolution IS ? AND url=? AND raw IS ? AND title IS ?)",[lead.id,lead.status,row.resolution,lead.url,lead.raw,lead.title]);
 const receipt={inputId:'lead-'+lead.id,candidateId,canonicalOfferId:null,entityId:null,versionId:null,decisionId,taskId:null,outcome:'duplicate_rejected',retryable:false,reasonCodes:['grounded_lead_closure']};
 builder.insert('intake_candidates',{id:candidateId,observation_id:ob.observationId,source_fetch_id:ob.fetchId??null,extraction_version:'lead-closure-v1',span_key:'lead:'+lead.id,candidate_key:await sha256(command),raw_candidate_json:JSON.stringify({candidate:{legacyLeadId:lead.id},quotes:[{id:'body',start:0,end:quote.length,quote}],span:{start:0,end:quote.length,quote}}),facts_json:JSON.stringify(facts),facts_hash:await sha256(stableJson(facts)),state:'resolved_rejected',receipt_json:JSON.stringify(receipt)});
 builder.insert('review_decisions',{id:decisionId,candidate_id:candidateId,action:'reject',reason_code:options.reasonCode??'other',reason_text:resolution.reason??'',scope_json:JSON.stringify({kind:'observation_only',observationId:ob.observationId}),reopen_policy_json:'{"kind":"manual","missingFacts":[]}',basis_json:JSON.stringify({leadId:lead.id,jobId:resolution.jobId,evidenceUrl:resolution.evidenceUrl,quote:resolution.quote}),rules_version:RULES_VERSION,evidence_refs_json:JSON.stringify([ob.observationId]),actor:options.actor??'pipeline:lead-review',idempotency_key:command});
 builder.update('intake_candidates',{decision_id:decisionId},'id=?',[candidateId]);builder.assertOwnership('intake_candidates',candidateId);builder.insert('lead_candidate_links',{lead_id:lead.id,candidate_id:candidateId});
 builder.update('leads',{status:'rejected',resolution:JSON.stringify({...resolution,identityCandidateIds:[candidateId],identityTaskIds:[]}),offer_id:resolution.offerIds?.[0]??lead.offerId,...(options.raw!==undefined?{raw:options.raw}:{})},'id=?',[lead.id]);
 const result=await commitIdentityMutation(db,builder.plan([],{status:'closed',candidateId,decisionId}));if(result.status==='conflict')throw new IdentityError(409,'lead closure changed; nothing applied');return result.value;
}
