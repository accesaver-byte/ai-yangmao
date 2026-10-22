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

// 2026-10-22: the owner's "same as" on a sibling page (locale or listing variant) is remembered for later re-reads.
async function readPage(f:ReturnType<typeof auditFixture>,offer:ReturnType<typeof displayOffer>,url:string,page:string,benefit:string,method:'direct'|'jina'='direct',fields:Record<string,unknown>={}){
 const sourceFetch={originalUrl:url,finalUrl:url,fetchedUrl:method==='jina'?'https://r.jina.ai/'+url:url,method,sourceVerified:method==='direct',truncated:false,contentHash:await sha256(page)};
 return f.call('ingest/offers',[{...offer,id:'vendor-zh-pricing-'+(await sha256(page+url)).slice(0,6),title:'注册即送 API 额度',valueText:'新用户注册后可获得 10 美元 API 赠额',...fields,evidence:{...offer.evidence,url,excerpts:{benefit}},sourceText:page,sourceFetch,identityRequestId:'sibling-'+(await sha256(page+url+method)).slice(0,12)}]);
}
const sibling='https://vendor.example/zh/rewards',zhQuote='活动 signup-2026 赠送 10 美元。';
async function ownerSame(f:ReturnType<typeof auditFixture>,offer:ReturnType<typeof displayOffer>,receipt:{taskId:string;candidateId:string}){
 const entityId=(f.sqlite.prepare('SELECT id FROM benefit_entities WHERE canonical_offer_id=?').get(offer.id) as any).id;
 const rev=(f.sqlite.prepare('SELECT revision FROM review_tasks WHERE id=?').get(receipt.taskId) as any).revision;
 const r=await f.call('admin/identity/tasks/'+receipt.taskId+'/resolve',{requestId:'sibling-same-'+receipt.taskId.slice(0,8),expectedRevision:rev,action:'same',candidateId:receipt.candidateId,entityId,reason:'与已上架的注册礼重复'},true);
 expect(r.status,JSON.stringify(r.body)).toBe(200);
}
it('a sibling page the owner confirmed once is re-read without a new card',async()=>{
 const {f,offer}=await approvedFixture();try{
  const first=(await readPage(f,offer,sibling,`价格\n${zhQuote}\n常见问题`,zhQuote)).body.results[0].identityReceipt;
  expect(first.outcome).toBe('needs_identity_review');
  await ownerSame(f,offer,first);
  const before=tasks(f);
  const again=(await readPage(f,offer,sibling,`价格（更新）\n${zhQuote}\n常见问题与帮助`,zhQuote,'direct',{title:'注册送 10 美元'})).body.results[0].identityReceipt;
  expect(again).toMatchObject({outcome:'duplicate_approved',canonicalOfferId:offer.id,reasonCodes:['same_source_reread']});
  expect(tasks(f)).toEqual(before);
 }finally{f.sqlite.close();}
});
it('a remembered sibling page that drops the confirmed wording, or states a new amount, still goes to the owner',async()=>{
 const {f,offer}=await approvedFixture();try{
  const first=(await readPage(f,offer,sibling,`价格\n${zhQuote}`,zhQuote)).body.results[0].identityReceipt;await ownerSame(f,offer,first);
  const changed=(await readPage(f,offer,sibling,'价格\n活动 signup-2026 赠送 5 美元。','活动 signup-2026 赠送 5 美元。','direct',{valueText:'新用户注册后可获得 5 美元 API 赠额'})).body.results[0].identityReceipt;
  expect(changed.outcome).not.toBe('duplicate_approved');
  const added=(await readPage(f,offer,sibling,`价格\n${zhQuote}\n另送 500 积分`,zhQuote,'direct',{valueText:'新用户注册后可获得 10 美元 API 赠额，另送 500 积分'})).body.results[0].identityReceipt;
  expect(added.outcome).not.toBe('duplicate_approved');
 }finally{f.sqlite.close();}
});
it('a confirmation covers only the page it was made on',async()=>{
 const {f,offer}=await approvedFixture();try{
  const first=(await readPage(f,offer,sibling,`价格\n${zhQuote}`,zhQuote)).body.results[0].identityReceipt;await ownerSame(f,offer,first);
  expect((await readPage(f,offer,'https://vendor.example/ja/rewards',`料金\n${zhQuote}`,zhQuote)).body.results[0].identityReceipt.outcome).not.toBe('duplicate_approved');
 }finally{f.sqlite.close();}
});
it('a registered official page read through Jina confirms a re-read when the approved wording is still on it',async()=>{
 const {f,offer}=await approvedFixture();try{
  const page=`Pricing\n${offer.evidence.excerpts.benefit}\nFAQ`;
  const r=(await readPage(f,offer,offer.evidence.url,page,offer.evidence.excerpts.benefit!,'jina')).body.results[0].identityReceipt;
  expect(f.sqlite.prepare("SELECT fetch_kind FROM source_observations ORDER BY rowid DESC LIMIT 1").get()).toEqual({fetch_kind:'indirect'});
  expect(r).toMatchObject({outcome:'duplicate_approved',canonicalOfferId:offer.id,reasonCodes:['same_source_reread']});
  const changed=(await readPage(f,offer,offer.evidence.url,'Pricing\nCampaign signup-2026 grants 5 USD.','Campaign signup-2026 grants 5 USD.','jina',{valueText:'新用户注册后可获得 5 美元 API 赠额'})).body.results[0].identityReceipt;
  expect(changed.outcome).not.toBe('duplicate_approved');
 }finally{f.sqlite.close();}
});
