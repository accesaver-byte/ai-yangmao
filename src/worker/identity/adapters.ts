import {membershipSchema,membershipFacts} from '../../shared/membership';
import {withMembershipFacts} from '../../shared/identity/membership';
import { legacyReceipt } from '../../shared/identity/legacy';
export { legacyReceipt } from '../../shared/identity/legacy';
import { IdentityQueryBudgetError } from './budget';
import { MutationBuilder,commitIdentityMutation,readIdentityReceipt } from './commit';
import { z } from 'zod';
import type { Env } from '../index';
import type { OfferIn } from '../../shared/ingest';
import { canonicalTermsSchema,intakeReceiptSchema,type CanonicalTermsV1,type IntakeReceipt } from '../../shared/identity/types';
import { sha256,stableJson } from '../../shared/identity/normalize';
import { IdentityStore,IdentityError } from './store';
import { IdentityService } from './service';

export function identitySelected(env:Pick<Env,'IDENTITY_MODE'|'IDENTITY_CANARY_PLATFORMS'>,productId:string):boolean {
 const products=(env.IDENTITY_CANARY_PLATFORMS??'').split(',').map(s=>s.trim());return env.IDENTITY_MODE==='enforce'&&(products.includes('*')||products.includes(productId));
}
/**
 * Identity intake waits until legacy refusals are reconciled. Intake-rule and gate0 closures are excluded (2026-10-24):
 * they are deliberate closures that never become offers and record no identity refusal by design, yet one platformless
 * rule closure (lead #7907) blocked identity intake for every platform.
 */
export async function requireIdentityReady(db:D1Database,productId:string):Promise<void> {
 const missing=await db.prepare('SELECT 1 FROM offers o LEFT JOIN benefit_entities e ON e.canonical_offer_id=o.id WHERE o.platform_id=? AND e.id IS NULL LIMIT 1').bind(productId).first();
 const refusals=await db.prepare("SELECT 1 FROM rejected_offer_updates r JOIN offers o ON o.id=r.offer_id WHERE o.platform_id=? AND NOT EXISTS(SELECT 1 FROM review_decisions d WHERE d.idempotency_key='backfill:rejected_update:'||r.id OR d.idempotency_key=r.decision_key) LIMIT 1").bind(productId).first();
 const leads=await db.prepare("SELECT 1 FROM leads l LEFT JOIN offers o ON o.id=l.offer_id WHERE l.status='rejected' AND json_extract(l.resolution,'$.ruleId') IS NULL AND coalesce(json_extract(l.resolution,'$.gate0'),0)<>1 AND (coalesce(json_extract(l.resolution,'$.platformId'),o.platform_id) IS NULL OR coalesce(json_extract(l.resolution,'$.platformId'),o.platform_id)=?) AND NOT EXISTS(SELECT 1 FROM review_decisions d WHERE d.idempotency_key='backfill:lead:'||l.id AND json_extract(d.basis_json,'$.legacyResolution') IS l.resolution) AND NOT EXISTS(SELECT 1 FROM lead_candidate_links lc JOIN intake_candidates c ON c.id=lc.candidate_id JOIN review_decisions d ON d.id=c.decision_id WHERE lc.lead_id=l.id AND d.action='reject') LIMIT 1").bind(productId).first();
 if(missing||refusals||leads)throw new IdentityError(409,'identity backfill reconciliation required');
}
export function unknownIdentityTerms(productId?:string):CanonicalTermsV1 {
 const unknown={state:'unknown'} as const;
 // Platform identity from an old request remains a hint until evidence is resolved.
 return {schemaVersion:'terms-v1',issuerProductId:unknown,mechanism:unknown,benefitPools:[],eligibility:unknown,geography:unknown,claimChannels:unknown,costs:unknown,claimWindow:unknown,occurrenceAnchor:unknown};
}
export async function adaptLegacyOffer(env:Env,offer:OfferIn,raw:unknown):Promise<Record<string,unknown>|null> {
 if(!identitySelected(env,offer.platformId))return null;
 // Legacy writers may omit structure but cannot erase a confirmed selection
 // while retaining the exact same compatibility member labels.
 const stored=await env.DB.prepare('SELECT o.requirements,o.membership_requirement,p.candidate FROM offers o LEFT JOIN offer_proposals p ON p.offer_id=o.id WHERE o.id=?').bind(offer.id).first<{requirements:string;membership_requirement:string|null;candidate:string|null}>();
 if(stored) {
  const proposal=stored.candidate?JSON.parse(stored.candidate):null;
  const previous=proposal?.membershipRequirement??(stored.membership_requirement?JSON.parse(stored.membership_requirement):null);
  const previousRequirements=proposal?.requirements??JSON.parse(stored.requirements);
  const members=(requirements:string[])=>[...new Set(requirements.filter(r=>r.startsWith('member:')))].sort();
  const rawMembership=raw&&typeof raw==='object'?(raw as Record<string,unknown>).membershipRequirement:null;
  const sameStructure=!rawMembership||!!previous&&!!offer.membershipRequirement&&stableJson(membershipFacts({...offer.membershipRequirement,status:previous?.status??offer.membershipRequirement.status}))===stableJson(membershipFacts(previous));
  if(previous&&sameStructure&&stableJson(members(previousRequirements))===stableJson(members(offer.requirements)))offer={...offer,membershipRequirement:membershipSchema.parse(previous)};
 }

 const transport=z.object({identityFacts:canonicalTermsSchema.optional(),identityRequestId:z.string().min(1).max(160).optional()}).parse(raw);
 const payloadHash=await sha256(stableJson({offer:{...offer,usdEstimate:null,usdMax:null,valuation:null},identityFacts:transport.identityFacts??null}));
 const request=transport.identityRequestId??payloadHash;
 const reservation=await commitIdentityMutation(env.DB,new MutationBuilder(env.DB,'legacy-request:'+request,payloadHash).plan([],{accepted:true}));
 if(reservation.status==='conflict')throw new IdentityError(409,'legacy request payload conflict');
 const completed=await env.DB.prepare("SELECT result_json FROM identity_commands WHERE request_id=? AND state='applied'").bind('resolve:legacy-resolve:'+request).first<{result_json:string}>();
 if(completed)return legacyReceipt(offer.id,intakeReceiptSchema.parse(JSON.parse(completed.result_json)));
 await requireIdentityReady(env.DB,offer.platformId);
 let originalJob:string|null=null;
 let legacyJob:{offerId:string;entityId:string;entityRevision:number;originalJob:string}|undefined;
 if(offer.officialReviewJobId){
  const row=await env.DB.prepare('SELECT o.updated_at,o.official_review,e.id AS entity_id,e.business_revision,p.updated_at AS proposal_version FROM offers o JOIN benefit_entities e ON e.canonical_offer_id=o.id LEFT JOIN offer_proposals p ON p.offer_id=o.id WHERE o.id=?').bind(offer.id).first<{updated_at:string;official_review:string|null;entity_id:string;business_revision:number;proposal_version:string|null}>();
  const job=row?.official_review?JSON.parse(row.official_review):null;
  originalJob=row?.official_review??null;
  if(!row||!job||job.jobId!==offer.officialReviewJobId||job.status!=='checking'||job.inputVersion!==row.updated_at+'|'+(row.proposal_version??'')||job.identityRevision!==row.business_revision)throw new IdentityError(409,'official review identity revision changed');
  legacyJob={offerId:offer.id,entityId:row.entity_id,entityRevision:row.business_revision,originalJob:originalJob!};
 }

 if(offer.evidence.tier==='tested')throw new IdentityError(400,'tested requires administrator confirmation');
 let legacyLead:{leadId:number;resolution:string}|undefined;
 if(offer.leadReviewJobId&&offer.leadId){const lead=await env.DB.prepare('SELECT status,resolution FROM leads WHERE id=?').bind(offer.leadId).first<{status:string;resolution:string|null}>();const state=lead?.resolution?JSON.parse(lead.resolution):null;if(!lead||lead.status!=='reviewing'||state?.jobId!==offer.leadReviewJobId||state?.status!=='checking')throw new IdentityError(409,'lead review revision changed');legacyLead={leadId:offer.leadId,resolution:lead.resolution!};}
 if(offer.sourceFetch&&new URL(offer.sourceFetch.finalUrl).href!==new URL(offer.evidence.url).href)throw new IdentityError(400,'fetch final URL differs from cited evidence');
 const store=new IdentityStore(env.DB);
 const text=offer.sourceText??Object.values(offer.evidence.excerpts).filter((v):v is string=>typeof v==='string').join('\n');
 const observation=await store.recordObservation({requestId:'legacy-ob:'+request,originalUrl:offer.sourceFetch?.originalUrl??offer.evidence.url,finalUrl:offer.sourceFetch?.finalUrl??offer.evidence.url,text,fetchKind:offer.sourceFetch&&['direct','readability','first_party_embed'].includes(offer.sourceFetch.method)&&offer.sourceFetch.sourceVerified?'direct':'indirect',sourceId:offer.sourceId,issuerProductId:offer.platformId,observedAt:offer.evidence.capturedAt,truncated:offer.sourceFetch?.truncated??false,fetchEvidence:offer.sourceFetch});
 const quotes=Object.entries(offer.evidence.excerpts).flatMap(([id,quote])=>{if(!quote)return [];const start=text.indexOf(quote);return start<0?[]:[{id,start,end:start+quote.length,quote}];});
 const span=quotes.find(q=>q.id==='benefit')??quotes[0];
 const {sourceFetch:_fetch,sourceText:_text,identityFacts:_facts,identityRequestId:_request,officialReviewJobId:_officialJob,leadReviewJobId:_leadJob,...display}=offer;
 let identityFacts=transport.identityFacts??unknownIdentityTerms();
 if(offer.membershipRequirement&&span)identityFacts=withMembershipFacts(identityFacts,offer.membershipRequirement,[span.id]);
 const receipts=await store.recordCandidates({requestId:'legacy-candidate:'+request,observationId:observation.observationId,sourceFetchId:observation.fetchId,extractionVersion:'legacy-adapter-v1',extractionComplete:!!span,leadIds:offer.leadId?[offer.leadId]:[],candidates:span?[{inputId:offer.id,span:{start:span.start,end:span.end,quote:span.quote},quotes,rawCandidate:{...display,...(legacyJob?{_identityLegacyJob:legacyJob}:{}),...(legacyLead?{_identityLegacyLead:legacyLead}:{})},facts:identityFacts}]:[]});
 if(!receipts.length)return {id:offer.id,error:'identity extraction incomplete',retryable:true};
 let receipt:IntakeReceipt;
 try {receipt=await new IdentityService(env.DB).resolveCandidate(receipts[0].candidateId,'legacy-resolve:'+request);}
 catch(error){if(!(error instanceof IdentityQueryBudgetError))throw error;return {id:offer.id,identityHandled:true,intakePersisted:true,identityReceipt:{...receipts[0],outcome:'deferred',retryable:true,reasonCodes:['query_budget_deferred']},pendingResolution:{candidateId:receipts[0].candidateId,requestId:'legacy-resolve:'+request}};}

 return legacyReceipt(offer.id,receipt);
}
