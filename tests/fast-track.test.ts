import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {makeSemanticReview} from '../src/shared/fast-track-semantics';
import worker from '../src/worker/index';
import { identityDb } from './fixtures/identity/db';
import { mergeFastTrackFields, missingBasicFields, fastTrackHeld } from '../src/worker/fast-track';
import { fastTrackFields, similarity } from '../pipeline/fast-track';

let f: ReturnType<typeof identityDb>;
beforeEach(() => { f = identityDb(); });
afterEach(() => f.sqlite.close());

const env = () => ({ DB: f.db, ADMIN_TOKEN: 'fast-admin-token-0001', INGEST_TOKEN: 'fast-ingest-token-0001', REVIEWER_TOKENS: 'rev:fast-reviewer-token-01', IDENTITY_MODE: 'enforce', IDENTITY_CANARY_PLATFORMS: '*' }) as any;
async function call(path: string, body?: unknown, token = 'fast-admin-token-0001') {
  const r = await worker.fetch(new Request('https://local.test/api/' + path, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }), env(), {} as any);
  return { status: r.status, body: await r.json() as any };
}
const ingest = (path: string, body?: any) => {
 if(path.endsWith('/result')&&body?.fields&&!body.error&&!body.semanticReview){
  const job=f.sqlite.prepare('SELECT * FROM fast_track_jobs WHERE id=?').get(path.split('/')[1]) as any;
  const fields=mergeFastTrackFields({...body.fields,audience:body.fields.audience??'all'},JSON.parse(job.owner_fields_json),job.benefit,'Odyssey');
  if(fields.type&&Array.isArray(fields.modalities)&&fields.audience){
   const context={platformId:job.platform_id,url:job.url,benefit:job.benefit,sourceText:body.sourceText??''};
   const quote=body.sourceText||job.benefit;
   const facts={type:{value:fields.type,quote},modalities:fields.modalities.map((value:string)=>({value,quote})),audience:{value:fields.audience,quote:fields.audience==='all'?'':job.benefit}} as any;
   const reviewed=makeSemanticReview(fields,facts,context,'fixture-review');
   body={...body,fields:{...body.fields,audience:fields.audience},semanticReview:reviewed.review};
  }
 }
 return call('ingest/'+path,body,'fast-ingest-token-0001');
};
/** Publishing spans several requests under the per-request query budget, as the pipeline drives it. */
async function settle(id: string, first: { status: number; body: any }) {
  let r = first, requests = 1;
  while (r.body.state === 'publishing') { r = await ingest(`fast-track/${id}/advance`, {}); requests++; expect(requests).toBeLessThan(10); }
  return r;
}
const page = 'Odyssey-3 public research preview is now open. Anyone can try Odyssey-3 for free in the browser during the preview.';
const extracted = { title: 'Odyssey-3 公开研究预览免费试用', type: 'free', modalities: ['video'], claimMethod: 'signup', requirements: ['none'], audience: 'all', valueText: '免费试用', endKind: 'unknown', sourceTz: 'UTC', steps: ['打开官网试用'], excerpts: { benefit: 'Anyone can try Odyssey-3 for free in the browser during the preview.' } };

it('a new vendor plus an official URL goes live once the free model fills the basic fields', async () => {
  f.sqlite.exec("INSERT INTO leads(id,origin,url,status,title) VALUES(6260,'aihot','https://aihot.example/odyssey','reviewing','Odyssey-3 公开研究预览')");
  const created = await call('admin/fast-track', { newPlatform: { name: 'Odyssey' }, url: 'https://odyssey.world/introducing-odyssey-3', benefit: 'Odyssey-3 公开研究预览，可免费试用', leadId: 6260 });
  expect(created.status).toBe(200);
  expect(created.body).toMatchObject({ platformId: 'odyssey', registered: { kind: 'existing' } });
  expect(f.sqlite.prepare("SELECT status,site FROM platforms WHERE id='odyssey'").get()).toEqual({ status: 'approved', site: 'https://odyssey.world' });

  const queue = await ingest('fast-track/queue');
  expect(queue.body.jobs).toEqual([{ id: created.body.jobId, publishing: false }]);
  const claim = await ingest(`fast-track/${created.body.jobId}/claim`, {});
  expect(claim.body.job).toMatchObject({ platformId: 'odyssey', platformName: 'Odyssey', url: 'https://odyssey.world/introducing-odyssey-3' });
  expect((await ingest(`fast-track/${created.body.jobId}/claim`, {})).status).toBe(409);

  const result = await settle(created.body.jobId, await ingest(`fast-track/${created.body.jobId}/result`, { fields: extracted, sourceText: page, model: 'free' }));
  expect(result.body).toMatchObject({ state: 'published' });
  const offer = f.sqlite.prepare('SELECT review_state,value_text,fast_tracked_at FROM offers WHERE id=?').get(result.body.offerId) as any;
  expect(offer).toMatchObject({ review_state: 'approved', value_text: 'Odyssey-3 公开研究预览，可免费试用' });
  expect(offer.fast_tracked_at).toBeTruthy();
  expect(f.sqlite.prepare('SELECT status,offer_id FROM leads WHERE id=6260').get()).toEqual({ status: 'linked', offer_id: result.body.offerId });
  expect((await call('admin/fast-track')).body.jobs[0]).toMatchObject({ state: 'published', offerId: result.body.offerId });
});

it('missing basic fields wait for the owner, who completes them and publishes immediately', async () => {
  const created = await call('admin/fast-track', { platformId: 'vendor', url: 'https://vendor.example/rewards', benefit: '注册即送 10 美元额度', basis: 'tested' });
  await ingest(`fast-track/${created.body.jobId}/claim`, {});
  f.sqlite.prepare('UPDATE fast_track_jobs SET attempts=3 WHERE id=?').run(created.body.jobId);
  const partial = await ingest(`fast-track/${created.body.jobId}/result`, { fields: { title: '注册赠额', type: 'new', modalities: ['text'], requirements: ['unknown'] }, sourceText: page });
  expect(partial.body).toMatchObject({ state: 'needs_owner' });
  expect(partial.body.missing).toEqual(expect.arrayContaining(['claimMethod', 'requirements', 'endKind']));
  const done = await settle(created.body.jobId, await call(`admin/fast-track/${created.body.jobId}/complete`, { fields: { claimMethod: 'signup', requirements: ['none'], endKind: 'unknown' } }));
  expect(done.body).toMatchObject({ state: 'published' });
  expect(f.sqlite.prepare('SELECT review_state FROM offers WHERE id=?').get(done.body.offerId)).toEqual({ review_state: 'approved' });
});

const catalog = { products: [{ id: 'odyssey', name: 'Odyssey', aliases: [], status: 'verified', sourceUrl: 'https://odyssey.world/pricing', verifiedAt: '2026-10-01T00:00:00.000Z', revision: 1 }],
  plans: [{ id: 'odyssey-pro', productId: 'odyssey', name: 'Pro', aliases: [], status: 'verified', sourceUrl: 'https://odyssey.world/pricing', verifiedAt: '2026-10-01T00:00:00.000Z', revision: 1, billing: 'paid' }] };
const proMembership = (revision: number) => ({ schemaVersion: 'membership-v1', status: 'confirmed', catalogRevision: revision, anyOf: [{ allOf: [{ productId: 'odyssey', scope: 'plans', planIds: ['odyssey-pro'], excludePlanIds: [] }] }], evidenceUrls: ['https://odyssey.world/introducing-odyssey-3'] });
const memberPerk = { ...extracted, type: 'perk', claimMethod: 'member', requirements: ['member', 'net'] };

it('a member perk waits for the owner\'s catalog membership, then publishes with it confirmed (2026-10-17 Higgsfield Wan 3.0)', async () => {
  const created = await call('admin/fast-track', { newPlatform: { name: 'Odyssey' }, url: 'https://odyssey.world/introducing-odyssey-3', benefit: 'Odyssey-3 Pro 会员 7 天无限使用' });
  f.sqlite.prepare('UPDATE membership_catalog SET revision=1, data_json=? WHERE id=1').run(JSON.stringify(catalog));
  await ingest(`fast-track/${created.body.jobId}/claim`, {});
  f.sqlite.prepare('UPDATE fast_track_jobs SET attempts=3 WHERE id=?').run(created.body.jobId);
  // A bare `member` used to fail the listing schema with nothing for the owner to fill.
  const waiting = await ingest(`fast-track/${created.body.jobId}/result`, { fields: memberPerk, sourceText: page, model: 'free' });
  expect(waiting.body).toMatchObject({ state: 'needs_owner', missing: ['membershipRequirement'] });
  expect(f.sqlite.prepare('SELECT count(*) n FROM offers').get()).toEqual({ n: 0 });
  expect((await call('admin/fast-track')).body.jobs[0].requirements).toEqual(['member:Odyssey 付费订阅', 'net']);
  const done = await settle(created.body.jobId, await call(`admin/fast-track/${created.body.jobId}/complete`, { fields: { membershipRequirement: proMembership(1) } }));
  expect(done.body).toMatchObject({ state: 'published' });
  const offer = f.sqlite.prepare('SELECT review_state,requirements,membership_requirement FROM offers WHERE id=?').get(done.body.offerId) as any;
  expect(offer.review_state).toBe('approved');
  expect(JSON.parse(offer.requirements)).toEqual(['net', 'member:Odyssey Pro']);
  expect(JSON.parse(offer.membership_requirement)).toMatchObject({ status: 'confirmed', anyOf: [{ allOf: [{ planIds: ['odyssey-pro'] }] }] });
});

it('a membership picked on the fast-track form publishes in one go', async () => {
  f.sqlite.prepare('UPDATE membership_catalog SET revision=1, data_json=? WHERE id=1').run(JSON.stringify(catalog));
  const created = await call('admin/fast-track', { newPlatform: { name: 'Odyssey' }, url: 'https://odyssey.world/introducing-odyssey-3', benefit: 'Odyssey-3 Pro 会员 7 天无限使用', membershipRequirement: proMembership(1) });
  expect(created.status).toBe(200);
  await ingest(`fast-track/${created.body.jobId}/claim`, {});
  const done = await settle(created.body.jobId, await ingest(`fast-track/${created.body.jobId}/result`, { fields: memberPerk, sourceText: page, model: 'free' }));
  expect(done.body).toMatchObject({ state: 'published' });
  expect(JSON.parse((f.sqlite.prepare('SELECT requirements FROM offers WHERE id=?').get(done.body.offerId) as any).requirements)).toEqual(['net', 'member:Odyssey Pro']);
});

it('a stale catalog choice hands the job back with the server reason, and a corrected choice resumes without a second draft', async () => {
  f.sqlite.prepare('UPDATE membership_catalog SET revision=2, data_json=? WHERE id=1').run(JSON.stringify(catalog));
  const created = await call('admin/fast-track', { newPlatform: { name: 'Odyssey' }, url: 'https://odyssey.world/introducing-odyssey-3', benefit: 'Odyssey-3 Pro 会员 7 天无限使用', membershipRequirement: proMembership(1) });
  await ingest(`fast-track/${created.body.jobId}/claim`, {});
  f.sqlite.prepare('UPDATE fast_track_jobs SET attempts=3 WHERE id=?').run(created.body.jobId);
  const stale = await settle(created.body.jobId, await ingest(`fast-track/${created.body.jobId}/result`, { fields: memberPerk, sourceText: page, model: 'free' }));
  expect(stale.body.state).toBe('needs_owner');
  expect(stale.body.error).toContain('会员目录');
  const done = await settle(created.body.jobId, await call(`admin/fast-track/${created.body.jobId}/complete`, { fields: { membershipRequirement: proMembership(2) } }));
  expect(done.body).toMatchObject({ state: 'published' });
  expect(f.sqlite.prepare('SELECT count(*) n FROM offers').get()).toEqual({ n: 1 });
});

it('requirements the schema cannot accept become a field the owner fills, not a dead-end error', () => {
  expect(mergeFastTrackFields({ requirements: ['member', 'pay', 'NET'] }, {}, 'x', 'Higgsfield').requirements).toEqual(['member:Higgsfield 付费订阅', 'pay:金额未写明', 'net']);
  expect(mergeFastTrackFields({ requirements: ['member:Higgsfield Pro 及以上套餐', 'net'] }, {}, 'x', 'Higgsfield').requirements).toEqual(['member:Higgsfield Pro 及以上套餐', 'net']);
  const odd = mergeFastTrackFields({ requirements: ['subscription'] }, {}, 'x', 'Higgsfield');
  expect(odd.requirements).toEqual(['unknown']);
  expect(missingBasicFields(odd)).toContain('requirements');
  expect(mergeFastTrackFields({}, {}, 'x', 'Higgsfield').requirements).toBeUndefined();
});

it('a second benefit for a vendor with a live offer passes the identity task as a new activity', async () => {
  const publish = async (benefit: string, fields: Record<string, unknown>) => {
    const created = await call('admin/fast-track', { platformId: 'vendor', url: 'https://vendor.example/rewards', benefit });
    await ingest(`fast-track/${created.body.jobId}/claim`, {});
    return settle(created.body.jobId, await ingest(`fast-track/${created.body.jobId}/result`, { fields, sourceText: page }));
  };
  const first = await publish('注册即送 10 美元额度', { ...extracted, title: '注册赠额', type: 'new', modalities: ['text'] });
  const second = await publish('每日签到送 100 积分', { ...extracted, title: '每日签到积分', type: 'standing', modalities: ['text'], endKind: 'standing' });
  expect([first.body.state, second.body.state]).toEqual(['published', 'published']);
  expect(second.body.offerId).not.toBe(first.body.offerId);
  expect(f.sqlite.prepare("SELECT count(*) n FROM offers WHERE platform_id='vendor' AND review_state='approved'").get()).toEqual({ n: 2 });
});

it('model failures retry, then hand the job to the owner after three attempts', async () => {
  const created = await call('admin/fast-track', { platformId: 'vendor', url: 'https://vendor.example/rewards', benefit: '注册即送 10 美元额度' });
  for (const expected of ['queued', 'queued', 'needs_owner']) {
    await ingest(`fast-track/${created.body.jobId}/claim`, {});
    expect((await ingest(`fast-track/${created.body.jobId}/result`, { error: '免费模型暂不可用' })).body.state).toBe(expected);
  }
  expect((await ingest('fast-track/queue')).body.jobs).toEqual([]);
  expect((await call(`admin/fast-track/${created.body.jobId}/retry`, {})).body.state).toBe('queued');
});

it('a registered staff X account stays staff and its post publishes at staff tier', async () => {
  f.sqlite.exec("INSERT INTO platforms(id,name,type,status,x_handles,staff_handles) VALUES('codexco','CodexCo','lab','approved','[\"@codexco\"]','[\"@tibo\"]')");
  const created = await call('admin/fast-track', { platformId: 'codexco', url: 'https://x.com/Tibo/status/2110595484180214059', benefit: 'Day 10 全局重置' });
  expect(created.body.registered).toEqual({ kind: 'existing', value: '@tibo' });
  expect(f.sqlite.prepare("SELECT x_handles,staff_handles FROM platforms WHERE id='codexco'").get()).toEqual({ x_handles: '["@codexco"]', staff_handles: '["@tibo"]' });
});

it('an administrator-tested fast-track publishes at tested tier, not as the linked page', async () => {
  f.sqlite.exec("INSERT INTO platforms(id,name,type,status,site) VALUES('odyssey','Odyssey','lab','approved','https://odyssey.world')");
  const created = await call('admin/fast-track', { platformId: 'odyssey', url: 'https://odyssey.world/', benefit: 'Odyssey-3 公开研究预览，可免费试用', basis: 'tested' });
  await ingest(`fast-track/${created.body.jobId}/claim`, {});
  const result = await settle(created.body.jobId, await ingest(`fast-track/${created.body.jobId}/result`, { fields: extracted, sourceText: page, model: 'free' }));
  expect(result.body).toMatchObject({ state: 'published' });
  expect(JSON.parse((f.sqlite.prepare('SELECT evidence FROM offers WHERE id=?').get(result.body.offerId) as any).evidence).tier).toBe('tested');
});

it('any URL the owner gives is registered as the vendor official address', async () => {
  f.sqlite.exec("INSERT INTO platforms(id,name,type,status) VALUES('odyssey','Odyssey','lab','pending')");
  await call('admin/fast-track', { platformId: 'odyssey', url: 'https://x.com/odysseyml/status/123', benefit: '公开预览免费试用' });
  expect(f.sqlite.prepare("SELECT status,x_handles FROM platforms WHERE id='odyssey'").get()).toEqual({ status: 'approved', x_handles: '["@odysseyml"]' });
  const docs = await call('admin/fast-track', { platformId: 'vendor', url: 'https://docs.vendor-cdn.example/free', benefit: '新文档页的免费额度' });
  expect(docs.body.registered).toEqual({ kind: 'source', value: 'https://docs.vendor-cdn.example/free' });
  expect(f.sqlite.prepare("SELECT tier,auto_publish FROM sources WHERE url='https://docs.vendor-cdn.example/free'").get()).toEqual({ tier: 'site', auto_publish: 0 });
});

// 2026-10-16：管理员粘贴的公众号分享短链（不带 __biz）曾被拒绝；担保的链接一律接受。
it('accepts a WeChat short link: registers the account when the page reveals __biz, otherwise only that article', async () => {
  vi.stubGlobal('fetch', vi.fn(async (input: string) => String(input).endsWith('/s/withbiz')
    ? new Response('<script>var biz = "MzkxMjM0NTY3OA==";</script>') : new Response('<h2>环境异常</h2><a>去验证</a>')));
  try {
    const known = await call('admin/fast-track', { platformId: 'vendor', url: 'https://mp.weixin.qq.com/s/withbiz', benefit: '公众号权益' });
    expect(known.status).toBe(200); expect(known.body.registered).toEqual({ kind: 'wechat', value: 'MzkxMjM0NTY3OA==' });
    expect((f.sqlite.prepare("SELECT wechat FROM platforms WHERE id='vendor'").get() as any).wechat).toContain('MzkxMjM0NTY3OA==');
    const captcha = await call('admin/fast-track', { platformId: 'vendor', url: 'https://mp.weixin.qq.com/s/dGd6Nz03MF4', benefit: 'DeepSeek 故障补偿：全员领 500 积分' });
    expect(captcha.status).toBe(200); expect(captcha.body.registered).toEqual({ kind: 'source', value: 'https://mp.weixin.qq.com/s/dGd6Nz03MF4' });
    expect(f.sqlite.prepare("SELECT tier,enabled FROM sources WHERE url='https://mp.weixin.qq.com/s/dGd6Nz03MF4'").get()).toEqual({ tier: 'official', enabled: 0 });
    const { officialTier } = await import('../src/shared/official-review');
    const sources = f.sqlite.prepare("SELECT url,tier FROM sources WHERE platform_id='vendor'").all() as { url: string; tier: string }[];
    const platform = { id: 'vendor', name: 'Vendor', site: null, xHandles: [], staffHandles: [], wechat: null };
    expect(officialTier('https://mp.weixin.qq.com/s/dGd6Nz03MF4', platform, sources)).toBe('site'); // 已登记的单篇文章按官网级别认定
    expect(officialTier('https://mp.weixin.qq.com/s/someOtherArticle', platform, sources)).toBeNull();
  } finally { vi.unstubAllGlobals(); }
});

it('fast-track is administrator only', async () => {
  expect((await call('admin/fast-track', { platformId: 'vendor', url: 'https://vendor.example/rewards', benefit: '注册即送' }, 'fast-reviewer-token-01')).status).toBe(403);
  expect((await call('admin/fast-track', undefined, 'fast-reviewer-token-01')).status).toBe(403);
});

it('owner values win, the benefit line is the listing benefit, and basics are checked', () => {
  const fields = mergeFastTrackFields({ title: '模型标题', valueText: '模型写的', endKind: 'unknown' }, { title: '我的标题', claimEnd: '2026-10-31' }, '主要权益');
  expect(fields).toMatchObject({ title: '我的标题', valueText: '主要权益', endKind: 'date', claimEnd: '2026-10-31', sourceTz: 'Asia/Shanghai' });
  expect(missingBasicFields(fields)).toEqual(['type', 'claimMethod', 'modalities', 'requirements']);
  expect(fastTrackHeld(new Date(Date.now() - 3600_000).toISOString(), new Date())).toBe(true);
  expect(fastTrackHeld(new Date(Date.now() - 25 * 3600_000).toISOString(), new Date())).toBe(false);
});

it('a model-supplied end kind that contradicts the type is normalised; the owner value is kept', () => {
  expect(mergeFastTrackFields({ type: 'free', endKind: 'standing' }, {}, 'x').endKind).toBe('unknown');
  expect(mergeFastTrackFields({ type: 'apply', endKind: 'unknown' }, {}, 'x').endKind).toBe('standing');
  expect(mergeFastTrackFields({ type: 'free', endKind: 'unknown' }, { endKind: 'standing' }, 'x').endKind).toBe('standing');
});

it('the pipeline picks the extracted candidate closest to the owner benefit', () => {
  expect(similarity('Odyssey-3 免费试用', 'Odyssey-3 公开预览免费试用')).toBeGreaterThan(0.5);
  const fields = fastTrackFields([{ ...extracted, title: '邀请好友得积分', valueText: '邀请奖励' }, extracted] as any, 'Odyssey-3 公开研究预览，可免费试用');
  expect(fields).toMatchObject({ title: extracted.title });
  expect(fastTrackFields([{ ...extracted, endKind: 'date', claimEnd: null }] as any, 'x')).toMatchObject({ endKind: 'unknown' });
});

it('vendor IDs never block fast-track: typed IDs are normalized, Chinese names on X get a hash ID (2026-10-16 "Replicas")', async () => {
  const created = await call('admin/fast-track', { newPlatform: { name: 'Replicas', id: 'Replicas' }, url: 'https://x.com/connortbot/status/2110037854386843677', benefit: 'Replicas 注册一次性赠金 $300', basis: 'official' });
  expect(created.status).toBe(200);
  expect(created.body).toMatchObject({ platformId: 'replicas' });
  const cn = await call('admin/fast-track', { newPlatform: { name: '某厂商' }, url: 'https://x.com/someone/status/2110037854386843678', benefit: '注册赠额' });
  expect(cn.status).toBe(200);
  expect(cn.body.platformId).toMatch(/^v-[0-9a-f]{8}$/);
  const bad = await call('admin/fast-track', { newPlatform: { name: '某厂商', id: '某厂商' }, url: 'https://vendor-x.example/a', benefit: '注册赠额' });
  expect(bad.status).toBe(400);
  expect(JSON.stringify(bad.body)).toContain('厂商 ID 只能用英文字母');
});

it('owner corrections after a readiness failure use a new request revision without discarding the failed reservation', async () => {
  const created=await call('admin/fast-track',{newPlatform:{name:'Odyssey'},url:'https://odyssey.world/preview',benefit:'Odyssey 免费试用'});
  await ingest(`fast-track/${created.body.jobId}/claim`,{});
  f.sqlite.exec("INSERT INTO leads(id,origin,url,status,title,resolution) VALUES(9911,'test','https://community.example/old','rejected','Historical refusal','{}')");
  const failed=await settle(created.body.jobId,await ingest(`fast-track/${created.body.jobId}/result`,{fields:extracted,sourceText:page}));
  expect(failed.body).toMatchObject({state:'needs_owner',error:'identity backfill reconciliation required'});
  const reservations=f.sqlite.prepare("SELECT request_id FROM identity_commands WHERE request_id LIKE 'legacy-request:fast-track:%'").all();
  expect(reservations).toHaveLength(1);expect(f.sqlite.prepare('SELECT count(*) n FROM offers').get()).toEqual({n:0});
  // Simulate the historical blocker having been reconciled, then correct the owner's listing fields.
  f.sqlite.exec('DELETE FROM leads WHERE id=9911');
  const done=await settle(created.body.jobId,await call(`admin/fast-track/${created.body.jobId}/complete`,{fields:{title:'更正后的免费试用',requirements:['net'],tags:['daily']}}));
  expect(done.body).toMatchObject({state:'published'});
  expect(f.sqlite.prepare('SELECT count(*) n FROM offers').get()).toEqual({n:1});
  expect(f.sqlite.prepare('SELECT title,requirements FROM offers').get()).toMatchObject({title:'更正后的免费试用',requirements:'["net"]'});
  expect(f.sqlite.prepare('SELECT state FROM identity_commands WHERE request_id=?').get(reservations[0].request_id)).toEqual({state:'applied'});
});
it('only an administrator can correct a failed official task to tested evidence',async()=>{
  const created=await call('admin/fast-track',{newPlatform:{name:'Odyssey'},url:'https://odyssey.world/preview',benefit:'每日登录奖励200积分，24小时有效',basis:'official'});
  await ingest(`fast-track/${created.body.jobId}/claim`,{});
  f.sqlite.prepare('UPDATE fast_track_jobs SET attempts=3 WHERE id=?').run(created.body.jobId);
  const partial=await ingest(`fast-track/${created.body.jobId}/result`,{fields:{...extracted,requirements:['unknown']},sourceText:page});
  expect(partial.body.state).toBe('needs_owner');
  const fields={requirements:['none']};
  expect((await call(`admin/fast-track/${created.body.jobId}/complete`,{basis:'tested',fields},'fast-reviewer-token-01')).status).toBe(403);
  expect(f.sqlite.prepare('SELECT basis FROM fast_track_jobs WHERE id=?').get(created.body.jobId)).toEqual({basis:'official'});
  const done=await settle(created.body.jobId,await call(`admin/fast-track/${created.body.jobId}/complete`,{basis:'tested',fields}));
  expect(done.body.state).toBe('published');
  expect(f.sqlite.prepare('SELECT basis FROM fast_track_jobs WHERE id=?').get(created.body.jobId)).toEqual({basis:'tested'});
  expect(JSON.parse((f.sqlite.prepare('SELECT evidence FROM offers WHERE id=?').get(done.body.offerId) as any).evidence).tier).toBe('tested');
});

it('normalizes a model UTC offset before publishing the owner-authorized job', async () => {
  const created = await call('admin/fast-track', { platformId: 'vendor', url: 'https://vendor.example/rewards', benefit: '注册即送 10 美元额度' });
  await ingest(`fast-track/${created.body.jobId}/claim`, {});
  const r = await settle(created.body.jobId, await ingest(`fast-track/${created.body.jobId}/result`, { fields: {...extracted, sourceTz: 'UTC+8'}, sourceText: page }));
  expect(r.body.state).toBe('published');
});

it('returns schema failures to the model with previous fields and repair feedback', async () => {
  const created = await call('admin/fast-track', { platformId: 'vendor', url: 'https://vendor.example/rewards', benefit: '注册即送 10 美元额度' });
  await ingest(`fast-track/${created.body.jobId}/claim`, {});
  const r = await ingest(`fast-track/${created.body.jobId}/result`, { fields: {...extracted, claimMethod: 'login'}, sourceText: page });
  expect(r.body.state).toBe('queued');
  const next = await ingest(`fast-track/${created.body.jobId}/claim`, {});
  expect(next.body.job.repairFeedback).toContain('claimMethod');
  expect(next.body.job.previousFields.claimMethod).toBe('login');
});

it('reconciles an already approved progress offer before trying stale extraction again', async () => {
  const created = await call('admin/fast-track', { platformId: 'vendor', url: 'https://vendor.example/rewards', benefit: '注册即送 10 美元额度' });
  const id=created.body.jobId;
  await ingest(`fast-track/${id}/claim`, {});
  const done=await settle(id,await ingest(`fast-track/${id}/result`, {fields:extracted,sourceText:page}));
  f.sqlite.prepare("UPDATE fast_track_jobs SET state='needs_owner',error='old error' WHERE id=?").run(id);
  const reconciled=await call(`admin/fast-track/${id}/reconcile`,{});
  expect(reconciled.body).toMatchObject({state:'published',offerId:done.body.offerId});
});

it('accepts model-completed verified catalog membership without a manual selector', async () => {
 f.sqlite.prepare('UPDATE membership_catalog SET revision=1,data_json=? WHERE id=1').run(JSON.stringify(catalog));
 const created=await call('admin/fast-track',{newPlatform:{name:'Odyssey'},url:'https://odyssey.world/introducing-odyssey-3',benefit:'Odyssey Pro 7 天免费使用'});
 const claim=await ingest(`fast-track/${created.body.jobId}/claim`,{});
 expect(claim.body.job.membershipCatalog.revision).toBe(1);
 const done=await settle(created.body.jobId,await ingest(`fast-track/${created.body.jobId}/result`,{fields:{...memberPerk,membershipRequirement:proMembership(1)},sourceText:page}));
 expect(done.body.state).toBe('published');
});

it('reconciles a rejected lead and never queues or publishes it again', async () => {
 f.sqlite.exec("INSERT INTO leads(id,origin,url,status,title) VALUES(9001,'manual','https://vendor.example/rewards','reviewing','paid discount')");
 const created=await call('admin/fast-track',{platformId:'vendor',url:'https://vendor.example/rewards',benefit:'低价调用',leadId:9001});
 f.sqlite.prepare("UPDATE fast_track_jobs SET state='needs_owner' WHERE id=?").run(created.body.jobId);
 f.sqlite.prepare("UPDATE leads SET status='rejected',resolution=? WHERE id=9001").run(JSON.stringify({reason:'仍扣积分，不是免费'}));
 await ingest('fast-track/queue');
 expect((await call('admin/fast-track')).body.jobs[0]).toMatchObject({state:'rejected',resolution:{reason:'仍扣积分，不是免费'}});
 expect((await ingest(`fast-track/${created.body.jobId}/claim`,{})).status).toBe(409);
});

it('does not reconcile a lead accidentally linked to another platform', async () => {
 const created=await call('admin/fast-track',{platformId:'vendor',url:'https://vendor.example/rewards',benefit:'免费调用'});
 await ingest(`fast-track/${created.body.jobId}/claim`,{});
 const done=await settle(created.body.jobId,await ingest(`fast-track/${created.body.jobId}/result`,{fields:extracted,sourceText:page}));
 f.sqlite.exec("INSERT INTO platforms(id,name,type,status,site) VALUES('other','Other','tool','approved','https://other.example')");
 f.sqlite.prepare("UPDATE fast_track_jobs SET state='needs_owner',platform_id='other' WHERE id=?").run(created.body.jobId);
 expect((await call(`admin/fast-track/${created.body.jobId}/reconcile`,{})).body.state).toBe('needs_owner');
 expect(done.body.state).toBe('published');
});

it('reapplies model-corrected membership after the catalog changes between edit and approval', async () => {
  const {IdentityService}=await import('../src/worker/identity/service');
  const {MembershipError}=await import('../src/worker/membership');
  f.sqlite.prepare('UPDATE membership_catalog SET revision=1,data_json=? WHERE id=1').run(JSON.stringify(catalog));
  const created=await call('admin/fast-track',{newPlatform:{name:'Odyssey'},url:'https://odyssey.world/introducing-odyssey-3',benefit:'Odyssey Pro 7 天免费使用'});
  await ingest(`fast-track/${created.body.jobId}/claim`,{});
  const approval=vi.spyOn(IdentityService.prototype,'decideTask').mockRejectedValueOnce(new MembershipError(409,'会员目录已更新'));
  const paused=await settle(created.body.jobId,await ingest(`fast-track/${created.body.jobId}/result`,{fields:{...memberPerk,membershipRequirement:proMembership(1)},sourceText:page}));
  approval.mockRestore();
  expect(paused.body.state).toBe('queued');
  f.sqlite.prepare('UPDATE membership_catalog SET revision=2 WHERE id=1').run();
  await ingest(`fast-track/${created.body.jobId}/claim`,{});
  const done=await settle(created.body.jobId,await ingest(`fast-track/${created.body.jobId}/result`,{fields:{...memberPerk,membershipRequirement:proMembership(2)},sourceText:page}));
  expect(done.body.state).toBe('published');
  const row=f.sqlite.prepare('SELECT membership_requirement FROM offers WHERE id=?').get(done.body.offerId) as any;
  expect(JSON.parse(row.membership_requirement).catalogRevision).toBe(2);
});

it('does not publish model fields without the mandatory semantic review receipt',async()=>{
 const created=await call('admin/fast-track',{platformId:'vendor',url:'https://vendor.example/rewards',benefit:'公开研究预览免费试用'});
 await ingest(`fast-track/${created.body.jobId}/claim`,{});
 const result=await call(`ingest/fast-track/${created.body.jobId}/result`,{fields:extracted,sourceText:page,model:'gemini'},'fast-ingest-token-0001');
 expect(result.body).toMatchObject({state:'queued',missing:['semanticReview']});
 expect(f.sqlite.prepare('SELECT count(*) n FROM offers').get()).toEqual({n:0});
});
it('exposes replay input read-only and rejects tampered reviewed fields before intake',async()=>{
 const created=await call('admin/fast-track',{platformId:'vendor',url:'https://vendor.example/rewards',benefit:'公开研究预览免费试用'});
 await ingest(`fast-track/${created.body.jobId}/claim`,{});
 const context={platformId:'vendor',url:'https://vendor.example/rewards',benefit:'公开研究预览免费试用',sourceText:page};
 const reviewed=makeSemanticReview(extracted,{type:{value:'free',quote:page},modalities:[{value:'video',quote:page}],audience:{value:'all',quote:''}},context,'review');
 const rejected=await call(`ingest/fast-track/${created.body.jobId}/result`,{fields:{...extracted,modalities:['image']},sourceText:page,model:'gemini',semanticReview:reviewed.review},'fast-ingest-token-0001');
 expect(rejected.body.state).toBe('queued');expect(rejected.body.error).toContain('modalities');
 const before=f.sqlite.prepare('SELECT * FROM fast_track_jobs WHERE id=?').get(created.body.jobId);
 const input=await ingest(`fast-track/${created.body.jobId}/review-input`);
 expect(input.body.fields.modalities).toEqual(['image']);
 expect(f.sqlite.prepare('SELECT * FROM fast_track_jobs WHERE id=?').get(created.body.jobId)).toEqual(before);
});

it('pauses for a pending membership catalog after one extraction and automatically resumes when verified',async()=>{
 const pending=structuredClone(catalog);pending.products[0].status='pending' as any;
 f.sqlite.prepare('UPDATE membership_catalog SET revision=1,data_json=? WHERE id=1').run(JSON.stringify(pending));
 const created=await call('admin/fast-track',{newPlatform:{name:'Odyssey'},url:'https://odyssey.world/introducing-odyssey-3',benefit:'Odyssey Pro 会员免费体验'});
 await ingest(`fast-track/${created.body.jobId}/claim`,{});
 const paused=await ingest(`fast-track/${created.body.jobId}/result`,{fields:{...memberPerk,membershipRequirement:proMembership(1)},sourceText:page});
 expect(paused.body).toMatchObject({state:'needs_owner',missing:['membershipCatalog']});
 expect((await ingest('fast-track/queue')).body.jobs).toEqual([]);
 f.sqlite.prepare('UPDATE membership_catalog SET revision=2,data_json=? WHERE id=1').run(JSON.stringify(catalog));
 expect((await ingest('fast-track/queue')).body.jobs).toEqual([{id:created.body.jobId,publishing:false}]);
 await ingest(`fast-track/${created.body.jobId}/claim`,{});
 const done=await settle(created.body.jobId,await ingest(`fast-track/${created.body.jobId}/result`,{fields:{...memberPerk,membershipRequirement:proMembership(2)},sourceText:page}));
 expect(done.body.state).toBe('published');
});

it('does not wake a catalog-blocked job on an unrelated directory edit or silently replace owner-selected membership',async()=>{
 const pending=structuredClone(catalog);pending.products[0].status='pending' as any;
 f.sqlite.prepare('UPDATE membership_catalog SET revision=1,data_json=? WHERE id=1').run(JSON.stringify(pending));
 const created=await call('admin/fast-track',{newPlatform:{name:'Odyssey'},url:'https://odyssey.world/introducing-odyssey-3',benefit:'Odyssey Pro 会员免费体验'});
 await ingest(`fast-track/${created.body.jobId}/claim`,{});
 await ingest(`fast-track/${created.body.jobId}/result`,{fields:{...memberPerk,membershipRequirement:proMembership(1)},sourceText:page});
 f.sqlite.prepare('UPDATE membership_catalog SET revision=2 WHERE id=1').run();
 expect((await ingest('fast-track/queue')).body.jobs).toEqual([]);
 f.sqlite.prepare('UPDATE membership_catalog SET revision=3,data_json=? WHERE id=1').run(JSON.stringify(catalog));
 f.sqlite.prepare('UPDATE fast_track_jobs SET owner_fields_json=? WHERE id=?').run(JSON.stringify({membershipRequirement:proMembership(1)}),created.body.jobId);
 expect((await ingest('fast-track/queue')).body.jobs).toEqual([]);
});
