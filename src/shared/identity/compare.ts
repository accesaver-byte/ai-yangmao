import { canonicalTermsSchema, evidenceContextSchema, versionedEntitySchema, type CanonicalTermsV1, type EvidenceContext, type VersionedEntity, type ResolutionResult, type Fact } from './types';
import { normalizeTerms, stableJson, withoutEvidence } from './normalize';
import { modelIdentityKey } from '../model-names';
export const RESOLVER_VERSION = 'identity-v2';
export const RULES_VERSION = 'identity-rules-v1';
const equal = (a: unknown,b: unknown) => stableJson(withoutEvidence(a))===stableJson(withoutEvidence(b));
const knownValue = <T>(fact: Fact<T>) => fact.state==='known'?fact.value:undefined;
export function evidenceGrounded(refs: string[], evidence: EvidenceContext): boolean {
  return refs.length>0 && refs.every(ref=>Object.hasOwn(evidence.quoteById,ref) && typeof evidence.quoteById[ref]==='string' && evidence.fullText.includes(evidence.quoteById[ref]));
}
export function factSlots(terms: CanonicalTermsV1): Map<string,Fact<unknown>> {
  const slots = new Map<string,Fact<unknown>>();
  for(const [key,value] of Object.entries(terms)) if(key!=='schemaVersion'&&key!=='benefitPools')slots.set(key,value as Fact<unknown>);
  for(const pool of terms.benefitPools) for(const [key,value] of Object.entries(pool)) if(key!=='poolKey')slots.set(`benefitPools.${pool.poolKey}.${key}`,value as Fact<unknown>);
  return slots;
}
export function compareCandidate(raw:CanonicalTermsV1,rawEntity:VersionedEntity,rawEvidence:EvidenceContext):ResolutionResult {
  const candidate=normalizeTerms(canonicalTermsSchema.parse(raw)),entity=versionedEntitySchema.parse(rawEntity),evidence=evidenceContextSchema.parse(rawEvidence);
  const result: ResolutionResult={relation:'UNRESOLVED',entityId:null,termsRelation:'INSUFFICIENT',matchingVersionId:null,evidenceRefs:[],conflicts:[],reasonCodes:[],retrievalComplete:true,resolverVersion:RESOLVER_VERSION,rulesVersion:RULES_VERSION};
  const unresolved=(reason:string)=>({...result,reasonCodes:[reason]});
  const distinct=(reason:string)=>({...result,relation:'DISTINCT' as const,reasonCodes:[reason]});
  // These gates must run before any alias, special-case or similarity comparison.
  if(evidence.differentEntityIds?.includes(entity.id))return distinct('manual_different');
  const product=knownValue(candidate.issuerProductId);
  if(product && product!==entity.platformId)return distinct('product_conflict');
  if(evidence.revokedEntityIds?.includes(entity.id))return unresolved('alias_revoked');
  if(!entity.terms)return unresolved('missing_fact_baseline');
  const before=normalizeTerms(entity.terms);
  const anchor=knownValue(candidate.occurrenceAnchor),oldAnchor=knownValue(before.occurrenceAnchor);
  const incomingSlots=factSlots(candidate),oldSlots=factSlots(before);
  // V1 member prose has no lossless interpretation without a reviewed mapping.
  // Only a fully known member-free eligibility can cross the version boundary.
  if(candidate.schemaVersion!==before.schemaVersion) {
    const legacy=candidate.schemaVersion==='terms-v1'?candidate:before;
    if(legacy.eligibility.state!=='known'||legacy.eligibility.value.requirements.some(r=>/^member:/i.test(r)))return unresolved('membership_legacy_mapping_required');
    const slot={state:'known' as const,value:{schemaVersion:'membership-v1',status:'not_required',anyOf:[]},evidenceRefs:legacy.eligibility.evidenceRefs};
    (candidate.schemaVersion==='terms-v1'?incomingSlots:oldSlots).set('membership',slot);
  }
  for(const value of [candidate,before])if(value.schemaVersion==='terms-v2'&&(value.membership.state!=='known'||value.membership.value.status==='needs_review'))return unresolved('membership_unconfirmed');
  const validSource=evidence.sourceVerified&&!evidence.truncated;
  const anchorRefs=candidate.occurrenceAnchor.state==='known'?candidate.occurrenceAnchor.evidenceRefs:[];
  const anchorGrounded=!!anchor&&validSource&&evidenceGrounded(anchorRefs,evidence)&&anchorRefs.some(ref=>evidence.quoteById[ref].includes(anchor));
  if(anchorGrounded&&oldAnchor&&anchor!==oldAnchor)return distinct('occurrence_conflict');
  if(knownValue(candidate.mechanism)&&knownValue(before.mechanism)&&!equal(candidate.mechanism,before.mechanism))return unresolved('mechanism_conflict');
  const confirmed = evidence.confirmedEntityId===entity.id;
  const same = confirmed || (anchorGrounded&&!!oldAnchor&&anchor===oldAnchor);
  if(!same)return unresolved('identity_unproven');
  // Known fact states alone are insufficient if the incoming model's citations are fake.
  const incomingRefs=[...new Set([...incomingSlots.values()].flatMap(f=>f.state==='unknown'?[]:f.evidenceRefs))];
  if(!evidenceGrounded(incomingRefs,evidence))return unresolved('invalid_evidence_reference');
  let incomplete=false,added=false;
  for(const [field,old] of oldSlots) {
    const value=incomingSlots.get(field);
    if(!value || value.state==='unknown'){if(old.state!=='unknown')incomplete=true;continue;}
    if(old.state==='unknown'){added=true;continue;}
    const modelIds=(v:unknown)=>Array.isArray(v)?[...new Set(v.map(String).map(modelIdentityKey).filter(Boolean))].sort():v;
    const sameModels=field.endsWith('.models')&&old.state==='known'&&value.state==='known'&&equal(modelIds(old.value),modelIds(value.value));
    if(!sameModels&&!equal(old,value))result.conflicts.push({field,before:withoutEvidence(old) as never,after:withoutEvidence(value) as never,evidenceRefs:value.evidenceRefs});
  }
  for(const [field,value] of incomingSlots)if(!oldSlots.has(field)&&value.state!=='unknown')added=true;
  const poolKeys=before.benefitPools.map(p=>p.poolKey),newPoolKeys=candidate.benefitPools.map(p=>p.poolKey);
  const poolScopeChanged=poolKeys.some(key=>!newPoolKeys.includes(key))||newPoolKeys.some(key=>!poolKeys.includes(key));
  if(poolScopeChanged)return unresolved('pool_scope_unproven');
  const replacement=validSource&&result.conflicts.length>0&&result.conflicts.every(conflict=>evidenceGrounded(conflict.evidenceRefs,evidence)
    && provesFieldReplacement(conflict.field,oldSlots.get(conflict.field)!,incomingSlots.get(conflict.field)!,candidate,evidence));
  if(result.conflicts.length&&!replacement)return unresolved('replacement_unproven');
  // An automatic campaign anchor cannot disambiguate an under-extracted sub-benefit.
  // Only a server-owned human confirmation may attach incomplete/new facts.
  if((incomplete||added)&&!confirmed)return unresolved(incomplete?'partial_identity_facts':'new_identity_facts');
  if(incomplete||added)return {...result,relation:'SAME',entityId:entity.id,reasonCodes:[incomplete?'partial_facts':'new_fact_evidence'],evidenceRefs:incomingRefs};
  return {...result,relation:'SAME',entityId:entity.id,termsRelation:replacement?'CHANGED':'EQUIVALENT',matchingVersionId:replacement?null:entity.approvedVersionId,evidenceRefs:incomingRefs,reasonCodes:[replacement?'official_replacement':'equivalent_facts']};
}

const escapePattern=(value:string)=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const normalizedQuote=(value:string)=>value.normalize('NFKC').toLowerCase().replace(/\s+/gu,' ').trim();
function hasLiteral(text:string,value:string):boolean {
  const token=normalizedQuote(value);
  return new RegExp(`(?<![\\p{L}\\p{N}])${escapePattern(token)}(?![\\p{L}\\p{N}])`,'u').test(text);
}
function hasCadence(text:string,value:unknown):boolean {
  if(!value||typeof value!=='object')return false;
  const cadence=value as Record<string,unknown>;
  if(cadence.kind==='once')return /\bonce\b|one[- ]time|一次性/u.test(text);
  if(cadence.kind==='calendar') {
    if(cadence.count!==1)return false;
    if(cadence.unit==='day')return /\bdaily\b|per day|each day|每日|每天/u.test(text);
    if(cadence.unit==='week')return /\bweekly\b|per week|每周/u.test(text);
    if(cadence.unit==='month')return /\bmonthly\b|per month|每月/u.test(text);
  }
  // Rolling/timezone/action changes need explicit structured/manual review in v1.
  return false;
}
function amountPresent(text:string,value:unknown):boolean {
  if(!value||typeof value!=='object')return false;
  const amount=value as Record<string,unknown>;
  if(typeof amount.value!=='string'||typeof amount.unit!=='string')return false;
  const number=escapePattern(amount.value)+(/\./.test(amount.value)?'0*':'(?:\\.0+)?');
  const unit=amount.currency?escapePattern(String(amount.currency).toLowerCase()):escapePattern(amount.unit.toLowerCase())+'s?';
  return new RegExp(`(?<![\\d.])${number}(?!\\d|\\.\\d)\\s*${unit}(?![\\p{L}\\p{N}])|${unit}\\s*${number}(?!\\d|\\.\\d)`,'u').test(text);
}
function changedValuesPresent(text:string,before:unknown,after:unknown):boolean {
  if(equal(before,after))return true;
  if(Array.isArray(before)&&Array.isArray(after)) {
    const removed=before.filter(x=>!after.includes(x)),added=after.filter(x=>!before.includes(x));
    return [...removed,...added].every(v=>typeof v==='string'&&hasLiteral(text,v));
  }
  if(typeof before==='string'&&typeof after==='string')return hasLiteral(text,before)&&hasLiteral(text,after);
  return false;
}
/** Deliberately narrow automatic proof: replacement wording, old/new values and
 * the changed slot must share one sentence. Unsupported forms remain reviewable. */
function provesFieldReplacement(field:string,old:Fact<unknown>,incoming:Fact<unknown>,terms:CanonicalTermsV1,evidence:EvidenceContext):boolean {
  if(old.state!=='known'||incoming.state!=='known')return false;
  return incoming.evidenceRefs.some(ref=>evidence.quoteById[ref].split(/(?<=[.!?。！？])\s+|\n/u).some(raw=>{
    const sentence=normalizedQuote(raw);
    const replacement=sentence.match(/\breplac(?:e|es|ed|ing)\s+(.{1,180}?)\s+(?:with|by)\s+(.{1,180})/u)
      ?? sentence.match(/\bfrom\s+(.{1,180}?)\s+to\s+(.{1,180})/u)
      ?? sentence.match(/(.{1,180}?)(?:改为|调整为)(.{1,180})/u);
    if(!replacement)return false;
    const beforeText=replacement[1],afterText=replacement[2];
    if(field.startsWith('benefitPools.')) {
      const pool=terms.benefitPools.find(p=>field.startsWith(`benefitPools.${p.poolKey}.`));
      if(!pool)return false;
      if(terms.benefitPools.length>1&&(!sentence.includes(pool.poolKey.toLowerCase())||terms.benefitPools.some(p=>p.poolKey!==pool.poolKey&&sentence.includes(p.poolKey.toLowerCase()))))return false;
      if(field.endsWith('.amount'))return amountPresent(beforeText,old.value)&&amountPresent(afterText,incoming.value);
      if(field.endsWith('.cadence'))return hasCadence(beforeText,old.value)&&hasCadence(afterText,incoming.value);
      if(field.endsWith('.models')||field.endsWith('.modalities'))return changedValuesPresent(sentence,old.value,incoming.value);
      return false;
    }
    if(field==='eligibility') {
      if(!/eligib|audience|qualif|资格|适用|对象/u.test(sentence))return false;
      const a=old.value as {audience:string;requirements:string[]},b=incoming.value as {audience:string;requirements:string[]};
      const audience=(value:string)=>value==='all'?/all[- ]users?|everyone|所有用户/u.test(sentence):value==='new'?/new[- ](?:users?|accounts?|student)|新用户/u.test(sentence):/existing[- ](?:users?|accounts?)|老用户/u.test(sentence);
      return (a.audience===b.audience||(audience(a.audience)&&audience(b.audience)))&&changedValuesPresent(sentence,a.requirements,b.requirements);
    }
    if(field==='geography'||field==='claimChannels')return changedValuesPresent(sentence,old.value,incoming.value);
    if(field==='claimWindow') {
      const a=old.value as Record<string,unknown>,b=incoming.value as Record<string,unknown>;
      return Object.keys(a).filter(key=>a[key]!==b[key]).every(key=>{
        const label=key==='startsAt'?/start|begin|开始/u:key==='endsAt'?/deadline|end|until|截止/u:/timezone|时区/u;
        return label.test(sentence)&&typeof a[key]==='string'&&typeof b[key]==='string'&&hasLiteral(beforeText,String(a[key]))&&hasLiteral(afterText,String(b[key]));
      });
    }
    if(field==='costs') {
      const a=old.value as Record<string,unknown>,b=incoming.value as Record<string,unknown>;
      return Object.keys(a).filter(key=>a[key]!==b[key]).every(key=>{
        if(key==='upfrontAmount'||key==='currency')return /upfront|cost|pay|费用|支付/u.test(sentence)
          &&amountPresent(beforeText,{value:a.upfrontAmount,unit:'currency',currency:a.currency})&&amountPresent(afterText,{value:b.upfrontAmount,unit:'currency',currency:b.currency});
        const label=key==='autoRenewal'?/automatic renewal|auto[- ]?renew|自动续费/u:key==='subscriptionRequired'?/subscription|订阅/u:null;
        const proof=(value:unknown,text:string)=>typeof value==='boolean'&&!!label?.test(text)&&(/\bno\b|without|not required|不|无需/u.test(text)?value===false:value===true);
        return proof(a[key],beforeText)&&proof(b[key],afterText);
      });
    }
    return false;
  }));
}
