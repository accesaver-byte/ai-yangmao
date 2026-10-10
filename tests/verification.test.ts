import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import worker from '../src/worker/index';
import { buildNotice } from '../src/worker/admin';
import { offerIn } from '../src/shared/ingest';
import { liveStatus } from '../src/shared/lifecycle';

let sqlite: DatabaseSync;
let env: Parameters<typeof worker.fetch>[1];
let beforeStatement: ((sql: string) => void) | undefined;

function d1(memory: DatabaseSync) {
  return {
    async batch(statements: { all(): Promise<unknown> }[]) {
      memory.exec('BEGIN');
      try {
        const results: unknown[] = [];
        for (const statement of statements) results.push(await statement.all());
        memory.exec('COMMIT');
        return results;
      } catch (error) {
        memory.exec('ROLLBACK');
        throw error;
      }
    },
    prepare(sql: string) {
      let args: unknown[] = [];
      return {
        bind(...values: unknown[]) {
          if (values.length > 100) throw new Error('D1_ERROR: too many SQL variables');
          args = values; return this;
        },
        async raw() { beforeStatement?.(sql); const statement = memory.prepare(sql); statement.setReturnArrays(true); return statement.all(...args as []); },
        async all() { beforeStatement?.(sql); return { results: memory.prepare(sql).all(...args as []) }; },
        async first() { return memory.prepare(sql).get(...args as []) ?? null; },
        async run() { beforeStatement?.(sql); return { meta: memory.prepare(sql).run(...args as []), success: true }; },
      };
    },
  } as unknown as D1Database;
}

async function call(path: string, body?: unknown, kind: 'ingest' | 'admin' = 'ingest') {
  const response = await worker.fetch(new Request(`https://local.test/api/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer audit-${kind}-token-long-enough`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), env, {} as ExecutionContext);
  return { status: response.status, body: (response.headers.get('Content-Type')?.includes('application/json') ? await response.json() : { error: await response.text() }) as Record<string, unknown> };
}

beforeEach(() => {
  beforeStatement = undefined;
  sqlite = new DatabaseSync(':memory:');
  for (const name of readdirSync(new URL('../migrations/', import.meta.url)).filter(name => /^\d+_.+\.sql$/.test(name)).sort()) {
    sqlite.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
  }
  env = { DB: d1(sqlite), INGEST_TOKEN: 'audit-ingest-token-long-enough', ADMIN_TOKEN: 'audit-admin-token-long-enough' } as typeof env;
  sqlite.prepare("INSERT INTO platforms (id,name,type,status) VALUES ('vendor','Vendor','lab','approved')").run();
  sqlite.prepare("INSERT INTO sources (id,platform_id,kind,url,tier) VALUES ('source','vendor','web_list','https://vendor.example/free','docs')").run();
});
afterEach(() => sqlite.close());

describe('V1 persisted valuation integration', () => {
  const unpriced = { version: 'v1', status: 'beta_unpriced', method: 'none', period: 'first30',
    usdEstimate: null, usdMax: null, fullValue: null, formula: null, inputs: {},
    sources: [{ url: 'https://vendor.example/pricing', checkedAt: '2026-10-09', excerpt: 'Public beta pricing is not announced.', priceBasis: '发放方价格页' }],
    assumptions: [], reviewedAt: '2026-10-09' };
  const priced = { ...unpriced, status: 'priced', method: 'face_value', period: 'one_time', usdEstimate: 5, fullValue: 5,
    formula: '注册赠送 $5', inputs: { amount: 5, currency: 'USD' }, sources: [{ ...unpriced.sources[0], excerpt: 'Free $5 credit.' }] };

  it('stores a conclusion without approving or renewing evidence, and leaves another row unchanged', async () => {
    await call('ingest/offers', [offer, { ...offer, id: 'vendor-unrelated', title: '另一项独立赠送', valueText: '777 tokens', evidence: { ...evidence, url: 'https://vendor.example/other', excerpts: { benefit: 'Free 777 tokens.', eligibility: 'All users.', validity: 'No end date.' } } }]);
    const before = sqlite.prepare('SELECT * FROM offers WHERE id=?').get(offer.id) as any;
    const unrelated = sqlite.prepare("SELECT * FROM offers WHERE id='vendor-unrelated'").get();
    const edit = await call(`admin/offers/${offer.id}/edit`, { fields: { usdEstimate: null, usdMax: null, valuation: unpriced }, reason: 'V1 公测未定价' }, 'admin');
    expect(edit.status).toBe(200);
    const after = sqlite.prepare('SELECT * FROM offers WHERE id=?').get(offer.id) as any;
    expect(after.review_state).toBe('pending');
    expect(after.last_verified_at).toBe(before.last_verified_at);
    expect(after.evidence).toBe(before.evidence);
    expect(JSON.parse(after.valuation)).toEqual(unpriced);
    expect(sqlite.prepare("SELECT * FROM offers WHERE id='vendor-unrelated'").get()).toEqual(unrelated);
    const detail = (await call(`admin/offers/${offer.id}`, undefined, 'admin')).body.offer as any;
    expect(detail.valuation).toEqual(unpriced);
    expect(detail.checks.some((issue: any) => issue.field === 'usdEstimate')).toBe(false);
    expect(sqlite.prepare("SELECT author,diff FROM offer_revisions WHERE offer_id=?").get(offer.id)).toMatchObject({ author: 'admin' });
    expect(JSON.parse((sqlite.prepare('SELECT edited_fields FROM reviews WHERE offer_id=?').get(offer.id) as any).edited_fields)).toContain('valuation');
  });

  it('filters internal public keys and invalid amounts consistently across all public offer routes', async () => {
    await call('ingest/offers', [offer]);
    await call(`admin/offers/${offer.id}/approve`, {}, 'admin');
    const raw = { ...priced, reason: 'internal reason', sources: [{ ...priced.sources[0], oldUsd: 100 }],
      inputs: { amount: 5, currency: 'USD', reviewMemo: 'internal input', limits: { days: 30, previousAmount: 123 } } };
    sqlite.prepare('UPDATE offers SET valuation=?,usd_estimate=5,review_memo=?,review_suggestion=? WHERE id=?')
      .run(JSON.stringify(raw), 'private audit', JSON.stringify({ reason: 'private suggestion' }), offer.id);
    for (const path of ['offers?view=all', `offers/${offer.id}`, 'platforms/vendor']) {
      const publicBody = (await call(path)).body as any;
      const published = publicBody.offer ?? publicBody.offers[0];
      expect(published.valuation).toMatchObject({ status: 'priced', usdEstimate: 5, inputs: { amount: 5, currency: 'USD', limits: { days: 30 } } });
      expect(published).not.toHaveProperty('reviewMemo');
      expect(published).not.toHaveProperty('reviewSuggestion');
      expect(JSON.stringify(publicBody)).not.toMatch(/internal reason|internal input|private audit|oldUsd|previousAmount/);
    }
    sqlite.prepare('UPDATE offers SET usd_estimate=8 WHERE id=?').run(offer.id);
    expect(((await call(`offers/${offer.id}`)).body.offer as any).valuation).toBeNull();
  });

  it('preserves reviewed USD and metadata through a real official terms update and an unrelated edit', async () => {
    await call('ingest/offers', [offer]);
    await call(`admin/offers/${offer.id}/approve`, {}, 'admin');
    expect((await call(`admin/offers/${offer.id}/edit`, { fields: { usdEstimate: 5, usdMax: null, valuation: priced } }, 'admin')).status).toBe(200);
    const nextEvidence = { ...evidence, excerpts: { ...evidence.excerpts, benefit: 'Free 200 tokens.' } };
    const next = await call('ingest/offers', [{ ...offer, usdEstimate: 99, usdMax: 100,
      valuation: { ...priced, usdEstimate: 99, usdMax: 100 }, valueText: '200 tokens', evidence: nextEvidence,
      sourceText: 'Free 200 tokens. All users. No published end date.' }]);
    expect((next.body.results as any[])[0].reviewState).toBe('pending_update');
    const proposed = JSON.parse((sqlite.prepare('SELECT candidate FROM offer_proposals WHERE offer_id=?').get(offer.id) as any).candidate);
    expect(proposed).toMatchObject({ usdEstimate: 5, usdMax: null, valuation: priced });
    expect((await call(`admin/offers/${offer.id}/edit`, { fields: { title: '保留已核实估值的标题' } }, 'admin')).status).toBe(200);
    expect(JSON.parse((sqlite.prepare('SELECT candidate FROM offer_proposals WHERE offer_id=?').get(offer.id) as any).candidate).valuation).toEqual(priced);
    const stored = sqlite.prepare('SELECT usd_estimate,usd_max,valuation FROM offers WHERE id=?').get(offer.id) as any;
    expect(stored).toMatchObject({ usd_estimate: 5, usd_max: null });
    expect(JSON.parse(stored.valuation)).toEqual(priced);
  });

  it('rejects inconsistent administrator amounts while ignoring extractor-supplied valuation on a new draft', async () => {
    await call('ingest/offers', [{ ...offer, valuation: { ...unpriced, reason: 'model generated audit' } }]);
    expect((sqlite.prepare('SELECT valuation FROM offers WHERE id=?').get(offer.id) as any).valuation).toBeNull();
    expect((await call(`admin/offers/${offer.id}/edit`, { fields: { valuation: priced, usdEstimate: 9 } }, 'admin')).status).toBe(400);
    expect((sqlite.prepare('SELECT valuation FROM offers WHERE id=?').get(offer.id) as any).valuation).toBeNull();
  });
});

describe('workflow recovery and race regressions',()=>{
  it('refuses an official review changing a reset into unrelated monthly plan benefits',async()=>{
    const reset={...offer,type:'perk',title:'赠送重置卡',tags:['reset'],evidence:{...evidence,tier:'media'}};
    await call('ingest/offers',[reset]);
    const lease=await call('ingest/official-reviews/vendor-free/claim',{});
    const result=await call('ingest/offers',[{...offer,type:'standing',endKind:'standing',valueText:'每月100积分',officialReviewJobId:lease.body.jobId}]);
    expect((result.body.results as any[])[0].error).toContain('另一类活动');
    expect((await call('admin/offers/vendor-free',undefined,'admin')).body.offer).toMatchObject({evidenceTier:'media',title:reset.title});
  });
  it('prioritizes an expiring ordinary draft while reserving capacity for the oldest official-review backlog',async()=>{
    for(let n=0;n<8;n++)await call('ingest/offers',[{...offer,id:`vendor-${n}`,title:`Codex 重置卡 ${n}`,valueText:`${n} tokens`,evidence:{...evidence,tier:'media',url:`https://community.example/${n}`}}]);
    sqlite.prepare("UPDATE offers SET discovered_at='2020-01-01T00:00:00Z',title='长期积压待补证' WHERE id='vendor-0'").run();
    await call('ingest/offers',[{...offer,id:'vendor-urgent',title:'普通名称赠额',valueText:'99 tokens',claimEnd:new Date().toISOString().slice(0,10),endKind:'date',evidence:{...evidence,tier:'media',url:'https://community.example/urgent'}}]);
    const jobs=(await call('ingest/official-reviews/queue?limit=5')).body.jobs as any[];
    expect(jobs[0].id).toBe('vendor-urgent');expect(jobs.map(x=>x.id)).toContain('vendor-0');
  });
  it('rejects a user-created issue in an otherwise official registered repository',async()=>{
    sqlite.prepare("UPDATE sources SET url='https://github.com/vendor/project',tier='docs' WHERE id='source'").run();
    await call('ingest/offers',[{...offer,evidence:{...evidence,url:'https://github.com/vendor/project/issues/99'}}]);
    expect((await call('admin/offers/vendor-free/approve',{},'admin')).status).toBe(400);
  });
  it('requires explicit direct provenance and preserves the last real verification',async()=>{
    await call('ingest/offers',[offer]);await call('admin/offers/vendor-free/approve',{},'admin');
    sqlite.prepare("UPDATE offers SET last_verified_at='2026-01-01T00:00:00Z' WHERE id='vendor-free'").run();
    const check={offerId:offer.id,url:evidence.url,text:Object.values(evidence.excerpts).join(' ')};
    for(const body of [check,{...check,trustedDirect:false}]){
      expect((await call('ingest/verify',body)).body).toMatchObject({verified:false,sourceUnverified:true});
    }
    expect(sqlite.prepare('SELECT last_verified_at FROM offers').get()).toEqual({last_verified_at:'2026-01-01T00:00:00Z'});
  });
  it('does not restore old evidence over an administrator edit made during verification',async()=>{
    await call('ingest/offers',[offer]);await call('admin/offers/vendor-free/approve',{},'admin');
    const corrected={...evidence,url:'https://vendor.example/corrected'};
    beforeStatement=sql=>{if(sql.startsWith('update "offers"')){beforeStatement=undefined;sqlite.prepare("UPDATE offers SET evidence=?,updated_at='2030-01-01T00:00:00Z' WHERE id='vendor-free'").run(JSON.stringify(corrected));}};
    const result=await call('ingest/verify',{trustedDirect:true,offerId:offer.id,url:evidence.url,text:Object.values(evidence.excerpts).join(' ')});
    expect(result.body).toMatchObject({verified:false,stale:true});
    expect(JSON.parse((sqlite.prepare('SELECT evidence FROM offers').get() as any).evidence).url).toBe(corrected.url);
  });
  it('keeps a reviewer proposal edit made while a new extraction is being saved',async()=>{
    await call('ingest/offers',[offer]);await call('admin/offers/vendor-free/approve',{},'admin');
    await call('ingest/offers',[changedOffer()]);
    beforeStatement=sql=>{if(sql.startsWith('update "offer_proposals"')){beforeStatement=undefined;sqlite.prepare("UPDATE offer_proposals SET candidate=?,updated_at='2030-01-01T00:00:00Z'").run(JSON.stringify({...offer,valueText:'管理员确认的额度'}));}};
    const result=await call('ingest/offers',[changedOffer('300 tokens')]);
    expect((result.body.results as any[])[0].error).toContain('已更新');
    expect(JSON.parse((sqlite.prepare('SELECT candidate FROM offer_proposals').get() as any).candidate).valueText).toBe('管理员确认的额度');
  });
  it('does not renew unchanged media proposals and defeat official review backoff',async()=>{
    await call('ingest/offers',[offer]);await call('admin/offers/vendor-free/approve',{},'admin');
    const next={...offer,valueText:'200 tokens',evidence:{...evidence,tier:'media'}};
    legacyProposal(next);
    sqlite.prepare("UPDATE offer_proposals SET updated_at='2026-01-01T00:00:00Z'").run();
    await call('ingest/offers',[next]);
    expect(sqlite.prepare('SELECT updated_at FROM offer_proposals').get()).toEqual({updated_at:'2026-01-01T00:00:00Z'});
  });
  it('recovers a lost completion receipt after the official draft was already saved',async()=>{
    await call('ingest/offers',[{...offer,evidence:{...evidence,tier:'media'}}]);
    const lease=await call('ingest/official-reviews/vendor-free/claim',{});
    await call('ingest/offers',[{...offer,officialReviewJobId:lease.body.jobId}]);
    sqlite.prepare("UPDATE offers SET official_review=json_set(official_review,'$.checkedAt','2026-01-01T00:00:00Z')").run();
    const queue=await call('ingest/official-reviews/queue');
    expect(queue.body.jobs).toMatchObject([{id:offer.id,recovery:true}]);
    expect((await call('ingest/official-reviews/vendor-free/claim',{})).body).toMatchObject({claimed:false,recovered:true});
    const detail=(await call('admin/offers/vendor-free',undefined,'admin')).body.offer as any;
    expect(detail).toMatchObject({reviewState:'pending',evidenceTier:'docs',officialReview:{status:'unresolved'}});
    expect((await call('ingest/official-reviews/queue')).body.jobs).toEqual([]);
  });
  it('requeues new input even if it changed before the old search finished',async()=>{
    await call('ingest/offers',[{...offer,evidence:{...evidence,tier:'media'}}]);
    const lease=await call('ingest/official-reviews/vendor-free/claim',{});
    sqlite.prepare("UPDATE offers SET updated_at='2026-01-01T00:00:00Z',title='已修改的搜索目标'").run();
    await call('ingest/official-reviews/vendor-free/result',{jobId:lease.body.jobId,status:'unresolved',reason:'旧目标无结果',queries:[],candidates:[],changedFields:[]});
    expect((await call('ingest/official-reviews/queue')).body.jobs).toMatchObject([{id:offer.id}]);
  });
  it('continues retrying technical outages after five attempts instead of silently exhausting them',async()=>{
    await call('ingest/offers',[{...offer,evidence:{...evidence,tier:'media'}}]);
    const lease=await call('ingest/official-reviews/vendor-free/claim',{});
    sqlite.prepare("UPDATE offers SET official_review=json_set(official_review,'$.attempts',6)").run();
    const result=await call('ingest/official-reviews/vendor-free/result',{jobId:lease.body.jobId,status:'failed',reason:'搜索限流',queries:[],candidates:[],changedFields:[]});
    expect(result.body.nextAttemptAt).toBeTruthy();
    expect((await call('ingest/official-reviews/vendor-free/result',{jobId:lease.body.jobId,status:'failed',reason:'重复回执',queries:[],candidates:[],changedFields:[]})).body).toEqual({ok:true,status:'failed',nextAttemptAt:result.body.nextAttemptAt});
  });
  it('counts full unresolved attempts separately from outages and retries expiring offers hourly',async()=>{
    await call('ingest/offers',[{...offer,claimEnd:new Date(Date.now()+86400_000).toISOString().slice(0,10),endKind:'date',evidence:{...evidence,tier:'media'}}]);
    const lease=await call('ingest/official-reviews/vendor-free/claim',{});
    sqlite.prepare("UPDATE offers SET official_review=json_set(official_review,'$.attempts',6,'$.unresolvedAttempts',0)").run();
    const result=await call('ingest/official-reviews/vendor-free/result',{jobId:lease.body.jobId,status:'unresolved',reason:'服务恢复后的第一次完整搜索',queries:[],candidates:[],changedFields:[]});
    expect(result.body.nextAttemptAt).toBeTruthy();
    expect(Date.parse(String(result.body.nextAttemptAt))-Date.now()).toBeLessThanOrEqual(3600_000);
    const record=JSON.parse((sqlite.prepare('SELECT official_review FROM offers').get() as any).official_review);
    expect(record.unresolvedAttempts).toBe(1);
    record.nextAttemptAt='2026-01-01T00:00:00Z';record.unresolvedAttempts=4;
    sqlite.prepare('UPDATE offers SET official_review=?').run(JSON.stringify(record));
    const last=await call('ingest/official-reviews/vendor-free/claim',{});
    const done=await call('ingest/official-reviews/vendor-free/result',{jobId:last.body.jobId,status:'unresolved',reason:'第五次完整搜索',queries:[],candidates:[],changedFields:[]});
    expect(done.body.nextAttemptAt).toBeNull();
  });
  it('blocks enrichment and publication of a second identical official activity',async()=>{
    await call('ingest/offers',[offer]);
    const other={...offer,id:'vendor-other',title:'另一篇社区说法',valueText:'传闻赠额',evidence:{...evidence,url:'https://community.example/2',tier:'media'}};
    await call('ingest/offers',[other]);
    const lease=await call('ingest/official-reviews/vendor-other/claim',{});
    const enriched=await call('ingest/offers',[{...offer,id:other.id,officialReviewJobId:lease.body.jobId}]);
    expect((enriched.body.results as any[])[0].error).toContain('核对合并');
    await call('admin/offers/vendor-free/approve',{},'admin');
    sqlite.prepare("UPDATE offers SET title=?,value_text=?,evidence=? WHERE id='vendor-other'").run(offer.title,offer.valueText,JSON.stringify(evidence));
    const approved=await call('admin/offers/vendor-other/approve',{},'admin');
    expect(approved.status).toBe(400);expect(String(approved.body.error)).toContain('重复上架');
  });
  it('preserves same-day reset candidates with a review note until event identity is established',async()=>{
    const reset={...offer,type:'perk',tags:['reset'],title:'Codex 重置卡',valueText:'赠送 1 张重置卡',claimStart:'2026-10-08',claimEnd:'2026-10-08',endKind:'date',publishedAt:'2026-10-08T12:00:00Z'};
    await call('ingest/offers',[reset]);
    const r=await call('ingest/offers',[{...reset,publishedAt:'2026-10-08T18:00:00Z',evidence:{...evidence,url:'https://vendor.example/second-reset'}}]);
    const second=(r.body.results as any[])[0];
    expect(second.id).not.toBe(reset.id);expect(second.reviewState).toBe('pending');
    const record=(await call('admin/offers/'+second.id,undefined,'admin')).body.offer as any;
    expect(record.reviewMemo).toContain('同日另有重置');
    expect((sqlite.prepare('SELECT count(*) n FROM offers').get() as any).n).toBe(2);
  });
});

const evidence = {
  url: 'https://vendor.example/free', tier: 'docs', capturedAt: '2026-09-30T00:00:00Z',
  excerpts: { benefit: 'Free 100 tokens', eligibility: 'All users', claim: 'Sign up', validity: 'No published end date' },
};
const offer = {
  id: 'vendor-free', platformId: 'vendor', sourceId: 'source', title: 'Vendor free tokens', type: 'new',
  modalities: ['text'], claimMethod: 'signup', requirements: ['none'], audience: 'all', valueText: '100 tokens',
  claimStart: null, claimEnd: null, endKind: 'unknown', sourceTz: 'UTC', evidence,
};

function changedOffer(valueText='200 tokens') {
  const benefit='Free '+valueText;
  return {...offer,valueText,sourceText:benefit+'. All users. No published end date.',evidence:{...evidence,excerpts:{...evidence.excerpts,benefit}}};
}
function legacyProposal(candidate: object) {
  sqlite.prepare("INSERT INTO offer_proposals(offer_id,candidate,diff) VALUES('vendor-free',?,?)").run(JSON.stringify(candidate),JSON.stringify([{field:'valueText',from:'100 tokens',to:'200 tokens'}]));
}

describe('official evidence verification', () => {
  it('blocks a new-ID FAQ daily-credit duplicate and preserves the approved amount',async()=>{
    await call('ingest/offers',[{...offer,id:'vendor-daily',type:'standing',endKind:'standing',title:'Vendor 免费档每日积分／签到奖励',valueText:'每日60积分'}]);
    await call('admin/offers/vendor-daily/approve',{},'admin');
    const r=await call('ingest/offers',[{...offer,id:'vendor-faq-daily',type:'standing',endKind:'standing',title:'Vendor 免费档每日积分',valueText:'每日积分，数量以账号为准',evidence:{...evidence,url:'https://vendor.example/faq'}}]);
    expect((r.body.results as any[])[0]).toMatchObject({id:'vendor-daily',unchanged:true});
    expect(sqlite.prepare('SELECT id,value_text FROM offers').all()).toEqual([{id:'vendor-daily',value_text:'每日60积分'}]);
  });
  it('blocks the exact same official benefit misattributed to another platform',async()=>{
    await call('ingest/offers',[offer]);await call('admin/offers/vendor-free/approve',{},'admin');
    sqlite.prepare("INSERT INTO platforms(id,name,type,status) VALUES('wrong','Wrong','tool','approved')").run();
    const r=await call('ingest/offers',[{...offer,id:'wrong-duplicate',platformId:'wrong',sourceId:undefined,evidence:{...evidence,tier:'media'}}]);
    expect((r.body.results as any[])[0].skipped).toContain('vendor-free');
    expect(sqlite.prepare('SELECT count(*) n FROM offers').get()).toEqual({n:1});
  });
  it('does not split an approved limited offer when a later repost changes its start date and source URL',async()=>{
    await call('ingest/offers',[{...offer,claimStart:'2026-10-08'}]);await call('admin/offers/vendor-free/approve',{},'admin');
    const result=await call('ingest/offers',[{...offer,claimStart:'2026-10-09',evidence:{...evidence,tier:'media',url:'https://community.example/repost'}}]);
    expect((result.body.results as any[])[0].unchanged).toBe(true);
    expect(sqlite.prepare('SELECT count(*) n FROM offers').get()).toEqual({n:1});
  });
  it('remembers newly approved official terms after an earlier manual evidence correction',async()=>{
    await call('ingest/offers',[offer]);await call('admin/offers/vendor-free/approve',{},'admin');
    await call('admin/offers/vendor-free/edit',{fields:{evidence:{...evidence,capturedAt:'2026-10-01'}}},'admin');
    await call('ingest/offers',[changedOffer()]);
    expect((await call('admin/offers/vendor-free/approve',{},'admin')).status).toBe(200);
    await call('ingest/offers',[{...changedOffer(),type:'perk',valueText:'200 tokens daily'}]);
    expect(sqlite.prepare('SELECT count(*) n FROM offer_proposals').get()).toEqual({n:0});
    expect(JSON.parse((sqlite.prepare('SELECT evidence FROM offers').get() as any).evidence).excerpts.benefit).toBe('Free 200 tokens');
  });
  it('keeps approved business fields stable when the source still contains approved terms despite model drift', async () => {
    await call('ingest/offers', [{...offer,usdEstimate:20,models:[]}]);
    await call('admin/offers/vendor-free/approve',{},'admin');
    const result=await call('ingest/offers',[{...offer,type:'perk',models:['Vendor'],usdEstimate:20,usdMax:20,valueText:'100 tokens with a new estimate',sourceText:'Free 100 tokens. All users. No published end date. Changed footer.',evidence:{...evidence,pageHash:'b'.repeat(64),excerpts:{benefit:'Free 100 tokens. All users.'}}}]);
    expect((result.body.results as any[])[0].unchanged).toBe(true);
    expect(sqlite.prepare('SELECT count(*) n FROM offer_proposals').get()).toEqual({n:0});
    expect(sqlite.prepare('SELECT type,usd_max,models FROM offers').get()).toEqual({type:'new',usd_max:null,models:'[]'});
  });
  it('does not recreate a rejected update on the same official terms even with a different extracted quote or ID', async () => {
    await call('ingest/offers',[offer]);await call('admin/offers/vendor-free/approve',{},'admin');
    const next={...offer,valueText:'200 tokens',sourceText:'Free 200 tokens. All users. No published end date.',evidence:{...evidence,excerpts:{...evidence.excerpts,benefit:'Free 200 tokens'}}};
    await call('ingest/offers',[next]);
    expect((await call('admin/offers/vendor-free/reject',{reason:'不要这次变更'},'admin')).status).toBe(200);
    const again=await call('ingest/offers',[{...next,id:'vendor-another-key',evidence:{...next.evidence,capturedAt:new Date().toISOString(),pageHash:'c'.repeat(64),excerpts:{...next.evidence.excerpts,benefit:'Free 200 tokens. All users.'}}}]);
    expect(sqlite.prepare('SELECT count(*) n FROM offers').get()).toEqual({n:1});
    expect(sqlite.prepare('SELECT count(*) n FROM offer_proposals').get()).toEqual({n:0});
    expect((again.body.results as any[])[0].unchanged).toBe(true);
    const realChange=await call('ingest/offers',[{...next,valueText:'300 tokens',sourceText:'Free 300 tokens. All users. No published end date.',evidence:{...evidence,excerpts:{...evidence.excerpts,benefit:'Free 300 tokens'}}}]);
    expect((realChange.body.results as any[])[0].reviewState).toBe('pending_update');
  });
  it('rejects an invalid merged valuation instead of queueing a maximum below the approved minimum',async()=>{
    await call('ingest/offers',[{...offer,usdEstimate:20,usdMax:20}]);await call('admin/offers/vendor-free/approve',{},'admin');
    await call('admin/offers/vendor-free/edit',{fields:{usdEstimate:20,valueText:'100 tokens, worth $20'}},'admin');
    // Explicitly protect the approved estimate as an administrator correction.
    sqlite.prepare("INSERT INTO offer_revisions(offer_id,diff,author) VALUES('vendor-free',?, 'admin')").run(JSON.stringify([{field:'usdEstimate',from:null,to:20}]));
    const result=await call('ingest/offers',[{...offer,usdEstimate:0,usdMax:0,valueText:'200 tokens',sourceText:'Free 200 tokens. All users. No published end date.',evidence:{...evidence,excerpts:{...evidence.excerpts,benefit:'Free 200 tokens'}}}]);
    expect((result.body.results as any[])[0].error).toContain('校验');
    expect(sqlite.prepare('SELECT count(*) n FROM offer_proposals').get()).toEqual({n:0});
  });
  it('preserves a manually edited proposal when a no-change extraction arrives',async()=>{
    await call('ingest/offers',[offer]);await call('admin/offers/vendor-free/approve',{},'admin');
    sqlite.prepare("INSERT INTO offer_proposals(offer_id,candidate,diff,manual_fields) VALUES('vendor-free',?,?,'[\"requirements\"]')").run(JSON.stringify({...offer,requirements:['card']}),JSON.stringify([{field:'requirements',from:['none'],to:['card']} ]));
    await call('ingest/offers',[{...offer,sourceText:'Free 100 tokens. All users. No published end date.'}]);
    expect(sqlite.prepare('SELECT count(*) n FROM offer_proposals').get()).toEqual({n:1});
  });
  it('uses current review metadata instead of a stale full-row proposal snapshot in both queue and detail', async () => {
    await call('ingest/offers', [offer]);
    await call('admin/offers/vendor-free/approve', {}, 'admin');
    const candidate={...offer,valueText:'200 tokens',reviewState:'rejected',reviewMemo:'旧核验',adminNote:'旧心得',reviewSuggestion:{verdict:'reject',reason:'旧建议'}};
    sqlite.prepare("INSERT INTO offer_proposals(offer_id,candidate,diff) VALUES('vendor-free',?,?)").run(JSON.stringify(candidate),JSON.stringify([{field:'valueText',from:'100 tokens',to:'200 tokens'}]));
    await call('admin/offers/vendor-free/memo',{memo:'最新核验'},'admin');
    await call('admin/offers/vendor-free/suggest',{verdict:'approve',reason:'最新建议'},'admin');
    await call('admin/offers/vendor-free/note',{note:'最新心得'},'admin');
    const detail=(await call('admin/offers/vendor-free',undefined,'admin')).body.offer as any;
    const queue=(await call('admin/queue',undefined,'admin')).body.pending as any[];
    for(const view of [detail,queue.find(o=>o.id==='vendor-free')]){
      expect(view).toMatchObject({value:'200 tokens',reviewState:'approved',reviewMemo:'最新核验',adminNote:'最新心得',suggestion:{verdict:'approve',reason:'最新建议'}});
    }
    expect((await call('admin/offers/vendor-free/approve',{},'admin')).status).toBe(200);
    const saved=sqlite.prepare("SELECT value_text,review_memo,admin_note FROM offers WHERE id='vendor-free'").get();
    expect(saved).toEqual({value_text:'200 tokens',review_memo:'最新核验',admin_note:'最新心得'});
  });
  it('records an administrator-tested end without inventing a deadline or rewriting historical official evidence', async () => {
    await call('ingest/offers', [offer]);
    await call('admin/offers/vendor-free/approve', {}, 'admin');
    sqlite.prepare("INSERT INTO offer_proposals(offer_id,candidate,diff) VALUES('vendor-free','{}','[]')").run();
    const before = sqlite.prepare("SELECT evidence FROM offers WHERE id='vendor-free'").get() as any;
    const stopped = await call('admin/offers/vendor-free/withdraw', { basis:'tested',reason:'新注册且从未使用的账号已没有试用次数',evidenceUrl:'https://vendor.example/app' }, 'admin');
    expect(stopped.body.status).toBe('ended');
    const saved = sqlite.prepare("SELECT * FROM offers WHERE id='vendor-free'").get() as any;
    expect(saved.claim_end).toBeNull();
    expect(saved.end_kind).toBe('unknown');
    expect(saved.review_state).toBe('approved');
    expect(saved.evidence).toBe(before.evidence);
    expect(saved.withdrawn_reason).toContain('管理员实测停止领取');
    expect(saved.review_memo).toContain('仅为确认时刻');
    expect(sqlite.prepare('SELECT count(*) n FROM offer_proposals').get()).toEqual({n:0});
    const publicResult = await worker.fetch(new Request('https://local.test/api/offers/vendor-free'),env,{} as ExecutionContext);
    expect((await publicResult.json() as any).offer.status).toBe('ended');
    expect((await call('ingest/verification-queue?force=1')).body.offers).toEqual([]);
  });
  it('keeps old correction text and review history private while administrators can read it', async () => {
    await call('ingest/offers', [offer]);
    await call('admin/offers/vendor-free/approve', {}, 'admin');
    sqlite.prepare("UPDATE offers SET review_memo='内部：曾误归平台',admin_note='公开使用心得' WHERE id='vendor-free'").run();
    sqlite.prepare("INSERT INTO offer_revisions(offer_id,diff,author) VALUES('vendor-free',?,'admin')").run(JSON.stringify([{field:'valueText',from:'历史审核错误：不得折美元',to:'100 tokens'}]));
    const response = await worker.fetch(new Request('https://local.test/api/offers/vendor-free'), env, {} as ExecutionContext);
    const publicBody = await response.json() as any;
    expect(response.status).toBe(200);
    expect(publicBody).not.toHaveProperty('revisions');
    expect(publicBody.offer).not.toHaveProperty('reviewMemo');
    expect(publicBody.offer.adminNote).toBe('公开使用心得');
    expect(JSON.stringify(publicBody)).not.toContain('历史审核错误');
    const adminBody = (await call('admin/offers/vendor-free', undefined, 'admin')).body;
    expect(JSON.stringify(adminBody)).toContain('历史审核错误');
    expect(JSON.stringify(adminBody)).toContain('内部：曾误归平台');
    const denied = await worker.fetch(new Request('https://local.test/api/admin/offers/vendor-free'), env, {} as ExecutionContext);
    expect(denied.status).toBe(401);
  });
  it('keeps verification, review queue and notices within D1 limits above 100 offers', async () => {
    await call('ingest/offers', [offer]);
    sqlite.prepare("UPDATE offers SET review_state='approved',last_verified_at=NULL WHERE id='vendor-free'").run();
    const columns = (sqlite.prepare('PRAGMA table_info(offers)').all() as { name: string }[]).map(c => c.name);
    const copy = sqlite.prepare(`INSERT INTO offers (${columns.join(',')}) SELECT ${columns.map(c => c === 'id' ? '?' : c).join(',')} FROM offers WHERE id='vendor-free'`);
    for (let i = 1; i < 120; i++) copy.run(`vendor-free-${i}`);
    sqlite.prepare("INSERT INTO offer_proposals (offer_id,candidate,diff,manual_fields,detected_at,updated_at) VALUES (?,?, '[]','[]',?,?)")
      .run('vendor-free-119', JSON.stringify({ evidence: { pageHash: 'proposal-hash' } }), new Date().toISOString(), new Date().toISOString());
    for (const suffix of ['', '?sourceId=source&force=1']) {
      const queue = await call(`ingest/verification-queue${suffix}`);
      expect(queue.status).toBe(200);
      const offers = queue.body.offers as { id: string; proposalHash: string | null }[];
      expect(offers).toHaveLength(120);
      expect(offers.find(o => o.id === 'vendor-free-119')?.proposalHash).toBe('proposal-hash');
      expect(offers.find(o => o.id === 'vendor-free')?.proposalHash).toBeNull();
    }
    expect((await call('ingest/verification-queue?sourceId=missing')).body.offers).toEqual([]);
    await expect(buildNotice(env, 'digest', 'telegram')).resolves.toBeDefined();
    const proposal = sqlite.prepare("INSERT OR REPLACE INTO offer_proposals (offer_id,candidate,diff,manual_fields,detected_at,updated_at) VALUES (?,?,?,'[]',?,?)");
    for (let i = 0; i < 120; i++) proposal.run(i ? `vendor-free-${i}` : 'vendor-free',
      JSON.stringify({ valueText: '200 tokens' }), JSON.stringify([{ field: 'valueText', from: '100 tokens', to: '200 tokens' }]),
      new Date().toISOString(), new Date().toISOString());
    const review = await call('admin/queue', undefined, 'admin');
    expect(review.status).toBe(200);
    expect(review.body.pending).toHaveLength(120);
  });

  it('refreshes an unchanged offer only when its saved quotations still appear', async () => {
    expect((await call('ingest/offers', [offer])).status).toBe(200);
    sqlite.prepare("UPDATE offers SET review_state='approved',last_verified_at='2026-09-27T00:00:00Z' WHERE id='vendor-free'").run();
    await call('ingest/snapshots', { sourceId: 'source', url: evidence.url, ok: true, hash: 'unchanged' });
    const before = sqlite.prepare("SELECT last_verified_at FROM offers WHERE id='vendor-free'").get() as { last_verified_at: string };
    expect(before.last_verified_at).toBe('2026-09-27T00:00:00Z');
    const queue = await call('ingest/verification-queue');
    expect((queue.body.offers as { id: string }[]).map(row => row.id)).toContain('vendor-free');

    const verified = await call('ingest/verify', { trustedDirect: true, offerId: 'vendor-free', url: evidence.url, text: Object.values(evidence.excerpts).join('\n') });
    expect(verified.body.verified).toBe(true);
    const after = sqlite.prepare("SELECT last_verified_at FROM offers WHERE id='vendor-free'").get() as { last_verified_at: string };
    expect(Date.parse(after.last_verified_at)).toBeGreaterThan(Date.parse(before.last_verified_at));
    expect((await call('ingest/verification-queue')).body.offers).toEqual([]);

    const missing = await call('ingest/verify', { trustedDirect: true, offerId: 'vendor-free', url: evidence.url, text: 'Offer removed' });
    expect(missing.body.verified).toBe(false);
    expect((sqlite.prepare("SELECT last_verified_at FROM offers WHERE id='vendor-free'").get() as { last_verified_at: string }).last_verified_at).toBe(after.last_verified_at);
  });

  it('rejects nonexistent calendar dates and honours withdrawal for permanent offers', () => {
    expect(offerIn.safeParse({ ...offer, claimEnd: '2026-02-30', endKind: 'date' }).success).toBe(false);
    expect(liveStatus({ type: 'standing', claimStart: null, claimEnd: null, endKind: 'standing', sourceTz: 'UTC', lastVerifiedAt: '2026-09-30T00:00:00Z', withdrawnAt: '2026-09-30T01:00:00Z' }, new Date('2026-09-30T02:00:00Z'))).toBe('ended');
  });

  it('removes an offer when current official evidence disappears and records a confirmed withdrawal', async () => {
    await call('ingest/offers', [offer]);
    await call('admin/offers/vendor-free/approve', {}, 'admin');
    const missing = await call('ingest/verify', { trustedDirect: true, offerId: 'vendor-free', url: evidence.url, text: 'The benefit has been discontinued.' });
    expect(missing.body.verified).toBe(false);
    expect((await call('offers?view=claimable')).body.count).toBe(0);
    expect((await call('admin/notify?kind=digest', undefined, 'admin')).body).toMatchObject({ needsVerificationCount: 0 });
    expect((await call('admin/queue', undefined, 'admin')).body.needsVerification).toHaveLength(0);
    const withdrawn = await call('admin/offers/vendor-free/withdraw', { reason: 'The vendor ended its free allowance', evidenceUrl: 'https://vendor.example/withdrawal' }, 'admin');
    expect(withdrawn.body.status).toBe('ended');
    expect((await call('admin/queue', undefined, 'admin')).body.needsVerification).toHaveLength(0);
    const status = sqlite.prepare("SELECT withdrawn_at, withdrawn_reason FROM offers WHERE id='vendor-free'").get() as { withdrawn_at: string; withdrawn_reason: string };
    expect(status.withdrawn_at).toBeTruthy();
    expect(status.withdrawn_reason).toContain('ended');
  });
});

describe('review gates and preserved public version', () => {
  it('requires the WorkBuddy official account on WorkBuddy rather than its parent platform', async () => {
    sqlite.prepare("INSERT INTO platforms(id,name,type,status,site,x_handles) VALUES('workbuddy','WorkBuddy','tool','approved','https://www.workbuddy.cn','[]')").run();
    sqlite.prepare("INSERT INTO platforms(id,name,type,status,x_handles) VALUES('tencent-hy','腾讯混元','lab','approved','[\"@WorkBuddy_AI\"]')").run();
    const referral={...offer,id:'workbuddy-referral',platformId:'workbuddy',sourceId:undefined,evidence:{...evidence,tier:'official',url:'https://x.com/WorkBuddy_AI/status/2108082016860413973'}};
    await call('ingest/offers',[referral]);
    const blocked=await call('admin/offers/workbuddy-referral/approve',{},'admin');
    expect(blocked.status).toBe(400);expect(blocked.body.error).toContain('已登记官方信源');
    sqlite.prepare("UPDATE platforms SET x_handles='[\"@WorkBuddy_AI\"]' WHERE id='workbuddy'").run();
    const approved=await call('admin/offers/workbuddy-referral/approve',{},'admin');
    expect(approved.status).toBe(200);
    expect(sqlite.prepare("SELECT review_state FROM offers WHERE id='workbuddy-referral'").get()).toEqual({review_state:'approved'});
  });
  it('审批页：待审条目带上架前检查；已上架但缺字段的进入“已上架、字段待补”；复测仍有效会更新核验时间', async () => {
    await call('ingest/offers', [{ ...offer, usdEstimate: null }]);
    const q1 = await call('admin/queue', undefined, 'admin');
    const pending = (q1.body.pending as { id: string; checks: { field: string; sections: string[] }[] }[]).find(o => o.id === 'vendor-free')!;
    expect(pending.checks.map(c => c.field)).toContain('usdEstimate');
    expect(pending.checks.find(c => c.field === 'usdEstimate')!.sections.length).toBeGreaterThan(0);
    await call('admin/offers/vendor-free/approve', {}, 'admin');
    const q2 = await call('admin/queue', undefined, 'admin');
    expect((q2.body.incomplete as { id: string }[]).map(o => o.id)).toContain('vendor-free');
    const r = await call('admin/offers/vendor-free/retested', {}, 'admin');
    expect(r.status).toBe(200);
    expect((sqlite.prepare("SELECT verify_result FROM offers WHERE id='vendor-free'").get() as { verify_result: string }).verify_result).toBe('管理员复测仍有效');
  });

  it('证据链接在平台已登记官方信源的域名下（不同于官网域名）也能通过', async () => {
    sqlite.prepare("INSERT INTO sources (id,platform_id,kind,url,tier,config) VALUES ('vendor-docs','vendor','web_list','https://docs.vendor-other.example/pricing','docs','{}')").run();
    await call('ingest/offers', [{ ...offer, sourceId: undefined, evidence: { ...evidence, url: 'https://docs.vendor-other.example/announcements' } }]);
    const r = await call('admin/offers/vendor-free/approve', {}, 'admin');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  });

  it('内部核验记录只给管理员看，公开接口不输出', async () => {
    await call('ingest/offers', [offer]);
    await call('admin/offers/vendor-free/approve', {}, 'admin');
    expect((await call('admin/offers/vendor-free/memo', { memo: '漏抓原因：平台没有信源' }, 'admin')).status).toBe(200);
    const pub = await call('offers?view=all');
    expect(JSON.stringify(pub.body)).not.toContain('漏抓原因');
    expect(JSON.stringify((await call('offers/vendor-free')).body)).not.toContain('漏抓原因');
    expect(JSON.stringify((await call('admin/queue', undefined, 'admin')).body) + JSON.stringify((await call('admin/offers/vendor-free', undefined, 'admin')).body)).toContain('漏抓原因');
  });

  it('管理员心得：写入后公开显示，采集更新不会覆盖', async () => {
    await call('ingest/offers', [offer]);
    expect((await call('admin/offers/vendor-free/note', { note: '速度慢，适合做翻译' }, 'admin')).status).toBe(200);
    await call('ingest/offers', [{ ...offer, valueText: offer.valueText + '（更新）' }]);
    expect(sqlite.prepare("SELECT admin_note FROM offers WHERE id='vendor-free'").get()).toEqual({ admin_note: '速度慢，适合做翻译' });
    expect((await call('admin/offers/vendor-free/note', { note: '' }, 'admin')).body.adminNote).toBeNull();
  });

  it('管理员实测：社区转述的条目改成“管理员实测”即可通过；采集管线不能自称管理员实测', async () => {
    await call('ingest/offers', [{ ...offer, evidence: { ...evidence, url: 'https://forum.example/t/1', tier: 'media' } }]);
    expect((await call('admin/offers/vendor-free/approve', {}, 'admin')).status).toBe(400);
    const edited = await call('admin/offers/vendor-free/edit', { fields: { evidence: { ...evidence, url: 'https://forum.example/t/1', tier: 'tested' } }, approve: true, reason: '我亲自领到了' }, 'admin');
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    expect((await call('ingest/verification-queue')).body.offers).toEqual([]);
    const piped = await call('ingest/offers', [{ ...offer, id: 'vendor-other', evidence: { ...evidence, tier: 'tested' } }]);
    expect(JSON.stringify(piped.body)).toContain('只能在后台人工设置');
  });

  it('管理员人工核对后可以填写模型读不到的有效期（如公众号图片里的），不被原文摘录门槛挡住', async () => {
    await call('ingest/offers', [{ ...offer, evidence: { ...evidence, excerpts: { benefit: evidence.excerpts.benefit } } }]);
    const edited = await call('admin/offers/vendor-free/edit', { fields: { creditValidity: '1 个月', audience: 'old' }, approve: true, reason: '有效期在公众号图片里' }, 'admin');
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    expect(sqlite.prepare("SELECT review_state, credit_validity FROM offers WHERE id='vendor-free'").get()).toEqual({ review_state: 'approved', credit_validity: '1 个月' });
  });

  it('blocks unapproved platforms and media-only proof, then permits corrected official proof', async () => {
    sqlite.prepare("UPDATE platforms SET status='pending' WHERE id='vendor'").run();
    await call('ingest/offers', [{ ...offer, evidence: { ...evidence, tier: 'media', excerpts: {} } }]);
    expect((await call('admin/offers/vendor-free/approve', {}, 'admin')).status).toBe(400);
    await call('admin/platforms/vendor/approve', {}, 'admin');
    expect((await call('admin/offers/vendor-free/approve', {}, 'admin')).status).toBe(400);
    const edited = await call('admin/offers/vendor-free/edit', { fields: { evidence }, approve: true }, 'admin');
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    const publicOffers = await call('offers?view=all');
    expect((publicOffers.body.offers as { id: string }[]).map(o => o.id)).toContain('vendor-free');
    expect((await call('admin/offers/vendor-free/approve', {}, 'admin')).status).toBe(409);
    expect((sqlite.prepare("SELECT clean_streak FROM sources WHERE id='source'").get() as { clean_streak: number }).clean_streak).toBe(0);
    sqlite.prepare("UPDATE platforms SET status='pending' WHERE id='vendor'").run();
    expect((await call('offers?view=all')).body.count).toBe(0);
    expect((await call('offers/vendor-free')).status).toBe(404);
  });

  it('exposes original and candidate values for review while leaving the public offer unchanged', async () => {
    await call('ingest/offers', [{...offer,usdEstimate:10}]);
    await call('admin/offers/vendor-free/approve', {}, 'admin');
    await call('ingest/offers', [{ ...changedOffer(), usdEstimate: 0, models:['New Model'] }]);
    sqlite.prepare("UPDATE offer_proposals SET diff='[]' WHERE offer_id='vendor-free'").run();
    const queue=await call('admin/queue',undefined,'admin');
    const proposal=(queue.body.pending as any[]).find(o=>o.id==='vendor-free');
    expect(proposal).toMatchObject({pendingUpdate:true,value:'200 tokens'});
    expect(proposal.updateDiff).toContainEqual({field:'valueText',from:'100 tokens',to:'200 tokens'});
    expect(proposal.updateDiff).toContainEqual({field:'usdEstimate',from:10,to:0});
    const detail=await call('admin/offers/vendor-free',undefined,'admin');
    expect((detail.body.offer as any).updateDiff).toEqual(proposal.updateDiff);
    expect(sqlite.prepare("SELECT value_text,usd_estimate FROM offers WHERE id='vendor-free'").get()).toMatchObject({value_text:'100 tokens',usd_estimate:10});
  });

  it('protects an administrator correction and stages a model update without hiding the published offer', async () => {
    await call('ingest/offers', [offer]);
    const firstApproval = await call('admin/offers/vendor-free/approve', {}, 'admin');
    expect(firstApproval.status, JSON.stringify(firstApproval.body)).toBe(200);
    const correction = await call('admin/offers/vendor-free/edit', { fields: { audience: 'old' }, reason: 'Official eligibility clarification' }, 'admin');
    expect(correction.status, JSON.stringify(correction.body)).toBe(200);
    const changed = await call('ingest/offers', [{ ...changedOffer(), audience: 'new' }]);
    expect((changed.body.results as { reviewState: string }[])[0].reviewState).toBe('pending_update');
    const published = sqlite.prepare("SELECT value_text,audience,review_state FROM offers WHERE id='vendor-free'").get() as { value_text: string; audience: string; review_state: string };
    expect(published).toMatchObject({ value_text: '100 tokens', audience: 'old', review_state: 'approved' });
    const queue = await call('admin/queue', undefined, 'admin');
    expect((queue.body.pending as { pendingUpdate?: boolean; value: string }[])[0]).toMatchObject({ pendingUpdate: true, value: '200 tokens' });
    const approved = await call('admin/offers/vendor-free/approve', {}, 'admin');
    expect(approved.status).toBe(200);
    const current = sqlite.prepare("SELECT value_text,audience,review_state FROM offers WHERE id='vendor-free'").get() as typeof published;
    expect(current).toMatchObject({ value_text: '200 tokens', audience: 'old', review_state: 'approved' });
  });

  it('does not ask for review when extraction loses evidence or changes optional presentation', async () => {
    await call('ingest/offers', [offer]);
    await call('admin/offers/vendor-free/approve', {}, 'admin');
    const changed = await call('ingest/offers', [{ ...offer, sourceId: undefined,
      steps: ['Open the app'], creditValidity: 'Not stated',
      evidence: { ...evidence, excerpts: {}, capturedAt: new Date().toISOString() } }]);
    expect((changed.body.results as { unchanged: boolean }[])[0].unchanged).toBe(true);
    expect((await call('admin/queue', undefined, 'admin')).body.pending).toEqual([]);
    const saved = sqlite.prepare("SELECT evidence,verify_result FROM offers WHERE id='vendor-free'").get() as { evidence: string; verify_result: string };
    expect(JSON.parse(saved.evidence).excerpts).toEqual(evidence.excerpts);
    expect(saved.verify_result).not.toBe('evidence_missing');
  });

  it('does not renew verification solely because a model says terms match despite missing saved quotes', async () => {
    await call('ingest/offers', [offer]);
    await call('admin/offers/vendor-free/approve', {}, 'admin');
    const hash = 'a'.repeat(64);
    await call('ingest/offers', [{ ...offer, evidence: { ...evidence, pageHash: hash, excerpts: {} } }]);
    const verified = await call('ingest/verify', { trustedDirect: true, offerId: offer.id, url: evidence.url,
      text: 'All members can receive one hundred tokens when they register.', pageHash: hash, processedChange: true });
    expect(verified.body.verified).toBe(false);
    expect((await call('admin/queue', undefined, 'admin')).body.needsVerification).toEqual([]);
  });

  it.each([
    ['models', ['Model A']], ['tags', ['daily']], ['usdMax', 10],
    ['valueText', '200 tokens'], ['requirements', ['card']], ['claimEnd', '2099-12-31'],
  ])('requires review for necessary field %s and preserves the published version', async (field, value) => {
    await call('ingest/offers', [offer]);
    await call('admin/offers/vendor-free/approve', {}, 'admin');
    const changed = await call('ingest/offers', [{ ...offer, sourceText:'Free 200 tokens. Replacement terms for '+field, evidence:{...evidence,excerpts:{benefit:'Free 200 tokens. Replacement terms for '+field}}, [field]: value,
      ...(field === 'claimEnd' ? { endKind: 'date' } : {}),
      ...(field === 'usdMax' ? { usdEstimate: 1 } : {}) }]);
    expect((changed.body.results as { reviewState: string }[])[0].reviewState).toBe('pending_update');
    const pending = (await call('admin/queue', undefined, 'admin')).body.pending as { changedFields: string[] }[];
    expect(pending[0].changedFields).toContain(field);
    expect(sqlite.prepare("SELECT value_text,review_state FROM offers WHERE id='vendor-free'").get())
      .toEqual({ value_text: '100 tokens', review_state: 'approved' });
  });

  it('does not propose cosmetic drift (title wording, modalities, timezone, claim method) on approved offers', async () => {
    await call('ingest/offers', [offer]);
    await call('admin/offers/vendor-free/approve', {}, 'admin');
    const r = await call('ingest/offers', [{ ...offer, title: offer.title + ' (reworded)', modalities: ['text', 'image'], sourceTz: 'Asia/Tokyo', claimMethod: 'auto',
      evidence: { ...evidence, excerpts: { ...evidence.excerpts, benefit: 'Another sentence about the same 100 tokens' } } }]);
    expect((await call('admin/queue', undefined, 'admin')).body.pending).toEqual([]);
  });

  it('ignores ordering and whitespace without exposing legacy evidence-only proposals', async () => {
    const initial = { ...offer, models: ['A', 'B'], modalities: ['text', 'code'] };
    await call('ingest/offers', [initial]);
    await call('admin/offers/vendor-free/approve', {}, 'admin');
    sqlite.prepare("INSERT INTO offer_proposals (offer_id,candidate,diff) VALUES (?,?,?)")
      .run(offer.id, JSON.stringify(initial), JSON.stringify([{ field: 'evidence', from: evidence, to: { ...evidence, excerpts: {} } }]));
    expect((await call('admin/queue', undefined, 'admin')).body.pending).toEqual([]);
    const changed = await call('ingest/offers', [{ ...initial, models: ['B', 'A'], modalities: ['code', 'text'], valueText: '  100   tokens  ' }]);
    expect((changed.body.results as { unchanged: boolean }[])[0].unchanged).toBe(true);
    expect((await call('admin/queue', undefined, 'admin')).body.pending).toEqual([]);
  });

  it('requires review of real changes even for sources allowed to auto-publish', async () => {
    sqlite.prepare("UPDATE sources SET auto_publish=1 WHERE id='source'").run();
    await call('ingest/offers', [offer]);
    expect(sqlite.prepare('SELECT review_state FROM offers').get()).toEqual({ review_state: 'approved' });
    const result = await call('ingest/offers', [changedOffer()]);
    expect((result.body.results as { reviewState: string }[])[0].reviewState).toBe('pending_update');
    expect(sqlite.prepare('SELECT value_text FROM offers').get()).toEqual({ value_text: '100 tokens' });
    const candidate = JSON.parse((sqlite.prepare('SELECT candidate FROM offer_proposals').get() as { candidate: string }).candidate);
    expect(candidate.evidence.excerpts).toEqual(changedOffer().evidence.excerpts);
  });

  it('proposes a necessary change supported by new terms even after an administrator correction', async () => {
    await call('ingest/offers', [offer]);
    await call('admin/offers/vendor-free/approve', {}, 'admin');
    await call('admin/offers/vendor-free/edit', { fields: { valueText: '100 tokens corrected' } }, 'admin');
    const result = await call('ingest/offers', [{ ...offer, valueText: '200 tokens', sourceText:'Free 200 tokens. All users. No published end date.',
      evidence: { ...evidence, excerpts: { ...evidence.excerpts, benefit: 'Free 200 tokens' } } }]);
    expect((result.body.results as { reviewState: string }[])[0].reviewState).toBe('pending_update');
    expect(sqlite.prepare('SELECT value_text FROM offers').get()).toEqual({ value_text: '100 tokens corrected' });
  });

  it('does not bless a failed quotation check by storing its hash and retrying', async () => {
    await call('ingest/offers', [offer]);
    await call('admin/offers/vendor-free/approve', {}, 'admin');
    const body = { trustedDirect: true, offerId: offer.id, url: evidence.url, text: 'Unrelated page', pageHash: 'b'.repeat(64), processedChange: true };
    expect((await call('ingest/verify', body)).body.verified).toBe(false);
    expect((await call('ingest/verify', body)).body.verified).toBe(false);
    expect((await call('admin/queue', undefined, 'admin')).body.needsVerification).toEqual([]);
  });

  it('keeps known dates and valuations when a later extraction omits them', async () => {
    await call('ingest/offers', [{ ...offer, usdEstimate: 1, usdMax: 10, claimStart: '2026-01-01', claimEnd: '2099-12-31', endKind: 'date' }]);
    await call('admin/offers/vendor-free/approve', {}, 'admin');
    const result = await call('ingest/offers', [{ ...offer, audience: 'unclear', requirements: ['unknown'] }]);
    expect((result.body.results as { unchanged: boolean }[])[0].unchanged).toBe(true);
    expect((await call('admin/queue', undefined, 'admin')).body.pending).toEqual([]);
    expect(sqlite.prepare('SELECT usd_max,claim_end FROM offers').get()).toEqual({ usd_max: 10, claim_end: '2099-12-31' });
  });

  it('does not let a disabled staff source auto-publish with a forged payload tier', async () => {
    sqlite.prepare("UPDATE sources SET tier='staff',enabled=0,auto_publish=1 WHERE id='source'").run();
    const result = await call('ingest/offers', [offer]);
    expect((result.body.results as { reviewState: string }[])[0].reviewState).toBe('pending');
  });

  it('refuses ambiguous short codes and gives both records their full IDs in the queue', async () => {
    await call('ingest/offers', [{ ...offer, id: 'offer-159', title: 'Short code A 5 credits', valueText: '5 credits' }, { ...offer, id: 'offer-14600', title: 'Short code B 9 credits', valueText: '9 credits' }]);
    const ambiguous = await call('admin/offers/etch/approve', {}, 'admin');
    expect(ambiguous.status).toBe(409);
    expect(ambiguous.body.ids).toEqual(['offer-159', 'offer-14600']);
    const queue = await call('admin/queue', undefined, 'admin');
    expect((queue.body.pending as { code: string }[]).map(o => o.code).sort()).toEqual(['offer-14600', 'offer-159']);
  });
});

describe('notification delivery receipts', () => {
  it('does not mark an event sent until delivery is acknowledged, and blocks concurrent claims', async () => {
    await call('ingest/offers', [offer]);
    await call('admin/offers/vendor-free/approve', {}, 'admin');
    const preview = await call('admin/notify?kind=digest', undefined, 'admin');
    expect((preview.body.items as { new: unknown[] }).new).toHaveLength(1);
    const first = await call('admin/notify/claim', { kind: 'digest', channel: 'telegram' }, 'admin');
    const second = await call('admin/notify/claim', { kind: 'digest', channel: 'telegram' }, 'admin');
    expect(first.body.deliveryId).toBeTruthy();
    expect(second.body.alreadyClaimed).toBe(true);
    expect((sqlite.prepare('SELECT count(*) n FROM notifications').get() as { n: number }).n).toBe(0);
    const ack = await call(`admin/notify/${first.body.deliveryId}/ack`, { status: 'sent' }, 'admin');
    expect(ack.status).toBe(200);
    expect((sqlite.prepare("SELECT status FROM notifications WHERE offer_id='vendor-free' AND stage='new'").get() as { status: string }).status).toBe('sent');
    expect((await call('admin/notify?kind=digest', undefined, 'admin')).body.empty).toBe(true);
  });

  it('keeps unknown outcomes for human reconciliation and excludes admin edits from public change alerts', async () => {
    await call('ingest/offers', [offer]);
    await call('admin/offers/vendor-free/approve', {}, 'admin');
    const first = await call('admin/notify/claim', { kind: 'digest', channel: 'telegram' }, 'admin');
    await call(`admin/notify/${first.body.deliveryId}/ack`, { status: 'unknown', error: 'transport timed out' }, 'admin');
    expect((await call('admin/notify/claim', { kind: 'digest', channel: 'telegram' }, 'admin')).body.alreadyClaimed).toBe(true);
    expect((await call(`admin/notify/${first.body.deliveryId}/ack`, { status: 'sent' }, 'admin')).status).toBe(409);
    expect((await call(`admin/notify/${first.body.deliveryId}/resolve`, { outcome: 'not_delivered', reason: 'Checked recipient chat history' }, 'admin')).status).toBe(200);
    const retried = await call('admin/notify/claim', { kind: 'digest', channel: 'telegram' }, 'admin');
    expect(retried.body.deliveryId).toBeTruthy();
    expect(retried.body.deliveryId).not.toBe(first.body.deliveryId);
    await call(`admin/notify/${retried.body.deliveryId}/ack`, { status: 'unknown', error: 'second timeout' }, 'admin');
    expect((await call(`admin/notify/${retried.body.deliveryId}/resolve`, { outcome: 'delivered', reason: 'Saw Telegram message in chat' }, 'admin')).status).toBe(200);
    expect((sqlite.prepare("SELECT status FROM notifications WHERE offer_id='vendor-free' AND channel='telegram'").get() as { status: string }).status).toBe('sent');

    const firstFeishu = await call('admin/notify/claim', { kind: 'digest', channel: 'feishu' }, 'admin');
    await call(`admin/notify/${firstFeishu.body.deliveryId}/ack`, { status: 'sent' }, 'admin');
    await call('admin/offers/vendor-free/edit', { fields: { audience: 'old' }, reason: 'Manual correction' }, 'admin');
    const nextFeishu = await call('admin/notify?kind=digest&channel=feishu', undefined, 'admin');
    expect((nextFeishu.body.items as { changed: unknown[] }).changed).toEqual([]);
  });

  it('includes pending review in the administrator digest even with no public events', async () => {
    await call('ingest/offers', [offer]);
    const digest = await call('admin/notify?kind=digest', undefined, 'admin');
    expect(digest.body.pendingCount).toBe(1);
    expect(digest.body.empty).toBe(false);
  });

  it('does not repeat the same pending summary after an event digest was delivered today', async () => {
    await call('ingest/offers', [offer, { ...offer, id: 'vendor-pending', title: 'Another pending offer', valueText: '7 extra credits' }]);
    await call('admin/offers/vendor-free/approve', {}, 'admin');
    const first = await call('admin/notify/claim', { kind: 'digest', channel: 'telegram' }, 'admin');
    expect(first.body.pendingCount).toBe(1);
    await call(`admin/notify/${first.body.deliveryId}/ack`, { status: 'sent' }, 'admin');
    const second = await call('admin/notify/claim', { kind: 'digest', channel: 'telegram' }, 'admin');
    expect(second.body.empty).toBe(true);
    expect(second.body.deliveryId).toBeUndefined();
  });

  it('does not announce a revision that predates the first new-offer message', async () => {
    await call('ingest/offers', [offer]);
    await call('admin/offers/vendor-free/approve', {}, 'admin');
    await call('ingest/offers', [{ ...offer, valueText: '200 tokens' }]);
    await call('admin/offers/vendor-free/approve', {}, 'admin');
    const first = await call('admin/notify/claim', { kind: 'digest', channel: 'telegram' }, 'admin');
    expect((first.body.items as { new: unknown[]; changed: unknown[] }).new).toHaveLength(1);
    await new Promise(resolve => setTimeout(resolve, 5));
    await call(`admin/notify/${first.body.deliveryId}/ack`, { status: 'sent' }, 'admin');
    const next = await call('admin/notify?kind=digest', undefined, 'admin');
    expect((next.body.items as { changed: unknown[] }).changed).toEqual([]);
    expect(next.body.empty).toBe(true);
  });

  it('never sends an urgent notice for an offer whose evidence is stale', async () => {
    const tomorrow = new Date(Date.now() + 86400_000).toISOString().slice(0, 10);
    await call('ingest/offers', [{ ...offer, claimEnd: tomorrow, endKind: 'date' }]);
    await call('admin/offers/vendor-free/approve', {}, 'admin');
    sqlite.prepare("UPDATE offers SET last_verified_at='2026-09-01T00:00:00Z' WHERE id='vendor-free'").run();
    expect((await call('admin/notify?kind=urgent', undefined, 'admin')).body.empty).toBe(true);
  });
});

describe('durable model budget', () => {
  it('reserves atomically across concurrent callers and releases unused tokens after a response', async () => {
    env.DAILY_TOKEN_CAP = '10000';
    env.MONTHLY_COST_CAP_CNY = '1';
    const request = { provider: 'paid-model', tokens: 7000, costCny: 0.7 };
    const [first, second] = await Promise.all([
      call('ingest/model-budget/reserve', request), call('ingest/model-budget/reserve', request),
    ]);
    expect([first.status, second.status].sort()).toEqual([200, 429]);
    const accepted = first.status === 200 ? first : second;
    expect((await call('ingest/budget')).body.tokensToday).toBe(7000);
    await call(`ingest/model-budget/${accepted.body.id}/settle`, { provider: 'paid-model', tokens: 1000, costCny: 0.2 });
    expect((await call('ingest/budget')).body).toMatchObject({ tokensToday: 1000, costMonthCny: 0.2 });
    expect((await call('ingest/model-budget/reserve', request)).status).toBe(200);
  });
  it('allows unlimited daily free-model tokens in debug mode while keeping the monthly paid ceiling', async () => {
    env.DAILY_TOKEN_CAP = '0';
    env.MONTHLY_COST_CAP_CNY = '1';
    for (let i = 0; i < 3; i++) expect((await call('ingest/model-budget/reserve', { provider: 'free-model', tokens: 300000, costCny: 0 })).status).toBe(200);
    expect((await call('ingest/budget')).body.tokensToday).toBe(900000);
    expect((await call('ingest/model-budget/reserve', { provider: 'paid-model', tokens: 10000, costCny: 0.7 })).status).toBe(200);
    expect((await call('ingest/model-budget/reserve', { provider: 'paid-model', tokens: 10000, costCny: 0.4 })).status).toBe(429);
  });
});

describe('public status and subscriptions', () => {
  it('distinguishes an untouched source from a healthy source', async () => {
    const coverage = await call('coverage');
    expect((coverage.body.officialPages as { healthy: boolean }[])[0].healthy).toBe(false);
    const health = await call('admin/health', undefined, 'admin');
    expect((health.body.failingSources as { id: string }[]).map(x => x.id)).toContain('source');
  });

  it('serves actual RSS XML for verified, approved offers', async () => {
    await call('ingest/offers', [offer]);
    await call('admin/offers/vendor-free/approve', {}, 'admin');
    const response = await worker.fetch(new Request('https://local.test/rss.xml'), env, {} as ExecutionContext);
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain('application/rss+xml');
    const xml = await response.text();
    expect(xml).toContain('<rss version="2.0">');
    expect(xml).toContain('Vendor free tokens');
  });
});


describe('lead to review workflow', () => {
  it('puts time-sensitive AIHOT leads before community noise and reserves backlog capacity', async () => {
    const insert = sqlite.prepare("INSERT INTO leads(origin,url,title,created_at) VALUES (?,?,?,?)");
    insert.run('reddit','https://example.org/old','Old free API credits','2026-09-01T00:00:00Z');
    for (let i=0;i<60;i++) insert.run('linuxdo',`https://example.org/noise-${i}`,'免费话费游戏','2026-10-01T00:00:00Z');
    insert.run('aihot','https://example.org/max','Anthropic Max 每月赠送 API 额度','2026-10-07T00:00:00Z');
    insert.run('aihot','https://example.org/reset','Codex 重置卡已发放','2026-10-08T00:00:00Z');
    insert.run('ithome','https://example.org/game','游戏免费更新：AI 敌人等级重置','2026-10-08T01:00:00Z');
    const result = await call('ingest/leads?limit=25');
    const rows = result.body.leads as {title:string}[];
    expect(rows.slice(0,2).map(l=>l.title)).toEqual(['Codex 重置卡已发放','Anthropic Max 每月赠送 API 额度']);
    expect(rows.map(l=>l.title)).toContain('Old free API credits');
  });
  it('alerts about untriaged reset leads and new pending offers hourly, without publishing or repeating', async () => {
    sqlite.prepare("INSERT INTO leads(origin,url,title) VALUES ('aihot','https://example.org/reset','Codex 重置卡已发放')").run();
    await call('ingest/offers',[offer]);
    const first = await call('admin/notify/claim',{kind:'urgent',channel:'telegram'},'admin');
    expect(first.body.empty).toBe(false);
    expect(first.body.reviewAlerts).toHaveLength(2);
    expect((sqlite.prepare("SELECT review_state FROM offers WHERE id='vendor-free'").get() as {review_state:string}).review_state).toBe('pending');
    const concurrent = await call('admin/notify/claim',{kind:'urgent',channel:'telegram'},'admin');
    expect(concurrent.body.empty).toBe(true);
    await call(`admin/notify/${first.body.deliveryId}/ack`,{status:'sent'},'admin');
    expect((await call('admin/notify?kind=urgent',undefined,'admin')).body.empty).toBe(true);
    sqlite.prepare("INSERT INTO leads(origin,url,title) VALUES ('aihot','https://example.org/reset2','Codex 第二次重置卡发放')").run();
    expect((await call('admin/notify?kind=urgent',undefined,'admin')).body.reviewAlerts).toHaveLength(1);
  });
});


it('refuses to consume a lead when its supposed offer did not persist', async () => {
  sqlite.prepare("INSERT INTO leads(origin,url,title) VALUES ('aihot','https://example.org/max','Vendor Max API credits')").run();
  expect((await call('ingest/leads/1/status',{status:'linked',offerId:'missing'})).status).toBe(409);
  expect((sqlite.prepare('SELECT status FROM leads WHERE id=1').get() as {status:string}).status).toBe('new');
  await call('ingest/offers',[{...offer,leadId:1}]);
  expect((sqlite.prepare('SELECT status FROM leads WHERE id=1').get() as {status:string}).status).toBe('new');
  expect((await call('ingest/leads/1/status',{status:'linked',offerId:'vendor-free'})).status).toBe(200);
});


it('creates a new pending reset event even when the model reuses a historical ID', async () => {
  const old = {...offer,id:'vendor-reset',title:'Codex 重置卡发放',type:'perk',tags:['reset'],claimStart:'2026-07-13',publishedAt:'2026-07-13T18:00:00Z'};
  await call('ingest/offers',[old]);
  sqlite.prepare("UPDATE offers SET review_state='approved' WHERE id='vendor-reset'").run();
  const next = await call('ingest/offers',[{...old,claimStart:'2026-10-07',publishedAt:'2026-10-07T19:00:00Z',evidence:{...evidence,url:'https://vendor.example/october-reset'}}]);
  expect((next.body.results as {id:string}[])[0].id).not.toBe('vendor-reset');
  expect((sqlite.prepare("SELECT count(*) n FROM offers WHERE review_state='pending'").get() as {n:number}).n).toBe(1);
  expect((sqlite.prepare("SELECT published_at FROM offers WHERE id='vendor-reset'").get() as {published_at:string}).published_at).toBe(old.publishedAt);
  expect((sqlite.prepare('SELECT count(*) n FROM offer_proposals').get() as {n:number}).n).toBe(0);
});


it('does not bury a new pending Max benefit behind routine review backlog',async()=>{
  for (let i=0;i<20;i++) await call('ingest/offers',[{...offer,id:`vendor-noise-${i}`,title:`工具体验 ${i}`,valueText:`${i+1} credits`}]);
  await call('ingest/offers',[{...offer,id:'vendor-max',title:'Anthropic Max 每月免费 API 额度',valueText:'700 API credits'}]);
  const notice = await call('admin/notify?kind=urgent',undefined,'admin');
  const alerts=notice.body.reviewAlerts as {title:string}[];
  expect(alerts[0].title).toContain('Anthropic Max');
  expect(alerts).toHaveLength(10);
});

describe('workflow audit regressions', () => {
  it('rejects malformed publication timestamps before they can break the review UI', async () => {
    expect((await call('ingest/offers',[{...offer,publishedAt:'unknown'}])).status).toBe(400);
  });
  it('cannot downgrade a published offer to forbidden evidence through an ordinary edit', async () => {
    await call('ingest/offers',[offer]);await call('admin/offers/vendor-free/approve',{},'admin');
    const edit=await call('admin/offers/vendor-free/edit',{fields:{evidence:{...evidence,tier:'media'},requirements:['unknown']}},'admin');
    expect(edit.status).toBe(400);
    expect((sqlite.prepare("SELECT review_state,requirements FROM offers WHERE id='vendor-free'").get() as {requirements:string}).requirements).toBe('["none"]');
  });
  it('an explicit approval records the reviewer verification so the offer is immediately eligible',async()=>{
    await call('ingest/offers',[offer]);
    sqlite.prepare("UPDATE offers SET last_verified_at=? WHERE id='vendor-free'").run(new Date(Date.now()-3*86400_000).toISOString());
    expect((await call('admin/offers/vendor-free/approve',{},'admin')).status).toBe(200);
    const listed=await call('offers');expect((listed.body.offers as {id:string}[]).map(x=>x.id)).toContain('vendor-free');
  });
  it('keeps pending or unknown Feishu batches out of all reconstructed rankings',async()=>{
    await call('ingest/offers',[offer]);await call('admin/offers/vendor-free/approve',{},'admin');
    const first=await call('admin/notify/claim',{kind:'digest',channel:'feishu'},'admin');
    expect(first.body.deliveryId).toBeTruthy();
    const second=await call('admin/notify/claim',{kind:'digest',channel:'feishu'},'admin');
    expect(second.body.empty).toBe(true);expect(second.body.deliveryId).toBeUndefined();
    await call(`admin/notify/${first.body.deliveryId}/ack`,{status:'unknown'},'admin');
    expect((await call('admin/notify?kind=digest&channel=feishu',undefined,'admin')).body.empty).toBe(true);
  });
  it('atomically prevents overlapping digest and urgent claims from sending the same offer twice',async()=>{
    await call('ingest/offers',[{...offer,endKind:'date',claimEnd:new Date(Date.now()+86400_000).toISOString().slice(0,10)}]);
    await call('admin/offers/vendor-free/approve',{},'admin');
    const results=await Promise.all(['digest','urgent'].map(kind=>call('admin/notify/claim',{kind,channel:'telegram'},'admin')));
    expect(results.filter(r=>r.body.deliveryId)).toHaveLength(1);
  });
  it('keeps expiring pending offers ahead of fresh leads and uses a protected review destination',async()=>{
    await call('ingest/offers',[{...offer,endKind:'date',claimEnd:new Date(Date.now()+86400_000).toISOString().slice(0,10)}]);
    const insert=sqlite.prepare("INSERT INTO leads(origin,url,title) VALUES ('aihot',?,'Codex 重置卡发放')");
    for(let i=0;i<20;i++)insert.run(`https://example.org/reset-${i}`);
    const r=await call('admin/notify?kind=urgent',undefined,'admin');
    const alerts=r.body.reviewAlerts as {key:string;url:string}[];
    expect(alerts[0].key).toBe('offer:vendor-free');expect(alerts[0].url).toContain('#admin-offer-vendor-free');
    const detail=await call('admin/offers/vendor-free',undefined,'admin');expect((detail.body.offer as {link:string}).link).toContain('#admin-offer-vendor-free');
  });
  it('paginates older manual-review leads and supports status filtering without omission',async()=>{
    const insert=sqlite.prepare("INSERT INTO leads(origin,url,title,status) VALUES ('aihot',?,'lead',?)");
    for(let i=0;i<65;i++)insert.run(`https://example.org/lead-${i}`,i===0?'reviewing':'new');
    const first=await call('admin/leads?limit=60',undefined,'admin');
    expect(first.body.total).toBe(65);expect(first.body.nextCursor).toBe(6);
    const next=await call(`admin/leads?limit=60&before=${first.body.nextCursor}`,undefined,'admin');
    expect((next.body.leads as {id:number}[]).map(l=>l.id)).toEqual([5,4,3,2,1]);expect(next.body.nextCursor).toBeNull();
    const manual=await call('admin/leads?status=reviewing',undefined,'admin');
    expect((manual.body.leads as {id:number}[]).map(l=>l.id)).toEqual([1]);
  });
});

it('does not revive official verification or erase an existing proposal using media-only extraction',async()=>{
  await call('ingest/offers',[offer]);await call('admin/offers/vendor-free/approve',{},'admin');
  const before='2026-07-01T00:00:00Z';
  sqlite.prepare("UPDATE offers SET last_verified_at=?,verify_result='evidence_missing' WHERE id='vendor-free'").run(before);
  await call('ingest/offers',[changedOffer('200 credits')]);
  await call('ingest/offers',[{...offer,evidence:{...evidence,tier:'media'}}]);
  expect((sqlite.prepare("SELECT last_verified_at FROM offers WHERE id='vendor-free'").get() as {last_verified_at:string}).last_verified_at).toBe(before);
  expect((sqlite.prepare("SELECT count(*) n FROM offer_proposals WHERE offer_id='vendor-free'").get() as {n:number}).n).toBe(1);
});

it('rejects stale review cards and does not report competing approvals as both successful',async()=>{
  await call('ingest/offers',[offer]);
  const q=await call('admin/queue',undefined,'admin');
  const shown=(q.body.pending as {reviewVersion:string}[])[0].reviewVersion;
  sqlite.prepare("UPDATE offers SET updated_at='2030-01-01T00:00:00Z',value_text='changed' WHERE id='vendor-free'").run();
  expect((await call('admin/offers/vendor-free/approve',{expectedReviewVersion:shown},'admin')).status).toBe(409);
  const competing=await Promise.all(['approve','reject'].map(action=>call(`admin/offers/vendor-free/${action}`,{},'admin')));
  expect(competing.map(r=>r.status).sort()).toEqual([200,409]);
});

it('accepting and rejecting the same proposal cannot both succeed',async()=>{
  await call('ingest/offers',[offer]);await call('admin/offers/vendor-free/approve',{},'admin');
  await call('ingest/offers',[changedOffer('200 credits')]);
  const actions=await Promise.all(['approve','reject'].map(action=>call(`admin/offers/vendor-free/${action}`,{},'admin')));
  expect(actions.map(r=>r.status).sort()).toEqual([200,409]);
});

it('reports the latest incomplete collect rather than masking it with an older success',async()=>{
  const insert=sqlite.prepare("INSERT INTO runs(kind,started_at,finished_at,ok,stats) VALUES ('collect',?,?,?,?)");
  insert.run('2026-10-07T00:00:00Z','2026-10-07T00:10:00Z',1,'{}');
  insert.run('2026-10-08T00:00:00Z','2026-10-08T00:10:00Z',1,JSON.stringify({errors:['vendor: 复核失败']}));
  const health=await call('admin/health',undefined,'admin');
  expect(health.body.coverageDegraded).toBe(true);
});

it('lets pending extraction improve fields while preserving fields explicitly edited by a reviewer',async()=>{
  await call('ingest/offers',[{...offer,title:'粗略标题',audience:'unclear',claimMethod:'auto',steps:[],evidence:{...evidence,tier:'media'}}]);
  const next={...offer,title:'完整的官方标题',audience:'all',claimMethod:'signup',steps:['注册领取'],creditValidity:'30 天'};
  await call('ingest/offers',[next]);
  const detail=await call('admin/offers/vendor-free',undefined,'admin');
  expect(detail.body.offer).toMatchObject({title:next.title,audience:'all',claimMethod:'signup',steps:['注册领取'],creditValidity:'30 天',evidenceTier:'docs',reviewState:'pending'});
  await call('admin/offers/vendor-free/edit',{fields:{title:'管理员确认标题'}},'admin');
  await call('ingest/offers',[{...next,title:'模型换个说法'}]);
  expect((await call('admin/offers/vendor-free',undefined,'admin')).body.offer).toMatchObject({title:'管理员确认标题'});
});

it('applies official evidence and missing steps to pending offers even if core terms are unchanged',async()=>{
  await call('ingest/offers',[{...offer,evidence:{...evidence,tier:'media'}}]);
  await call('ingest/offers',[{...offer,steps:['注册后领取'],creditValidity:'30 天'}]);
  expect((await call('admin/offers/vendor-free',undefined,'admin')).body.offer).toMatchObject({evidenceTier:'docs',steps:['注册后领取'],creditValidity:'30 天'});
});

describe('automatic official review queue',()=>{
  it('leases jobs once, permits protected draft updates, and never auto-approves the result',async()=>{
    await call('ingest/offers',[{...offer,evidence:{...evidence,tier:'media'}}]);
    expect(((await call('ingest/official-reviews/queue')).body.jobs as unknown[])).toHaveLength(1);
    const first=await call('ingest/official-reviews/vendor-free/claim',{});
    expect(first.body.claimed).toBe(true);
    expect((await call('ingest/official-reviews/vendor-free/claim',{})).body.claimed).toBe(false);
    sqlite.prepare("UPDATE sources SET auto_publish=1 WHERE id='source'").run();
    const changed=await call('ingest/offers',[{...offer,officialReviewJobId:first.body.jobId}]);
    expect((changed.body.results as {reviewState:string}[])[0].reviewState).toBe('pending');
    const end=await call('ingest/official-reviews/vendor-free/result',{jobId:first.body.jobId,status:'matched',reason:'官方正文匹配',queries:['vendor free credits'],candidates:[evidence.url],chosenUrl:evidence.url,changedFields:['evidence']});
    expect(end.body.status).toBe('matched');
    expect(((await call('ingest/official-reviews/queue')).body.jobs as unknown[])).toHaveLength(0);
    const detail=await call('admin/offers/vendor-free',undefined,'admin');expect((detail.body.offer as any).officialReview.status).toBe('matched');
    await call('admin/offers/vendor-free/approve',{},'admin');
    expect(JSON.stringify((await call('offers?view=all')).body)).not.toContain('vendor free credits');
    expect(JSON.stringify((await call('offers?view=all')).body)).not.toContain('officialReview');
  });
  it('preserves media evidence and schedules retry if no official support was found',async()=>{
    await call('ingest/offers',[{...offer,evidence:{...evidence,tier:'media'}}]);
    const lease=await call('ingest/official-reviews/vendor-free/claim',{});
    const result=await call('ingest/official-reviews/vendor-free/result',{jobId:lease.body.jobId,status:'unresolved',reason:'没有充分证据',queries:['vendor credits'],candidates:[],changedFields:[]});
    expect(result.body.nextAttemptAt).toBeTruthy();
    expect(((await call('ingest/official-reviews/queue')).body.jobs as unknown[])).toHaveLength(0);
    const record=await call('admin/offers/vendor-free',undefined,'admin');expect(record.body.offer).toMatchObject({reviewState:'pending',evidenceTier:'media'});
    expect((await call('admin/offers/vendor-free/official-retry',{},'admin')).status).toBe(200);
    expect(((await call('ingest/official-reviews/queue')).body.jobs as unknown[])).toHaveLength(1);
  });
  it('does not accept a forged or completed official review job id',async()=>{
    await call('ingest/offers',[{...offer,evidence:{...evidence,tier:'media'}}]);
    const r=await call('ingest/offers',[{...offer,officialReviewJobId:'12345678-1234-4234-8234-123456789012'}]);
    expect((r.body.results as any[])[0].error).toContain('失效');
  });
});

it('discards official-review edits if the administrator changed the draft after it was claimed',async()=>{
  await call('ingest/offers',[{...offer,evidence:{...evidence,tier:'media'}}]);
  const lease=await call('ingest/official-reviews/vendor-free/claim',{});
  sqlite.prepare("UPDATE offers SET title='管理员正在修改',updated_at='2030-01-01T00:00:00Z' WHERE id='vendor-free'").run();
  const saved=await call('ingest/offers',[{...offer,officialReviewJobId:lease.body.jobId}]);
  expect((saved.body.results as any[])[0].error).toBeTruthy();
  expect((await call('admin/offers/vendor-free',undefined,'admin')).body.offer).toMatchObject({title:'管理员正在修改',evidenceTier:'media'});
});

it('requeues a corrected media draft even after automatic retries previously stopped',async()=>{
  await call('ingest/offers',[{...offer,evidence:{...evidence,tier:'media'}}]);
  sqlite.prepare("UPDATE offers SET official_review=?,updated_at='2030-01-02T00:00:00Z' WHERE id='vendor-free'").run(JSON.stringify({status:'unresolved',jobId:'old',inputVersion:'old',attempts:5,checkedAt:'2030-01-01T00:00:00Z',nextAttemptAt:null,reason:'old',queries:[],candidates:[]}));
  expect(((await call('ingest/official-reviews/queue')).body.jobs as unknown[])).toHaveLength(1);
});

it('official review of an update improves its proposal while keeping the public approved version unchanged',async()=>{
  await call('ingest/offers',[offer]);await call('admin/offers/vendor-free/approve',{},'admin');
  legacyProposal({...offer,valueText:'200 tokens',evidence:{...evidence,tier:'media',url:'https://community.example/post'}});
  const lease=await call('ingest/official-reviews/vendor-free/claim',{});expect(lease.body.claimed).toBe(true);
  await call('ingest/offers',[{...changedOffer(),officialReviewJobId:lease.body.jobId}]);
  const result=await call('ingest/official-reviews/vendor-free/result',{jobId:lease.body.jobId,status:'matched',reason:'官方匹配',queries:['vendor'],candidates:[evidence.url],chosenUrl:evidence.url,changedFields:['valueText','evidence']});
  expect(result.body.status).toBe('matched');
  expect(((await call('offers?view=all')).body.offers as any[])[0].valueText).toBe(offer.valueText);
  const admin=await call('admin/offers/vendor-free',undefined,'admin');expect(admin.body.pendingUpdate).toBe(true);expect((admin.body.offer as any).evidenceTier).toBe('docs');
});

it('does not let unapproved platforms occupy the official verification queue',async()=>{
  await call('ingest/offers',[{...offer,evidence:{...evidence,tier:'media'}}]);
  sqlite.prepare("UPDATE platforms SET status='pending' WHERE id='vendor'").run();
  expect(((await call('ingest/official-reviews/queue')).body.jobs as unknown[])).toHaveLength(0);
});

it('official review cannot silently discard a pending update when official terms match the old public version',async()=>{
  await call('ingest/offers',[offer]);await call('admin/offers/vendor-free/approve',{},'admin');
  legacyProposal({...offer,valueText:'200 tokens',evidence:{...evidence,tier:'media',url:'https://community.example/post'}});
  const lease=await call('ingest/official-reviews/vendor-free/claim',{});
  const result=await call('ingest/offers',[{...offer,officialReviewJobId:lease.body.jobId}]);
  expect((result.body.results as any[])[0].skipped).toBeTruthy();
  expect((await call('admin/offers/vendor-free',undefined,'admin')).body.pendingUpdate).toBe(true);
});

describe('stuck lead rescue lifecycle',()=>{
  const seed=()=>sqlite.prepare("INSERT INTO leads(id,origin,url,title,status,raw) VALUES(1312,'aihot','https://vendor.example/free','Vendor 额度重置预告','reviewing','原始线索')").run();
  it('automatically queues legacy reviewing leads that have no offer',async()=>{
    seed();const q=await call('ingest/lead-reviews/queue?limit=4');
    expect(q.status).toBe(200);expect(q.body.jobs).toMatchObject([{id:1312}]);
    const jobs=await Promise.all([1,2].map(()=>call('ingest/lead-reviews/1312/claim',{})));
    expect(jobs.filter(r=>r.body.claimed)).toHaveLength(1);
  });
  it('records a timed retry then exposes an actionable manual task instead of losing the lead',async()=>{
    seed();const lease=await call('ingest/lead-reviews/1312/claim',{});
    const result=await call('ingest/lead-reviews/1312/result',{jobId:lease.body.jobId,outcome:'retry',reason:'官方页面暂时不可达',candidates:[],queries:[]});
    expect(result.status).toBe(200);expect(result.body.nextAttemptAt).toBeTruthy();
    expect((await call('ingest/lead-reviews/queue')).body.jobs).toEqual([]);
    const admin=await call('admin/queue',undefined,'admin');
    expect(admin.body.leadTasks).toMatchObject([{id:1312,resolution:{status:'retry'}}]);
  });
  it('ignores stale task results after an administrator ends a lead',async()=>{
    seed();const lease=await call('ingest/lead-reviews/1312/claim',{});
    await call('admin/leads/1312/dismiss',{expectedVersion:((await call('admin/queue',undefined,'admin')).body.leadTasks as any[])[0].reviewVersion,reason:'并非独立发放，管理员核对原文'},'admin');
    const result=await call('ingest/lead-reviews/1312/result',{jobId:lease.body.jobId,outcome:'manual',reason:'旧任务',queries:[],candidates:[]});
    expect(result.status).toBe(409);
    expect((sqlite.prepare('SELECT status FROM leads WHERE id=1312').get() as any).status).toBe('rejected');
  });
  it('offers a versioned link-to-existing action and records an explicit final resolution',async()=>{
    seed();await call('ingest/offers',[offer]);
    const q=await call('admin/queue',undefined,'admin');const task=(q.body.leadTasks as any[])[0];
    const linked=await call('admin/leads/1312/resolve',{expectedVersion:task.reviewVersion,outcome:'linked',offerId:offer.id,reason:'同一次活动的进度回复'},'admin');
    expect(linked.status).toBe(200);
    expect(sqlite.prepare('SELECT status,offer_id FROM leads WHERE id=1312').get()).toMatchObject({status:'linked',offer_id:offer.id});
    expect((await call('admin/queue',undefined,'admin')).body.leadTasks).toEqual([]);
    const history=await call('admin/leads?status=linked',undefined,'admin');
    expect((history.body.leads as any[])[0].resolution.reason).toContain('进度回复');
  });
});

it('leased lead extraction cannot publish automatically or overwrite an existing approved offer',async()=>{
  sqlite.prepare("INSERT INTO leads(id,origin,url,title,status) VALUES(1312,'aihot','https://vendor.example/free','Vendor 免费额度','reviewing')").run();
  const lease=await call('ingest/lead-reviews/1312/claim',{});
  sqlite.prepare('UPDATE sources SET auto_publish=1').run();
  const saved=await call('ingest/offers',[{...offer,leadId:1312,leadReviewJobId:lease.body.jobId}]);
  expect((saved.body.results as any[])[0].reviewState).toBe('pending');
  await call('admin/offers/vendor-free/approve',{},'admin');
  const update=await call('ingest/offers',[{...changedOffer(),sameOccurrenceAs:offer.id,leadId:1312,leadReviewJobId:lease.body.jobId}]);
  expect((update.body.results as any[])[0].linkedExisting).toBe(true);
  expect((sqlite.prepare('SELECT value_text FROM offers').get() as any).value_text).toBe(offer.valueText);
});
it('dismissal during lead processing stops a late new draft insert',async()=>{
  sqlite.prepare("INSERT INTO leads(id,origin,url,title,status) VALUES(1312,'aihot','https://vendor.example/free','Vendor 免费额度','reviewing')").run();
  const lease=await call('ingest/lead-reviews/1312/claim',{});
  await call('admin/leads/1312/dismiss',{expectedVersion:((await call('admin/queue',undefined,'admin')).body.leadTasks as any[])[0].reviewVersion},'admin');
  const result=await call('ingest/offers',[{...offer,leadId:1312,leadReviewJobId:lease.body.jobId}]);
  expect((result.body.results as any[])[0].error).toBeTruthy();
  expect((sqlite.prepare('SELECT count(*) n FROM offers').get() as any).n).toBe(0);
});

it('does not mistake a generated ID collision for a related activity',async()=>{
  await call('ingest/offers',[offer]);await call('admin/offers/vendor-free/approve',{},'admin');
  sqlite.prepare("INSERT INTO leads(id,origin,url,title,status) VALUES(1312,'aihot','https://vendor.example/grant','独立资助','reviewing')").run();
  const lease=await call('ingest/lead-reviews/1312/claim',{});
  const r=await call('ingest/offers',[{...offer,type:'apply',endKind:'standing',claimMethod:'form',title:'开发者独立研究资助',valueText:'最高1000美元',evidence:{...evidence,url:'https://vendor.example/grant'},leadId:1312,leadReviewJobId:lease.body.jobId}]);
  expect((r.body.results as any[])[0].error).toContain('ID');
});
it('rejects a stale manual decision after automatic results arrive and prevents reopening a linked lead',async()=>{
  sqlite.prepare("INSERT INTO leads(id,origin,url,title,status) VALUES(1312,'aihot','https://vendor.example/free','线索','reviewing')").run();
  const lease=await call('ingest/lead-reviews/1312/claim',{});
  const old=((await call('admin/queue',undefined,'admin')).body.leadTasks as any[])[0].reviewVersion;
  await call('ingest/lead-reviews/1312/result',{jobId:lease.body.jobId,outcome:'retry',reason:'新找到的证据需要稍后重试',queries:[],candidates:[]});
  expect((await call('admin/leads/1312/resolve',{expectedVersion:old,outcome:'closed',reason:'旧卡片结论'},'admin')).status).toBe(409);
  const current=((await call('admin/queue',undefined,'admin')).body.leadTasks as any[])[0].reviewVersion;
  await call('ingest/offers',[offer]);await call('admin/leads/1312/resolve',{expectedVersion:current,outcome:'linked',offerId:offer.id,reason:'人工已核对'},'admin');
  expect((await call('admin/leads/1312/retry',{expectedVersion:current},'admin')).status).toBe(409);
});

it('cannot close a lead using an unrelated official page as negative evidence',async()=>{
  sqlite.prepare("INSERT INTO leads(id,origin,url,title,status) VALUES(1312,'aihot','https://vendor.example/original','新线索','reviewing')").run();
  const lease=await call('ingest/lead-reviews/1312/claim',{});
  const r=await call('ingest/lead-reviews/1312/result',{jobId:lease.body.jobId,outcome:'closed',reason:'该页面没有赠额',queries:[],candidates:[],evidenceUrl:'https://vendor.example/other',quote:'No bonus is offered on this unrelated page.',sourceText:'No bonus is offered on this unrelated page.'});
  expect(r.status).toBe(400);
});


describe('cross-page recurring plan identity',()=>{
 const canonical={...offer,id:'vendor-tokenplan-original',title:'Vendor TokenPlan 公测免费：每5小时6万积分',type:'standing',claimMethod:'signup',requirements:['none'],audience:'all',modalities:['text','image'],models:['Model Flash Lite','Model Image'],valueText:'通用积分池与专属池各滚动5小时6万积分，每周60万积分',claimStart:'2026-08-28',endKind:'standing',tags:[],evidence:{...evidence,url:'https://vendor.example/docs'}};
 const alias={...canonical,id:'completely-new-plan-id',title:'Vendor 免费公测积分',valueText:'Free公测档60,000积分 / 5小时',claimStart:null,evidence:{...canonical.evidence,url:'https://vendor.example/token-plan'}};
 it('replaying a new ID preserves the approved row without a proposal',async()=>{
  await call('ingest/offers',[canonical]);await call('admin/offers/'+canonical.id+'/approve',{},'admin');
  const before=sqlite.prepare('SELECT * FROM offers WHERE id=?').get(canonical.id);
  for(let i=0;i<2;i++){
   const r=await call('ingest/offers',[{...alias,id:'replay-'+i}]);
   expect(r.status).toBe(200);expect(r.body.results[0]).toMatchObject({id:canonical.id,unchanged:true});
  }
  expect(sqlite.prepare('SELECT * FROM offers WHERE id=?').get(canonical.id)).toEqual(before);
  expect(sqlite.prepare('SELECT count(*) n FROM offers').get()).toMatchObject({n:1});
  expect(sqlite.prepare('SELECT count(*) n FROM offer_proposals').get()).toMatchObject({n:0});
 });
 it('official recheck of an old community lead links the approved canonical instead of creating a draft',async()=>{
  await call('ingest/offers',[canonical]);await call('admin/offers/'+canonical.id+'/approve',{},'admin');
  const before=sqlite.prepare('SELECT * FROM offers WHERE id=?').get(canonical.id);
  sqlite.prepare("INSERT INTO leads(id,origin,url,title,status) VALUES(546,'v2ex','https://community.example/original','Vendor 免费公测积分','reviewing')").run();
  const lease=await call('ingest/lead-reviews/546/claim',{});
  const r=await call('ingest/offers',[{...alias,leadId:546,leadReviewJobId:lease.body.jobId}]);
  expect(r.body.results[0]).toMatchObject({id:canonical.id,linkedExisting:true,reviewState:'approved'});
  expect(sqlite.prepare('SELECT * FROM offers WHERE id=?').get(canonical.id)).toEqual(before);
  const linked=await call('ingest/lead-reviews/546/result',{jobId:lease.body.jobId,outcome:'linked',reason:'同一TokenPlan免费档',offerIds:[canonical.id],queries:[],candidates:[alias.evidence.url]});
  expect(linked.status).toBe(200);expect(sqlite.prepare('SELECT offer_id,status FROM leads WHERE id=546').get()).toMatchObject({offer_id:canonical.id,status:'linked'});
  expect(sqlite.prepare('SELECT count(*) n FROM offers').get()).toMatchObject({n:1});
 });
 it('same-batch aliases reuse the draft, while a watermark feature remains separate',async()=>{
  const watermark={...canonical,id:'vendor-watermark',title:'无水印图片生成限时免费',type:'free',claimStart:null,endKind:'unknown',claimMethod:'auto',valueText:'无水印生成当前免费公测',modalities:['image'],models:['Model Image']};
  const r=await call('ingest/offers',[canonical,alias,watermark]);expect(r.status).toBe(200);
  expect(sqlite.prepare('SELECT count(*) n FROM offers').get()).toMatchObject({n:2});
  expect(sqlite.prepare('SELECT id FROM offers WHERE id=?').get(alias.id)).toBeUndefined();
  expect(sqlite.prepare('SELECT id FROM offers WHERE id=?').get(watermark.id)).toBeDefined();
 });
});


describe('repeated failed evidence checks are idempotent',()=>{
 it('does not advance reviewVersion for repeated missing quotes or outside-host redirects',async()=>{
  await call('ingest/offers',[offer]);await call('admin/offers/'+offer.id+'/approve',{},'admin');
  const probe={trustedDirect:true,offerId:offer.id,url:evidence.url,text:'Unrelated navigation only.'};
  expect((await call('ingest/verify',probe)).body.verified).toBe(false);
  const before=sqlite.prepare('SELECT * FROM offers WHERE id=?').get(offer.id);
  for(const next of [probe,{...probe,finalUrl:'https://unrelated.example/login'},probe]){expect((await call('ingest/verify',next)).body).toMatchObject({verified:false,unchanged:true});}
  expect(sqlite.prepare('SELECT * FROM offers WHERE id=?').get(offer.id)).toEqual(before);
  const recovered=await call('ingest/verify',{...probe,text:Object.values(evidence.excerpts).join(' ')});expect(recovered.body.verified).toBe(true);
 });
});


it('links a model-extension status alias during old lead recheck without creating another review',async()=>{
 sqlite.prepare("UPDATE platforms SET x_handles='[\"@vendor\"]' WHERE id='vendor'").run();
 const original={...offer,id:'model-extension',type:'free',claimMethod:'auto',models:['Space Bunny'],title:'Vendor Space Bunny 模型免费期延长数日',valueText:'免费期延长数日',evidence:{...evidence,tier:'official',url:'https://x.com/vendor/status/2107398361733104102'}};
 await call('ingest/offers',[original]);const approval=await call('admin/offers/'+original.id+'/approve',{},'admin');expect(approval.body.error).toBeUndefined();expect(approval.status).toBe(200);
 const before=sqlite.prepare('SELECT * FROM offers WHERE id=?').get(original.id);
 sqlite.prepare("INSERT INTO leads(id,origin,url,title,status) VALUES(99,'v2ex','https://community.example/post','Vendor Space Bunny免费期延长','reviewing')").run();
 const lease=await call('ingest/lead-reviews/99/claim',{});
 const r=await call('ingest/offers',[{...original,id:'another-extension-key',claimMethod:'signup',title:'Space Bunny 免费期延长',valueText:'免费tier开放，未写具体天数',leadId:99,leadReviewJobId:lease.body.jobId}]);
 expect(r.body.results[0]).toMatchObject({id:original.id,linkedExisting:true,reviewState:'approved'});
 expect(sqlite.prepare('SELECT * FROM offers WHERE id=?').get(original.id)).toEqual(before);
 expect(sqlite.prepare('SELECT count(*) n FROM offers').get()).toMatchObject({n:1});
});

it('rejects unrelated student offers from an unadmitted reseller lead before insertion',async()=>{
 sqlite.prepare("UPDATE platforms SET name='Vendor AI',site='https://vendor.example' WHERE id='vendor'").run();
 sqlite.prepare("INSERT INTO leads(id,origin,url,title,raw,status) VALUES(2321,'linuxdo','https://community.example/pool','PQH AI 号池促销','账号池充值送额度 https://pqh.example','reviewing')").run();
 const lease=await call('ingest/lead-reviews/2321/claim',{});
 const r=await call('ingest/offers',[{...offer,id:'vendor-student',title:'Vendor Pro 学生优惠',type:'topup',claimMethod:'member',requirements:['student'],leadId:2321,leadReviewJobId:lease.body.jobId}]);
 expect((r.body.results as any[])[0].error).toMatch(/线索|平台|活动/);
 expect((sqlite.prepare('SELECT count(*) n FROM offers').get() as any).n).toBe(0);
});

const studentQuote='Verified students can get Vendor Pro for $5.99 / month (normally $14.99).';
const studentTerms='Valid for a maximum of 12 months for verified students at accredited higher institutions who have never subscribed before.';
const canonicalStudent={...offer,id:'vendor-student-main',title:'Vendor Pro 学生价 $5.99/月（原价 $14.99，最多12个月）',valueText:'认证学生优惠每月5.99美元，最多12个月，每月省9美元',type:'topup',claimMethod:'member',requirements:['student','pay:5.99'],evidence:{...evidence,pageHash:'a'.repeat(64),excerpts:{benefit:studentQuote,eligibility:studentTerms}}};
const studentReplay={...canonicalStudent,id:'student-alias',title:'认证学生四折订阅',valueText:'订阅优惠最多一年',requirements:['student'],models:['New model'],evidence:{...canonicalStudent.evidence,excerpts:{benefit:studentTerms,eligibility:studentQuote}}};
it('preserves the approved student baseline without creating proposals through cross-ID replays',async()=>{
 await call('ingest/offers',[canonicalStudent]);await call('admin/offers/'+canonicalStudent.id+'/approve',{},'admin');
 const before=sqlite.prepare('SELECT * FROM offers WHERE id=?').get(canonicalStudent.id);
 for(const change of [{},{title:'学生认证专属权益',requirements:['student','card']},{models:[],evidence:{...studentReplay.evidence,pageHash:'b'.repeat(64)}}]){
  const r=await call('ingest/offers',[{...studentReplay,...change}]);
  expect(r.body.results[0]).toMatchObject({id:canonicalStudent.id,unchanged:true});
 }
 expect(sqlite.prepare('SELECT * FROM offers WHERE id=?').get(canonicalStudent.id)).toEqual(before);
 expect(sqlite.prepare('SELECT count(*) n FROM offers').get()).toMatchObject({n:1});
 expect(sqlite.prepare('SELECT count(*) n FROM offer_proposals').get()).toMatchObject({n:0});
});
it('remembers rejected source claims and allows a separate same-page benefit',async()=>{
 await call('ingest/offers',[canonicalStudent]);await call('admin/offers/'+canonicalStudent.id+'/reject',{reasonCode:'duplicate',reason:'已审核同一权益'},'admin');
 const replay=await call('ingest/offers',[studentReplay]);expect(replay.body.results[0].duplicateId).toBe(canonicalStudent.id);
 const separate={...offer,id:'different-api-grant',title:'科研API资助',valueText:'研究机构可申请50000token',type:'apply',claimMethod:'form',endKind:'standing',requirements:['biz'],evidence:{...canonicalStudent.evidence,excerpts:{benefit:'Research teams can apply for 50,000 API tokens for an approved project.',eligibility:'An accredited research institution must submit a project proposal.'}}};
 const saved=await call('ingest/offers',[separate]);expect(saved.body.results[0]).toMatchObject({id:separate.id,reviewState:'pending'});
 expect(sqlite.prepare('SELECT count(*) n FROM offers').get()).toMatchObject({n:2});
});
it('blocks scope bypass through ordinary ingestion and both automatic link endpoints',async()=>{
 await call('ingest/offers',[canonicalStudent]);
 sqlite.prepare("INSERT INTO leads(id,origin,url,title,status) VALUES(2322,'linuxdo','https://community.example/unrelated','Vendor API 新模型发布','new')").run();
 const insert=await call('ingest/offers',[{...studentReplay,leadId:2322}]);expect(insert.body.results[0].error).toBeTruthy();
 const link=await call('ingest/leads/2322/status',{status:'linked',offerId:canonicalStudent.id});expect(link.status).toBe(400);
 sqlite.prepare("UPDATE leads SET status='reviewing' WHERE id=2322").run();
 const lease=await call('ingest/lead-reviews/2322/claim',{});
 const result=await call('ingest/lead-reviews/2322/result',{jobId:lease.body.jobId,outcome:'linked',reason:'模型声称已收录',offerIds:[canonicalStudent.id],queries:[],candidates:[]});expect(result.status).toBe(400);
 expect(sqlite.prepare('SELECT status FROM leads WHERE id=2322').get()).toMatchObject({status:'reviewing'});
 expect(sqlite.prepare('SELECT count(*) n FROM offers').get()).toMatchObject({n:1});
});


// phase1 regression: actual Worker routes against the migration-backed SQLite harness.
const phase1Offer = () => ({
  id: 'vendor-phase1-quota', platformId: 'vendor', sourceId: 'source',
  title: '常驻免费积分', type: 'standing', modalities: ['text'], models: [], tags: [],
  claimMethod: 'signup', requirements: ['none'], audience: 'all',
  valueText: '每天 100 积分', usdEstimate: null, usdMax: null,
  claimStart: null, claimEnd: null, endKind: 'standing', creditValidity: null,
  sourceTz: 'UTC', publishedAt: null, steps: [],
  evidence: { url: 'https://vendor.example/free', tier: 'docs', capturedAt: '2026-10-10T00:00:00Z',
    excerpts: { benefit: '100 credits every day.', eligibility: 'All users.', validity: 'No published end date.' } },
});
async function phase1Approved() {
  const o = phase1Offer();
  expect((await call('ingest/offers', [o])).status).toBe(200);
  expect((await call(`admin/offers/${o.id}/approve`, {}, 'admin')).status).toBe(200);
  return o;
}
async function phase1Proposal() {
  const o = await phase1Approved();
  const next = { ...o, valueText: '每天 200 积分', evidence: { ...o.evidence,
    excerpts: { ...o.evidence.excerpts, benefit: '200 credits every day.' } } };
  const result = await call('ingest/offers', [{ ...next, sourceText: Object.values(next.evidence.excerpts).join(' ') }]);
  expect((result.body.results as any[])[0].reviewState).toBe('pending_update');
  return o;
}
const phase1Count = (table: string) => Number((sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as any).n);

describe('phase1 reviewed benefit facts', () => {
  it.each([false, true])('proposes a same-number cadence change (administrator-edited baseline: %s)', async edited => {
    const o = await phase1Approved();
    if (edited) expect((await call(`admin/offers/${o.id}/edit`, { fields: { valueText: '每天 100 积分（已核对）' } }, 'admin')).status).toBe(200);
    const previous = sqlite.prepare('SELECT value_text FROM offers WHERE id=?').get(o.id) as any;
    const next = { ...o, valueText: '每月 100 积分', evidence: { ...o.evidence,
      excerpts: { ...o.evidence.excerpts, benefit: '100 credits every month.' } } };
    const result = await call('ingest/offers', [{ ...next, sourceText: Object.values(next.evidence.excerpts).join(' ') }]);
    expect((result.body.results as any[])[0].reviewState).toBe('pending_update');
    const proposal = sqlite.prepare('SELECT candidate,diff FROM offer_proposals WHERE offer_id=?').get(o.id) as any;
    expect(JSON.parse(proposal.candidate).valueText).toBe('每月 100 积分');
    expect(JSON.parse(proposal.diff)).toContainEqual({ field: 'valueText', from: previous.value_text, to: '每月 100 积分' });
    expect(sqlite.prepare('SELECT value_text,review_state FROM offers WHERE id=?').get(o.id))
      .toMatchObject({ value_text: previous.value_text, review_state: 'approved' });
  });

  it('does not reopen a mere rewrite with unchanged official source terms', async () => {
    const o = await phase1Approved();
    const result = await call('ingest/offers', [{ ...o, valueText: '每日赠予一百个积分', sourceText: Object.values(o.evidence.excerpts).join(' ') }]);
    expect((result.body.results as any[])[0].unchanged).toBe(true);
    expect(phase1Count('offer_proposals')).toBe(0);
  });

  it('keeps an actively edited manual proposal despite a later official benefit change', async () => {
    const o = await phase1Proposal();
    const manual = '管理员正在核对的新额度';
    expect((await call(`admin/offers/${o.id}/edit`, { fields: { valueText: manual } }, 'admin')).status).toBe(200);
    const next = { ...o, valueText: '每月 300 积分', evidence: { ...o.evidence,
      excerpts: { ...o.evidence.excerpts, benefit: '300 credits every month.' } } };
    await call('ingest/offers', [{ ...next, sourceText: Object.values(next.evidence.excerpts).join(' ') }]);
    const proposal = sqlite.prepare('SELECT candidate FROM offer_proposals WHERE offer_id=?').get(o.id) as any;
    expect(JSON.parse(proposal.candidate).valueText).toBe(manual);
  });
});

describe('phase1 rejection transaction', () => {
  it('does not remove a proposal after its approved baseline changes before rejection', async () => {
    const o = await phase1Proposal();
    beforeStatement = sql => {
      if (!/INSERT INTO rejected_offer_updates/i.test(sql)) return;
      beforeStatement = undefined;
      sqlite.prepare('UPDATE offers SET updated_at=? WHERE id=?').run('2031-01-01T00:00:00Z', o.id);
    };
    const result = await call(`admin/offers/${o.id}/reject`, { reason: '不要此更新' }, 'admin');
    expect(result.status).toBe(409);
    expect(phase1Count('offer_proposals')).toBe(1);
    expect(phase1Count('rejected_offer_updates')).toBe(0);
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM reviews WHERE action='reject'").get()).toMatchObject({ n: 0 });
  });

  it('does not reject a replacement proposal with a newer version', async () => {
    const o = await phase1Proposal();
    beforeStatement = sql => {
      if (!/INSERT INTO rejected_offer_updates/i.test(sql)) return;
      beforeStatement = undefined;
      sqlite.prepare('UPDATE offer_proposals SET updated_at=? WHERE offer_id=?').run('2031-01-01T00:00:00Z', o.id);
    };
    expect((await call(`admin/offers/${o.id}/reject`, {}, 'admin')).status).toBe(409);
    expect(phase1Count('offer_proposals')).toBe(1);
    expect(phase1Count('rejected_offer_updates')).toBe(0);
  });

  it('rolls back rejection memory and deletion when audit insertion fails', async () => {
    const o = await phase1Proposal();
    sqlite.exec("CREATE TRIGGER phase1_fail_audit BEFORE INSERT ON reviews WHEN NEW.action='reject' BEGIN SELECT RAISE(ABORT, 'phase1 audit unavailable'); END;");
    expect((await call(`admin/offers/${o.id}/reject`, {}, 'admin')).status).toBe(500);
    expect(phase1Count('offer_proposals')).toBe(1);
    expect(phase1Count('rejected_offer_updates')).toBe(0);
  });

  it('records one rejection and one audit, removes only the proposal, and preserves the approved offer', async () => {
    const o = await phase1Proposal();
    expect((await call(`admin/offers/${o.id}/reject`, { reason: '已核对，拒绝这个版本', reasonCode: 'wrong_field' }, 'admin')).status).toBe(200);
    expect(phase1Count('offer_proposals')).toBe(0);
    expect(phase1Count('rejected_offer_updates')).toBe(1);
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM reviews WHERE action='reject'").get()).toMatchObject({ n: 1 });
    expect(sqlite.prepare('SELECT review_state,value_text FROM offers WHERE id=?').get(o.id)).toMatchObject({ review_state: 'approved', value_text: o.valueText });
    expect((await call(`admin/offers/${o.id}/reject`, {}, 'admin')).status).toBe(409);
    expect(phase1Count('rejected_offer_updates')).toBe(1);
  });
});
