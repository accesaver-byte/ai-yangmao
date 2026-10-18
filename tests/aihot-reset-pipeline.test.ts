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
it('budget continuation reopens the same persisted candidate, never creates an unversioned approval',async()=>{
 responses=[{outcome:'received',candidateId:'c1'},{outcome:'retry'},{outcome:'resume',candidateId:'c1'},{outcome:'published',candidateId:'c1',offerId:'o1'}];
 expect(await publishAiHotResets(source,[lead],{dry:false,log:()=>{}})).toMatchObject({published:1});expect(vi.mocked(api).mock.calls.map(c=>c[0])).toEqual(['/aihot-resets/pending','/aihot-resets','/aihot-resets/c1/advance','/aihot-resets','/aihot-resets/c1/advance']);
});

it('resumes a saved reset when the source feed no longer contains any event',async()=>{
 pending=[{candidateId:'saved'}];responses=[{outcome:'published',candidateId:'saved',offerId:'o1'}];
 expect(await publishAiHotResets(source,[],{dry:false,log:()=>{}})).toMatchObject({published:1,failed:0});expect(fetchPage).not.toHaveBeenCalled();expect(vi.mocked(api).mock.calls.map(c=>c[0])).toEqual(['/aihot-resets/pending','/aihot-resets/saved/advance']);
});
