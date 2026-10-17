import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sha256, relevantText } from '../pipeline/lib';

const benefit = 'All Max members receive free API credits monthly: $100 or $200.';
const page = `<html><body><article><p>${benefit}</p><p>${'Product documentation. '.repeat(50)}</p></article></body></html>`;
const candidate = {
  key: 'max-api', platformId: 'vendor', title: 'Max 每月 API 赠额', type: 'standing', modalities: ['text'],
  claimMethod: 'member', requirements: ['member:Max'], audience: 'all', valueText: '每月赠送 100 至 200 美元 API 额度',
  usdEstimate: 100, usdMax: 200, claimStart: null, claimEnd: null, endKind: 'standing', sourceTz: 'UTC', steps: [],
  excerpts: { benefit },
};
const lead = { id: 1, origin: 'aihot', url: 'https://vendor.example/offer', title: 'Vendor 免费 API 额度', raw: benefit, createdAt: new Date().toISOString() };
const aihotSource = { id: 'aihot', kind: 'aihot', tier: 'lead', url: 'https://mock-aihot.example/api', config: {} };
const rssSource = { id: 'rss', kind: 'rss', tier: 'site', platformId: 'vendor', platform: { id: 'vendor', name: 'Vendor', status: 'approved' }, url: 'https://vendor.example/rss', config: {}, lastHash: null, lastText: null };
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });

interface HarnessOptions {
  indexFailure?: boolean;
  ingestResults?: Record<string, unknown>[];
  rescueJob?:boolean;
  rescuePlatforms?:Record<string,unknown>[];
  officialJob?: boolean;
  officialJobIds?:string[];
  officialSteps?: string[];
  officialUrls?: string[];
  previousCandidates?: string[];
  jinaBody?: string;
  officialSearchStatus?: number;
  partialSearch?: boolean;
  sources?: Record<string, unknown>[];
  leads?: Record<string, unknown>[];
  pages?: Record<string, string | number>;
  modelOutput?: string;
  geminiStatus?: number;
  budgetDenied?: boolean;
  costMonthCny?: number;
  verification?: Record<string, unknown>[];
  verificationStatus?: number;
  verified?: boolean;
  known?: Record<string, unknown>[];
  profiles?: Record<string, unknown>[];
}
function harness(options: HarnessOptions = {}) {
  const writes: { url: string; body: any }[] = [];
  const reads: string[] = [];
  let reservation = 0, searchCalls = 0;
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init: RequestInit = {}) => {
    const url = String(input), body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    reads.push(url);
    if (body) writes.push({ url, body });
    if (url.endsWith('/budget')) return json({ tokensToday: 0, costMonthCny: options.costMonthCny ?? 0 });
    if (url.endsWith('/sources')) return json({ sources: options.sources ?? [aihotSource] });
    if (url === aihotSource.url) return json({ items: [] });
    if (url.endsWith('/observations')) return json({observationId:'obs-test',documentId:'doc-test',contentHash:'a'.repeat(64),truncated:false});
    if (url.endsWith('/candidates')) return json({receipts:body.candidates.map((c:any)=>({inputId:c.inputId,candidateId:'c-'+c.inputId,canonicalOfferId:null,entityId:null,versionId:null,decisionId:null,taskId:null,outcome:'deferred',retryable:true,reasonCodes:['shadow_pending_resolution']}))});
    if (url.endsWith('/snapshots')) return json({ changed: false });
    if (url.endsWith('/api/platforms')) return json({ platforms: [{ id: 'vendor', name: 'Vendor', site: 'https://vendor.example', xHandles: [], staffHandles: [] }] });
    if(url.includes('/fast-track/queue'))return json({jobs:[]});
    if(url.includes('/lead-reviews/queue'))return json({jobs:options.rescueJob?[{id:1312}]:[]});
    if(url.endsWith('/lead-reviews/1312/claim'))return json({claimed:true,jobId:'12345678-1234-4234-8234-123456789012',previousCandidates:options.previousCandidates,lead:{...lead,...options.leads?.[0],id:1312,status:'reviewing'},platforms:options.rescuePlatforms??[{id:'vendor',name:'Vendor',site:'https://vendor.example',xHandles:[],staffHandles:[]}],sources:[],existing:options.known??[]});
    if(url.endsWith('/lead-reviews/1312/result'))return json({status:body.outcome,nextAttemptAt:body.outcome==='retry'?'2030-01-01T00:00:00Z':null});
    if (url.includes('/leads?')) return json({ leads: options.leads ?? [] });
    if (url.includes('/official-reviews/queue')) return json({jobs:(options.officialJobIds??(options.officialJob?['vendor-max-api']:[])).map(id=>({id,title:candidate.title})),remaining:options.officialJobIds?.length??(options.officialJob?1:0)});
    if(url.includes('/official-reviews/')&&url.endsWith('/claim'))return json({claimed:true,jobId:'12345678-1234-4234-8234-123456789012',previousCandidates:options.previousCandidates,offer:{...candidate,steps:options.officialSteps??[],id:url.split('/').at(-2),firstChannel:'reddit',evidence:{url:'https://community.example/post',tier:'media',capturedAt:new Date().toISOString(),excerpts:{}}},platform:{id:'vendor',name:'Vendor',site:'https://vendor.example',xHandles:options.partialSearch?['@vendor']:[],staffHandles:[]},sources:[]});
    if(url.includes('/official-reviews/')&&url.endsWith('/result'))return json({status:body.status});
    if(url==='https://mcp.exa.ai/mcp' && options.partialSearch && ++searchCalls>1)return new Response('quota',{status:429});
    if(url==='https://mcp.exa.ai/mcp')return options.officialSearchStatus?new Response('unavailable',{status:options.officialSearchStatus}):json({result:{content:[{type:'text',text:(options.officialUrls??['https://vendor.example/confirmed']).map(u=>'URL: '+u).join('\n')}]}});
    if (url.includes('/offers-index')) return options.indexFailure?new Response('unavailable',{status:503}):json({ offers: options.known ?? [], complete:true, nextCursor:null });
    if (url.includes('/screening/memory')) return json({ records: [], rules: [], profiles: options.profiles ?? [], calibrations: [], nextCursor: null });
    if (url.includes('/corrections?')) return json({ corrections: [] });
    if (url.endsWith('/model-budget/reserve')) return options.budgetDenied ? jsonError() : json({ id: ++reservation });
    if (url.endsWith('/settle')) return json({ ok: true });
    if (url.includes('generativelanguage.googleapis.com')) return options.geminiStatus
      ? new Response('quota exhausted', { status: options.geminiStatus })
      : json({ candidates: [{ content: { parts: [{ text: options.modelOutput ?? JSON.stringify({ offers: [candidate] }) }] } }], usageMetadata: { totalTokenCount: 100 } });
    if (url.includes('api.deepseek.com')) return json({ choices: [{ message: { content: options.modelOutput ?? JSON.stringify({ offers: [candidate] }) } }], usage: { total_tokens: 100, prompt_tokens: 80, completion_tokens: 20 } });
    if (url.endsWith('/leads')) return json({created:body.length});
    if (url.endsWith('/offers')) return json({ results: options.ingestResults ?? body.map((o: { id: string }) => ({ id: o.id, created: true, reviewState: 'pending' })) });
    if (url.endsWith('/status') || url.endsWith('/runs')) return json({ ok: true });
    if (url.includes('/verification-queue')) return options.verificationStatus
      ? new Response('verification queue unavailable', { status: options.verificationStatus }) : json({ offers: options.verification ?? [] });
    if (url.endsWith('/verify')) return json({ verified: body.trustedDirect !== false && (options.verified ?? true) });
    if (url.startsWith('https://r.jina.ai/')) return options.jinaBody?new Response(options.jinaBody):new Response('blocked', { status: 403 });
    if (url.startsWith('https://vendor.example/')) {
      const response = options.pages?.[url] ?? page;
      return typeof response === 'number' ? new Response('blocked', { status: response }) : new Response(response);
    }
    if(url==='https://community.example/post')return new Response(page);
    throw new Error(`Unexpected mocked request: ${url}`);
  }));
  return { reads, writes, payloads: (suffix: string) => writes.filter(write => write.url.endsWith(suffix)).map(write => write.body) };
}
const jsonError = () => new Response(JSON.stringify({ error: '模型预算不足' }), { status: 429 });
const rss = (...urls: string[]) => `<rss><channel>${urls.map(url => `<item><title>Free API credits</title><link>${url}</link></item>`).join('')}</channel></rss>`;

beforeEach(() => {
  vi.resetModules();
  for (const [key, value] of Object.entries({ API_BASE: 'https://mock.local', IDENTITY_MODE:'shadow', IDENTITY_MODEL_ASSIST:'false', INGEST_TOKEN: 'test-ingest', GEMINI_API_KEY: 'test-key', OPENROUTER_API_KEY: '', GLM_API_KEY: '', DEEPSEEK_API_KEY: '', FAST_LEADS: '1', FORCE: '0', DRY_RUN: '0', ONLY_SOURCES: '', DAILY_TOKEN_CAP: '0', MONTHLY_COST_CAP_CNY: '10', LLM_MIN_GAP_MS: '0' })) vi.stubEnv(key, value);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('lead evidence and value delivery', () => {
  it('keeps an unreachable official link at media tier and ignores untrusted model dollar amounts', async () => {
    const h = harness({ leads: [lead], pages: { [lead.url]: 403 } });
    const { runPipeline } = await import('../pipeline/run');
    await runPipeline();
    expect(h.payloads('/offers')[0][0]).toMatchObject({ usdEstimate: null, usdMax: null, evidence: { tier: 'media', excerpts: { benefit } } });
    expect(h.payloads('/status')[0]).toMatchObject({ status: 'linked' });
  });

  it('never treats the aggregator headline as a quotation from a successfully fetched official page', async () => {
    const headline = 'Every member receives an additional 900 dollars.';
    const h = harness({ leads: [{ ...lead, title: headline }], modelOutput: JSON.stringify({ offers: [{ ...candidate, excerpts: { benefit: headline } }] }) });
    const { runPipeline } = await import('../pipeline/run');
    await runPipeline();
    expect(h.payloads('/offers')[0][0].evidence.tier).toBe('site');
    expect(h.payloads('/offers')[0][0].evidence.excerpts).toEqual({});
  });

  it('does not advance an official page checkpoint after an invalid model envelope', async () => {
    vi.stubEnv('FAST_LEADS', '0');
    const h = harness({ sources: [{ ...rssSource, kind: 'web_list', url: lead.url }], modelOutput: '{"error":"could not read source"}' });
    const { runPipeline } = await import('../pipeline/run');
    const result = await runPipeline();
    expect(result.ok).toBe(false);
    expect(h.payloads('/snapshots').some(snapshot => snapshot.hash)).toBe(false);
    expect(h.payloads('/offers')).toEqual([]);
  });

  it('gives reset extraction the existing event dates and evidence links, not just its repeated title', async () => {
    const evidenceUrl = 'https://x.com/OpenAI/status/1950000000000000000';
    const h = harness({ leads: [lead], known: [{ id: 'vendor-july-reset', platformId: 'vendor', title: 'Codex 重置卡发放', valueText: '1 张',
      tags: ['reset'], claimStart: '2026-07-13', publishedAt: '2026-07-13T18:00:00Z', evidenceUrl }] });
    const { runPipeline } = await import('../pipeline/run');
    await runPipeline();
    const instruction = h.writes.find(write => write.url.includes('googleapis'))!.body.systemInstruction.parts[0].text;
    expect(instruction).toContain('2026-07-13');
    expect(instruction).toContain('2026-07-13T18:00:00Z');
    expect(instruction).toContain(evidenceUrl);
  });
  // 2026-10-15：整份索引（400+ 条）随每条线索发送，提示词 6–8 万 token，免费档 429、付费兜底昂贵。
  it('sends triage only the existing offers of platforms the lead mentions', async () => {
    const h = harness({ leads: [lead], known: [
      { id: 'vendor-signup', platformId: 'vendor', title: 'Vendor 注册赠额', valueText: '10 美元' },
      { id: 'elsewhere-promo', platformId: 'elsewhere', title: 'Elsewhere 无关活动', valueText: '无关' }] });
    const { runPipeline } = await import('../pipeline/run');
    await runPipeline();
    const instruction = h.writes.find(write => write.url.includes('googleapis'))!.body.systemInstruction.parts[0].text;
    expect(instruction).toContain('vendor-signup');
    expect(instruction).not.toContain('elsewhere-promo');
  });
});

describe('official RSS progress', () => {
  it('continues beyond a broken article and checkpoints only articles completed successfully', async () => {
    vi.stubEnv('FAST_LEADS', '0');
    const bad = 'https://vendor.example/bad', good = 'https://vendor.example/good';
    const h = harness({ sources: [rssSource], pages: { [rssSource.url]: rss(bad, good), [bad]: 403 } });
    const { runPipeline } = await import('../pipeline/run');
    const result = await runPipeline();
    expect(h.reads).toContain(good);
    expect(h.payloads('/offers')).toHaveLength(1);
    expect(h.payloads('/snapshots').find(snapshot => snapshot.hash)?.text).toBe(good);
    expect(result.stats.fetchedSources).toBe(1);
    expect(result.stats.ok).toBe(0);
    expect(result.stats.coverageDegraded).toBe(true);
    expect(result.ok).toBe(false);
  });

  it('force re-extracts already completed RSS articles with an unchanged feed hash', async () => {
    vi.stubEnv('FAST_LEADS', '0');
    vi.stubEnv('FORCE', '1');
    const url = 'https://vendor.example/offer';
    const h = harness({ sources: [{ ...rssSource, lastHash: sha256(url), lastText: url }], pages: { [rssSource.url]: rss(url) } });
    const { runPipeline } = await import('../pipeline/run');
    await runPipeline();
    expect(h.reads).toContain(url);
    expect(h.payloads('/offers')).toHaveLength(1);
  });

  it('does not let five broken articles permanently occupy the five successful-extraction slots', async () => {
    vi.stubEnv('FAST_LEADS', '0');
    const broken = Array.from({ length: 5 }, (_, n) => `https://vendor.example/bad-${n}`);
    const good = 'https://vendor.example/good';
    const h = harness({ sources: [rssSource], pages: { [rssSource.url]: rss(...broken, good), ...Object.fromEntries(broken.map(url => [url, 403])) } });
    const { runPipeline } = await import('../pipeline/run');
    await runPipeline();
    expect(h.reads).toContain(good);
    expect(h.payloads('/snapshots').find(snapshot => snapshot.hash)?.text).toBe(good);
  });
});

describe('verification health', () => {
  it('still records a failed run if the verification queue itself is unavailable', async () => {
    vi.stubEnv('FAST_LEADS', '0');
    const h = harness({ verificationStatus: 500 });
    const { runPipeline } = await import('../pipeline/run');
    const result = await runPipeline();
    expect(result.ok).toBe(false);
    expect(h.payloads('/runs')[0]).toMatchObject({ ok: false, stats: { verificationFailed: 1, coverageDegraded: true } });
  });

  it.each(['unreachable', 'missing quotes'])('reports degraded coverage when an existing offer is %s', async reason => {
    vi.stubEnv('FAST_LEADS', '0');
    const h = harness({ verification: [{ id: 'vendor-free', url: lead.url, tier: 'site', pageHash: sha256(relevantText(`${benefit}\n${'Product documentation. '.repeat(50)}`)), proposalHash: null, sourceId: null, platformId: 'vendor' }],
      pages: reason === 'unreachable' ? { [lead.url]: 403 } : undefined, verified: false });
    const { runPipeline } = await import('../pipeline/run');
    const result = await runPipeline();
    expect(result.ok).toBe(false);
    expect(result.stats.coverageDegraded).toBe(true);
    expect(result.stats.verificationFailed).toBeGreaterThan(0);
    expect(h.payloads('/runs')[0]).toMatchObject({ ok: false, stats: { coverageDegraded: true } });
  });
});

describe('bounded lead processing and paid fallback', () => {
  it('finishes immediately after a budget refusal and preserves remaining new leads', async () => {
    const h = harness({ leads: Array.from({ length: 50 }, (_, id) => ({ ...lead, id })), budgetDenied: true });
    const { runPipeline } = await import('../pipeline/run');
    const result = await runPipeline();
    expect(h.payloads('/model-budget/reserve')).toHaveLength(1);
    expect(h.payloads('/status')).toEqual([]);
    expect(result.stats.coverageDegraded).toBe(true);
    expect(result.ok).toBe(false);
  });

  it.each([
    { title: 'Codex 重置卡已发放', createdAt: new Date().toISOString() },
    { title: '工具发布动态', raw: 'New product settings.', createdAt: new Date(Date.now() - 3 * 3600_000).toISOString() },
  ])('uses the budgeted paid fallback after free quota failure for an eligible lead %o', async details => {
    vi.useFakeTimers();
    vi.stubEnv('DEEPSEEK_API_KEY', 'test-key');
    const resetBenefit='A reset card has been granted to all Vendor Codex members.';
    const matchingOutput=/重置/.test(details.title)?{
      modelOutput:JSON.stringify({offers:[{...candidate,title:'Vendor Codex 重置卡',type:'perk',tags:['reset'],valueText:'已发放重置卡',excerpts:{benefit:resetBenefit}}]}),
      pages:{[lead.url]:`<html><body><article>${resetBenefit} ${'Documentation. '.repeat(50)}</article></body></html>`},
    }:{};
    const h = harness({ leads: [{ ...lead, ...details }], geminiStatus: 429, ...matchingOutput });
    const { runPipeline } = await import('../pipeline/run');
    const run = runPipeline();
    await vi.runAllTimersAsync();
    await run;
    expect(h.reads.filter(url => url.includes('api.deepseek.com'))).toHaveLength(1);
    expect(h.payloads('/offers')).toHaveLength(1);
    expect(h.payloads('/model-budget/reserve').find(body => body.provider === 'deepseek').costCny).toBeGreaterThan(0);
  });

  it('keeps ordinary fresh leads free-only and does not repeat quota attempts for every lead', async () => {
    vi.useFakeTimers();
    vi.stubEnv('DEEPSEEK_API_KEY', 'test-key');
    const h = harness({ leads: Array.from({ length: 50 }, (_, id) => ({ ...lead, id, title: '工具发布动态', raw: 'New product settings.' })), geminiStatus: 429 });
    const { runPipeline } = await import('../pipeline/run');
    const run = runPipeline();
    await vi.runAllTimersAsync();
    const result = await run;
    expect(h.reads.filter(url => url.includes('googleapis'))).toHaveLength(1);
    expect(h.reads.filter(url => url.includes('api.deepseek.com'))).toHaveLength(0);
    expect(h.payloads('/status')).toEqual([]);
    expect(result.stats.coverageDegraded).toBe(true);
  });

  it('does not enable paid calls when the existing monthly cost ceiling is exhausted', async () => {
    vi.useFakeTimers();
    vi.stubEnv('DEEPSEEK_API_KEY', 'test-key');
    const h = harness({ leads: [{ ...lead, title: 'Codex 重置卡已发放' }], geminiStatus: 429, costMonthCny: 10 });
    const { runPipeline } = await import('../pipeline/run');
    const run = runPipeline();
    await vi.runAllTimersAsync();
    await run;
    expect(h.reads.some(url => url.includes('api.deepseek.com'))).toBe(false);
    expect(h.payloads('/status')).toEqual([]);
  });
});


describe('scheduled official review integration',()=>{
  it('automatically searches and re-extracts official evidence in the normal pipeline run',async()=>{
    const h=harness({officialJob:true,leads:[{...lead,origin:'reddit',url:'https://community.example/post'}]});
    const {runPipeline}=await import('../pipeline/run');const result=await runPipeline();
    expect(h.reads).toContain('https://mcp.exa.ai/mcp');expect(h.reads).toContain('https://vendor.example/confirmed');
    const writes=h.payloads('/offers');expect(writes).toHaveLength(2);
    expect(writes[0][0].evidence.tier).toBe('media');
    expect(writes[1][0]).toMatchObject({id:'vendor-max-api',officialReviewJobId:'12345678-1234-4234-8234-123456789012',usdMax:null,evidence:{url:'https://vendor.example/confirmed',tier:'site',excerpts:{benefit}}});
    expect((result.stats as any).officialReview.matched).toBe(1);
  });
  it('records search failure and coverage degradation rather than pretending no official benefit exists',async()=>{
    const h=harness({officialJob:true,officialSearchStatus:429});
    const {runPipeline}=await import('../pipeline/run');const result=await runPipeline();
    expect(h.payloads('/offers')).toHaveLength(0);
    expect(h.payloads('/official-reviews/vendor-max-api/result')[0]).toMatchObject({status:'failed'});
    expect(result.stats.coverageDegraded).toBe(true);
  });
});

it('leaves the community draft untouched when fetched official pages do not corroborate the target',async()=>{
  const h=harness({officialJob:true,modelOutput:'{"offers":[]}'});
  const {runPipeline}=await import('../pipeline/run');await runPipeline();
  expect(h.payloads('/offers')).toHaveLength(0);
  expect(h.payloads('/official-reviews/vendor-max-api/result')[0]).toMatchObject({status:'unresolved'});
});


it('does not falsely fail a completed review when only the supplementary search is limited',async()=>{
  const h=harness({officialJob:true,partialSearch:true});
  const {runPipeline}=await import('../pipeline/run');const result=await runPipeline();
  expect(result.ok).toBe(true);
  expect((result.stats as any).officialReview).toMatchObject({matched:1,failed:0,deferred:0,searches:2});
  expect(h.payloads('/official-reviews/vendor-max-api/result')[0].reason).toContain('部分搜索受限');
});

it('uses a known exact official link even when search is rate limited',async()=>{
  const h=harness({officialJob:true,officialSearchStatus:429,officialSteps:['官方出处：https://vendor.example/exact']});
  const {runPipeline}=await import('../pipeline/run');await runPipeline();
  expect(h.payloads('/offers')[0][0].evidence.url).toBe('https://vendor.example/exact');
  expect(h.payloads('/official-reviews/vendor-max-api/result')[0]).toMatchObject({status:'matched'});
});

it('tries an explicit official link before broad search results and moves on from previous candidates',async()=>{
  const urls=['one','two','three','four'].map(p=>'https://vendor.example/'+p);
  const h=harness({officialJob:true,officialUrls:urls,officialSteps:['https://vendor.example/exact']});
  const {runPipeline}=await import('../pipeline/run');await runPipeline();
  expect(h.payloads('/offers')[0][0].evidence.url).toBe('https://vendor.example/exact');
});

it('advances beyond three previously unhelpful official pages on the next attempt',async()=>{
  const urls=['one','two','three','four'].map(p=>'https://vendor.example/'+p);
  const h=harness({officialJob:true,officialUrls:urls,previousCandidates:urls.slice(0,3)});
  const {runPipeline}=await import('../pipeline/run');await runPipeline();
  expect(h.payloads('/offers')[0][0].evidence.url).toBe(urls[3]);
});

it('does not count indirect reader text as a successful routine verification',async()=>{
  vi.stubEnv('FAST_LEADS','0');
  const h=harness({verification:[{id:'vendor-free',url:lead.url,tier:'site',platformId:'vendor',sourceId:null}],pages:{[lead.url]:403},
    jinaBody:'URL Source: https://unrelated.example\nWarning: Target URL returned error 403\nMarkdown Content:\n'+benefit});
  const {runPipeline}=await import('../pipeline/run');const result=await runPipeline();
  expect(h.payloads('/verify')[0].trustedDirect).toBe(false);
  expect(result.stats.verificationFailed).toBe(1);expect(result.stats.coverageDegraded).toBe(true);
});

it('turns inaccessible manual notes into a media draft or visible manual review instead of an endless new lead',async()=>{
  const h=harness({leads:[{...lead,origin:'manual'}],pages:{[lead.url]:403},modelOutput:'{"offers":[]}'});
  const {runPipeline}=await import('../pipeline/run');await runPipeline();
  expect(h.payloads('/status')[0]).toMatchObject({status:'reviewing'});
});


it('cools down a limited search service but still reads known official sources for the remaining jobs',async()=>{
  const h=harness({officialJobIds:['vendor-max-api','vendor-another'],officialSearchStatus:429,officialSteps:['https://vendor.example/exact']});
  const {runPipeline}=await import('../pipeline/run');const result=await runPipeline();
  expect(h.reads.filter(url=>url==='https://mcp.exa.ai/mcp')).toHaveLength(1);
  expect(h.payloads('/offers')).toHaveLength(2);
  expect((result.stats as any).officialReview).toMatchObject({checked:2,matched:2,failed:0,searches:1});
});


it('automatically rescues a reviewing lead into a pending offer in the hourly workflow',async()=>{
  const h=harness({rescueJob:true});
  const {runPipeline}=await import('../pipeline/run');await runPipeline();
  expect(h.payloads('/offers')[0]?.[0]).toMatchObject({leadId:1312,leadReviewJobId:'12345678-1234-4234-8234-123456789012'});
  expect(h.payloads('/lead-reviews/1312/result')[0]).toMatchObject({outcome:'linked'});
});
it('closes an explicit non-benefit official post with its grounded explanation',async()=>{
  const h=harness({rescueJob:true,modelOutput:JSON.stringify({offers:[],leadAssessment:{outcome:'not_benefit',reason:'这是异常说明，不是独立赠额',quote:benefit}})});
  const {runPipeline}=await import('../pipeline/run');await runPipeline();
  expect(h.payloads('/offers')).toEqual([]);
  expect(h.payloads('/lead-reviews/1312/result')[0]).toMatchObject({outcome:'closed',quote:benefit,evidenceUrl:lead.url});
});
it('records a technical retry when a stuck lead has no readable primary source',async()=>{
  const h=harness({rescueJob:true,officialSearchStatus:429,pages:{[lead.url]:403}});
  const {runPipeline}=await import('../pipeline/run');const result=await runPipeline();
  expect(h.payloads('/lead-reviews/1312/result')[0]).toMatchObject({outcome:'retry'});
  // 单条复核等待重试是积压，不再把整轮采集记为覆盖不完整（2026-10-15）；仍在 backlogDeferred 和 leadReview 中可见。
  expect((result.stats as any).backlogDeferred).toBeGreaterThan(0);
  expect((result.stats as any).leadReview).toMatchObject({retry:1});
});

it('does not silently truncate six recovered benefits and mark the lead complete',async()=>{
  const h=harness({rescueJob:true,modelOutput:JSON.stringify({offers:Array.from({length:6},(_,n)=>({...candidate,key:'benefit-'+n,title:'独立权益'+n}))})});
  const {runPipeline}=await import('../pipeline/run');await runPipeline();
  expect(h.payloads('/offers')).toHaveLength(6);
  expect(h.payloads('/lead-reviews/1312/result')[0].offerIds).toHaveLength(6);
});
it('advances to a fourth official page instead of rereading all raw links before search',async()=>{
  const urls=['one','two','three','four'].map(n=>'https://vendor.example/'+n);
  const h=harness({rescueJob:true,leads:[{...lead,url:urls[0],raw:urls[1]+' '+urls[2]}],previousCandidates:urls.slice(0,3),officialUrls:[urls[3]],modelOutput:'{"offers":[]}'});
  const {runPipeline}=await import('../pipeline/run');await runPipeline();
  expect(h.reads).toContain(urls[3]);
});

it('keeps official-origin rescue search scoped to its issuer instead of similarly named products',async()=>{
  const h=harness({rescueJob:true,modelOutput:'{"offers":[]}',rescuePlatforms:[{id:'vendor',name:'Vendor',site:'https://vendor.example',xHandles:[],staffHandles:[]},{id:'other',name:'Vendor compatible API',site:'https://other.example',xHandles:[],staffHandles:[]}]});
  const {runPipeline}=await import('../pipeline/run');await runPipeline();
  const queries=h.writes.filter(r=>r.url==='https://mcp.exa.ai/mcp').map(r=>r.body.params.arguments.query);
  expect(queries.length).toBeGreaterThan(0);expect(queries.join(' ')).not.toContain('site:other.example');
});

it('does not turn a reseller rescue into an unrelated student offer despite an official search hit',async()=>{
 const student={...candidate,platformId:'mistral',key:'student',title:'Mistral Pro 学生价',type:'topup',requirements:['student'],valueText:'每月5.99美元，最多12个月'};
 const h=harness({rescueJob:true,leads:[{...lead,url:'https://community.example/post',title:'PQH AI 号池充值福利',raw:'API Code Studio https://pqh.example'}],rescuePlatforms:[{id:'mistral',name:'Mistral AI',site:'https://mistral.ai',xHandles:[],staffHandles:[]}],officialUrls:['https://mistral.ai/pricing'],pages:{'https://mistral.ai/pricing':page},modelOutput:JSON.stringify({offers:[student]})});
 const {runPipeline}=await import('../pipeline/run');await runPipeline();
 expect(h.payloads('/offers')).toHaveLength(0);
 expect(h.payloads('/lead-reviews/1312/result')[0].outcome).not.toBe('linked');
});
it('refuses a hallucinated existing-offer link during rescue',async()=>{
 const known={id:'student-main',platformId:'vendor',title:'Vendor 学生折扣',valueText:'认证学生专属',evidenceUrl:lead.url,reviewState:'approved'};
 const h=harness({rescueJob:true,leads:[{...lead,url:'https://community.example/post',title:'Vendor 模型发布',raw:'无赠额的模型发布'}],known:[known],modelOutput:JSON.stringify({offers:[],leadAssessment:{outcome:'existing',reason:'模型错误关联',offerId:known.id,quote:benefit}})});
 const {runPipeline}=await import('../pipeline/run');await runPipeline();
 expect(h.payloads('/offers')).toHaveLength(0);
 expect(h.payloads('/lead-reviews/1312/result')[0].outcome).not.toBe('linked');
});
it('blocks replacing a reset lead with a monthly plan even after paid fallback succeeds',async()=>{
 const h=harness({leads:[{...lead,title:'Vendor Codex重置卡已发放'}]});
 const {runPipeline}=await import('../pipeline/run');await runPipeline();
 expect(h.payloads('/offers')).toHaveLength(0);
});


// phase1 regression: exercise the real intake caller, not a copied condition.
describe('phase1 duplicate intake', () => {
  it.each(['rejected', 'approved'])('resolves a duplicate of an %s offer without requeueing the lead', async state => {
    const h = harness({ leads: [lead], ingestResults: [
      { id: 'fresh-alias', duplicateId: 'vendor-canonical', skipped: `duplicate ${state}` },
    ] });
    const { runPipeline } = await import('../pipeline/run');
    await runPipeline();
    expect(h.payloads('/status')).toEqual([{ status: 'linked', offerId: 'vendor-canonical' }]);
  });

  it('does not turn an unidentified skip into a resolved lead', async () => {
    const h = harness({ leads: [lead], ingestResults: [{ id: 'fresh-alias', skipped: 'needs identity verification' }] });
    const { runPipeline } = await import('../pipeline/run');
    await runPipeline();
    expect(h.payloads('/status')[0].status).toBe('reviewing');
  });

  it('retains a partially failed lead even when another candidate is a resolved duplicate', async () => {
    const other = { ...candidate, key: 'other-api', title: '另一项 API 赠送', valueText: '另一个独立积分池' };
    const h = harness({ leads: [lead], modelOutput: JSON.stringify({ offers: [candidate, other] }), ingestResults: [
      { id: 'alias', duplicateId: 'vendor-canonical', skipped: 'duplicate rejected' },
      { id: 'other', error: 'write failed' },
    ] });
    const { runPipeline } = await import('../pipeline/run');
    await runPipeline();
    expect(h.payloads('/status')[0].status).toBe('reviewing');
  });
});

it('A18 official extraction never treats an unavailable identity index as empty history',async()=>{
 vi.stubEnv('FAST_LEADS','0');
 const h=harness({indexFailure:true,sources:[{...rssSource,kind:'web_list',url:'https://vendor.example/rewards'}]});
 const {runPipeline}=await import('../pipeline/run');const result=await runPipeline();
 expect(h.payloads('/offers')).toHaveLength(0);
 expect(result.stats.coverageDegraded).toBe(true);
});
it('R07 scheduled official pages and feeds transport the actual fetch descriptor with the body',async()=>{
 vi.stubEnv('FAST_LEADS','0');const url='https://vendor.example/article';const h=harness({sources:[rssSource],pages:{[rssSource.url]:rss(url)}});const {runPipeline}=await import('../pipeline/run');await runPipeline();const posted=h.payloads('/offers')[0][0];expect(posted.sourceFetch).toMatchObject({originalUrl:url,finalUrl:url,fetchedUrl:url,sourceVerified:true,truncated:false});expect(posted.sourceFetch.contentHash).toBe(sha256(posted.sourceText));
});
it('R07 scheduled Jina feed fallback preserves its reader provenance and media tier',async()=>{
 vi.stubEnv('FAST_LEADS','0');const url='https://vendor.example/article';const h=harness({sources:[rssSource],pages:{[rssSource.url]:rss(url),[url]:403},jinaBody:'URL Source: https://unrelated.example\nWarning: Target URL returned error 403\nMarkdown Content:\n'+benefit});const {runPipeline}=await import('../pipeline/run');await runPipeline();const posted=h.payloads('/offers')[0][0];expect(posted.evidence.tier).toBe('media');expect(posted.sourceFetch).toMatchObject({originalUrl:url,method:'jina',sourceVerified:false});expect(posted.sourceFetch.fetchedUrl).toContain('r.jina.ai');
});
it('uses a D1 platform profile during extraction when screening is off', async () => {
  vi.stubEnv('FAST_LEADS', '0');
  vi.stubEnv('SCREENING_MODE', 'off');
  const h = harness({
    sources: [rssSource],
    pages: { [rssSource.url]: rss('https://vendor.example/article') },
    profiles: [{ platformId: 'vendor', channels: [], patterns: [], pitfalls: [{ text: '画像专属要点XYZ', since: null }], cadence: [], fieldEditRates: {}, quicklyExhausted: false, revision: 1 }],
  });
  const { runPipeline } = await import('../pipeline/run');
  await runPipeline();
  expect(h.writes.some(write => JSON.stringify(write.body).includes('画像专属要点XYZ'))).toBe(true);
});
it('R07 official enrichment transports reader attestation rather than deriving it from source text',async()=>{
 const h=harness({officialJob:true});const {runPipeline}=await import('../pipeline/run');await runPipeline();const posted=h.payloads('/offers')[0][0];expect(posted.sourceFetch.originalUrl).toBe(posted.evidence.url);expect(posted.sourceFetch.sourceVerified).toBe(true);expect(posted.sourceFetch.contentHash).toBe(sha256(posted.sourceText));
});

describe('Discord pipeline checkpoint ordering',()=>{
  it.each([false,true])('checkpoints only after successful lead ingestion (write fails=%s)',async(fails)=>{
    const channel='1558646770689384560',guild='1558646769938735136';
    for(const[k,v]of Object.entries({DISCORD_BOT_TOKEN:'synthetic-test-token',DISCORD_CHANNEL_ID:channel,DISCORD_GUILD_ID:guild,LEAD_LIMIT:'0',LEAD_REVIEW_LIMIT:'0',OFFICIAL_REVIEW_LIMIT:'0'}))vi.stubEnv(k,v);
    const source={id:'discord',kind:'discord',tier:'lead',platformId:null,platform:null,autoPublish:false,lastHash:null,url:`https://discord.com/channels/${guild}/${channel}`,config:{publishers:[{platformId:'midjourney',name:'Midjourney',guildId:'662267976984297473',channelId:'952771221915840552'}]}};
    const h=harness({sources:[source],leads:[lead]});const base=fetch;
    vi.stubGlobal('fetch',vi.fn(async(input:any,init?:RequestInit)=>{
      const u=String(input);
      if(u.startsWith('https://discord.com/api/v10/'))return json(u.includes('/messages?')?[{id:'1558661628222906430',channel_id:channel,type:0,flags:2,content:'Free credits for all users',embeds:[],attachments:[],message_reference:{guild_id:'662267976984297473',channel_id:'952771221915840552',message_id:'1000000000000000001'}}]:{id:channel,guild_id:guild,type:0});
      if(fails&&u.endsWith('/leads')&&init?.method==='POST')return new Response('failure',{status:500});
      return base(input,init);
    }));
    const {runPipeline}=await import('../pipeline/run');const result=await runPipeline();
    if(!fails)expect(result.stats.errors).toEqual([]);
    expect(h.payloads('/snapshots').some(x=>x.hash==='discord:1558661628222906430')).toBe(!fails);
    expect(result.stats.failed).toBe(fails?1:0);
    expect(h.payloads('/offers')).toEqual([]);
    expect(h.writes.filter(x=>x.url.includes('googleapis'))).toHaveLength(0);
  });
});

// 2026-10-15：只追最新福利，已收录的内容不再反复交给模型。
describe('already-listed content is not re-processed', () => {
  it('links a lead that is the evidence of an approved offer without calling a model', async () => {
    const h = harness({ leads: [lead], known: [{ id: 'vendor-listed', platformId: 'vendor', title: 'Vendor 免费额度', valueText: '100 美元', reviewState: 'approved', evidenceUrl: lead.url }] });
    const { runPipeline } = await import('../pipeline/run');
    const result = await runPipeline();
    expect(h.reads.some(url => url.includes('googleapis') || url.includes('deepseek') || url.includes('openrouter'))).toBe(false);
    expect(h.payloads('/status')[0]).toMatchObject({ status: 'linked', offerId: 'vendor-listed' });
    expect((result.stats as any).leadsLinkedByUrl).toBe(1);
  });
  it('does not re-extract an official page when sentences were only removed', async () => {
    vi.stubEnv('FAST_LEADS', '0');
    const filler = '<p>Company history, customer stories and product overview without any offer.</p>'.repeat(30);
    const page = (offers: string[]) => `<html><body><article><h1>Pricing</h1>${offers.map(o => `<p>${o}</p>`).join(filler)}${filler}</article></body></html>`;
    const offers = ['Free plan includes 100 credits per month.', 'Students get a free trial for 30 days.'];
    const source = { id: 'pricing', kind: 'web_list', tier: 'site', platformId: 'vendor', platform: { id: 'vendor', name: 'Vendor', status: 'approved' }, url: 'https://vendor.example/pricing', config: {}, lastHash: null, lastText: null };
    let h = harness({ sources: [source], pages: { [source.url]: page(offers) } });
    let { runPipeline } = await import('../pipeline/run');
    await runPipeline();
    const baseline = h.payloads('/snapshots').find(snapshot => snapshot.hash);
    expect(baseline?.text).toContain(offers[1]);
    vi.resetModules();
    h = harness({ sources: [{ ...source, lastHash: baseline.hash, lastText: baseline.text }], pages: { [source.url]: page(offers.slice(0, 1)) } });
    ({ runPipeline } = await import('../pipeline/run'));
    const result = await runPipeline();
    expect(h.reads.some(url => url.includes('googleapis'))).toBe(false);
    expect((result.stats as any).unchangedPages).toBe(1);
    expect(h.payloads('/snapshots').find(snapshot => snapshot.hash)?.hash).not.toBe(baseline.hash);
  });
});

// 2026-10-16：WorkBuddy 补偿只发在公众号，#7681 反复搜索官网多轮仍搁置。
it('hands a WeChat article lead to the administrator for fast-track instead of retrying searches', async () => {
  const h = harness({ rescueJob: true, officialSearchStatus: 429, modelOutput: JSON.stringify({ offers: [], leadAssessment: { outcome: 'unresolved', reason: '官网未提及' } }),
    leads: [{ ...lead, url: 'https://mp.weixin.qq.com/s/dGd6Nz03MF4', title: 'Vendor 赠送 500 积分', raw: 'Vendor 官方公众号公告' }] });
  const { runPipeline } = await import('../pipeline/run');
  await runPipeline();
  const result = h.payloads('/lead-reviews/1312/result')[0];
  expect(result).toMatchObject({ outcome: 'manual', manualNow: true });
  expect(result.reason).toContain('快速上架');
});
