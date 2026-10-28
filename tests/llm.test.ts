import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const offer = {
  key: 'free-api', title: '免费 API 额度', type: 'standing', valueText: '每月 100 至 200 美元',
  usdEstimate: 100, usdMax: 200, modalities: ['text'], claimMethod: 'signup', requirements: ['none'],
  audience: 'all', endKind: 'standing', sourceTz: 'UTC', steps: [], excerpts: {},
};
const gemini = (text: string) => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }], usageMetadata: { totalTokenCount: 100 } }));

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('GEMINI_API_KEY', 'test-key');
  vi.stubEnv('OPENROUTER_API_KEY', '');
  vi.stubEnv('GLM_API_KEY', '');
  vi.stubEnv('DEEPSEEK_API_KEY', '');
  vi.stubEnv('LLM_MIN_GAP_MS', '0');
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('model result contract', () => {
  it('rechecks suspicious empty extraction without losing an independent grant beside a competition',async()=>{
    let calls=0,feedback='';
    vi.stubGlobal('fetch',vi.fn(async(_input,init)=>{
      feedback=JSON.parse(String(init?.body)).systemInstruction.parts[0].text;
      return gemini(JSON.stringify({offers:++calls===1?[]:[{...offer,type:'apply',valueText:'最高$200科研API额度'}]}));
    }));
    const {extract}=await import('../pipeline/llm');
    const body='比赛前三名获奖$1000。另有独立科研资助，提交课题材料，审批后最高$200 API额度，不参与比赛排名。';
    const r=await extract('Vendor','https://vendor.example/free',body);
    expect(calls).toBe(2);expect(r.offers[0].type).toBe('apply');expect(feedback).toContain('空结果疑似漏掉');
  });
  it('never checkpoints a repeatedly empty mixed grant page as successfully evaluated',async()=>{
    const fetcher=vi.fn(async()=>gemini('{"offers":[]}'));vi.stubGlobal('fetch',fetcher);
    const {extract}=await import('../pipeline/llm');
    await expect(extract('Vendor','https://vendor.example/free','比赛前三名获奖$1000。另有独立科研资助，提交课题材料，审批后最高$200 API额度。')).rejects.toThrow('疑似漏掉');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('applies administrator network policy to foreign providers alongside billing requirements',async()=>{
    vi.stubGlobal('fetch',vi.fn(async()=>gemini(JSON.stringify({offers:[{...offer,requirements:['card','net']}]}))));
    const {extract}=await import('../pipeline/llm');
    const r=await extract('AWS','https://vendor.example','按量计费账户需要绑定支持的支付方式，无需预付款。');
    expect(r.offers[0].requirements).toEqual(['card','net']);
    const explicit=await extract('Vendor','https://vendor.example','须使用海外网络、境外IP地址并绑定支付方式。');
    expect(explicit.offers[0].requirements).toContain('net');
  });
  it('does not turn ordinary recurring allowances into reset-clock events',async()=>{
    const {tidy}=await import('../pipeline/llm');
    expect(tidy({...offer,type:'perk',tags:['reset'],title:'每月API赠额'} as never).tags).toEqual([]);
    expect(tidy({...offer,type:'standing',tags:['reset']} as never).tags).toEqual([]);
    expect(tidy({...offer,type:'perk',title:'未来一周每天发放重置卡',valueText:'每天1张重置卡',tags:['reset']} as never).tags).toEqual(['reset']);
  });
  it('rejects an invented first-of-month claim date instead of accepting prompt compliance on trust',async()=>{
    vi.stubGlobal('fetch',vi.fn(async()=>gemini(JSON.stringify({offers:[{...offer,claimStart:'2026-05-01'}]}))));
    const {extract}=await import('../pipeline/llm');
    await expect(extract('Vendor','https://vendor.example/free','计划2026年5月推出，2026年10月6日公布扩展权益')).rejects.toThrow('只有月份');
  });
  it('sends a month-precision validation error to a fallback model and accepts its evidenced current date',async()=>{
    vi.stubEnv('OPENROUTER_API_KEY','test-key');vi.stubEnv('OPENROUTER_MODEL','test:free');
    let instruction='';
    vi.stubGlobal('fetch',vi.fn(async(input,init)=>{
      if(String(input).includes('googleapis'))return gemini(JSON.stringify({offers:[{...offer,claimStart:'2026-05-01'}]}));
      instruction=JSON.parse(String(init?.body)).messages[0].content;
      return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({offers:[{...offer,claimStart:'2026-10-06'}]})}}],usage:{total_tokens:10}}));
    }));
    const {extract}=await import('../pipeline/llm');
    const r=await extract('Vendor','https://vendor.example/free','计划2026年5月推出，2026年10月6日公布扩展权益');
    expect(r.offers[0].claimStart).toBe('2026-10-06');expect(instruction).toContain('只有月份');
  });
  it.each([false, true])('sends current review lessons through the real extraction request (triage=%s)', async triage => {
    let system = '';
    vi.stubGlobal('fetch', vi.fn(async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      system = body.systemInstruction.parts[0].text;
      return gemini('{"offers":[]}');
    }));
    const { extract } = await import('../pipeline/llm');
    await extract('WorkBuddy', 'https://www.workbuddy.cn/docs/workbuddy/Pricing', '标准版每月实得4,000积分', undefined,
      triage ? { platformList: 'workbuddy=WorkBuddy', existing: 'old｜标准版加赠2000｜每月2000', corrections: ['此前误归平台，无法折美元，待审'] } : { platformIds: ['workbuddy'], existing: 'old｜标准版加赠2000｜每月2000', corrections: ['此前误归平台，无法折美元，待审'] });
    expect(system).toContain('WorkBuddy 标准/高级/旗舰每月加赠');
    expect(system).toContain('不因这些字样自动输出');
    expect(system).toContain('无需先付款');
    expect(system).toContain('不是 10 条免费视频');
    expect(system).toContain('第三方合作优惠分别核验与估值');
    expect(system).toContain('只知道月份不猜月初');
    expect(system).toContain('已有条目只是去重索引');
    expect(system).toContain('Qoder、Qwen及Qwen Code同属阿里体系');
    expect(system).toContain('第三方平台调用Qwen模型不因此成为阿里产品');
    expect(system).not.toContain('Qoder不等于Qwen');
    expect(system).toContain('steps只写用户操作，不写审核员待办');
    expect(system).toContain('仅作内部判断依据，不得将核验经过、历史错误或审核待办复制到公开字段');
    expect(system).toContain('权益估值V1');
    expect(system).toContain('Fact 数字必须为');
    expect(system).toContain('不要计算最终美元');
    expect(system).toContain('视频600秒生成素材');
    expect(system).toContain('输入输出各按对应单价');
    expect(system).toContain('不代表$0');
    expect(system).not.toContain('Token 按官方输入价');
    expect(system).not.toContain('人民币按 7.1 折算');
    expect(system).not.toContain('每分钟 Token 数 × 1440');
    expect(system).not.toContain('写"官方未写明具体额度："加原文说法');
    expect(system).not.toContain('只输出免费档里可量化的 AI 额度，以及写明');
    if (!triage) expect(system).toContain('6j7x/lpen/v4sd');
  });

  it.each(['{"error":"could not read source"}', '{"offers":null}', '{"offers":{}}', '{"offers":[null]}', '{"offers":['])
    ('does not turn malformed output %s into a successful empty extraction', async output => {
      vi.stubGlobal('fetch', vi.fn(async () => gemini(output)));
      const { extract } = await import('../pipeline/llm');
      await expect(extract('Vendor', 'https://vendor.example/free', 'Free API credits')).rejects.toThrow();
    });

  it('falls back after an invalid envelope and still records the first provider usage', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'test-key');
    vi.stubEnv('OPENROUTER_MODEL', 'test:free');
    const settle = vi.fn(async () => undefined);
    vi.stubGlobal('fetch', vi.fn(async input => String(input).includes('googleapis')
      ? gemini('{"error":"unable to extract"}')
      : new Response(JSON.stringify({ choices: [{ message: { content: '{"offers":[]}' } }], usage: { total_tokens: 10 } }))));
    const { extract } = await import('../pipeline/llm');
    const result = await extract('Vendor', 'https://vendor.example/free', 'Free API credits', undefined, {
      budget: { async reserve() { return { id: 1, tokens: 1000, costCny: 0 }; }, settle },
    });
    expect(result).toMatchObject({ provider: 'openrouter', offers: [] });
    expect(settle.mock.calls.map(call => call[2])).toEqual([100, 10]);
  });

  it('keeps only quotations from the supplied evidence body, excluding the discovery headline', async () => {
    const headline = 'Every Max member receives free credits.';
    const body = 'The service supports API calls.';
    vi.stubGlobal('fetch', vi.fn(async () => gemini(JSON.stringify({ offers: [{ ...offer, excerpts: { benefit: headline } }] }))));
    const { extract } = await import('../pipeline/llm');
    const result = await extract('Vendor', 'https://vendor.example/free', `${headline}\n${body}`, undefined, { evidenceText: body });
    expect(result.offers[0].excerpts).toEqual({});
  });

  it('ignores model-computed final amounts, including numeric strings', async () => {
    const { tidy } = await import('../pipeline/llm');
    expect(tidy({ ...offer, usdEstimate: '100', usdMax: '200' } as never)).toMatchObject({ usdEstimate: null, usdMax: null });
  });

  it('keeps publication day precision without inventing a midnight timestamp', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => gemini(JSON.stringify({ offers: [{ ...offer, publishedAt: '2026-10-06' }] }))));
    const { extract } = await import('../pipeline/llm');
    const r = await extract('Vendor', 'https://vendor.example/free', '活动发表于2026年10月6日');
    expect(r.offers[0].publishedAt).toBe('2026-10-06');
  });

  it.each([
    ['活动发表于2026年10月6日', '2026-10-06'],
    ['Published October 6, 2026', '2026-10-06'],
    ['公告发表于2026-10-06T00:00:00Z', '2026-10-06T00:00:00.000Z'],
    ['Published October 6, 2026 at 12 AM UTC', '2026-10-06T00:00:00.000Z'],
  ])('grounds model-supplied time precision in the evidence: %s', async (body, expected) => {
    vi.stubGlobal('fetch', vi.fn(async () => gemini(JSON.stringify({ offers: [{ ...offer, publishedAt: '2026-10-06T00:00:00Z' }] }))));
    const { extract } = await import('../pipeline/llm');
    const r = await extract('Vendor', 'https://vendor.example/free', body);
    expect(r.offers[0].publishedAt).toBe(expected);
  });
});

describe('provider cooldown within a collection run', () => {
  it('does not reserve budget or start a provider after the run deadline', async () => {
    const fetcher = vi.fn(), reserve = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    const { extract } = await import('../pipeline/llm');
    await expect(extract('Vendor', 'https://vendor.example/free', 'Free API credits', undefined, {
      deadlineAt: Date.now() - 1, budget: { reserve, settle: vi.fn() },
    })).rejects.toThrow('本轮即将结束');
    expect(reserve).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('does not repeat quota waits or call the paid fallback without authorization', async () => {
    vi.useFakeTimers();
    vi.stubEnv('OPENROUTER_API_KEY', 'test-key');
    vi.stubEnv('OPENROUTER_MODEL', 'test:free');
    vi.stubEnv('DEEPSEEK_API_KEY', 'test-key');
    const fetcher = vi.fn(async () => new Response('quota exhausted', { status: 429 }));
    vi.stubGlobal('fetch', fetcher);
    const { extract } = await import('../pipeline/llm');
    const started = Date.now();
    const run = (async () => {
      for (let i = 0; i < 50; i++) await expect(extract('Vendor', 'https://vendor.example/free', 'Free API credits')).rejects.toThrow();
    })();
    await vi.runAllTimersAsync();
    await run;
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls.map(call => String(call[0])).some(url => url.includes('deepseek'))).toBe(false);
    expect(Date.now() - started).toBeLessThan(60_000);
  });
});

it('requires a grounded reason for a lead-resolution decision without weakening normal extraction envelopes',async()=>{
  const text='We are investigating a display issue. No new credits are being granted.';
  vi.stubGlobal('fetch',vi.fn(async()=>gemini(JSON.stringify({offers:[],leadAssessment:{outcome:'not_benefit',reason:'仅额度显示异常，未新发放额度',quote:text}}))));
  const {extract}=await import('../pipeline/llm');
  const result=await extract('Vendor','https://vendor.example/post',text,undefined,{leadTarget:'额度重置异常'} as any);
  expect((result as any).leadAssessment).toMatchObject({outcome:'not_benefit',quote:text});
});

it('does not accept fabricated quotes as a reason to close a stuck lead',async()=>{
  vi.stubGlobal('fetch',vi.fn(async()=>gemini(JSON.stringify({offers:[],leadAssessment:{outcome:'not_benefit',reason:'无福利',quote:'This quote is fabricated'}}))));
  const {extract}=await import('../pipeline/llm');
  const result=await extract('Vendor','https://vendor.example/post','Actual official text',undefined,{leadTarget:'异常'} as any) as any;
  // 不采信伪造摘录：降为无结论交回，计入 inconclusive 并最终交人工，而不是当技术故障无限重试。
  expect(result.leadAssessment).toMatchObject({outcome:'unresolved'});
  expect(result.leadAssessment.reason).toContain('线索处理依据不在官方原文中');
  expect(result.leadAssessment.quote).toBeUndefined();
});
