import {beforeEach,afterEach,expect,it} from 'vitest';
import worker from '../src/worker/index';
import {identityDb} from './fixtures/identity/db';
import {IdentityStore} from '../src/worker/identity/store';
import {IdentityService} from '../src/worker/identity/service';
import {unknownIdentityTerms} from '../src/worker/identity/adapters';
let f:ReturnType<typeof identityDb>;
beforeEach(()=>{f=identityDb();});afterEach(()=>f.sqlite.close());
async function read(path:string){const r=await worker.fetch(new Request('https://local.test/api/ingest/'+path,{headers:{Authorization:'Bearer learning-test-ingest-token'}}),{DB:f.db,INGEST_TOKEN:'learning-test-ingest-token'} as any,{} as ExecutionContext);expect(r.status).toBe(200);return await r.json() as any;}
const label=(kind:string,id:string)=>f.sqlite.prepare("INSERT INTO decision_labels(subject_kind,subject_id,category,actor_kind,label_source,justification,labeled_at) VALUES(?,?,'model_news_only','owner','owner','旧的错误关闭',?)").run(kind,id,new Date().toISOString());
it('does not teach a known wrong closure as a negative example even before its repair finishes',async()=>{
 f.sqlite.exec(`UPDATE leads SET title='Nemotron 免费上线',status='rejected',resolution='{"spotCheck":{"verdict":"wrong"}}' WHERE id=1; INSERT INTO leads(id,origin,url,title,status) VALUES(2,'manual','https://x.example/news','常规收费定价新闻','rejected')`);label('lead','1');label('lead','2');
 const r=await read('corrections?limit=100');expect(r.corrections.some((s:string)=>s.includes('Nemotron'))).toBe(false);expect(r.corrections.some((s:string)=>s.includes('常规收费定价新闻'))).toBe(true);
});
it('keeps active candidate refusals in feedback but removes them after an explicit reopen',async()=>{
 const store=new IdentityStore(f.db),text='Ordinary product launch with no promotion.',o=await store.recordObservation({requestId:'n',originalUrl:'https://vendor.example/news',finalUrl:'https://vendor.example/news',text,fetchKind:'direct',sourceId:'vendor-source',observedAt:new Date().toISOString()});
 const [c]=await store.recordCandidates({requestId:'c',observationId:o.observationId,extractionVersion:'t',extractionComplete:true,leadIds:[1],candidates:[{inputId:'n',span:{start:0,end:text.length,quote:text},quotes:[{id:'q',start:0,end:text.length,quote:text}],rawCandidate:{title:'某条模型新闻',platformId:'vendor'},facts:unknownIdentityTerms()}]});
 const service=new IdentityService(f.db),receipt=await service.resolveCandidate(c.candidateId,'r'),decision=await service.decideTask(receipt.taskId!,{requestId:'reject',expectedRevision:0,action:'reject',reason:'常规收费新闻',reasonCode:'other',actor:'admin',role:'admin'});label('candidate',c.candidateId);
 expect((await read('corrections?limit=100')).corrections.some((s:string)=>s.includes('某条模型新闻'))).toBe(true);
 const rev=f.sqlite.prepare('SELECT revision FROM intake_candidates WHERE id=?').get(c.candidateId)!.revision;
 await service.reopenDecision(decision.decisionId,{requestId:'reopen',expectedRevision:Number(rev),reason:'管理员确认此前拒绝缺证',basis:{description:'原官方链接包含免费变体，需要补证而不是拒绝'},actor:'admin'});
 expect((await read('corrections?limit=100')).corrections.some((s:string)=>s.includes('某条模型新闻'))).toBe(false);
});
