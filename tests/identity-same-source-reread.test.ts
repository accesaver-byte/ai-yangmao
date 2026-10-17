import {it,expect} from 'vitest';
import {auditFixture} from './fixtures/identity/audit';
import {displayOffer} from './fixtures/identity/offer';
import {captureLocalSnapshot,buildBackfillPlan,applyBackfillPage} from '../scripts/identity/backfill';
import {sha256} from '../src/shared/identity/normalize';
const context={environment:'synthetic' as const,sourceDatabaseId:'reread-fixture',sourceCodeSha:'b'.repeat(40),approvedBy:'fixture-admin'};
// 2026-10-15：免费模型每 6 小时重读已批准的价格/文档页，不给结构化事实且换措辞，旧的精确指纹从不命中，每次都生成人工身份任务。
async function approvedFixture(){
 const f=auditFixture();const offer=displayOffer();
 await f.call('ingest/offers',[offer],false,{IDENTITY_MODE:'off'});f.sqlite.prepare("UPDATE offers SET review_state='approved'").run();
 const plan=await buildBackfillPlan(await captureLocalSnapshot(f.db,context));await applyBackfillPage(f.db,plan,{environment:'synthetic',approvedPlanHash:plan.planHash,actor:'fixture-admin'});
 return {f,offer};
}
async function reread(f:ReturnType<typeof auditFixture>,offer:ReturnType<typeof displayOffer>,page:string,overrides:Record<string,unknown>={}){
 const url=(overrides.url as string|undefined)??offer.evidence.url;
 const sourceFetch={originalUrl:url,finalUrl:url,fetchedUrl:url,method:'direct',sourceVerified:true,truncated:false,contentHash:await sha256(page)};
 const {url:_url,...fields}=overrides;
 return f.call('ingest/offers',[{...offer,title:'注册即送 API 额度',valueText:'新用户注册后可获得 10 美元 API 赠额',...fields,evidence:{...offer.evidence,url},sourceText:page,sourceFetch,identityRequestId:'reread-'+(await sha256(page+url+JSON.stringify(fields))).slice(0,12)}]);
}
const tasks=(f:ReturnType<typeof auditFixture>)=>f.sqlite.prepare("SELECT count(*) n FROM review_tasks WHERE state<>'resolved'").get();
it('a reworded re-read of the same official page that still carries the approved wording needs no task',async()=>{
 const {f,offer}=await approvedFixture();try{
  const before=tasks(f);
  const page=`Pricing\n${offer.evidence.excerpts.benefit}\n${offer.evidence.excerpts.eligibility}\nFAQ`;
  const response=await reread(f,offer,page);
  expect(response.status).toBe(200);
  expect(response.body.results[0].identityReceipt).toMatchObject({outcome:'duplicate_approved',canonicalOfferId:offer.id,taskId:null,reasonCodes:['same_source_reread']});
  expect(tasks(f)).toEqual(before);
  expect(f.sqlite.prepare('SELECT value_text FROM offers WHERE id=?').get(offer.id)).toEqual({value_text:offer.valueText});
 }finally{f.sqlite.close();}
});
it('a page that no longer carries the approved wording still goes to review',async()=>{
 const {f,offer}=await approvedFixture();try{
  const response=await reread(f,offer,'Pricing\nCampaign signup-2026 grants 5 USD.\nAll new accounts qualify.');
  expect(response.status).toBe(200);
  expect(response.body.results[0].identityReceipt?.outcome).not.toBe('duplicate_approved');
 }finally{f.sqlite.close();}
});
it('a different page cannot borrow the approved activity',async()=>{
 const {f,offer}=await approvedFixture();try{
  const response=await reread(f,offer,`${offer.evidence.excerpts.benefit}`,{url:'https://vendor.example/other'});
  expect(response.status).toBe(200);
  expect(response.body.results[0].identityReceipt?.outcome).not.toBe('duplicate_approved');
 }finally{f.sqlite.close();}
});

// 2026-10-16: the extractor invents a new offer ID slug and new wording on every run; the page and the anchors decide.
it('a re-read under a new model-made ID and reworded title still resolves to the approved perk',async()=>{
 const {f,offer}=await approvedFixture();try{
  const benefit=offer.evidence.excerpts.benefit!;
  const page=`Pricing\n${benefit}\nFAQ`;
  const response=await reread(f,offer,page,{id:'vendor-vendor-signup-credit-renamed',title:'Vendor 新用户 API 赠额'});
  expect(response.body.results[0].identityReceipt).toMatchObject({outcome:'duplicate_approved',canonicalOfferId:offer.id,reasonCodes:['same_source_reread']});
 }finally{f.sqlite.close();}
});
it('a re-read that states a new amount goes to the owner even though the approved quote is still on the page',async()=>{
 const {f,offer}=await approvedFixture();try{
  const page=`Pricing\n${offer.evidence.excerpts.benefit}\nNow also 500 bonus credits.`;
  const response=await reread(f,offer,page,{id:'vendor-vendor-signup-credit-v2',valueText:'新用户注册后可获得 10 美元 API 赠额，另送 500 积分'});
  expect(response.body.results[0].identityReceipt?.outcome).not.toBe('duplicate_approved');
 }finally{f.sqlite.close();}
});
// 2026-10-16 即梦 card: the owner links an unverified card to a listed perk without choosing a claim mechanism.
it('the owner can confirm an unverified card is the same as a listed perk without supplying facts',async()=>{
 const {f,offer}=await approvedFixture();try{
  const {canonicalTermsSchema}=await import('../src/shared/identity/types');
  const {unknown}=await import('./fixtures/identity/terms');
  const text='Media says new users get the signup credit.';
  const observed=await f.call('ingest/observations',{requestId:'owner-same-ob',originalUrl:'https://vendor.example/media-copy',finalUrl:'https://vendor.example/media-copy',text,sourceId:'vendor-source',fetchKind:'indirect',observedAt:'2026-10-12T10:00:00Z'});
  const facts=canonicalTermsSchema.parse({schemaVersion:'terms-v1',issuerProductId:unknown,mechanism:unknown,benefitPools:[],eligibility:unknown,geography:unknown,claimChannels:unknown,costs:unknown,claimWindow:unknown,occurrenceAnchor:unknown});
  const c=await f.candidate('owner-same',observed.body.observationId,text,facts,{id:'vendor-other-promo-copy',title:'Vendor 社区转述的体验活动',valueText:'转述：体验 7 次',type:'trial'});
  const task=(await f.call('ingest/identity-candidates/'+c.candidateId+'/resolve',{requestId:'owner-same-create'})).body;
  expect(task.taskId,JSON.stringify(task).slice(0,300)).toBeTruthy();
  const entityId=(f.sqlite.prepare('SELECT id FROM benefit_entities WHERE canonical_offer_id=?').get(offer.id) as any).id;
  const rev=(f.sqlite.prepare('SELECT revision FROM review_tasks WHERE id=?').get(task.taskId) as any).revision;
  const r=await f.call('admin/identity/tasks/'+task.taskId+'/resolve',{requestId:'owner-same-decide',expectedRevision:rev,action:'same',candidateId:c.candidateId,entityId,reason:'与已上架的注册礼重复'},true);
  expect(r.status,JSON.stringify(r.body)).toBe(200);
  expect(r.body.canonicalOfferId).toBe(offer.id);
  expect(f.sqlite.prepare('SELECT state FROM review_tasks WHERE id=?').get(task.taskId)).toEqual({state:'resolved'});
 }finally{f.sqlite.close();}
});
