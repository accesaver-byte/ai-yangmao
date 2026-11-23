import {afterEach,beforeEach,expect,it} from 'vitest';
import {readFileSync} from 'node:fs';
import {identityDb} from './fixtures/identity/db';
import {withIdentityQueryBudget} from '../src/worker/identity/budget';
import {prepareAiHotReset,advanceAiHotReset,pendingAiHotResets} from '../src/worker/aihot-resets';
import {aiHotEventSchema,aiHotResetProfileForSource,buildAiHotReset,AIHOT_RESET_PROFILES,type AiHotResetProduct} from '../src/shared/aihot-reset';
import {sha256} from '../src/shared/identity/normalize';
// Real AIHOT events (2026-11-22 snapshot) for the Antigravity and Claude feeds the admin authorized alongside Codex.
const events=JSON.parse(readFileSync(new URL('./fixtures/aihot-reset-profile-events.json',import.meta.url),'utf8'));
let f:ReturnType<typeof identityDb>;
const env=()=>({DB:withIdentityQueryBudget(f.db),IDENTITY_MODE:'enforce',IDENTITY_CANARY_PLATFORMS:'*'} as any);
const at=(link:string)=>new Date(Number((BigInt(link.split('/').at(-1)!)>>22n)+1288834974657n)).toISOString();
async function input(product:AiHotResetProduct,event:any,link=event.posts.at(-1).url){
 const post=event.posts.find((p:any)=>p.url===link),body=post.fullOriginalText||post.originalText,id=link.split('/').at(-1)!;
 const sourceText=`@${link.split('/')[3]}\n${at(link)}\n${body}`;
 f.sqlite.prepare("UPDATE leads SET origin='aihot',url=?,status='new' WHERE id=1").run(link);
 return {url:link,sourceText,capturedAt:'2026-11-22T08:00:00.000Z',product,aihotEvent:aiHotEventSchema.parse(event),
  sourceFetch:{originalUrl:link,finalUrl:link,fetchedUrl:`https://cdn.syndication.twimg.com/tweet-result?id=${id}&lang=en&token=0`,method:'first_party_embed' as const,sourceVerified:true,truncated:false,contentHash:await sha256(sourceText),originalContentHash:await sha256(sourceText)}};
}
async function finish(candidateId:string){let result:any;for(let i=0;i<12;i++){result=await advanceAiHotReset(env(),candidateId);if(['published','manual'].includes(result.outcome))return result;}throw Error('did not finish');}
const claudeCatalog=(extra:string[]=[])=>({products:[{id:'claude',name:'Claude',aliases:[],status:'verified',sourceUrl:'https://claude.com/pricing',verifiedAt:'2026-11-01',revision:1}],
 plans:['Claude Pro','Claude Max 5x','Claude Max 20x','Claude Team Standard','Claude Team Premium',...extra].map(name=>({id:name.toLowerCase().replaceAll(' ','-'),productId:'claude',name,aliases:[],billing:'paid',status:'verified',sourceUrl:'https://claude.com/pricing',verifiedAt:'2026-11-01',revision:1}))});
beforeEach(()=>{f=identityDb();f.sqlite.exec(`
 INSERT INTO platforms(id,name,type,status,site,x_handles,staff_handles) VALUES('google','Google AI','lab','approved','https://ai.google.dev','["@GoogleAI"]','["@_mohansolo"]'),('anthropic','Anthropic','lab','approved','https://www.anthropic.com','["@ClaudeDevs"]','["@lydiahallie"]'),('openai','OpenAI','lab','approved','https://openai.com','[]','["@thsottiaux"]'),('xai','xAI','lab','approved','https://x.ai','["@grok","@xai","@bot"]','[]');
 INSERT INTO sources(id,kind,url,tier,enabled,auto_publish) VALUES('aihot-antigravity-resets','aihot','https://aihot.news/api/v1/antigravity-resets','lead',1,1),('aihot-claude-resets','aihot','https://aihot.news/api/v1/claude-resets','lead',1,1),('aihot-resets','aihot','https://aihot.news/api/v1/codex-resets','lead',1,1),('aihot-grok-resets','aihot','https://aihot.news/api/v1/grok-bot-resets','lead',1,1);`);});
afterEach(()=>f.sqlite.close());

it('matches a profile only for the exact source id, kind and feed URL',()=>{
 expect(aiHotResetProfileForSource({id:'aihot-antigravity-resets',kind:'aihot',url:'https://aihot.news/api/v1/antigravity-resets'})?.platformId).toBe('google');
 expect(aiHotResetProfileForSource({id:'aihot-claude-resets',kind:'aihot',url:'https://aihot.news/api/v1/claude-resets'})?.platformId).toBe('anthropic');
 expect(aiHotResetProfileForSource({id:'aihot-claude-resets',kind:'aihot',url:'https://aihot.news/api/v1/codex-resets'})).toBeNull();
 expect(aiHotResetProfileForSource({id:'aihot-items',kind:'aihot',url:'https://aihot.news/api/v1/claude-resets'})).toBeNull();
 expect(aiHotResetProfileForSource({id:'aihot-claude-resets',kind:'feed',url:'https://aihot.news/api/v1/claude-resets'})).toBeNull();
});
it('publishes an Antigravity reset from Varun under Google without a valuation estimate',async()=>{
 const p=await input('antigravity',events.antigravityNov17);
 expect(buildAiHotReset(p)).toMatchObject({id:'google-aihot-antigravity-reset-2122836883877347836',platformId:'google',sourceId:'aihot-antigravity-resets',title:'Antigravity 使用额度重置（11 月 17 日）',claimStart:'2026-11-17',claimEnd:'2026-11-17',audience:'all',requirements:['net'],tags:['reset']});
 expect(buildAiHotReset(p).valuationFactors).toBeUndefined();
 const done=await finish((await prepareAiHotReset(env(),p)).candidateId!);
 expect(done.outcome).toBe('published');
 expect(f.sqlite.prepare('SELECT platform_id,review_state,membership_requirement FROM offers').get()).toEqual({platform_id:'google',review_state:'approved',membership_requirement:null});
 expect(f.sqlite.prepare("SELECT actor FROM review_decisions WHERE action='approve'").get()).toEqual({actor:'policy:aihot-antigravity-reset-v1'});
 expect(f.sqlite.prepare('SELECT status,offer_id FROM leads WHERE id=1').get()).toEqual({status:'linked',offer_id:done.offerId});
});
it('dates an Antigravity reset announced ahead by the AIHOT confirmation',async()=>{
 const p=await input('antigravity',events.antigravityNov21,'https://x.com/_mohansolo/status/2123848516581892181');
 expect(buildAiHotReset(p)).toMatchObject({claimStart:'2026-11-21',claimEnd:'2026-11-21',title:'Antigravity 使用额度重置（11 月 21 日）'});
});
it('links a new discovery to the already listed reset with the same official post',async()=>{
 f.sqlite.prepare("INSERT INTO offers(id,platform_id,title,value_text,type,claim_method,claim_start,claim_end,end_kind,tags,review_state,evidence,steps,requirements,modalities,models) VALUES('identity-manual','google','Antigravity 一周年','x','perk','auto','2026-11-17','2026-11-17','date','[\"reset\"]','approved',?,'[]','[\"net\"]','[\"text\"]','[]')").run(JSON.stringify({url:'https://x.com/_mohansolo/status/2122836883877347836',tier:'staff',capturedAt:'2026-11-18T00:00:00Z',excerpts:{}}));
 expect(await prepareAiHotReset(env(),await input('antigravity',events.antigravityNov17))).toEqual({outcome:'published',offerId:'identity-manual'});
 expect(f.sqlite.prepare('SELECT count(*) n FROM intake_candidates').get()).toEqual({n:0});
});
it('maps a Claude Max reset onto both verified Max tiers',async()=>{
 f.sqlite.prepare('UPDATE membership_catalog SET revision=revision+1,data_json=? WHERE id=1').run(JSON.stringify(claudeCatalog()));
 const p=await input('claude',events.claudeMaxSep05);
 expect(buildAiHotReset(p)).toMatchObject({id:'anthropic-aihot-claude-reset-2095967323412930677',title:'Claude 用量限额重置（9 月 4 日）',claimStart:'2026-09-04',claimEnd:'2026-09-04',evidence:{tier:'staff'}});
 const done=await finish((await prepareAiHotReset(env(),p)).candidateId!);
 expect(done.outcome).toBe('published');
 const offer=f.sqlite.prepare('SELECT membership_requirement,requirements FROM offers').get()!;
 expect(JSON.parse(String(offer.membership_requirement)).anyOf[0].allOf[0].planIds.sort()).toEqual(['claude-max-20x','claude-max-5x']);
 expect(f.sqlite.prepare("SELECT actor FROM review_decisions WHERE action='approve'").get()).toEqual({actor:'policy:aihot-claude-reset-v1'});
});
it('publishes an all-users Claude reset from the official account without a membership requirement',async()=>{
 const p=await input('claude',events.claudeAllSep02);
 expect(buildAiHotReset(p)).toMatchObject({audience:'all',evidence:{tier:'official'}});
 expect((await finish((await prepareAiHotReset(env(),p)).candidateId!)).outcome).toBe('published');
 expect(f.sqlite.prepare('SELECT membership_requirement FROM offers').get()).toEqual({membership_requirement:null});
});
it('ends a Claude reset card on the use-by date the post gives',async()=>{
 f.sqlite.prepare('UPDATE membership_catalog SET revision=revision+1,data_json=? WHERE id=1').run(JSON.stringify(claudeCatalog(['Claude Ultra'])));
 const p=await input('claude',events.claudeNov11);
 expect(buildAiHotReset(p)).toMatchObject({title:'Claude 免费重置卡发放（12 月 10 日前使用）',claimStart:'2026-11-10',claimEnd:'2026-12-10',endKind:'date'});
 expect((await finish((await prepareAiHotReset(env(),p)).candidateId!)).outcome).toBe('published');
 expect(JSON.parse(String(f.sqlite.prepare('SELECT membership_requirement FROM offers').get()!.membership_requirement)).anyOf[0].allOf[0].planIds).toHaveLength(6);
});
it('holds Claude posts naming a plan missing from the catalog, affected-only resets and undated cards for review',async()=>{
 f.sqlite.prepare('UPDATE membership_catalog SET revision=revision+1,data_json=? WHERE id=1').run(JSON.stringify(claudeCatalog()));
 expect(await prepareAiHotReset(env(),await input('claude',events.claudeNov11))).toMatchObject({outcome:'manual',reason:'原帖具体套餐没有已核实的会员目录'});
 expect(await prepareAiHotReset(env(),await input('claude',events.claudeAffectedJun19))).toMatchObject({outcome:'manual'});
 const weekly=structuredClone(events.claudeAllSep02);weekly.title='Claude 每周都会重置一次';
 await expect(input('claude',weekly).then(buildAiHotReset)).rejects.toThrow('周期安排');
 await expect(input('claude',events.claudeNoDeadlineSep23,'https://x.com/claudedevs/status/2102438800836489554').then(buildAiHotReset)).rejects.toThrow('未写明使用期限');
 expect(f.sqlite.prepare('SELECT count(*) n FROM offers').get()).toEqual({n:0});
});
it('keeps each feed to its own registered accounts and switch',async()=>{
 const p=await input('antigravity',events.antigravityNov17);
 expect(()=>buildAiHotReset({...p,product:'claude'})).toThrow('不是登记的 Claude 重置原帖');
 expect(()=>buildAiHotReset({...p,product:undefined})).toThrow('不是登记的 Tibo 重置原帖');
 expect(()=>buildAiHotReset({...p,aihotEvent:undefined})).toThrow('没有 AIHOT 事件判定');
 f.sqlite.exec("UPDATE sources SET auto_publish=0 WHERE id='aihot-antigravity-resets'");
 await expect(prepareAiHotReset(env(),p)).rejects.toThrow('AIHOT Antigravity reset 自动上架未启用');
 await expect(pendingAiHotResets(env(),'antigravity')).rejects.toThrow();
 expect((await pendingAiHotResets(env(),'claude')).candidates).toEqual([]);
 expect(Object.values(AIHOT_RESET_PROFILES).map(p=>p.source)).toEqual(['aihot-resets','aihot-antigravity-resets','aihot-grok-resets','aihot-claude-resets']);
});
it('resumes a candidate under the profile it was admitted with even after the switch for another feed is off',async()=>{
 const a=await prepareAiHotReset(env(),await input('claude',events.claudeAllSep02));
 f.sqlite.exec("UPDATE sources SET auto_publish=0 WHERE id='aihot-resets'");
 expect((await pendingAiHotResets(env(),'claude')).candidates).toContainEqual({candidateId:a.candidateId});
 expect((await finish(a.candidateId!)).outcome).toBe('published');
 f.sqlite.exec("UPDATE sources SET auto_publish=0 WHERE id='aihot-claude-resets'");
 await expect(advanceAiHotReset(env(),a.candidateId!)).rejects.toThrow('AIHOT Claude reset 自动上架未启用');
});
it('publishes a Grok Bot reset from the official @bot account under xAI',async()=>{
 const p=await input('grok',events.grokNov10);
 expect(buildAiHotReset(p)).toMatchObject({id:'xai-aihot-grok-reset-2119871982946971659',platformId:'xai',sourceId:'aihot-grok-resets',title:'Grok Bot 用量限额重置（11 月 9 日）',claimStart:'2026-11-09',evidence:{tier:'official'}});
 const paid={...p,sourceText:p.sourceText+'\nSuperGrok subscribers only.'};
 paid.sourceFetch={...paid.sourceFetch,contentHash:await sha256(paid.sourceText),originalContentHash:await sha256(paid.sourceText)};
 expect(await prepareAiHotReset(env(),paid)).toMatchObject({outcome:'manual'});
 const done=await finish((await prepareAiHotReset(env(),p)).candidateId!);
 expect(done.outcome).toBe('published');
 expect(f.sqlite.prepare("SELECT actor FROM review_decisions WHERE action='approve'").get()).toEqual({actor:'policy:aihot-grok-reset-v1'});
});
