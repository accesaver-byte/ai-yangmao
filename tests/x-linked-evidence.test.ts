import {afterEach,describe,expect,it,vi} from 'vitest';
import {fetchPage,officialLinkedUrls,syndicatedPostLinks,syndicatedPostText} from '../pipeline/lib';

const url='https://x.com/OpenRouter/status/2110755162214338984';
const product='https://openrouter.ai/nvidia/nemotron-3.5-super-vl:free';
const platform={id:'openrouter',name:'OpenRouter',site:'https://openrouter.ai',xHandles:['@OpenRouter'],staffHandles:[]};
const post={id_str:'2110755162214338984',user:{screen_name:'OpenRouter'},text:'Try it: https://t.co/nMwAvm5wm3',entities:{urls:[{url:'https://t.co/nMwAvm5wm3',expanded_url:product}]},card:{binding_values:{title:{string_value:'Nemotron3.5SuperVL(free)'}}}};
afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();});
describe('X evidence navigation',()=>{
 it('keeps preview metadata outside verbatim post text',async()=>{
  vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify(post))));
  const page=await fetchPage(url,{tries:1});
  expect(page.text).toBe('@OpenRouter\n'+post.text);
  expect(page.text).not.toContain('Nemotron3.5SuperVL(free)');
  expect(page.outboundLinks).toEqual([{url:product,title:'Nemotron3.5SuperVL(free)'}]);
  expect(page).toMatchObject({originalUrl:url,finalUrl:url,sourceVerified:true,fetchMethod:'first_party_embed'});
 });
 it('resolves the real card shortlink alias and preserves its title only on the expanded target',async()=>{
  const other='https://openrouter.ai/docs/free-models';
  const title='Nemotron 3.5 Super VL (free) - API Pricing & Providers';
  const realistic={...post,entities:{urls:[{url:'https://t.co/docs',expanded_url:other},{url:'https://t.co/nMwAvm5wm3',expanded_url:product},{url:product,expanded_url:product}]},
    card:{url:'https://t.co/nMwAvm5wm3',binding_values:{card_url:{type:'STRING',string_value:'https://t.co/nMwAvm5wm3'},title:{type:'STRING',string_value:title}}}};
  vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify(realistic))));
  const page=await fetchPage(url,{tries:1});
  expect(page.outboundLinks).toEqual([{url:other},{url:product,title}]);
  expect(page.outboundLinks?.some(link=>link.url.startsWith('https://t.co/'))).toBe(false);
  expect(page.text).toBe('@OpenRouter\n'+post.text);expect(page.text).not.toContain(title);
 });
 it.each([{...post,id_str:'2110755162214338985'},{...post,user:{screen_name:'attacker'}}])('drops metadata when author or ID mismatches',wrong=>{
  expect(syndicatedPostText(url,wrong)).toBeNull();expect(syndicatedPostLinks(url,wrong)).toEqual([]);
 });
 it('accepts already present AIHOT product URLs and rejects off-platform/private targets',()=>{
  const raw=`OpenRouter ${product} https://evil.example/free https://127.0.0.1/free https://openrouter.ai@evil.example/free https://openrouter.ai.evil.example/free`;
  expect(officialLinkedUrls(url,raw,undefined,[platform])).toEqual([product]);
  expect(officialLinkedUrls('https://news.example/post',raw,undefined,[platform])).toEqual([product]);
  expect(officialLinkedUrls('https://news.example/post',product,undefined,[platform])).toEqual([]);
 });
 it('does not send an unsafe redirect through reader fallbacks',async()=>{
  const fetch=vi.fn(async()=>new Response(null,{status:302,headers:{location:'http://127.0.0.1/private'}}));vi.stubGlobal('fetch',fetch);
  await expect(fetchPage(product,{tries:1})).rejects.toThrow('私有地址');
  expect(fetch).toHaveBeenCalledTimes(1);
 });
 it('does not allow a link to inherit another admitted platform identity',()=>{
  expect(officialLinkedUrls(url,'https://other.example/free',undefined,[platform,{...platform,id:'other',name:'Other',site:'https://other.example',xHandles:[]}])).toEqual([]);
 });
});
