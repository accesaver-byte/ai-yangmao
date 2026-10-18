import {afterEach,beforeEach,expect,it} from 'vitest';
import {identityDb} from './fixtures/identity/db';
import {withIdentityQueryBudget} from '../src/worker/identity/budget';
import {prepareAiHotReset,advanceAiHotReset} from '../src/worker/aihot-resets';
import {buildAiHotReset} from '../src/shared/aihot-reset';
import {sha256} from '../src/shared/identity/normalize';
let f:ReturnType<typeof identityDb>;
const url='https://x.com/thsottiaux/status/2111492673890824348';
const text='@thsottiaux\n2026-10-17T16:20:57.000Z\nDay 13/ Le limit reset';
async function input(body=text,link=url){const id=link.split('/').at(-1)!;return {url:link,sourceText:body,capturedAt:'2026-10-18T08:00:00.000Z',sourceFetch:{originalUrl:link,finalUrl:link,fetchedUrl:`https://cdn.syndication.twimg.com/tweet-result?id=${id}&lang=en&token=0`,method:'first_party_embed' as const,sourceVerified:true,truncated:false,contentHash:await sha256(body),originalContentHash:await sha256(body)}};}
const env=()=>({DB:withIdentityQueryBudget(f.db),IDENTITY_MODE:'enforce',IDENTITY_CANARY_PLATFORMS:'openai'} as any);
beforeEach(()=>{f=identityDb();f.sqlite.exec(`INSERT INTO platforms(id,name,type,status,site,staff_handles) VALUES('openai','OpenAI','lab','approved','https://openai.com','["@thsottiaux"]'); INSERT INTO sources(id,kind,url,tier,enabled,auto_publish) VALUES('aihot-resets','aihot','https://aihot.news/api/v1/codex-resets','lead',1,1); UPDATE leads SET origin='aihot',url='${url}',status='new' WHERE id=1;`);});
afterEach(()=>f.sqlite.close());
async function finish(candidateId:string){let result:any;for(let i=0;i<12;i++){result=await advanceAiHotReset(env(),candidateId);if(['published','manual'].includes(result.outcome))return result;}throw Error('did not finish');}
it('Day13 source-only context becomes a single dated reset without inferred paid tiers',async()=>{
 const offer=buildAiHotReset(await input());expect(offer).toMatchObject({platformId:'openai',sourceId:'aihot-resets',claimStart:'2026-10-17',claimEnd:'2026-10-17',publishedAt:'2026-10-17T16:20:57.000Z',requirements:['net'],audience:'unclear',tags:['reset']});expect(offer.identityFacts?.occurrenceAnchor).toMatchObject({state:'known'});
});
it('automatically publishes using versioned identity approval, reconciles the lead, and survives replay',async()=>{
 const a=await prepareAiHotReset(env(),await input());expect(a.candidateId).toBeTruthy();const done=await finish(a.candidateId!);expect(done.outcome).toBe('published');
 expect(f.sqlite.prepare('SELECT review_state FROM offers').get()).toEqual({review_state:'approved'});
 expect(f.sqlite.prepare('SELECT status,offer_id FROM leads WHERE id=1').get()).toEqual({status:'linked',offer_id:done.offerId});
 const replay=await prepareAiHotReset(env(),await input());expect(replay.outcome).toBe('published');expect(f.sqlite.prepare('SELECT count(*) n FROM offers').get()).toEqual({n:1});
 expect(f.sqlite.prepare("SELECT count(*) n FROM identity_events WHERE kind='new'").get()).toEqual({n:1});
 expect(f.sqlite.prepare("SELECT actor FROM review_decisions WHERE action='approve'").get()).toEqual({actor:'policy:aihot-codex-reset-v1'});
});
it('keeps other sources and disabled/reset sources outside automatic publication',async()=>{
 f.sqlite.exec("UPDATE sources SET auto_publish=0 WHERE id='aihot-resets'");await expect(prepareAiHotReset(env(),await input())).rejects.toThrow(/自动上架/);
 expect(f.sqlite.prepare('SELECT count(*) n FROM intake_candidates').get()).toEqual({n:0});
});
it('refuses unverified, truncated, mismatched or other-author evidence',async()=>{
 const p=await input();for(const proof of [{...p.sourceFetch,sourceVerified:false},{...p.sourceFetch,truncated:true},{...p.sourceFetch,contentHash:'0'.repeat(64)},{...p.sourceFetch,fetchedUrl:'https://reader.example/tweet'}])await expect(prepareAiHotReset(env(),{...p,sourceFetch:proof})).rejects.toThrow();
 await expect(prepareAiHotReset(env(),await input(text.replace('@thsottiaux','@other')))).rejects.toThrow();
});
it('does not promote progress-only replies or plans into independent reset events',async()=>{
 for(const body of ['Landing sometime today by EOD PST','Done and dusted','Day 13/ No reset today','Next week we might reset limits','Day 13/ Reset every day for a week'])expect(()=>buildAiHotReset({...({url,sourceText:'@thsottiaux\n2026-10-17T16:20:57.000Z\n'+body,capturedAt:'2026-10-18T08:00:00Z',sourceFetch:{}} as any)})).toThrow();
});
it('does not auto-approve administrator-edited or rejected drafts',async()=>{
 const a=await prepareAiHotReset(env(),await input());let r:any;for(let i=0;i<5;i++){r=await advanceAiHotReset(env(),a.candidateId!);if(r.outcome==='pending_initial')break;}
 const offer=f.sqlite.prepare('SELECT id FROM offers').get();expect(offer).toBeTruthy();f.sqlite.prepare("INSERT INTO offer_revisions(offer_id,diff,author) VALUES(?,'[]','admin')").run(offer!.id as string);
 expect((await finish(a.candidateId!)).outcome).toBe('manual');expect(f.sqlite.prepare('SELECT review_state FROM offers').get()).toEqual({review_state:'pending'});
});
it('does not mint another event when an existing reset on the same day needs identity review',async()=>{
 f.sqlite.exec(`INSERT INTO offers(id,platform_id,title,type,modalities,tags,claim_method,requirements,audience,value_text,claim_start,claim_end,end_kind,source_tz,evidence,review_state) VALUES('older','openai','本日重置','perk','["text"]','["reset"]','auto','["net"]','unclear','本日额度重置','2026-10-17','2026-10-17','date','America/Los_Angeles','{"url":"https://x.com/thsottiaux/status/2111492738025959922","tier":"staff","capturedAt":"2026-10-18T00:00:00Z","excerpts":{"benefit":"Landing sometime today by EOD PST"}}','approved')`);
 const a=await prepareAiHotReset(env(),await input());expect(a.outcome).toBe('manual');expect(f.sqlite.prepare('SELECT count(*) n FROM offers').get()).toEqual({n:1});
});
it('makes an explicit tomorrow reset a single event on the execution day',async()=>{
 const o=buildAiHotReset({...await input(),sourceText:text+'\nGlobal reset tomorrow.'});expect(o.claimStart).toBe('2026-10-18');expect(o.claimEnd).toBe('2026-10-18');
});

it('resumes a partially processed automatic candidate rather than treating its own pending offer as a collision',async()=>{
 const p=await input(),first=await prepareAiHotReset(env(),p);await advanceAiHotReset(env(),first.candidateId!);
 const again=await prepareAiHotReset(env(),{...p,capturedAt:'2026-10-18T08:01:00.000Z'});expect(again.candidateId).toBe(first.candidateId);expect(again.outcome).toBe('resume');
 expect((await finish(again.candidateId!)).outcome).toBe('published');
});
it('publishes independent same-word reset announcements on different dates as separate events',async()=>{
 const first=await prepareAiHotReset(env(),await input(text.replace('Day 13/ Le limit reset','Global reset by EOD.')));await finish(first.candidateId!);
 const older='https://x.com/thsottiaux/status/2110595484180214059';f.sqlite.prepare("INSERT INTO leads(id,origin,url,status) VALUES(2,'aihot',?,'new')").run(older);
 const second=await prepareAiHotReset(env(),await input('@thsottiaux\n2026-10-15T04:55:51.000Z\nGlobal reset by EOD.',older));expect((await finish(second.candidateId!)).outcome).toBe('published');
 expect(f.sqlite.prepare("SELECT count(*) n FROM offers WHERE review_state='approved'").get()).toEqual({n:2});
});

import worker from '../src/worker/index';
it('the authenticated HTTP flow stays within fifty D1 statements per request',async()=>{
 let statements=0;f.inject(()=>{statements++;});
 const post=async(path:string,body:unknown,token='ingest-test-token-123')=>{statements=0;const response=await worker.fetch(new Request('https://local.test/api/ingest/'+path,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(body)}),{DB:f.db,IDENTITY_MODE:'enforce',IDENTITY_CANARY_PLATFORMS:'openai',INGEST_TOKEN:'ingest-test-token-123'} as any,{} as ExecutionContext);expect(statements).toBeLessThanOrEqual(50);return response;};
 expect((await post('aihot-resets',await input(),'wrong')).status).toBe(401);
 let r:any=await (await post('aihot-resets',await input())).json();
 for(let i=0;i<12&&r.outcome!=='published';i++){const response=await post(r.candidateId?'aihot-resets/'+r.candidateId+'/advance':'aihot-resets',r.candidateId?{}:await input());expect([200,202]).toContain(response.status);r=await response.json();}
 expect(r.outcome).toBe('published');
});
it('the administrator can enable only the exact AIHOT reset feed exception',async()=>{
 const post=(id:string)=>worker.fetch(new Request(`https://local.test/api/admin/sources/${id}/auto-publish`,{method:'POST',headers:{Authorization:'Bearer admin-test-token-123','Content-Type':'application/json'},body:'{"on":true}'}),{DB:f.db,ADMIN_TOKEN:'admin-test-token-123'} as any,{} as ExecutionContext);
 f.sqlite.exec("UPDATE sources SET auto_publish=0 WHERE id='aihot-resets'");expect((await post('aihot-resets')).status).toBe(200);
 f.sqlite.exec("INSERT INTO sources(id,kind,url,tier) VALUES('aihot-items','aihot','https://aihot.news/api/v1/items','lead')");expect((await post('aihot-items')).status).toBe(400);
});
it('keeps embedded links intact so an original excerpt remains contiguous',async()=>{
 const p=await input(text+' https://t.co/example\nGlobal reset landing today.');const o=buildAiHotReset(p);expect(p.sourceText).toContain(o.evidence.excerpts.benefit);expect((await prepareAiHotReset(env(),p)).candidateId).toBeTruthy();
});

it('rejects cancellation and uncertainty after the word reset as well as before it',async()=>{
 for(const statement of ['Global reset was cancelled.','Global reset has not happened.','Day 13/ Reset will not happen.','Global reset might happen tomorrow.'])expect(()=>buildAiHotReset({...({url,sourceText:'@thsottiaux\n2026-10-17T16:20:57.000Z\n'+statement,capturedAt:'2026-10-18T08:00:00Z',sourceFetch:{}} as any)})).toThrow();
});
it('does not erase explicitly limited named-plan eligibility',async()=>{
 const result=await prepareAiHotReset(env(),await input(text+'\nGlobal reset for Pro subscribers only.'));expect(result.outcome).toBe('manual');expect(f.sqlite.prepare('SELECT count(*) n FROM offers').get()).toEqual({n:0});
});
it('records known named-plan eligibility against the verified membership catalog',async()=>{
 const catalog={products:[{id:'chatgpt',name:'ChatGPT',aliases:[],status:'verified',sourceUrl:'https://openai.com',verifiedAt:'2026-10-18',revision:1}],plans:[{id:'pro200',productId:'chatgpt',name:'ChatGPT Pro200',aliases:[],billing:'paid',status:'verified',sourceUrl:'https://openai.com',verifiedAt:'2026-10-18',revision:1}]};
 f.sqlite.prepare('UPDATE membership_catalog SET revision=revision+1,data_json=? WHERE id=1').run(JSON.stringify(catalog));
 const result=await prepareAiHotReset(env(),await input(text+'\nGlobal reset for Pro subscribers only.'));const done=await finish(result.candidateId!);expect(done.outcome).toBe('published');
 const offer=f.sqlite.prepare('SELECT membership_requirement,requirements FROM offers').get();expect(JSON.parse(offer!.membership_requirement as string).anyOf[0].allOf[0].planIds).toEqual(['pro200']);expect(JSON.parse(offer!.requirements as string).join(' ')).toContain('ChatGPT');
});

import {pendingAiHotResets} from '../src/worker/aihot-resets';
it('persists a policy continuation independently of the feed window, and excludes permanent manual results',async()=>{
 const a=await prepareAiHotReset(env(),await input());expect((await pendingAiHotResets(env())).candidates).toContainEqual({candidateId:a.candidateId});
 await advanceAiHotReset(env(),a.candidateId!);const offer=f.sqlite.prepare('SELECT id FROM offers').get();
 if(offer){f.sqlite.prepare("INSERT INTO offer_revisions(offer_id,diff,author) VALUES(?,'[]','admin')").run(offer.id as string);}else{await advanceAiHotReset(env(),a.candidateId!);const id=f.sqlite.prepare('SELECT id FROM offers').get()!.id;f.sqlite.prepare("INSERT INTO offer_revisions(offer_id,diff,author) VALUES(?,'[]','admin')").run(id as string);}
 expect((await finish(a.candidateId!)).outcome).toBe('manual');expect((await pendingAiHotResets(env())).candidates).toEqual([]);
});
it('rejects ordinary post-reset negation and does not treat an imperative go as a plan',async()=>{
 expect(()=>buildAiHotReset({...({url,sourceText:text.replace('Day 13/ Le limit reset','Global reset is not happening.'),capturedAt:'2026-10-18T08:00:00Z',sourceFetch:{}} as any)})).toThrow();
 const a=await prepareAiHotReset(env(),await input(text.replace('Day 13/ Le limit reset','Here we go! Global reset today.')));expect((await finish(a.candidateId!)).outcome).toBe('published');
});
import {closeIdentityLead} from '../src/worker/identity/lead-closure';
it('preserves an administrator lead closure made after automatic intake',async()=>{
 const a=await prepareAiHotReset(env(),await input());const row=f.sqlite.prepare('SELECT * FROM leads WHERE id=1').get()!;
 const lead={...row,offerId:null,createdAt:row.created_at,resolution:row.resolution?JSON.parse(String(row.resolution)):null} as any;
 await closeIdentityLead(f.db,lead,{status:'closed',jobId:'human-close',attempts:0,inconclusive:0,checkedAt:'2026-10-18T08:01:00Z',nextAttemptAt:null,reason:'管理员确认不收',queries:[],candidates:[],offerIds:[]},text,{actor:'admin'});
 expect((await finish(a.candidateId!)).outcome).toBe('manual');expect(f.sqlite.prepare('SELECT status FROM leads WHERE id=1').get()).toEqual({status:'rejected'});expect(f.sqlite.prepare("SELECT count(*) n FROM offers WHERE review_state='approved'").get()).toEqual({n:0});
});
it('continues reconciliation after a crash immediately after approval',async()=>{
 const a=await prepareAiHotReset(env(),await input());let result:any;for(let i=0;i<12;i++){result=await advanceAiHotReset(env(),a.candidateId!);if(result.outcome==='approved')break;}expect(result.outcome).toBe('approved');
 expect((await pendingAiHotResets(env())).candidates).toContainEqual({candidateId:a.candidateId});
 const replay=await prepareAiHotReset(env(),await input());expect(replay.outcome).toBe('published');expect(f.sqlite.prepare('SELECT status,offer_id FROM leads WHERE id=1').get()).toEqual({status:'linked',offer_id:replay.offerId});expect((await pendingAiHotResets(env())).candidates).toEqual([]);
});
it('keeps a farewell tomorrow separate from the actual reset execution date',async()=>{
 const p=await input();const o=buildAiHotReset({...p,sourceText:p.sourceText.replace('Day 13/ Le limit reset',"Loading a banked reset in everyone's paid accounts. See you again tomorrow!")});expect(o.claimStart).toBe('2026-10-17');expect(o.claimEnd).toBe('2026-10-17');
});
it('does not interpret go as a membership after a for-everyone phrase',async()=>{
 const a=await prepareAiHotReset(env(),await input(text.replace('Day 13/ Le limit reset','Global reset for everyone, go have fun!')));expect((await finish(a.candidateId!)).outcome).toBe('published');expect(f.sqlite.prepare('SELECT membership_requirement FROM offers').get()?.membership_requirement).toBeNull();
});
