import {claimIdentityKey} from '../../shared/identity/normalize';
import {canonicalTermsSchema,type CanonicalTermsV1,type EvidenceContext,type ReviewDecision,type ReopenEvaluation} from '../../shared/identity/types';
import {compareCandidate,evidenceGrounded,factSlots} from '../../shared/identity/compare';
import {evaluateReopen} from '../../shared/identity/decision-policy';
import {readReviewDecision} from './store';
export function groundedClaim(facts:CanonicalTermsV1,evidence:EvidenceContext,human=false):boolean {
 return !!claimIdentityKey(facts)&&!evidence.truncated&&(human||evidence.sourceVerified)&&facts.occurrenceAnchor.state==='known'&&evidenceGrounded(facts.occurrenceAnchor.evidenceRefs,evidence)&&facts.occurrenceAnchor.evidenceRefs.some(id=>evidence.quoteById[id].includes(facts.occurrenceAnchor.state==='known'?facts.occurrenceAnchor.value:''));
}
export interface ClaimMatch {decision:ReviewDecision;canonicalCandidateId:string;proofCandidateId:string;proofRevision:number;reopen:ReopenEvaluation;
 /** Why a refusal from elsewhere applies, stored with the application (e.g. same_page_refusal). */
 basis?:{reason:string}&Record<string,unknown>}
interface ProofRow extends Record<string,unknown>{proof_id:string;proof_revision:number;proof_facts:string;proof_raw:string;proof_observation:string;proof_text:string;proof_truncated:number;proof_trust:string;canonical_claim:string;identity_basis:string}
function proofEvidence(row:ProofRow,facts:CanonicalTermsV1):EvidenceContext {
 const trust=JSON.parse(row.proof_trust),raw=JSON.parse(row.proof_raw) as {quotes?:{id:string;quote:string}[]};return {observationId:row.proof_observation,fullText:row.proof_text,truncated:!!row.proof_truncated,sourceVerified:trust.sourceVerified===true&&facts.issuerProductId.state==='known'&&facts.issuerProductId.value===trust.productId,quoteById:Object.fromEntries((raw.quotes??[]).map(q=>[q.id,q.quote]))};
}
export async function findClaimMemory(db:D1Database,candidateId:string,facts:CanonicalTermsV1,evidence:EvidenceContext):Promise<{match:ClaimMatch|null;unresolved:boolean}> {
 const key=claimIdentityKey(facts);if(!key)return {match:null,unresolved:false};
 const fields=`d.*,c.id proof_id,c.revision proof_revision,c.facts_json proof_facts,c.raw_candidate_json proof_raw,c.observation_id proof_observation,o.text proof_text,coalesce(json_extract(f.provenance_json,'$.truncated'),o.text_truncated) proof_truncated,coalesce(f.provenance_json,o.trust_json) proof_trust`;
 const active="d.entity_id IS NULL AND d.action='reject' AND json_extract(d.scope_json,'$.kind')='claim' AND NOT EXISTS(SELECT 1 FROM review_decisions n WHERE n.supersedes_id=d.id)";
 const pages=await Promise.all([
  db.prepare(`SELECT ${fields},c.id canonical_claim,'{}' identity_basis FROM intake_candidates c JOIN review_decisions d ON d.candidate_id=c.id JOIN source_observations o ON o.id=c.observation_id LEFT JOIN source_observation_fetches f ON f.id=c.source_fetch_id AND f.observation_id=o.id WHERE c.claim_identity_key=? AND ${active} ORDER BY d.id LIMIT 41`).bind(key).all<ProofRow>(),
  db.prepare(`SELECT ${fields},a.canonical_candidate_id canonical_claim,a.identity_basis_json identity_basis FROM intake_candidates c JOIN identity_refusal_applications a ON a.candidate_id=c.id AND a.facts_hash=c.facts_hash JOIN review_decisions d ON d.id=a.decision_id JOIN source_observations o ON o.id=c.observation_id LEFT JOIN source_observation_fetches f ON f.id=c.source_fetch_id AND f.observation_id=o.id WHERE c.claim_identity_key=? AND a.canonical_candidate_id IS NOT NULL AND ${active} ORDER BY d.id,c.id LIMIT 41`).bind(key).all<ProofRow>(),
 ]);
 if(pages.some(p=>p.results.length>40))return {match:null,unresolved:true};
 const matches=new Map<string,ClaimMatch>();let unresolved=false;
 for(const row of pages.flatMap(p=>p.results)){
  const previous=canonicalTermsSchema.parse(JSON.parse(row.proof_facts)),basis=JSON.parse(row.identity_basis),proof=proofEvidence(row,previous),decision=readReviewDecision(row);
  const reopen=await evaluateReopen(decision,facts,evidence);
  const officialSupplement=reopen.allowed&&decision.reopenPolicy.kind==='missing_facts'&&groundedClaim(previous,proof,true)&&groundedClaim(facts,evidence);
  if(!groundedClaim(previous,proof,basis.humanConfirmed===true)&&!officialSupplement){unresolved=true;continue;}
  const directHuman=basis.humanConfirmed===true&&row.proof_id===candidateId;
  const current=directHuman?{...evidence,confirmedEntityId:row.canonical_claim}:evidence;
  const entity={id:row.canonical_claim,platformId:previous.issuerProductId.state==='known'?previous.issuerProductId.value:'unknown',revision:row.proof_revision,publicationRevision:0,approvedVersionId:null,terms:previous};
  const comparison=compareCandidate(facts,entity,current);
  const before=factSlots(previous),added=[...factSlots(facts)].filter(([field,value])=>value.state!=='unknown'&&(!before.has(field)||before.get(field)!.state==='unknown')).map(([field])=>field);
  const namedReopen=groundedClaim(facts,evidence)&&comparison.reasonCodes.includes('new_identity_facts')&&reopen.allowed&&added.length>0&&added.every(field=>decision.reopenPolicy.missingFacts.includes(field));
  if((comparison.relation==='SAME'&&comparison.termsRelation==='EQUIVALENT')||namedReopen)matches.set(decision.id,{decision,canonicalCandidateId:row.canonical_claim,proofCandidateId:row.proof_id,proofRevision:row.proof_revision,reopen});else if(comparison.relation!=='DISTINCT')unresolved=true;
 }
 return {match:matches.size===1?[...matches.values()][0]:null,unresolved:matches.size>1||(matches.size===0&&unresolved)};
}
