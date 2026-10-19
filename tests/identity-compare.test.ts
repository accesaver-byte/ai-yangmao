import { expect,it } from 'vitest';
import { compareCandidate } from '../src/shared/identity/compare';
import { known,terms,unknown } from './fixtures/identity/terms';
import type { EvidenceContext, VersionedEntity } from '../src/shared/identity/types';
const entity=():VersionedEntity=>({id:'entity-1',platformId:'vendor',revision:1,publicationRevision:1,approvedVersionId:'version-1',terms:terms()});
const context=(quote='Campaign signup-2026 grants 10 USD.'):EvidenceContext=>({observationId:'obs-1',fullText:quote,truncated:false,sourceVerified:true,quoteById:{'quote-1':quote}});
function anchored(){const candidate=terms(),old=entity();candidate.occurrenceAnchor=known('signup-2026');old.terms!.occurrenceAnchor=known('signup-2026');return {candidate,old};}
it('official model aliases are equivalent facts while sizes and modes remain conflicts',()=>{
 const {candidate,old}=anchored();old.terms!.benefitPools[0].models=known(['GLM-5.3-Flash','Qwen3.8-27B']);
 candidate.benefitPools[0].models=known(['glm-5-3-flash','Qwen/Qwen3.8-27B','GLM 5.3 Flash']);
 expect(compareCandidate(candidate,old,context())).toMatchObject({relation:'SAME',termsRelation:'EQUIVALENT'});
 candidate.benefitPools[0].models=known(['GLM-5.3-FlashX','Qwen3.8-35B']);
 expect(compareCandidate(candidate,old,context()).relation).not.toBe('SAME');
});
it('A09 confirmed multilingual campaign with equivalent facts adds evidence without changing terms',()=>{
 const {candidate,old}=anchored();const proof=context('活动 signup-2026 注册赠送 10 美元。');
 expect(compareCandidate(candidate,old,proof)).toMatchObject({relation:'SAME',termsRelation:'EQUIVALENT',entityId:'entity-1'});
});
it('A10 same title/amount but independent eligibility cannot establish identity',()=>{
 const candidate=terms(),old=entity();candidate.eligibility=known({audience:'all',requirements:['student']});old.terms!.eligibility=known({audience:'all',requirements:['business']});
 expect(compareCandidate(candidate,old,context()).relation).not.toBe('SAME');
});
it('A11 actual issuer wins over a common parent or a shared model',()=>{
 const {candidate,old}=anchored();candidate.issuerProductId=known('another-product');
 expect(compareCandidate(candidate,old,context())).toMatchObject({relation:'DISTINCT',reasonCodes:expect.arrayContaining(['product_conflict'])});
});
it.each(['models','pool','geography','channel'] as const)('A12 unproven %s scope replacement cannot merge',field=>{
 const {candidate,old}=anchored();
 if(field==='models')candidate.benefitPools[0].models=known(['model-v2-fast']);
 if(field==='pool')candidate.benefitPools[0].poolKey='vendor:video';
 if(field==='geography'){candidate.geography=known(['US']);old.terms!.geography=known(['EU']);}
 if(field==='channel'){candidate.claimChannels=known(['desktop']);old.terms!.claimChannels=known(['api']);}
 expect(compareCandidate(candidate,old,context()).termsRelation).not.toBe('EQUIVALENT');
 expect(compareCandidate(candidate,old,context()).relation).not.toBe('SAME');
});
it('A13 same-day independent resets remain distinct despite otherwise equal facts',()=>{
 const {candidate,old}=anchored();candidate.occurrenceAnchor=known('reset-two');old.terms!.occurrenceAnchor=known('reset-one');
 expect(compareCandidate(candidate,old,context('reset-two grants 10 USD.'))).toMatchObject({relation:'DISTINCT'});
});
it('A14 same digits with a grounded cadence replacement are SAME CHANGED',()=>{
 const {candidate,old}=anchored();old.terms!.benefitPools[0].cadence=known({kind:'calendar',unit:'day',count:1,timezone:'UTC'});candidate.benefitPools[0].cadence=known({kind:'calendar',unit:'month',count:1,timezone:'UTC'});
 expect(compareCandidate(candidate,old,context('Campaign signup-2026 replaces daily grants with monthly grants, effective today.'))).toMatchObject({relation:'SAME',termsRelation:'CHANGED'});
});
it('A15 amounts and quoted text presentation drift do not constitute changed facts',()=>{
 const {candidate,old}=anchored();candidate.benefitPools[0].amount=known({value:'10.00',unit:'currency',currency:'USD'});
 expect(compareCandidate(candidate,old,context())).toMatchObject({relation:'SAME',termsRelation:'EQUIVALENT'});
});
it('A16 trusted scope replacement needs wording from the relevant quote',()=>{
 const {candidate,old}=anchored();candidate.eligibility=known({audience:'new',requirements:['student']});old.terms!.eligibility=known({audience:'all',requirements:[]});
 expect(compareCandidate(candidate,old,context('Campaign signup-2026 now replaces all-user eligibility with new student accounts only.'))).toMatchObject({relation:'SAME',termsRelation:'CHANGED'});
 const proof=context('Campaign signup-2026 is available to students.');proof.fullText+=' Other campaign now replaces old terms.';
 expect(compareCandidate(candidate,old,proof).termsRelation).toBe('INSUFFICIENT');
});
it('A17 restored historical terms are compared with the current approved B version',()=>{
 const {candidate,old}=anchored();old.terms!.benefitPools[0].amount=known({value:'20',unit:'currency',currency:'USD'});
 expect(compareCandidate(candidate,old,context('Campaign signup-2026 now replaces 20 USD with 10 USD.'))).toMatchObject({relation:'SAME',termsRelation:'CHANGED',matchingVersionId:null});
});
it('A08 omissions never erase known facts; wholly vague candidates are insufficient',()=>{
 const {candidate,old}=anchored();candidate.benefitPools[0].amount=unknown;
 expect(compareCandidate(candidate,old,context()).termsRelation).toBe('INSUFFICIENT');
 expect(old.terms!.benefitPools[0].amount).toEqual(known({value:'10',unit:'currency',currency:'USD'}));
});
it('A19 unverified/truncated/forged anchor references cannot prove identity or replacement',()=>{
 for(const patch of [{sourceVerified:false},{truncated:true},{quoteById:{'quote-1':'not in source'}}]){
  const {candidate,old}=anchored();expect(compareCandidate(candidate,old,{...context(),...patch}).relation).toBe('UNRESOLVED');
 }
});
it('A29 manual different is a hard veto even over an exact campaign or model suggestion',()=>{
 const {candidate,old}=anchored();
 expect(compareCandidate(candidate,old,{...context(),differentEntityIds:['entity-1']})).toMatchObject({relation:'DISTINCT',reasonCodes:expect.arrayContaining(['manual_different'])});
});
it('A10 independent mechanisms cannot be merged merely because the same umbrella campaign is quoted',()=>{
 const {candidate,old}=anchored();candidate.mechanism=known('recurring_quota');
 expect(compareCandidate(candidate,old,context('Campaign signup-2026 replaces an unrelated page notice.'))).toMatchObject({relation:'UNRESOLVED',reasonCodes:expect.arrayContaining(['mechanism_conflict'])});
});
it('A16 unrelated replacement wording cannot authorize an invented amount',()=>{
 const {candidate,old}=anchored();candidate.benefitPools[0].amount=known({value:'999',unit:'currency',currency:'USD'});
 expect(compareCandidate(candidate,old,context('Campaign signup-2026 grants 10 USD. A new logo replaces the old logo.')).termsRelation).toBe('INSUFFICIENT');
});
it('A12 one pool replacement cannot authorize a change in a second pool',()=>{
 const {candidate,old}=anchored();
 candidate.benefitPools.push({...structuredClone(candidate.benefitPools[0]),poolKey:'vendor:video'});
 old.terms!.benefitPools.push({...structuredClone(old.terms!.benefitPools[0]),poolKey:'vendor:video'});
 candidate.benefitPools[1].amount=known({value:'20',unit:'currency',currency:'USD'});
 expect(compareCandidate(candidate,old,context('Campaign signup-2026 vendor:api replaces 10 USD with 20 USD. vendor:video remains 10 USD.')).termsRelation).toBe('INSUFFICIENT');
});
it('A16 explicit claim deadline and renewal replacements produce CHANGED without publishing',()=>{
 const {candidate,old}=anchored();
 old.terms!.claimWindow=known({startsAt:null,endsAt:'2026-10-31',timezone:'UTC'});candidate.claimWindow=known({startsAt:null,endsAt:'2026-11-30',timezone:'UTC'});
 expect(compareCandidate(candidate,old,context('Campaign signup-2026 replaces the claim deadline 2026-10-31 with claim deadline 2026-11-30.'))).toMatchObject({relation:'SAME',termsRelation:'CHANGED'});
 const a=anchored();a.old.terms!.costs=known({upfrontAmount:'0',currency:'USD',subscriptionRequired:false,autoRenewal:false});a.candidate.costs=known({upfrontAmount:'0',currency:'USD',subscriptionRequired:false,autoRenewal:true});
 expect(compareCandidate(a.candidate,a.old,context('Campaign signup-2026 replaces no automatic renewal with automatic renewal.'))).toMatchObject({relation:'SAME',termsRelation:'CHANGED'});
});
it('A19 replacement direction must agree with the proposed after-value',()=>{
 const {candidate,old}=anchored();candidate.benefitPools[0].amount=known({value:'20',unit:'currency',currency:'USD'});
 expect(compareCandidate(candidate,old,context('Campaign signup-2026 replaces 20 USD with 10 USD.')).termsRelation).toBe('INSUFFICIENT');
});
it('A08/A10 an automatic anchor with omitted or newly discovered facts cannot prove the same activity',()=>{
 const {candidate,old}=anchored();candidate.benefitPools[0].amount=unknown;
 expect(compareCandidate(candidate,old,context('Umbrella campaign signup-2026: a separate student signup bonus grants 20 USD.'))).toMatchObject({relation:'UNRESOLVED',entityId:null,termsRelation:'INSUFFICIENT'});
 const added=anchored();added.candidate.eligibility=known({audience:'new',requirements:['student']});
 expect(compareCandidate(added.candidate,added.old,context('Campaign signup-2026 grants a separate student benefit.'))).toMatchObject({relation:'UNRESOLVED',entityId:null});
});
