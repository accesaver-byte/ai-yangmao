import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({api:vi.fn(),fetchPage:vi.fn(),extract:vi.fn(),save:vi.fn(),search:vi.fn()}));
vi.mock('../pipeline/lib',async original=>({...await original<typeof import('../pipeline/lib')>(),api:mocks.api,fetchPage:mocks.fetchPage}));
vi.mock('../pipeline/llm',()=>({extract:mocks.extract,modelAvailable:()=>true,DeferError:class extends Error{}}));
vi.mock('../pipeline/identity-client',()=>({postIdentityOffers:mocks.save}));
vi.mock('../pipeline/official-review',()=>({searchOfficial:mocks.search}));
import {runLeadReviews} from '../pipeline/lead-review';
const url='https://x.com/OpenRouter/status/2110755162214338984';
const product='https://openrouter.ai/nvidia/nemotron-3.5-super-vl:free';
const body='Nemotron 3.5 Super VL (free)\nFree inference. Input: $0 per million tokens. Output: $0 per million tokens.';
const platform={id:'openrouter',name:'OpenRouter',site:'https://openrouter.ai',xHandles:['@OpenRouter'],staffHandles:[]};
const candidate={key:'nemotron-free',platformId:'openrouter',title:'Nemotron 3.5 Super VL 免费模型',type:'standing',modalities:['text','image'],models:['Nemotron 3.5 Super VL'],claimMethod:'signup',requirements:['none'],audience:'all',valueText:'免费推理',claimStart:null,claimEnd:null,endKind:'standing',sourceTz:'UTC',steps:[],excerpts:{benefit:'Free inference.'}};
const primary={text:'@OpenRouter\nTry it: https://t.co/nMwAvm5wm3',via:'direct',originalUrl:url,finalUrl:url,fetchedUrl:'https://cdn.syndication.twimg.com/tweet-result?id=2110755162214338984',fetchMethod:'first_party_embed',sourceVerified:true,outboundLinks:[{url:product,title:'Nemotron3.5SuperVL(free)'}]};
const linked={text:body,via:'direct',originalUrl:product,finalUrl:product,fetchedUrl:product,fetchMethod:'direct',sourceVerified:true,truncated:false};
let raw:string;
beforeEach(()=>{
 vi.clearAllMocks();raw='OpenRouter new free model';
 mocks.api.mockImplementation(async(path:string,request?:unknown)=>path.includes('/queue')?{jobs:[{id:7669}]}:path.endsWith('/claim')?{claimed:true,jobId:'12345678-1234-4234-8234-123456789012',lead:{id:7669,title:'OpenRouter 免费模型',url,raw,origin:'aihot'},platforms:[platform],sources:[],existing:[]}:path.startsWith('/corrections')?{corrections:[]}:{status:(request as any).outcome});
 mocks.fetchPage.mockImplementation(async(link:string)=>link===url?primary:linked);
 mocks.extract.mockImplementation(async(_name:string,link:string)=>({offers:link===product?[candidate]:[],...(link===url?{leadAssessment:{outcome:'not_benefit',reason:'Only a short announcement',quote:'Try it: https://t.co/nMwAvm5wm3'}}:{}),tokens:1,costCny:0}));
 mocks.save.mockResolvedValue({results:[{id:'openrouter-nemotron-free'}]});mocks.search.mockResolvedValue([]);
});
afterEach(()=>vi.restoreAllMocks());
const run=()=>runLeadReviews({limit:1,deadlineAt:Date.now()+60000,dry:false,allowPaid:false,canContinue:()=>true,account:()=>{},log:()=>{}});
const receipt=()=>mocks.api.mock.calls.find(([path])=>path.endsWith('/result'))?.[1] as any;
describe('lead linked official evidence recovery',()=>{
 it('reads the product page before accepting a negative short-post assessment and binds its own source',async()=>{
  await run();expect(receipt()).toMatchObject({outcome:'linked'});
  expect(mocks.fetchPage.mock.calls.map(([link])=>link)).toEqual([url,product]);
  expect(mocks.extract.mock.calls[0][2]).not.toContain('Nemotron3.5SuperVL(free)');
  expect(mocks.extract.mock.calls[1][2]).toBe(body);
  const saved=mocks.save.mock.calls[0][0][0];
  expect(saved).toMatchObject({evidence:{url:product,excerpts:{benefit:'Free inference.'}},sourceText:body,sourceFetch:{originalUrl:product,finalUrl:product,method:'direct'}});
  expect(saved.sourceText).not.toContain('Try it:');
 });
 it('reads AIHOT raw exact links in phase zero before generic sources/searches',async()=>{
  raw=`OpenRouter ${product}`;mocks.fetchPage.mockImplementation(async(link:string)=>link===url?{...primary,outboundLinks:[]}:linked);
  await run();expect(receipt().outcome).toBe('linked');expect(mocks.search).not.toHaveBeenCalled();expect(mocks.fetchPage.mock.calls[1][0]).toBe(product);
 });
 it('keeps technical linked-page failure retryable even when the post model says not_benefit',async()=>{
  mocks.fetchPage.mockImplementation(async(link:string)=>{if(link===product)throw new Error('HTTP 403');return primary;});
  await run();expect(receipt()).toMatchObject({outcome:'retry'});expect(mocks.save).not.toHaveBeenCalled();expect(receipt().sourceText).toBeUndefined();
 });
 it('rejects off-platform redirect provenance without replacing original text',async()=>{
  mocks.fetchPage.mockImplementation(async(link:string)=>link===url?primary:{...linked,finalUrl:'https://evil.example/free'});
  await run();expect(receipt().outcome).toBe('retry');expect(mocks.save).not.toHaveBeenCalled();expect(primary.text).toContain('Try it:');
 });
 it('does not negatively close a linked benefit merely because extraction returns no offer',async()=>{
  mocks.extract.mockResolvedValue({offers:[],leadAssessment:{outcome:'not_benefit',reason:'No new grant',quote:'Try it:'},tokens:1,costCny:0});
  await run();expect(receipt().outcome).toBe('manual');
 });
});
