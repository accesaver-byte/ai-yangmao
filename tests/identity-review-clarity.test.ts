import {it,expect} from 'vitest';
import {auditFixture} from './fixtures/identity/audit';
import {displayOffer} from './fixtures/identity/offer';
import {unknown} from './fixtures/identity/terms';
import {canonicalTermsSchema} from '../src/shared/identity/types';

it('A candidate with unknown identity shows its actual activity and provenance while remaining undecided',async()=>{
 const f=auditFixture();try{
  const source='Campaign signup-2026 grants 10 USD to new individual accounts.';
  const observation=await f.observation('identity-card',source);
  const facts=canonicalTermsSchema.parse({schemaVersion:'terms-v1',issuerProductId:unknown,mechanism:unknown,benefitPools:[],eligibility:unknown,geography:unknown,claimChannels:unknown,costs:unknown,claimWindow:unknown,occurrenceAnchor:unknown});
  const candidate=await f.candidate('identity-card',observation,source,facts,{id:'candidate-signup',title:'真实的注册赠额候选',valueText:'新用户赠 10 USD'});
  const receipt=await f.call('ingest/identity-candidates/'+candidate.candidateId+'/resolve',{requestId:'identity-card-resolve'});
  expect(receipt.status).toBe(200);expect(receipt.body.outcome).toBe('needs_identity_review');
  const page=await f.call('admin/identity/tasks',undefined,true);const task=page.body.tasks.find((x:any)=>x.id===receipt.body.taskId);
  expect(task.candidateDisplay).toMatchObject({title:'真实的注册赠额候选',valueText:'新用户赠 10 USD',platformId:'vendor'});
  expect(task.sources[0].provenance).toMatchObject({sourceVerified:true,productId:'vendor'});
  expect(task.reviewPreparation).toMatchObject({state:'needs_system_review',canDecide:false});
  expect(f.sqlite.prepare('SELECT count(*) n FROM offers').get()).toEqual({n:0});
 }finally{f.sqlite.close();}
});
it('a single unprepared claim can be explicitly rejected with a narrow scope and audit reason',async()=>{
 const f=auditFixture();try{
  const text='A repeated announcement claims a free signup benefit.';
  const observed=await f.call('ingest/observations',{requestId:'manual-reject-ob',originalUrl:'https://vendor.example/repeated',finalUrl:'https://vendor.example/repeated',text,sourceId:'vendor-source',fetchKind:'indirect',observedAt:'2026-10-12T10:00:00Z'});
  const facts=canonicalTermsSchema.parse({schemaVersion:'terms-v1',issuerProductId:unknown,mechanism:unknown,benefitPools:[],eligibility:unknown,geography:unknown,claimChannels:unknown,costs:unknown,claimWindow:unknown,occurrenceAnchor:unknown});
  const candidate=await f.candidate('manual-reject',observed.body.observationId,text,facts,{id:'repeated-candidate',title:'明显重复的候选'});
  const task=(await f.call('ingest/identity-candidates/'+candidate.candidateId+'/resolve',{requestId:'manual-reject-task'})).body;
  expect((await f.call('admin/identity/tasks',undefined,true)).body.tasks.find((item:any)=>item.id===task.taskId).reviewPreparation.canDecide).toBe(false);
  const rejected=await f.call('admin/identity/tasks/'+task.taskId+'/resolve',{requestId:'manual-reject-decision',expectedRevision:0,action:'reject',reasonCode:'other',reason:'人工已核对原拒绝记录，确认本条重复且不应收录',scope:{kind:'claim',candidateId:candidate.candidateId}},true);
  expect(rejected.status,JSON.stringify(rejected.body)).toBe(200);expect(rejected.body.decisionId).toEqual(expect.any(String));
  expect(f.sqlite.prepare('SELECT action,reason_text FROM review_decisions WHERE id=?').get(rejected.body.decisionId)).toEqual({action:'reject',reason_text:'人工已核对原拒绝记录，确认本条重复且不应收录'});
  expect(f.sqlite.prepare('SELECT state FROM review_tasks WHERE id=?').get(task.taskId)).toEqual({state:'resolved'});
  expect(f.sqlite.prepare('SELECT count(*) n FROM offers').get()).toEqual({n:0});
 }finally{f.sqlite.close();}
});
it('an early suspected-duplicate hint persists through automatic preparation without creating a decision',async()=>{
 const f=auditFixture();try{
  const text='Official campaign grants a free benefit to new accounts.',o=await f.observation('human-hint',text);
  const facts=canonicalTermsSchema.parse({schemaVersion:'terms-v1',issuerProductId:unknown,mechanism:unknown,benefitPools:[],eligibility:unknown,geography:unknown,claimChannels:unknown,costs:unknown,claimWindow:unknown,occurrenceAnchor:unknown});
  const candidate=await f.candidate('human-hint',o,text,facts,{id:'human-hint',title:'疑似重复的候选'});
  const task=(await f.call('ingest/identity-candidates/'+candidate.candidateId+'/resolve',{requestId:'human-hint-create'})).body;
  const hint=await f.call('admin/identity/tasks/'+task.taskId+'/hint',{requestId:'human-hint-write',expectedRevision:0,kind:'suspected_duplicate',reason:'人工核对标题与原文，疑似旧活动再次报送'},true);
  expect(hint.status,JSON.stringify(hint.body)).toBe(200);expect(hint.body.revision).toBe(1);
  expect((await f.call('admin/identity/tasks/'+task.taskId+'/hint',{requestId:'human-hint-write',expectedRevision:0,kind:'suspected_duplicate',reason:'人工核对标题与原文，疑似旧活动再次报送'},true)).body).toEqual(hint.body);
  expect((await f.call('admin/identity/tasks/'+task.taskId+'/hint',{requestId:'stale-human-hint',expectedRevision:0,kind:'previously_rejected',reason:'另一个旧拒绝主张的依据尚未核实'},true)).status).toBe(409);
  expect((await f.call('admin/identity/tasks',undefined,true)).body.tasks.find((item:any)=>item.id===task.taskId).reviewPreparation.state).toBe('history_incomplete');
  const scanned=await f.call('ingest/identity-preparations/'+task.taskId+'/scan',{requestId:'human-hint-scan',expectedRevision:1});expect(scanned.status).toBe(200);
  const card=(await f.call('admin/identity/tasks',undefined,true)).body.tasks.find((item:any)=>item.id===task.taskId);
  expect(card.reviewPreparation.manualHint).toMatchObject({kind:'suspected_duplicate',reason:'人工核对标题与原文，疑似旧活动再次报送'});
  expect(f.sqlite.prepare('SELECT count(*) n FROM offers').get()).toEqual({n:0});
  expect(f.sqlite.prepare('SELECT count(*) n FROM review_decisions').get()).toEqual({n:0});
 }finally{f.sqlite.close();}
});
it('an imminent unknown-identity candidate exposes its deadline without unlocking publication',async()=>{
 const f=auditFixture();try{
  const text='Campaign deadline grants a free benefit to new accounts.',o=await f.observation('imminent-card',text);
  const facts=canonicalTermsSchema.parse({schemaVersion:'terms-v1',issuerProductId:unknown,mechanism:unknown,benefitPools:[],eligibility:unknown,geography:unknown,claimChannels:unknown,costs:unknown,claimWindow:unknown,occurrenceAnchor:unknown});
  const end=new Date(Date.now()+2*86400_000).toISOString().slice(0,10);
  const candidate=await f.candidate('imminent-card',o,text,facts,{id:'imminent-card',title:'两天后截止的福利',endKind:'date',claimEnd:end});
  const created=await f.call('ingest/identity-candidates/'+candidate.candidateId+'/resolve',{requestId:'imminent-card-resolve'});
  const task=(await f.call('admin/identity/tasks',undefined,true)).body.tasks.find((x:any)=>x.id===created.body.taskId);
  expect(task.reviewPreparation).toMatchObject({urgency:'imminent',deadline:end,canDecide:false});
 }finally{f.sqlite.close();}
});
it('identity history comparison paginates the whole verified issuer scope and exposes old activity labels',async()=>{
 const f=auditFixture();try{
  for(let i=0;i<41;i++)f.sqlite.prepare("INSERT INTO benefit_entities(id,platform_id) VALUES(?,'vendor')").run('historical-'+String(i).padStart(2,'0'));
  const source='Campaign signup-2026 grants 10 USD to new individual accounts.';
  const observation=await f.observation('history-scan',source);
  const facts=canonicalTermsSchema.parse({schemaVersion:'terms-v1',issuerProductId:unknown,mechanism:unknown,benefitPools:[],eligibility:unknown,geography:unknown,claimChannels:unknown,costs:unknown,claimWindow:unknown,occurrenceAnchor:unknown});
  const candidate=await f.candidate('history-scan',observation,source,facts,{id:'candidate-new',title:'新人注册赠额',valueText:'10 USD'});
  const task=await f.call('ingest/identity-candidates/'+candidate.candidateId+'/resolve',{requestId:'history-scan-resolve'});
  const id=task.body.taskId;
  const first=await f.call('admin/identity/tasks/'+id+'/comparisons',undefined,true);
  expect(first.status).toBe(200);expect(first.body).toMatchObject({complete:false,issuerProductId:'vendor'});expect(first.body.entries).toHaveLength(40);expect(first.body.nextCursor).toEqual(expect.any(String));
  const second=await f.call('admin/identity/tasks/'+id+'/comparisons?cursor='+encodeURIComponent(first.body.nextCursor),undefined,true);
  expect(second.status).toBe(200);expect(second.body).toMatchObject({complete:true});expect(second.body.entries).toHaveLength(1);
  expect(new Set([...first.body.entries,...second.body.entries].map((x:any)=>x.entityId)).size).toBe(41);
 }finally{f.sqlite.close();}
});
it('system preparation advances a 41-entity history scan across bounded requests without asking for a guessed identity',async()=>{
 const f=auditFixture();try{
  await f.call('ingest/offers',[displayOffer()],false,{IDENTITY_MODE:'off'});
  const original=f.sqlite.prepare("SELECT * FROM offers WHERE id='vendor-signup'").get()!,columns=Object.keys(original);
  for(let i=0;i<41;i++){const key=String(i).padStart(2,'0'),offerId='historical-offer-'+key,entityId='historical-'+key;
   f.sqlite.prepare(`INSERT INTO offers(${columns.join(',')}) VALUES(${columns.map(()=>'?').join(',')})`).run(...columns.map(column=>column==='id'?offerId:column==='title'?'同平台历史活动 '+key:original[column]));
   f.sqlite.prepare("INSERT INTO benefit_entities(id,platform_id,canonical_offer_id) VALUES(?,'vendor',?)").run(entityId,offerId);
  }
  const text='Campaign signup-2026 grants 10 USD to new individual accounts.',o=await f.observation('automatic-scan',text);
  const facts=canonicalTermsSchema.parse({schemaVersion:'terms-v1',issuerProductId:unknown,mechanism:unknown,benefitPools:[],eligibility:unknown,geography:unknown,claimChannels:unknown,costs:unknown,claimWindow:unknown,occurrenceAnchor:unknown});
  const c=await f.candidate('automatic-scan',o,text,facts,{id:'unreviewed-grant',title:'新用户独立优惠',valueText:'10 USD'});
  const receipt=await f.call('ingest/identity-candidates/'+c.candidateId+'/resolve',{requestId:'automatic-scan-create'});const taskId=receipt.body.taskId;
  const beforeEvents=f.sqlite.prepare('SELECT count(*) n FROM identity_events').get();
  const queued=await f.call('ingest/identity-preparations');expect(queued.status).toBe(200);expect(queued.body.tasks.map((t:any)=>t.id)).toContain(taskId);
  const first=await f.call('ingest/identity-preparations/'+taskId+'/scan',{requestId:'automatic-scan-1',expectedRevision:0});expect(first.status).toBe(200);expect(first.body).toMatchObject({status:'scanning',scanned:40});
  const second=await f.call('ingest/identity-preparations/'+taskId+'/scan',{requestId:'automatic-scan-2',expectedRevision:first.body.revision});expect(second.status).toBe(200);expect(second.body).toMatchObject({status:'ready',scanned:41});
  const admin=await f.call('admin/identity/tasks',undefined,true);expect(admin.body.tasks.find((t:any)=>t.id===taskId).reviewPreparation).toMatchObject({state:'ready',canDecide:true});
  expect(f.sqlite.prepare('SELECT count(*) n FROM offers').get()).toEqual({n:42});expect(f.sqlite.prepare('SELECT count(*) n FROM review_decisions').get()).toEqual({n:0});expect(f.sqlite.prepare('SELECT count(*) n FROM identity_events').get()).toEqual(beforeEvents);
 }finally{f.sqlite.close();}
});
it('a 201-entry history completes in bounded scans and requires paged UI verification',async()=>{
 const f=auditFixture();try{
  await f.call('ingest/offers',[displayOffer()],false,{IDENTITY_MODE:'off'});
  const original=f.sqlite.prepare("SELECT * FROM offers WHERE id='vendor-signup'").get()!,columns=Object.keys(original);
  const insert=f.sqlite.prepare(`INSERT INTO offers(${columns.join(',')}) VALUES(${columns.map(()=>'?').join(',')})`);
  const entity=f.sqlite.prepare("INSERT INTO benefit_entities(id,platform_id,canonical_offer_id) VALUES(?,'vendor',?)");
  for(let i=0;i<201;i++){const key=String(i).padStart(3,'0'),offerId='offer-'+key;insert.run(...columns.map(column=>column==='id'?offerId:column==='title'?'历史权益 '+key:original[column]));entity.run('entity-'+key,offerId);}
  const text='Campaign signup-2026 grants 10 USD to new individual accounts.',o=await f.observation('large-history',text);
  const facts=canonicalTermsSchema.parse({schemaVersion:'terms-v1',issuerProductId:unknown,mechanism:unknown,benefitPools:[],eligibility:unknown,geography:unknown,claimChannels:unknown,costs:unknown,claimWindow:unknown,occurrenceAnchor:unknown});
  const c=await f.candidate('large-history',o,text,facts,{id:'large-history-candidate'});
  const created=await f.call('ingest/identity-candidates/'+c.candidateId+'/resolve',{requestId:'large-history-create'});
  let revision=0,last:any;for(let i=0;i<6;i++){const step=await f.call('ingest/identity-preparations/'+created.body.taskId+'/scan',{requestId:'large-history-scan-'+i,expectedRevision:revision});expect(step.status,JSON.stringify(step.body)).toBe(200);last=step.body;revision=last.revision;}
  expect(last).toMatchObject({status:'ready',scanned:201});
  const task=(await f.call('admin/identity/tasks',undefined,true)).body.tasks.find((x:any)=>x.id===created.body.taskId);
  expect(task.reviewPreparation.canDecide).toBe(true);expect(task.historyOptions).toHaveLength(200);
  expect((await f.call('admin/identity/tasks/'+created.body.taskId+'/comparisons',undefined,true)).body).toMatchObject({complete:false,issuerProductId:'vendor'});
 }finally{f.sqlite.close();}
});
it('an indirect source can be retried with a grounded direct fetch before the history scan continues',async()=>{
 const f=auditFixture();try{
  const text='Campaign signup-2026 grants 10 USD to new individual accounts.';
  const observed=await f.call('ingest/observations',{requestId:'indirect-source',originalUrl:'https://vendor.example/indirect',finalUrl:'https://vendor.example/indirect',text,sourceId:'vendor-source',fetchKind:'indirect',observedAt:'2026-10-12T10:00:00Z'});
  const facts=canonicalTermsSchema.parse({schemaVersion:'terms-v1',issuerProductId:unknown,mechanism:unknown,benefitPools:[],eligibility:unknown,geography:unknown,claimChannels:unknown,costs:unknown,claimWindow:unknown,occurrenceAnchor:unknown});
  const c=await f.candidate('indirect-benefit',observed.body.observationId,text,facts,{id:'indirect-benefit',title:'需要官方来源的候选权益'});
  const task=(await f.call('ingest/identity-candidates/'+c.candidateId+'/resolve',{requestId:'indirect-create'})).body;
  const missing=await f.call('ingest/identity-preparations/'+task.taskId+'/scan',{requestId:'indirect-first',expectedRevision:0});expect(missing.body.status).toBe('needs_source');
  const context=await f.call('ingest/identity-preparations/'+task.taskId+'/source');expect(context.status).toBe(200);expect(context.body).toMatchObject({sourceVerified:false,issuerProductHint:'vendor',url:'https://vendor.example/indirect'});
  const {sha256}=await import('../src/shared/identity/normalize');
  const directText='Official current page: '+text+' Terms verified today.';
  const evidence={sourceText:directText,sourceFetch:{originalUrl:'https://vendor.example/indirect',finalUrl:'https://vendor.example/indirect',fetchedUrl:'https://vendor.example/indirect',method:'direct',sourceVerified:true,truncated:false,contentHash:await sha256(directText)}};
  const recovered=await f.call('ingest/identity-preparations/'+task.taskId+'/scan',{requestId:'indirect-retry',expectedRevision:missing.body.revision,freshSource:evidence});expect(recovered.status,JSON.stringify(recovered.body)).toBe(200);expect(recovered.body.status).toBe('ready');
  const updated=f.sqlite.prepare('SELECT observation_id,source_fetch_id FROM intake_candidates WHERE id=?').get(c.candidateId) as any;
  expect(updated.observation_id).not.toBe(observed.body.observationId);expect(updated.source_fetch_id).toEqual(expect.any(String));
  const preparation=JSON.parse((f.sqlite.prepare('SELECT suggestion_json FROM review_tasks WHERE id=?').get(task.taskId) as any).suggestion_json);
  expect(preparation.sourceOriginalObservationId).toBe(observed.body.observationId);
  expect((await f.call('admin/identity/tasks',undefined,true)).body.tasks.find((t:any)=>t.id===task.taskId).reviewPreparation).toMatchObject({state:'ready',canDecide:true});
  for(const table of ['offers','review_decisions'])expect(f.sqlite.prepare('SELECT count(*) n FROM '+table).get()).toEqual({n:0});
  const confirmed=canonicalTermsSchema.parse({...facts,issuerProductId:{state:'known',value:'vendor',evidenceRefs:['quote-1']},mechanism:{state:'known',value:'signup_grant',evidenceRefs:['quote-1']}});
  const decided=await f.call('admin/identity/tasks/'+task.taskId+'/resolve',{requestId:'indirect-human-confirm',expectedRevision:recovered.body.revision,action:'new',candidateId:c.candidateId,facts:confirmed,reason:'人工已核对重新获取的官方原文与领取机制'},true);
  expect(decided.status,JSON.stringify(decided.body)).toBe(200);expect(decided.body.outcome).toBe('created_pending');
  expect(f.sqlite.prepare('SELECT count(*) n FROM source_observations').get()).toEqual({n:2});
 }finally{f.sqlite.close();}
});
it('one verified source does not unlock decisions for a second indirect candidate in the same task',async()=>{
 const f=auditFixture();try{
  const text='Campaign signup-2026 grants 10 USD to new individual accounts.';
  const direct=await f.observation('mixed-direct',text);
  const indirect=(await f.call('ingest/observations',{requestId:'mixed-indirect',originalUrl:'https://vendor.example/notice',finalUrl:'https://vendor.example/notice',text,sourceId:'vendor-source',fetchKind:'indirect',observedAt:'2026-10-12T10:00:00Z'})).body.observationId;
  const facts=canonicalTermsSchema.parse({schemaVersion:'terms-v1',issuerProductId:unknown,mechanism:unknown,benefitPools:[],eligibility:unknown,geography:unknown,claimChannels:unknown,costs:unknown,claimWindow:unknown,occurrenceAnchor:unknown});
  const first=await f.candidate('mixed-first',direct,text,facts,{id:'mixed-first'}),second=await f.candidate('mixed-second',indirect,text,facts,{id:'mixed-second'});
  const task=(await f.call('ingest/identity-candidates/'+first.candidateId+'/resolve',{requestId:'mixed-create'})).body;
  f.sqlite.prepare('INSERT INTO task_candidates(task_id,candidate_id) VALUES(?,?)').run(task.taskId,second.candidateId);
  const scanned=await f.call('ingest/identity-preparations/'+task.taskId+'/scan',{requestId:'mixed-scan',expectedRevision:0});
  expect(scanned.body.status).toBe('needs_source');
  const next=await f.call('ingest/identity-preparations/'+task.taskId+'/source');expect(next.body.sourceVerified).toBe(false);
  expect((await f.call('admin/identity/tasks',undefined,true)).body.tasks.find((t:any)=>t.id===task.taskId).reviewPreparation.canDecide).toBe(false);
 }finally{f.sqlite.close();}
});
it('preparation preserves prior model advice and leaves a bounded known-facts task model-reviewable',async()=>{
 const f=auditFixture();try{
  const text='Campaign signup-2026 grants 10 USD to new individual accounts.',o=await f.observation('model-preserve',text);
  const unknownFacts=canonicalTermsSchema.parse({schemaVersion:'terms-v1',issuerProductId:unknown,mechanism:unknown,benefitPools:[],eligibility:unknown,geography:unknown,claimChannels:unknown,costs:unknown,claimWindow:unknown,occurrenceAnchor:unknown});
  const facts=canonicalTermsSchema.parse({...unknownFacts,issuerProductId:{state:'known',value:'vendor',evidenceRefs:['quote-1']},mechanism:{state:'known',value:'signup_grant',evidenceRefs:['quote-1']}});
  const c=await f.candidate('model-preserve',o,text,unknownFacts,{id:'model-preserve-offer'});
  const created=await f.call('ingest/identity-candidates/'+c.candidateId+'/resolve',{requestId:'model-preserve-create'});
  f.sqlite.prepare('UPDATE intake_candidates SET facts_json=? WHERE id=?').run(JSON.stringify(facts),c.candidateId);
  const prior={relation:'UNRESOLVED',entityId:null,retrievalComplete:false,reasonCodes:['retrieval_incomplete']};
  f.sqlite.prepare('UPDATE review_tasks SET suggestion_json=? WHERE id=?').run(JSON.stringify(prior),created.body.taskId);
  const scanned=await f.call('ingest/identity-preparations/'+created.body.taskId+'/scan',{requestId:'model-preserve-scan',expectedRevision:0});expect(scanned.body.status).toBe('ready');
  const task=f.sqlite.prepare('SELECT state,suggestion_json FROM review_tasks WHERE id=?').get(created.body.taskId) as any;
  expect(task.state).toBe('open');expect(JSON.parse(task.suggestion_json).previousModelSuggestion).toMatchObject(prior);
  expect((await f.call('ingest/identity-tasks')).body.tasks.map((t:any)=>t.id)).toContain(created.body.taskId);
  const claimed=await f.call('ingest/identity-tasks/'+created.body.taskId+'/claim',{requestId:'model-preserve-claim',expectedRevision:scanned.body.revision});expect(claimed.status).toBe(200);
  const result={relation:'UNRESOLVED',entityId:null,termsRelation:'INSUFFICIENT',matchingVersionId:null,evidenceRefs:[],conflicts:[],reasonCodes:['needs_human_review'],retrievalComplete:true,resolverVersion:'identity-v1',rulesVersion:'identity-rules-v1'};
  expect((await f.call('ingest/identity-tasks/'+created.body.taskId+'/result',{requestId:'model-preserve-result',expectedRevision:claimed.body.revision,leaseToken:claimed.body.leaseToken,result})).status).toBe(200);
  const retained=JSON.parse((f.sqlite.prepare('SELECT suggestion_json FROM review_tasks WHERE id=?').get(created.body.taskId) as any).suggestion_json);
  expect(retained).toMatchObject({kind:'identity_preparation_v1',status:'ready',modelResult:result,previousModelSuggestion:prior});
 }finally{f.sqlite.close();}
});
it('a candidate whose claimed product is outside the active canary cannot run preparation',async()=>{
 const f=auditFixture();try{
  const text='Campaign signup-2026 grants 10 USD.',o=await f.observation('outside-product',text);
  const facts=canonicalTermsSchema.parse({schemaVersion:'terms-v1',issuerProductId:unknown,mechanism:unknown,benefitPools:[],eligibility:unknown,geography:unknown,claimChannels:unknown,costs:unknown,claimWindow:unknown,occurrenceAnchor:unknown});
  const c=await f.candidate('outside-product',o,text,facts,{platformId:'other'});
  const receipt=await f.call('ingest/identity-candidates/'+c.candidateId+'/resolve',{requestId:'outside-product-task'});
  const queue=await f.call('ingest/identity-preparations');expect(queue.body.tasks.map((x:any)=>x.id)).not.toContain(receipt.body.taskId);
  expect((await f.call('ingest/identity-preparations/'+receipt.body.taskId+'/scan',{requestId:'outside-scan',expectedRevision:0})).status).toBe(409);
 }finally{f.sqlite.close();}
});
it('a verified issuer cannot be used to silently relabel a candidate from another product',async()=>{
 const f=auditFixture();try{
  const text='Vendor grants 10 USD signup credit.',o=await f.observation('cross-product-proof',text);
  const facts=canonicalTermsSchema.parse({schemaVersion:'terms-v1',issuerProductId:unknown,mechanism:unknown,benefitPools:[],eligibility:unknown,geography:unknown,claimChannels:unknown,costs:unknown,claimWindow:unknown,occurrenceAnchor:unknown});
  const c=await f.candidate('cross-product-proof',o,text,facts,{platformId:'other',id:'other-benefit'});
  const created=await f.call('ingest/identity-candidates/'+c.candidateId+'/resolve',{requestId:'cross-product-task'});
  const reviewed=await f.call('ingest/identity-preparations/'+created.body.taskId+'/scan',{requestId:'cross-product-scan',expectedRevision:0},false,{IDENTITY_CANARY_PLATFORMS:'*'});
  expect(reviewed.body.status).toBe('needs_source');expect((await f.call('admin/identity/tasks',undefined,true)).body.tasks.find((t:any)=>t.id===created.body.taskId).reviewPreparation.canDecide).toBe(false);
  expect(f.sqlite.prepare('SELECT count(*) n FROM offers').get()).toEqual({n:0});
 }finally{f.sqlite.close();}
});
it('a prepared history remains pending until an explicit human identity decision',async()=>{
 const f=auditFixture();try{
  const text='Campaign signup-2026 grants 10 USD to new individual accounts.',o=await f.observation('manual-decision',text);
  const facts=canonicalTermsSchema.parse({schemaVersion:'terms-v1',issuerProductId:unknown,mechanism:unknown,benefitPools:[],eligibility:unknown,geography:unknown,claimChannels:unknown,costs:unknown,claimWindow:unknown,occurrenceAnchor:unknown});
  const c=await f.candidate('manual-decision',o,text,facts,{id:'manual-decision-offer',title:'独立领取的新用户赠额',valueText:'10 USD'});
  const created=await f.call('ingest/identity-candidates/'+c.candidateId+'/resolve',{requestId:'manual-decision-create'});
  const preview=await f.call('ingest/identity-preparations/'+created.body.taskId+'/scan',{requestId:'manual-decision-scan',expectedRevision:0});expect(preview.status,JSON.stringify(preview.body)).toBe(200);expect(preview.body.status).toBe('ready');
  expect(f.sqlite.prepare('SELECT count(*) n FROM offers').get()).toEqual({n:0});
  const confirmed=canonicalTermsSchema.parse({...facts,issuerProductId:{state:'known',value:'vendor',evidenceRefs:['quote-1']},mechanism:{state:'known',value:'signup_grant',evidenceRefs:['quote-1']}});
  const decided=await f.call('admin/identity/tasks/'+created.body.taskId+'/resolve',{requestId:'human-independent',expectedRevision:preview.body.revision,action:'new',candidateId:c.candidateId,facts:confirmed,reason:'人工核对官网领取机制和独立活动条件'},true);
  expect(decided.status,JSON.stringify(decided.body)).toBe(200);expect(decided.body.outcome).toBe('created_pending');
  expect(f.sqlite.prepare('SELECT review_state FROM offers WHERE id=?').get(decided.body.canonicalOfferId)).toEqual({review_state:'pending'});
 }finally{f.sqlite.close();}
});
it('malformed candidate display cannot become a ready identity decision',async()=>{
 const f=auditFixture();try{
  const text='Campaign signup-2026 grants 10 USD.',o=await f.observation('bad-display',text);
  const facts=canonicalTermsSchema.parse({schemaVersion:'terms-v1',issuerProductId:unknown,mechanism:unknown,benefitPools:[],eligibility:unknown,geography:unknown,claimChannels:unknown,costs:unknown,claimWindow:unknown,occurrenceAnchor:unknown});
  const c=await f.candidate('bad-display',o,text,facts,{evidence:null});
  const created=await f.call('ingest/identity-candidates/'+c.candidateId+'/resolve',{requestId:'bad-display-create'});
  const scanned=await f.call('ingest/identity-preparations/'+created.body.taskId+'/scan',{requestId:'bad-display-scan',expectedRevision:0});
  expect(scanned.status).toBe(200);expect(scanned.body.status).toBe('needs_source');
  expect((await f.call('admin/identity/tasks',undefined,true)).body.tasks.find((t:any)=>t.id===created.body.taskId).reviewPreparation.canDecide).toBe(false);
 }finally{f.sqlite.close();}
});
it('a mismatched known fact cannot starve the preparation queue through a permitted raw platform',async()=>{
 const f=auditFixture();try{
  const text='Campaign signup-2026 grants 10 USD.',o=await f.observation('stale-known-scope',text);
  const facts=canonicalTermsSchema.parse({schemaVersion:'terms-v1',issuerProductId:unknown,mechanism:unknown,benefitPools:[],eligibility:unknown,geography:unknown,claimChannels:unknown,costs:unknown,claimWindow:unknown,occurrenceAnchor:unknown});
  const c=await f.candidate('stale-known-scope',o,text,facts,{id:'scope-candidate'});const created=await f.call('ingest/identity-candidates/'+c.candidateId+'/resolve',{requestId:'stale-known-create'});
  f.sqlite.prepare('UPDATE intake_candidates SET facts_json=? WHERE id=?').run(JSON.stringify({...facts,issuerProductId:{state:'known',value:'outside',evidenceRefs:['quote-1']}}),c.candidateId);
  expect((await f.call('ingest/identity-preparations')).body.tasks.map((t:any)=>t.id)).not.toContain(created.body.taskId);
  expect((await f.call('ingest/identity-preparations/'+created.body.taskId+'/scan',{requestId:'stale-known-scan',expectedRevision:0})).status).toBe(409);
 }finally{f.sqlite.close();}
});
// 2026-10-16: a source the system could not re-verify left the card locked in "系统核查中" for days (one card re-checked 19
// times) while the owner's buttons stayed hidden. It is now handed to the owner, with the vendor's activities to pick from.
it('an official page that no longer shows the quote hands the card to the owner instead of looping',async()=>{
 const f=auditFixture();try{
  const text='Campaign signup-2026 grants 10 USD to new individual accounts.';
  const observed=await f.call('ingest/observations',{requestId:'unverifiable-source',originalUrl:'https://vendor.example/js',finalUrl:'https://vendor.example/js',text,sourceId:'vendor-source',fetchKind:'indirect',observedAt:'2026-10-12T10:00:00Z'});
  const facts=canonicalTermsSchema.parse({schemaVersion:'terms-v1',issuerProductId:unknown,mechanism:unknown,benefitPools:[],eligibility:unknown,geography:unknown,claimChannels:unknown,costs:unknown,claimWindow:unknown,occurrenceAnchor:unknown});
  const c=await f.candidate('unverifiable-benefit',observed.body.observationId,text,facts,{id:'unverifiable-benefit',title:'只在脚本渲染页上出现的权益'});
  const task=(await f.call('ingest/identity-candidates/'+c.candidateId+'/resolve',{requestId:'unverifiable-create'})).body;
  const missing=await f.call('ingest/identity-preparations/'+task.taskId+'/scan',{requestId:'unverifiable-first',expectedRevision:0});expect(missing.body.status).toBe('needs_source');
  const {sha256}=await import('../src/shared/identity/normalize');
  const shell='Loading… please enable JavaScript to use this app.';
  const evidence={sourceText:shell,sourceFetch:{originalUrl:'https://vendor.example/js',finalUrl:'https://vendor.example/js',fetchedUrl:'https://vendor.example/js',method:'direct',sourceVerified:true,truncated:false,contentHash:await sha256(shell)}};
  const handed=await f.call('ingest/identity-preparations/'+task.taskId+'/scan',{requestId:'unverifiable-fresh',expectedRevision:missing.body.revision,freshSource:evidence});
  expect(handed.status,JSON.stringify(handed.body)).toBe(200);expect(handed.body.status).toBe('source_unverifiable');
  const card=(await f.call('admin/identity/tasks',undefined,true)).body.tasks.find((t:any)=>t.id===task.taskId);
  expect(card.reviewPreparation).toMatchObject({state:'source_unverifiable',canDecide:true});
  expect(card.reviewPreparation.reason).toContain('找不到候选摘录的原文');
  expect(Date.parse(card.reviewPreparation.nextAttemptAt)-Date.now()).toBeGreaterThan(2*86400_000);
  // Not offered to the preparation queue again until the re-check is due; a routine re-scan does not lock it again.
  expect((await f.call('ingest/identity-preparations')).body.tasks.some((t:any)=>t.id===task.taskId)).toBe(false);
  const again=await f.call('ingest/identity-preparations/'+task.taskId+'/scan',{requestId:'unverifiable-again',expectedRevision:handed.body.revision});
  expect(again.body.status).toBe('source_unverifiable');
  for(const table of ['offers','review_decisions'])expect(f.sqlite.prepare('SELECT count(*) n FROM '+table).get()).toEqual({n:0});
  // A plain rejection needs only a category and a reason — no original rejection ID (2026-10-16 即梦 card).
  const rejected=await f.call('admin/identity/tasks/'+task.taskId+'/resolve',{requestId:'unverifiable-reject',expectedRevision:again.body.revision,action:'reject',reasonCategory:'duplicate',reason:'与已上架的注册礼重复'},true);
  expect(rejected.status,JSON.stringify(rejected.body)).toBe(200);
  expect(f.sqlite.prepare('SELECT state FROM review_tasks WHERE id=?').get(task.taskId)).toEqual({state:'resolved'});
 }finally{f.sqlite.close();}
});
it('a candidate whose source is not a registered official address goes to the owner, not into an endless wait',async()=>{
 const f=auditFixture();try{
  const text='Campaign media-2026 grants 10 USD to new individual accounts.';
  const observed=await f.call('ingest/observations',{requestId:'media-source',originalUrl:'https://news.example/vendor-promo',finalUrl:'https://news.example/vendor-promo',text,sourceId:'vendor-source',fetchKind:'indirect',observedAt:'2026-10-12T10:00:00Z'});
  const facts=canonicalTermsSchema.parse({schemaVersion:'terms-v1',issuerProductId:unknown,mechanism:unknown,benefitPools:[],eligibility:unknown,geography:unknown,claimChannels:unknown,costs:unknown,claimWindow:unknown,occurrenceAnchor:unknown});
  const c=await f.candidate('media-benefit',observed.body.observationId,text,facts,{id:'media-benefit',title:'媒体转述的权益',evidence:{url:'https://news.example/vendor-promo',tier:'media',capturedAt:'2026-10-12T10:00:00Z',excerpts:{benefit:text}}});
  const task=(await f.call('ingest/identity-candidates/'+c.candidateId+'/resolve',{requestId:'media-create'})).body;
  const scan=await f.call('ingest/identity-preparations/'+task.taskId+'/scan',{requestId:'media-first',expectedRevision:0});
  expect(scan.body.status).toBe('source_unverifiable');
  const card=(await f.call('admin/identity/tasks',undefined,true)).body.tasks.find((t:any)=>t.id===task.taskId);
  expect(card.reviewPreparation).toMatchObject({state:'source_unverifiable',canDecide:true});
  expect(card.reviewPreparation.reason).toContain('不是该厂商已登记的官方地址');
 }finally{f.sqlite.close();}
});
