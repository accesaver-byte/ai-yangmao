import {afterEach,beforeEach,expect,it} from 'vitest';
import {identityDb} from './fixtures/identity/db';
import {IdentityStore} from '../src/worker/identity/store';
import {IdentityService} from '../src/worker/identity/service';
import {unknownIdentityTerms} from '../src/worker/identity/adapters';
import {displayOffer} from './fixtures/identity/offer';
import {closeIdentityLead} from '../src/worker/identity/lead-closure';
import {openRouterEvidenceGap} from '../src/shared/official-lead-policy';
let f:ReturnType<typeof identityDb>;
const url='https://x.com/OpenRouter/status/2110755162214338984';
const text='@OpenRouter\n2026-10-15T15:30:21.000Z\nTry it: https://t.co/nMwAvm5wm3';
beforeEach(()=>{f=identityDb();f.sqlite.exec(`INSERT INTO platforms(id,name,type,status,site,x_handles) VALUES('openrouter','OpenRouter','infra','approved','https://openrouter.ai','["@OpenRouter"]'); UPDATE leads SET url='${url}',origin='aihot' WHERE id=1;`);});
afterEach(()=>f.sqlite.close());
it('protects a real official Try-it claim from repeating the historical missing-credit rejection',async()=>{
 const store=new IdentityStore(f.db),o=await store.recordObservation({requestId:'post',originalUrl:url,finalUrl:url,text,fetchKind:'direct',issuerProductId:'openrouter',observedAt:'2026-10-15T16:31:57Z'}),quote='Try it: https://t.co/nMwAvm5wm3',start=text.indexOf(quote);
 const [c]=await store.recordCandidates({requestId:'claim',observationId:o.observationId,extractionVersion:'test',extractionComplete:true,leadIds:[1],candidates:[{inputId:'free-vl',span:{start,end:start+quote.length,quote},quotes:[{id:'benefit',start,end:start+quote.length,quote}],facts:unknownIdentityTerms(),rawCandidate:{...displayOffer(),platformId:'openrouter',evidence:{url,tier:'official',capturedAt:'2026-10-15T16:31:57Z',excerpts:{benefit:quote}}}}]});
 const service=new IdentityService(f.db),r=await service.resolveCandidate(c.candidateId,'resolve');
 await expect(service.decideTask(r.taskId!,{requestId:'reject',expectedRevision:0,action:'reject',actor:'admin',role:'admin',reasonCode:'other',reason:'官方帖只说已上线，附带的帖子只有 Try it 链接，没有免费额度。'})).rejects.toMatchObject({status:409});
 expect(f.sqlite.prepare('SELECT count(*) n FROM review_decisions').get()).toEqual({n:0});
 const facts=unknownIdentityTerms();facts.issuerProductId={state:'known',value:'openrouter',evidenceRefs:['benefit']};facts.mechanism={state:'known',value:'trial',evidenceRefs:['benefit']};
 const next=await service.resolveIdentityTask(r.taskId!,{requestId:'new',expectedRevision:0,action:'new',candidateId:c.candidateId,facts,actor:'admin'});expect(next.outcome).toBe('created_pending');
 await expect(service.decideTask(next.taskId!,{requestId:'reject-initial',expectedRevision:0,action:'reject',actor:'admin',role:'admin',reasonCode:'other',reason:'没有免费额度'})).rejects.toMatchObject({status:409});
});
it('does not let lead closure bypass the same official-source evidence guard',async()=>{
 const lead={id:1,url,status:'reviewing',raw:null,title:null,resolution:null,offerId:null};
 await expect(closeIdentityLead(f.db,lead,{status:'closed',jobId:'close',attempts:1,inconclusive:0,checkedAt:'2026-10-18T10:00:00Z',nextAttemptAt:null,reason:'没有免费额度',queries:[],candidates:[],offerIds:[]},text,{actor:'pipeline:lead-review'})).rejects.toMatchObject({status:409});
 expect(f.sqlite.prepare('SELECT status FROM leads WHERE id=1').get()).toEqual({status:'reviewing'});
});
it('separates absent evidence from supported negative facts and other accounts',()=>{
 expect(openRouterEvidenceGap(url,'insufficient_evidence','无法核实',text)).toBe(true);
 expect(openRouterEvidenceGap(url,'other','这个模型没有赠额',text)).toBe(true);
 expect(openRouterEvidenceGap(url,'other','模型判断不是 AI 羊毛','https://openrouter.ai/nvidia/nemotron-3.5-super-vl:free')).toBe(true);
 expect(openRouterEvidenceGap(url,'paid_bundle','仅限已购买付费套餐的常规内含功能','Subscribe to Pro for this feature.')).toBe(false);
 expect(openRouterEvidenceGap('https://x.com/notOpenRouter/status/2110755162214338984','other','没有免费额度',text)).toBe(false);
});
