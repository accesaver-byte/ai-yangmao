import { afterEach, beforeEach, expect, it, vi } from 'vitest';
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
const ingest = (path: string, body?: unknown) => call('ingest/' + path, body, 'fast-ingest-token-0001');
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
  const partial = await ingest(`fast-track/${created.body.jobId}/result`, { fields: { title: '注册赠额', type: 'new', modalities: ['text'], requirements: ['unknown'] }, sourceText: page });
  expect(partial.body).toMatchObject({ state: 'needs_owner' });
  expect(partial.body.missing).toEqual(expect.arrayContaining(['claimMethod', 'requirements', 'endKind']));
  const done = await settle(created.body.jobId, await call(`admin/fast-track/${created.body.jobId}/complete`, { fields: { claimMethod: 'signup', requirements: ['none'], endKind: 'unknown' } }));
  expect(done.body).toMatchObject({ state: 'published' });
  expect(f.sqlite.prepare('SELECT review_state FROM offers WHERE id=?').get(done.body.offerId)).toEqual({ review_state: 'approved' });
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
