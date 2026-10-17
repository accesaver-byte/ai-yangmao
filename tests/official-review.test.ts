import { describe,it,expect,vi,afterEach } from 'vitest';
import { officialTier,officialActivityMismatch } from '../src/shared/official-review';
import { parseSearchResults,searchOfficial,exaSearchRequest } from '../pipeline/official-review';
const platform={id:'vendor',name:'Vendor',site:'https://vendor.example',xHandles:['@vendor'],staffHandles:['@staff']};
afterEach(()=>vi.unstubAllGlobals());
describe('official source discovery',()=>{
  it('rejects unrelated recurring quotas or pricing as proof of a one-off gift or reset',()=>{
    const monthly={title:'Max API credits',valueText:'每月 100 至 200 美元 API 额度',type:'standing',tags:[]};
    expect(officialActivityMismatch({title:'Claude $250 额度赠金',valueText:'$250赠金',type:'perk'},monthly)).toContain('另一类活动');
    expect(officialActivityMismatch({title:'Opus发布送重置卡',valueText:'1张',type:'perk',tags:['reset']},monthly)).toContain('另一类活动');
    expect(officialActivityMismatch({...monthly,type:'perk',valueText:'每月100美元 API额度'},monthly)).toBeNull();
  });
  it('accepts registered docs and account posts but rejects lookalikes and unrelated shared-host content',()=>{
    expect(officialTier('https://docs.vendor.example/credits',platform,[])).toBe('docs');
    expect(officialTier('https://vendor.example.evil.test/free',platform,[])).toBeNull();
    expect(officialTier('https://x.com/vendor/status/123',platform,[])).toBe('official');
    expect(officialTier('https://x.com/vendor_fans/status/123',platform,[])).toBeNull();
    expect(officialTier('https://x.com/staff/status/123',platform,[])).toBe('staff');
    const sources=[{url:'https://github.com/vendor/project',tier:'official'}];
    expect(officialTier('https://github.com/vendor/project/blob/main/README.md',platform,sources)).toBe('site');
    expect(officialTier('https://github.com/attacker/project',platform,sources)).toBeNull();
    expect(officialTier('https://github.com/vendor/project/issues/123',platform,sources)).toBeNull();
    expect(officialTier('https://github.com/vendor/project/discussions/123',platform,sources)).toBeNull();
    expect(officialTier('https://github.com/vendor/project/releases/tag/v1#issuecomment-123',platform,sources)).toBeNull();
    expect(officialTier('https://vendor.example:8080/free',platform,[])).toBeNull();
  });
  it('parses actual MCP source records, never promoting excerpts into fetched evidence',()=>{
    const body=JSON.stringify({result:{content:[{type:'text',text:'Title: Benefit\nURL: https://vendor.example/free\nHighlights:\nFree credits'}]}});
    expect(parseSearchResults('event: message\ndata: '+body+'\n\n')).toEqual(['https://vendor.example/free']);
    expect(()=>parseSearchResults(JSON.stringify({result:{isError:true,content:[{type:'text',text:'rate limit'}]}}))).toThrow();
  });
  it('uses the cloud-callable search endpoint with no local browser or credentials',async()=>{
    delete process.env.EXA_API_KEY;
    const fetcher=vi.fn(async()=>new Response(JSON.stringify({result:{content:[{type:'text',text:'URL: https://vendor.example/free'}]}})));
    vi.stubGlobal('fetch',fetcher);
    expect(await searchOfficial('Vendor free credits official',Date.now()+30000)).toEqual(['https://vendor.example/free']);
    const [url,init]=fetcher.mock.calls[0] as unknown as [string,RequestInit];
    expect(url).toBe('https://mcp.exa.ai/mcp');
    const request=JSON.parse(String(init.body));expect(request.params.name).toBe('web_search_exa');expect(request.params.arguments.objective).toContain('official');
  });
  // build-with-exa：有密钥时走 REST /search，query + type auto + objective；官方站点/X 账号白名单用 includeDomains，不写进查询文字。
  it('turns registered official site restrictions into Exa includeDomains',()=>{
    expect(exaSearchRequest('Codex 重置 官方 原文 site:openai.com OR site:help.openai.com')).toMatchObject({query:'Codex 重置 官方 原文',type:'auto',includeDomains:['openai.com','help.openai.com']});
    expect(exaSearchRequest('Codex 重置 site:x.com/thsottiaux/status OR site:x.com/OpenAI/status').includeDomains).toEqual(['x.com/thsottiaux','x.com/OpenAI']);
    const plain=exaSearchRequest('DeepSeek 故障补偿');
    expect(plain).toEqual({query:'DeepSeek 故障补偿',type:'auto',objective:expect.any(String)});
    expect(plain).not.toHaveProperty('contents');expect(plain).not.toHaveProperty('numResults');
  });
  it('uses the Exa REST search endpoint with the API key when configured',async()=>{
    process.env.EXA_API_KEY='exa-test';
    const fetcher=vi.fn(async()=>Response.json({results:[{url:'https://openai.com/news/a'},{url:'https://openai.com/news/a'},{url:'https://help.openai.com/b'}]}));
    vi.stubGlobal('fetch',fetcher);
    expect(await searchOfficial('Codex 重置 site:openai.com OR site:help.openai.com',Date.now()+30000)).toEqual(['https://openai.com/news/a','https://help.openai.com/b']);
    const [url,init]=fetcher.mock.calls[0] as unknown as [string,RequestInit];
    expect(url).toBe('https://api.exa.ai/search');
    expect((init.headers as Record<string,string>)['x-api-key']).toBe('exa-test');
    expect(JSON.parse(String(init.body))).toMatchObject({query:'Codex 重置',type:'auto',includeDomains:['openai.com','help.openai.com']});
    delete process.env.EXA_API_KEY;
  });
  // 2026-10-15：Exa 匿名端点限流后整轮暂停搜索，社区线索全部转重试。
  it('falls back to OpenRouter web search when Exa is rate limited, charging the shared budget',async()=>{
    process.env.OPENROUTER_API_KEY='test-key';
    const calls:string[]=[];
    vi.stubGlobal('fetch',vi.fn(async(input:string,init?:RequestInit)=>{
      const url=String(input);calls.push(url);
      if(url==='https://mcp.exa.ai/mcp')return new Response(JSON.stringify({result:{isError:true,content:[{type:'text',text:'rate limit'}]}}));
      if(url.endsWith('/model-budget/reserve'))return Response.json({id:7});
      if(url.endsWith('/model-budget/7/settle'))return Response.json({ok:true});
      if(url.startsWith('https://openrouter.ai/')){
        expect(JSON.parse(String(init?.body)).plugins).toEqual([{id:'web',max_results:5}]);
        return Response.json({choices:[{message:{content:'urls',annotations:[{type:'url_citation',url_citation:{url:'https://vendor.example/notice'}},{type:'url_citation',url_citation:{url:'https://vendor.example/notice'}}]}}],usage:{cost:0.007}});
      }
      throw new Error('unexpected '+url);
    }));
    expect(await searchOfficial('Vendor outage compensation',Date.now()+30000)).toEqual(['https://vendor.example/notice']);
    expect(calls.filter(u=>u.includes('/model-budget/'))).toHaveLength(2);
    delete process.env.OPENROUTER_API_KEY;
  });
  it('keeps the original search error when the fallback is unavailable',async()=>{
    delete process.env.OPENROUTER_API_KEY;
    vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({result:{isError:true,content:[{type:'text',text:'rate limit'}]}}))));
    await expect(searchOfficial('Vendor',Date.now()+30000)).rejects.toThrow();
  });
});

it('keeps room for a fresh automatic benefit amid an unreachable manual backlog',async()=>{
  const {selectLeads}=await import('../src/shared/leads');
  const stuck=Array.from({length:50},(_,id)=>({id,origin:'manual',title:'旧补录链接'}));
  const urgent={id:99,origin:'aihot',title:'Codex 今日重置卡发放'};
  const chosen=selectLeads([...stuck,urgent],50);
  expect(chosen).toHaveLength(50);expect(chosen).toContain(urgent);expect(chosen).toContain(stuck[0]);
});

it('only marks reader content attributable when its source metadata matches and has no error warning',async()=>{
  const {fetchPage}=await import('../pipeline/lib');
  vi.stubGlobal('fetch',vi.fn(async(input)=>String(input).startsWith('https://r.jina.ai/')
    ?new Response('Title: Official\nURL Source: https://vendor.example/free\nMarkdown Content:\nAll users receive free credits.')
    :new Response('tiny')));
  expect((await fetchPage('https://vendor.example/free',{tries:1})).sourceVerified).toBe(true);
  vi.stubGlobal('fetch',vi.fn(async(input)=>String(input).startsWith('https://r.jina.ai/')
    ?new Response('URL Source: https://vendor.example/free\nWarning: Target URL returned error 403\nMarkdown Content:\nblocked')
    :new Response('tiny')));
  expect((await fetchPage('https://vendor.example/free',{tries:1})).sourceVerified).toBe(false);
});


it('validates the identity of a first-party status embed and preserves reader provenance',async()=>{
 const {fetchPage,syndicatedPostText}=await import('../pipeline/lib');
 const url='https://x.com/vendor/status/2107398361733104102';const post={id_str:'2107398361733104102',user:{screen_name:'Vendor'},text:'Space Bunny free period extended.',created_at:'2026-10-06T09:11:37.000Z'};
 expect(syndicatedPostText(url,post)).toContain(post.text);
 for(const wrong of [{...post,id_str:'other'}, {...post,user:{screen_name:'Imposter'}},{...post,text:''},{...post,truncated:true}])expect(syndicatedPostText(url,wrong)).toBeNull();
 vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify(post),{headers:{'content-type':'application/json'}})));
 const result=await fetchPage(url,{tries:1});
 expect(result).toMatchObject({via:'direct',sourceVerified:true,finalUrl:url});expect(result.fetchedUrl).toContain('cdn.syndication.twimg.com/tweet-result');expect(result.text).toContain(post.text);
});

import { fetchPage } from '../pipeline/lib';
// 2026-10-16：公众号文章云端直读与 Jina 都是验证页，改用 Exa 读取正文；结果按第三方阅读器（间接来源）处理。
describe('WeChat article reading', () => {
  const article = 'https://mp.weixin.qq.com/s/Z-t4CsaER-erJLsqRnT1eA';
  const captcha = '<html><body><h2>环境异常</h2><p>当前环境异常，完成验证后即可继续访问。</p><a>去验证</a></body></html>';
  it('reads a CAPTCHA-blocked WeChat article through Exa contents', async () => {
    process.env.EXA_API_KEY = 'exa-test';
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input); calls.push(url);
      if (url === 'https://api.exa.ai/contents') {
        expect(JSON.parse(String(init?.body))).toEqual({ urls: [article], text: true });
        return Response.json({ results: [{ url: article, title: 'CodeBuddy 补偿公告', author: '腾讯云代码助手', text: '面向 CodeBuddy 国内版全量用户额外赠送 500 积分，10 月 22 日 24 点前在“用量管理”页面手动领取。' }] });
      }
      return new Response(captcha, { headers: { 'content-type': 'text/html' } });
    }));
    const page = await fetchPage(article, { timeoutMs: 5000, tries: 1, minimumTextLength: 50 });
    expect(page).toMatchObject({ via: 'jina', fetchMethod: 'exa', sourceVerified: true });
    expect(page.text).toContain('500 积分');
    expect(page.text).toContain('公众号：腾讯云代码助手');
    expect(calls.some(u => u.startsWith('https://r.jina.ai/'))).toBe(false);
    delete process.env.EXA_API_KEY;
  });
  it('does not treat an Exa CAPTCHA copy as the article', async () => {
    process.env.EXA_API_KEY = 'exa-test';
    vi.stubGlobal('fetch', vi.fn(async (input: string) => String(input) === 'https://api.exa.ai/contents'
      ? Response.json({ results: [{ url: article, text: '环境异常 当前环境异常，完成验证后即可继续访问。 去验证 '.repeat(5) }] })
      : String(input).startsWith('https://r.jina.ai/') ? new Response('Title: 环境异常\nMarkdown Content:\n' + '环境异常 去验证 '.repeat(40)) : new Response(captcha)));
    const page = await fetchPage(article, { timeoutMs: 5000, tries: 1, minimumTextLength: 50 }).catch(() => null);
    expect(page?.fetchMethod).not.toBe('exa');
    delete process.env.EXA_API_KEY;
  });
});

it('treats the "scan in WeChat to open" page as blocked and reads the article through Exa', async () => {
  process.env.EXA_API_KEY = 'exa-test';
  const article = 'https://mp.weixin.qq.com/s/Z-t4CsaER-erJLsqRnT1eA';
  const shell = '<html><body>Got It Scan with Weixin to use this Mini Program Cancel Allow 微信扫一扫可打开此内容，使用完整服务 Video Mini Program Like Share</body></html>';
  vi.stubGlobal('fetch', vi.fn(async (input: string) => String(input) === 'https://api.exa.ai/contents'
    ? Response.json({ results: [{ url: article, title: 'CodeBuddy 公告', text: '面向 CodeBuddy 国内版全量用户额外赠送 500 积分。'.repeat(20) }] })
    : new Response(shell)));
  const page = await fetchPage(article, { timeoutMs: 5000, tries: 1, minimumTextLength: 50 });
  expect(page.fetchMethod).toBe('exa');
  delete process.env.EXA_API_KEY;
});
