import {afterEach,beforeEach,expect,it,vi} from 'vitest';
vi.mock('../pipeline/lib',async original=>({...await original<any>(),api:vi.fn(),fetchPage:vi.fn()}));
import {api,fetchPage} from '../pipeline/lib';
import {publishAiHotResets} from '../pipeline/aihot-resets';
import type {Source} from '../pipeline/collectors';
const url='https://x.com/thsottiaux/status/2111492673890824348';
const source={id:'aihot-resets',kind:'aihot',url:'https://aihot.news/api/v1/codex-resets',autoPublish:true} as Source;
let responses:any[]=[];let pending:{candidateId:string}[]=[];
const lead={origin:'aihot' as const,url,title:'Codex Day13额度重置'};
beforeEach(()=>{responses=[];pending=[];vi.mocked(api).mockImplementation(async path=>path==='/aihot-resets/pending'?{candidates:pending}:responses.shift() as any);vi.mocked(fetchPage).mockResolvedValue({text:'@thsottiaux\n2026-10-17T16:20:57.000Z\nDay 13/ Le limit reset',via:'direct',originalUrl:url,finalUrl:url,fetchedUrl:'https://cdn.syndication.twimg.com/tweet-result?id=2111492673890824348&lang=en&token=0',fetchMethod:'first_party_embed',sourceVerified:true,truncated:false});});
afterEach(()=>vi.resetAllMocks());
it('uses the linked employee post directly and advances persisted stages without a model',async()=>{
 responses=[{outcome:'received',candidateId:'c1'},{outcome:'pending_initial',candidateId:'c1'},{outcome:'approved',candidateId:'c1'},{outcome:'published',candidateId:'c1',offerId:'o1'}];
 expect(await publishAiHotResets(source,[lead],{dry:false,log:()=>{}})).toMatchObject({published:1,failed:0});
 expect(fetchPage).toHaveBeenCalledWith(url);expect(vi.mocked(api).mock.calls.map(c=>c[0])).toEqual(['/aihot-resets/pending','/aihot-resets','/aihot-resets/c1/advance','/aihot-resets/c1/advance','/aihot-resets/c1/advance']);
});
it('a dry run or another source never sends publication requests',async()=>{
 await publishAiHotResets(source,[lead],{dry:true,log:()=>{}});await publishAiHotResets({...source,id:'aihot-items'},[lead],{dry:false,log:()=>{}});await publishAiHotResets({...source,autoPublish:false},[lead],{dry:false,log:()=>{}});expect(api).not.toHaveBeenCalled();expect(fetchPage).not.toHaveBeenCalled();
});
it('failed official fetching is reported and never clears the lead or sends publication',async()=>{
 vi.mocked(fetchPage).mockRejectedValue(Error('official source unavailable'));
 expect(await publishAiHotResets(source,[lead],{dry:false,log:()=>{}})).toMatchObject({failed:1,published:0});expect(vi.mocked(api).mock.calls.map(c=>c[0])).toEqual(['/aihot-resets/pending']);
});
it('records the actual review reason and official URL instead of hiding every fallback as progress',async()=>{
 vi.mocked(fetchPage).mockResolvedValueOnce({...await fetchPage(url),text:'@thsottiaux\n2026-10-17T16:20:57.000Z\nLanding sometime today by EOD PST'});
 const messages:unknown[][]=[];
 const result=await publishAiHotResets(source,[lead],{dry:false,log:(...args)=>messages.push(args)});
 expect(result).toMatchObject({published:0,manual:1,failed:0,manualReasons:[{subject:url,reason:expect.stringContaining('只有进度、计划或未知重置形式')}]});
 expect(messages.flat().join(' ')).toContain('只有进度、计划或未知重置形式');
});
it('reports broken author or timestamp validation as a failure requiring retry',async()=>{
 vi.mocked(fetchPage).mockResolvedValueOnce({...await fetchPage(url),text:'@wrong-author\n2026-10-17T16:20:57.000Z\nDay 13/ Le limit reset'});
 expect(await publishAiHotResets(source,[lead],{dry:false,log:()=>{}})).toMatchObject({published:0,manual:0,failed:1,errors:[expect.stringContaining('原帖作者不符')]});
});
it('budget continuation reopens the same persisted candidate, never creates an unversioned approval',async()=>{
 responses=[{outcome:'received',candidateId:'c1'},{outcome:'retry'},{outcome:'resume',candidateId:'c1'},{outcome:'published',candidateId:'c1',offerId:'o1'}];
 expect(await publishAiHotResets(source,[lead],{dry:false,log:()=>{}})).toMatchObject({published:1});expect(vi.mocked(api).mock.calls.map(c=>c[0])).toEqual(['/aihot-resets/pending','/aihot-resets','/aihot-resets/c1/advance','/aihot-resets','/aihot-resets/c1/advance']);
});

it('resumes a saved reset when the source feed no longer contains any event',async()=>{
 pending=[{candidateId:'saved'}];responses=[{outcome:'published',candidateId:'saved',offerId:'o1'}];
 expect(await publishAiHotResets(source,[],{dry:false,log:()=>{}})).toMatchObject({published:1,failed:0});expect(fetchPage).not.toHaveBeenCalled();expect(vi.mocked(api).mock.calls.map(c=>c[0])).toEqual(['/aihot-resets/pending','/aihot-resets/saved/advance']);
});

import {readFileSync} from 'node:fs';
const events=JSON.parse(readFileSync(new URL('./fixtures/aihot-reset-events.json',import.meta.url),'utf8'));
it('passes AIHOT\'s event to the Worker so a figurative post is judged by AIHOT\'s reading',async()=>{
 const day17='https://x.com/thsottiaux/status/2113162277688070445';
 vi.mocked(fetchPage).mockResolvedValueOnce({...await fetchPage(url),originalUrl:day17,finalUrl:day17,fetchedUrl:'https://cdn.syndication.twimg.com/tweet-result?id=2113162277688070445&lang=en&token=0',text:'@thsottiaux\n2026-10-22T06:55:22.000Z\nDay 17/ Bet you thought we forgot, but no, it’s reset day today.\n\nAlso good time to remind you to get Daybreak Blue access, it only takes 15 mins and you don’t want to have to do it in the middle of an incident.'});
 responses=[{outcome:'published',candidateId:'c1',offerId:'o1'}];
 expect(await publishAiHotResets(source,[{origin:'aihot',url:day17,aihotEvent:events.day17}],{dry:false,log:()=>{}})).toMatchObject({published:1,manual:0,failed:0});
 const sent=vi.mocked(api).mock.calls.find(c=>c[0]==='/aihot-resets')![1] as any;
 expect(sent.aihotEvent).toMatchObject({id:'reset-2113162277688070445-1-1',type:'direct_reset',status:'announced'});
 expect(sent.aihotEvent.presentation).toBeUndefined();
});
it('keeps one post anchoring several AIHOT events in review without fetching it',async()=>{
 const result=await publishAiHotResets(source,[{...lead,aihotEvent:events.day13},{...lead,aihotEvent:events.day13}],{dry:false,log:()=>{}});
 expect(result).toMatchObject({published:0,manual:1,failed:0,manualReasons:[{subject:url,reason:expect.stringContaining('同一原帖对应多次重置')}]});
 expect(fetchPage).not.toHaveBeenCalled();
});
it('falls back to the employee post when AIHOT\'s event cannot be read',async()=>{
 responses=[{outcome:'published',candidateId:'c1',offerId:'o1'}];const messages:unknown[][]=[];
 expect(await publishAiHotResets(source,[{...lead,aihotEvent:{id:'x'}}],{dry:false,log:(...a)=>messages.push(a)})).toMatchObject({published:1});
 expect((vi.mocked(api).mock.calls.find(c=>c[0]==='/aihot-resets')![1] as any).aihotEvent).toBeUndefined();
 expect(messages.flat().join(' ')).toContain('改读员工原帖');
});
