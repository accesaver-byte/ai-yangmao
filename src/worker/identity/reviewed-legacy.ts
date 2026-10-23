import {offerIn,type OfferIn} from '../../shared/ingest';
import { foldText, introducesNothingNew, pageContains, textSimilarity } from '../../shared/identity/perk-anchors';
import {readReviewDecision} from './store';
import type {ClaimMatch} from './claim-memory';
import {stableJson,normalizeDocumentUrl} from '../../shared/identity/normalize';
import {factSlots} from '../../shared/identity/compare';
import {canonicalTermsSchema,type CanonicalTermsV1} from '../../shared/identity/types';
import {officialTier} from '../../shared/official-review';
export function hasKnownTerms(facts:CanonicalTermsV1){return facts.benefitPools.length>0||[...factSlots(facts).values()].some(f=>f.state!=='unknown');}
/** Exact reviewed assertion only. This is not a semantic entity classifier. */
function fingerprint(value:OfferIn){
 const fields=['platformId','type','claimMethod','audience','requirements','valueText','models','modalities','tags','claimStart','claimEnd','endKind','creditValidity'] as const;
 const normalize=(v:unknown):unknown=>Array.isArray(v)?v.map(normalize).sort((a,b)=>stableJson(a).localeCompare(stableJson(b))):typeof v==='string'?v.normalize('NFKC').replace(/\s+/g,' ').trim():v??null;
 return stableJson({fields:Object.fromEntries(fields.map(k=>[k,normalize(value[k])])),url:normalizeDocumentUrl(value.evidence.url),excerpts:Object.fromEntries(Object.entries(value.evidence.excerpts).map(([k,v])=>[k,normalize(v)]))});
}
export interface ReviewedLegacyMatch {entityId:string;versionId:string;decisionId:string;offerId:string;action:'approve'|'reject';revision:number;updatedAt:string;display:string;relatedRevisions:{id:string;revision:number}[];reason?:'same_source_reread'}
/** Old rows without canonical facts can remember the same reviewed assertion.
 * New canonical scope, changed raw conditions or ambiguous matches never use this path. */
export async function findReviewedLegacy(db:D1Database,raw:string,facts:CanonicalTermsV1):Promise<ReviewedLegacyMatch|null>{
 if(hasKnownTerms(facts))return null;
 const parsed=offerIn.safeParse(JSON.parse(raw).candidate);if(!parsed.success||!Object.values(parsed.data.evidence.excerpts).some(q=>q?.trim()))return null;
 const offer=parsed.data,hash=fingerprint(offer);
 const rows=await db.prepare(`SELECT e.id entity_id,e.business_revision,e.canonical_offer_id,o.updated_at,v.id version_id,v.facts_json,v.display_candidate_json,d.id decision_id,d.action,d.reason_code,d.reason_text
 FROM benefit_entities e JOIN offers o ON o.id=e.canonical_offer_id
 JOIN review_decisions d ON d.entity_id=e.id AND d.idempotency_key='backfill:offer:'||o.id
 JOIN benefit_versions v ON v.id=d.version_id AND v.entity_id=e.id
 WHERE e.platform_id=? AND json_extract(o.evidence,'$.url')=? AND e.state='active' AND o.withdrawn_at IS NULL
 AND ((d.action='approve' AND o.review_state='approved' AND e.current_approved_version_id=v.id) OR (d.action='reject' AND o.review_state='rejected' AND e.current_approved_version_id IS NULL))
 AND NOT EXISTS(SELECT 1 FROM review_decisions n WHERE n.supersedes_id=d.id)
 AND NOT EXISTS(SELECT 1 FROM review_decisions other WHERE other.entity_id=e.id AND other.action='reject' AND other.id<>d.id AND (other.version_id=v.id OR json_extract(other.scope_json,'$.kind')='entity_alias') AND NOT EXISTS(SELECT 1 FROM review_decisions n WHERE n.supersedes_id=other.id)) LIMIT 41`).bind(offer.platformId,offer.evidence.url).all<{entity_id:string;business_revision:number;canonical_offer_id:string;updated_at:string;version_id:string;facts_json:string;display_candidate_json:string;decision_id:string;action:'approve'|'reject';reason_code:string;reason_text:string}>();
 if(rows.results.length>40)return null;
 const matches=rows.results.filter(row=>{const old=offerIn.safeParse(JSON.parse(row.display_candidate_json));return old.success&&(row.action==='reject'||!!old.data.evidence.excerpts.benefit)&&!hasKnownTerms(canonicalTermsSchema.parse(JSON.parse(row.facts_json)))&&fingerprint(old.data)===hash;});
 let row=matches[0];if(!row)return null;
 if(matches.length>1){
  const candidates=matches.filter(m=>m.action==='approve'||m.reason_code!=='duplicate');if(candidates.length!==1)return null;row=candidates[0];
  const others=matches.filter(m=>m!==row);const shortCode=(id:string)=>{let h=2166136261;for(const c of id){h^=c.charCodeAt(0);h=Math.imul(h,16777619);}return (h>>>0).toString(36).padStart(4,'0').slice(-4);};
  const ids=await db.prepare('SELECT id FROM offers ORDER BY id LIMIT 5001').all<{id:string}>();if(ids.results.length>5000)return null;
  const code=shortCode(row.canonical_offer_id),uniqueCode=ids.results.filter(o=>shortCode(o.id)===code).length===1;
  if(!others.every(m=>m.action==='reject'&&m.reason_code==='duplicate'&&(new RegExp('(?<![a-z0-9_-])'+row.canonical_offer_id.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'(?![a-z0-9_-])').test(m.reason_text)||(uniqueCode&&new RegExp('(?<![a-z0-9])'+code+'(?![a-z0-9])').test(m.reason_text)))))return null;
  if(await db.prepare("SELECT 1 FROM identity_constraints WHERE relation='different' AND entity_a IN (SELECT value FROM json_each(?1)) AND entity_b IN (SELECT value FROM json_each(?1)) LIMIT 1").bind(JSON.stringify(matches.map(m=>m.entity_id))).first())return null;
 }
return {entityId:row.entity_id,versionId:row.version_id,decisionId:row.decision_id,offerId:row.canonical_offer_id,action:row.action,revision:row.business_revision,updatedAt:row.updated_at,display:row.display_candidate_json,relatedRevisions:matches.map(m=>({id:m.entity_id,revision:m.business_revision}))};
}

/**
 * Same-source re-read of an approved activity (2026-10-15). Free models omit canonical facts and reword the display
 * text on every 6-hour collect, so the exact fingerprint above never matched and each re-read of an approved pricing
 * or docs page became a manual identity task (61 of 150 open tasks; 38 offers re-queued repeatedly).
 *
 * Identity is accepted only when every condition holds: no known canonical facts; the same legacy offer ID, platform
 * and normalized official URL as the active approved activity; a verified, untruncated fetch of that page for that
 * platform; and the approved benefit excerpt still present verbatim in the fresh page text. The approved version stays
 * the public baseline (policy: re-confirmed old terms are kept). A page that no longer carries the approved wording
 * still goes to review, so real term changes are never auto-absorbed.
 */
/**
 * A re-read of an approved perk's own official page (2026-10-16). Matched by the page, not the model-made offer ID:
 * the extractor invents a new ID slug and new wording on every run, which let most re-reads through to the owner.
 * Same vendor, same normalized page URL, the approved benefit quote still on the page (tolerant of reflow, width and
 * punctuation), and the candidate states no amount, model or requirement the approved terms lack.
 *
 * 2026-10-22 (admin): a page the owner already confirmed "same as" an approved perk counts as its page too — locale and
 * listing variants (/zh/pricing for /pricing, x.ai/news for the article) reopened a card on every crawl (Tripo 13 in 8
 * days). The quote the owner confirmed from that page then anchors the re-read. Registered official pages a vendor only
 * serves through a reader (Jina, fetch_kind indirect) are accepted for this narrow check.
 */
type OwnerDecisionRow=Record<string,unknown>&{id:string;action:string;entity_id:string|null;reason_code:string;created_at:string;proof_id:string;proof_revision:number;proof_raw:string};
/** One read of the owner's "same as" and refusal decisions per resolution, shared by page memory and refusal memory. */
export interface OwnerDecisionMemo {platformId?:string;rows?:OwnerDecisionRow[]}
const REFUSAL_DAYS=90;
const refusalScope=`d.action='reject' AND d.entity_id IS NULL AND d.reason_code<>'insufficient_evidence' AND d.created_at>=? AND json_extract(c.raw_candidate_json,'$.candidate.platformId')=?`;
async function ownerDecisions(db:D1Database,platformId:string,entityIds:string[],since:string,memo:OwnerDecisionMemo):Promise<OwnerDecisionRow[]>{
 const rows=(await db.prepare(`SELECT d.*,c.id proof_id,c.revision proof_revision,c.raw_candidate_json proof_raw FROM review_decisions d JOIN intake_candidates c ON c.id=d.candidate_id
  WHERE d.actor NOT LIKE 'policy:%' AND NOT EXISTS(SELECT 1 FROM review_decisions n WHERE n.supersedes_id=d.id)
  AND ((d.action='same' AND d.entity_id IN (SELECT value FROM json_each(?))) OR (${refusalScope}))
  ORDER BY d.created_at DESC LIMIT 600`).bind(JSON.stringify(entityIds),since,platformId).all<OwnerDecisionRow>()).results;
 memo.platformId=platformId;memo.rows=rows;return rows;
}
export async function findSameSourceReread(db:D1Database,raw:string,facts:CanonicalTermsV1,observationId:string,sourceFetchId:string|null,memo:OwnerDecisionMemo={},now=new Date()):Promise<ReviewedLegacyMatch|null>{
 if(hasKnownTerms(facts))return null;
 const parsed=offerIn.safeParse(JSON.parse(raw).candidate);if(!parsed.success)return null;
 const offer=parsed.data,page=normalizeDocumentUrl(offer.evidence.url);
 const rows=(await db.prepare(`SELECT e.id entity_id,e.business_revision,e.canonical_offer_id,o.updated_at,o.evidence offer_evidence,v.id version_id,v.display_candidate_json,d.id decision_id,p.site,p.x_handles,p.staff_handles,p.wechat
  FROM benefit_entities e JOIN offers o ON o.id=e.canonical_offer_id JOIN platforms p ON p.id=e.platform_id
  JOIN benefit_versions v ON v.id=e.current_approved_version_id AND v.entity_id=e.id
  JOIN review_decisions d ON d.entity_id=e.id AND d.version_id=v.id AND d.action='approve' AND NOT EXISTS(SELECT 1 FROM review_decisions n WHERE n.supersedes_id=d.id)
  WHERE e.platform_id=? AND e.state='active' AND o.review_state='approved' AND o.withdrawn_at IS NULL
  AND NOT EXISTS(SELECT 1 FROM review_decisions other WHERE other.entity_id=e.id AND other.action='reject' AND (other.version_id=v.id OR json_extract(other.scope_json,'$.kind')='entity_alias') AND NOT EXISTS(SELECT 1 FROM review_decisions n WHERE n.supersedes_id=other.id))
  ORDER BY d.created_at DESC LIMIT 200`).bind(offer.platformId).all<{entity_id:string;business_revision:number;canonical_offer_id:string;updated_at:string;offer_evidence:string;version_id:string;display_candidate_json:string;decision_id:string;site:string|null;x_handles:string;staff_handles:string;wechat:string|null}>()).results;
 if(!rows.length)return null;
 const decided=await ownerDecisions(db,offer.platformId,rows.map(row=>row.entity_id),new Date(now.getTime()-REFUSAL_DAYS*86400_000).toISOString(),memo);
 const confirmedQuotes=new Map<string,string[]>();
 for(const row of decided){
  if(row.action!=='same'||!row.entity_id)continue;
  const proof=JSON.parse(row.proof_raw).candidate as {evidence?:{url?:string;excerpts?:{benefit?:string}}}|undefined,url=proof?.evidence?.url,quote=proof?.evidence?.excerpts?.benefit;
  if(url&&quote?.trim()&&normalizeDocumentUrl(url)===page)confirmedQuotes.set(row.entity_id,[...(confirmedQuotes.get(row.entity_id)??[]),quote]);
 }
 const onPage=rows.filter(row=>{const url=(JSON.parse(row.offer_evidence) as {url?:string}).url;return !!url&&normalizeDocumentUrl(url)===page||confirmedQuotes.has(row.entity_id);});
 if(!onPage.length)return null;
 const sources=(await db.prepare('SELECT url,tier FROM sources WHERE platform_id=?').bind(offer.platformId).all<{url:string;tier:string}>()).results;
 const first=onPage[0],platform={id:offer.platformId,name:offer.platformId,site:first.site,xHandles:JSON.parse(first.x_handles||'[]'),staffHandles:JSON.parse(first.staff_handles||'[]'),wechat:first.wechat};
 if(!['site','docs','official'].includes(officialTier(offer.evidence.url,platform,sources)??''))return null;
 const obs=await db.prepare("SELECT o.text,o.fetch_kind,o.final_url,coalesce(json_extract(f.provenance_json,'$.truncated'),o.text_truncated) truncated,coalesce(f.provenance_json,o.trust_json) trust_json FROM source_observations o LEFT JOIN source_observation_fetches f ON f.id=? AND f.observation_id=o.id WHERE o.id=?").bind(sourceFetchId,observationId).first<{text:string;fetch_kind:string;final_url:string;truncated:number|null;trust_json:string}>();
 if(!obs||obs.truncated||obs.fetch_kind==='unavailable')return null;
 const trust=JSON.parse(obs.trust_json) as {sourceVerified?:boolean;productId?:string|null};
 // A reader fetch is never "verified"; the registered official URL above and the quote below carry this check. A
 // redirect to another page is also "indirect" and stays out.
 if(obs.fetch_kind==='indirect'?normalizeDocumentUrl(obs.final_url)!==page||trust.productId!=null&&trust.productId!==offer.platformId:trust.sourceVerified!==true||trust.productId!==offer.platformId)return null;
 // Several approved perks can share one page (a pricing page); keep those whose approved quote is still on it and
 // which the candidate's anchors fit. Exactly one must remain, otherwise the owner decides.
 const fitting=onPage.filter(row=>{
  const approved=offerIn.safeParse(JSON.parse(row.display_candidate_json)),stored=JSON.parse(row.offer_evidence) as {excerpts?:{benefit?:string}};
  const benefit=(approved.success?approved.data.evidence.excerpts.benefit:undefined)??stored.excerpts?.benefit;
  if(!(benefit?.trim()&&pageContains(obs.text,benefit))&&!(confirmedQuotes.get(row.entity_id)??[]).some(quote=>pageContains(obs.text,quote)))return false;
  const a=approved.success?approved.data:null;
  const texts=[a?.title,a?.valueText,a?.creditValidity,...(a?.steps??[]),...Object.values(a?.evidence.excerpts??stored.excerpts??{})].filter((x):x is string=>!!x);
  return introducesNothingNew(offer,{texts,models:a?.models,requirements:a?.requirements});
 });
 if(fitting.length!==1)return null;
 const row=fitting[0];
 return {entityId:row.entity_id,versionId:row.version_id,decisionId:row.decision_id,offerId:row.canonical_offer_id,action:'approve',revision:row.business_revision,updatedAt:row.updated_at,display:row.display_candidate_json,relatedRevisions:[{id:row.entity_id,revision:row.business_revision}],reason:'same_source_reread'};
}

/**
 * The refusal side of page memory (2026-10-22, admin). Content the owner already rejected from a page came back on
 * every crawl because a refusal, unlike a "same as X", was not remembered (Vidu /zh/pricing: 7 of 12 cards rejected).
 * A fresh read closes on that decision when: it is the owner's own refusal, still in force, within 90 days and not an
 * evidence-gap refusal; the refused passage is still on this page; the new candidate quotes that same passage; and it
 * states no amount, model or requirement the refused candidate lacked. A real change still reaches the owner.
 */
export async function findSameSourceRefusal(db:D1Database,raw:string,facts:CanonicalTermsV1,page:{text:string;truncated:boolean},memo:OwnerDecisionMemo={},now=new Date()):Promise<ClaimMatch|null>{
 if(hasKnownTerms(facts)||page.truncated||!page.text)return null;
 const parsed=offerIn.safeParse(JSON.parse(raw).candidate);if(!parsed.success)return null;
 const offer=parsed.data,quote=offer.evidence.excerpts.benefit;
 if(!quote?.trim()||offer.tags.includes('reset'))return null;
 const url=normalizeDocumentUrl(offer.evidence.url),since=new Date(now.getTime()-REFUSAL_DAYS*86400_000).toISOString();
 // Page memory has usually read these already in this resolution; otherwise read the refusals alone.
 const rows=memo.platformId===offer.platformId&&memo.rows?memo.rows.filter(row=>row.action==='reject'&&!row.entity_id&&row.reason_code!=='insufficient_evidence'&&row.created_at>=since)
  :(await db.prepare(`SELECT d.*,c.id proof_id,c.revision proof_revision,c.raw_candidate_json proof_raw FROM review_decisions d JOIN intake_candidates c ON c.id=d.candidate_id
   WHERE d.actor NOT LIKE 'policy:%' AND NOT EXISTS(SELECT 1 FROM review_decisions n WHERE n.supersedes_id=d.id) AND ${refusalScope} ORDER BY d.created_at DESC LIMIT 200`).bind(since,offer.platformId).all<OwnerDecisionRow>()).results;
 const refused=rows.filter(row=>{const proofUrl=(JSON.parse(row.proof_raw).candidate?.evidence?.url) as string|undefined;return !!proofUrl&&normalizeDocumentUrl(proofUrl)===url;});
 for(const row of refused){
  const proof=offerIn.safeParse(JSON.parse(row.proof_raw).candidate);if(!proof.success)continue;
  const refusedQuote=proof.data.evidence.excerpts.benefit;
  if(!refusedQuote?.trim()||!pageContains(page.text,refusedQuote))continue;
  const a=foldText(quote),b=foldText(refusedQuote);
  if(!(a.includes(b)||b.includes(a)||textSimilarity(quote,refusedQuote)>=0.8))continue;
  const p=proof.data,texts=[p.title,p.valueText,p.creditValidity,...(p.steps??[]),...Object.values(p.evidence.excerpts)].filter((x):x is string=>!!x);
  if(!introducesNothingNew(offer,{texts,models:p.models,requirements:p.requirements}))continue;
  return {decision:readReviewDecision(row),canonicalCandidateId:row.proof_id,proofCandidateId:row.proof_id,proofRevision:row.proof_revision,reopen:{allowed:false,reasonCodes:[],basisHash:null},basis:{reason:'same_page_refusal',page:url,appliedAt:now.toISOString()}};
 }
 return null;
}
