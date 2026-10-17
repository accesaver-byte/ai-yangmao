import { afterEach,expect,it,vi } from 'vitest';
import { resumeIdentityIntake } from '../pipeline/identity-workflow';
afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();});
it('A06 resumes only server-selected deferred candidates without another extraction or search call',async()=>{
 vi.stubEnv('IDENTITY_MODE','enforce');vi.stubEnv('API_BASE','https://mock.local');vi.stubEnv('IDENTITY_MODEL_ASSIST','false');
 const calls:string[]=[];
 vi.stubGlobal('fetch',async(url:string)=>{calls.push(url);if(url.endsWith('/identity-retries'))return new Response(JSON.stringify({candidates:[{id:'deferred-1',revision:2}]}));if(url.endsWith('/identity-preparations'))return Response.json({tasks:[]});if(url.endsWith('/identity-candidates/deferred-1/resolve'))return new Response(JSON.stringify({inputId:'i1',candidateId:'deferred-1',canonicalOfferId:'offer-1',entityId:'e1',versionId:'v1',decisionId:null,taskId:null,outcome:'duplicate_approved',retryable:false,reasonCodes:[]}));throw new Error('unexpected network call');});
 const result=await resumeIdentityIntake(Date.now()+10000);
 expect(result.resolved).toBe(1);expect(calls).toHaveLength(3);expect(calls.some(url=>/generativelanguage|search|exa/.test(url))).toBe(false);
});
it('A27 shadow/off modes do not resolve diagnostic intake or consume models',async()=>{
 vi.stubEnv('IDENTITY_MODE','shadow');vi.stubEnv('API_BASE','https://mock.local');vi.stubGlobal('fetch',()=>{throw new Error('no network');});
 expect(await resumeIdentityIntake(Date.now()+10000)).toMatchObject({resolved:0,deferred:0,modelTasks:0,status:'disabled',reason:'mode_shadow'});
});
import { auditFixture } from './fixtures/identity/audit';
import { unknown } from './fixtures/identity/terms';
import { canonicalTermsSchema } from '../src/shared/identity/types';
// 2026-10-16: candidates whose originating lead was later linked or closed failed with 409 on every run all week.
it('a candidate whose originating lead has moved on resolves on its own instead of failing forever',async()=>{
 const f=auditFixture();try{
  const text='Campaign moved-on grants 10 USD to new individual accounts.';
  const o=await f.observation('moved-on',text);
  const facts=canonicalTermsSchema.parse({schemaVersion:'terms-v1',issuerProductId:unknown,mechanism:unknown,benefitPools:[],eligibility:unknown,geography:unknown,claimChannels:unknown,costs:unknown,claimWindow:unknown,occurrenceAnchor:unknown});
  const stale=JSON.stringify({status:'checking',jobId:'old-job'});
  f.sqlite.prepare("INSERT INTO leads(id,origin,url,status,title,resolution) VALUES(9501,'aihot','https://x.example/moved','linked','已关联的线索',?)").run(JSON.stringify({status:'linked',offerIds:['x']}));
  const c=await f.candidate('moved-on',o,text,facts,{id:'moved-on',title:'线索已处理后的候选',_identityLegacyLead:{leadId:9501,resolution:stale}});
  const r=await f.call('ingest/identity-candidates/'+c.candidateId+'/resolve',{requestId:'moved-on-resolve'});
  expect(r.status,JSON.stringify(r.body)).toBe(200);
  expect(r.body.outcome).not.toBe('deferred');
  expect(f.sqlite.prepare('SELECT status FROM leads WHERE id=9501').get()).toEqual({status:'linked'});
 }finally{f.sqlite.close();}
});
