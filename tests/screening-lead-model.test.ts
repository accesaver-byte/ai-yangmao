import { afterEach, beforeEach, expect, it } from 'vitest';
import worker from '../src/worker/index';
import { identityDb } from './fixtures/identity/db';

let f: ReturnType<typeof identityDb>;
beforeEach(() => { f = identityDb(); });
afterEach(() => f.sqlite.close());
const MODEL = 'nvidia/nemotron-3-ultra-550b-a55b:free';
const none = { tier: 'P3', deadline: null, signals: [], quote: null };
const post = async (leadId: number, verdict: string, { matchId = null as string | null, confidence = 0.95, model = MODEL, trusted = MODEL } = {}) => {
  const body = { requestId: `lm:${leadId}:${verdict}:${model}:${trusted}:${confidence}`, itemId: `lead:${leadId}`, subject: { kind: 'lead', leadId, discoveredAt: new Date().toISOString() },
    verdict: { verdict, matchId, ruleId: null, reasonCategory: null, occurrenceCheck: null, confidence, evidenceQuote: 'x', explanation: '新闻报道，无可领取额度', urgency: none },
    model, calibrated: false, promptVersion: 'screening-v2', contextHash: 'h', downgradeReasons: [] };
  const r = await worker.fetch(new Request('https://local.test/api/ingest/screening/verdicts', { method: 'POST', headers: { Authorization: 'Bearer lead-model-ingest-01', 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    { DB: f.db, INGEST_TOKEN: 'lead-model-ingest-01', SCREENING_MODE: 'shadow', SCREENING_LEAD_MODELS: trusted } as any, {} as any);
  return (await r.json() as any).applied as boolean;
};
const lead = (id: number, title: string, url = `https://news.example/${id}`) => f.sqlite.prepare("INSERT INTO leads(id,origin,url,status,title) VALUES(?,'aihot',?,'new',?)").run(id, url, title);
const status = (id: number) => (f.sqlite.prepare('SELECT status FROM leads WHERE id=?').get(id) as any).status;
const offer = (id: string, title: string, tags = '[]') => f.sqlite.prepare("INSERT INTO offers(id,platform_id,title,value_text,type,claim_method,requirements,audience,end_kind,source_tz,modalities,tags,evidence,review_state,discovered_at,updated_at) VALUES(?,'vendor',?,?,'trial','signup','[\"none\"]','all','standing','UTC','[\"text\"]',?,'{}','approved','2026-10-01','2026-10-01')").run(id, title, title, tags);

it('closes plain non-perk news from a trusted model and lists it for spot-check', async () => {
  lead(9801, '特斯拉 App 适配苹果折叠 iPhone，引入大屏双栏体验');
  expect(await post(9801, 'not_a_perk')).toBe(true);
  expect(status(9801)).toBe('rejected');
  expect(JSON.parse((f.sqlite.prepare('SELECT resolution FROM leads WHERE id=9801').get() as any).resolution)).toMatchObject({ screeningModel: MODEL });
});
it('keeps shadow for untrusted models, low confidence, perk words, launch news and recurring titles', async () => {
  lead(9802, '特斯拉 App 适配苹果折叠 iPhone'); expect(await post(9802, 'not_a_perk', { model: 'other/free:free' })).toBe(false);
  lead(9803, '特斯拉 App 适配苹果折叠 iPhone'); expect(await post(9803, 'not_a_perk', { confidence: 0.8 })).toBe(false);
  lead(9804, 'Vendor 新用户送 5 美元'); expect(await post(9804, 'not_a_perk')).toBe(false);
  lead(9805, 'Recursive 发布可在笔记本运行的编程模型 Flint'); expect(await post(9805, 'not_a_perk')).toBe(false);
  lead(9806, 'Codex 今天又重置了'); expect(await post(9806, 'not_a_perk')).toBe(false);
  lead(9807, '特斯拉 App 适配苹果折叠 iPhone'); expect(await post(9807, 'not_a_perk', { trusted: '' })).toBe(false);
  expect([9802, 9803, 9804, 9805, 9806, 9807].map(status)).toEqual(Array(6).fill('new'));
});
it('never closes posts from a registered official account', async () => {
  f.sqlite.prepare("UPDATE platforms SET site='https://vendor.example', x_handles='[\"VendorAI\"]' WHERE id='vendor'").run();
  lead(9808, 'Vendor 致歉说明', 'https://x.com/VendorAI/status/1'); expect(await post(9808, 'not_a_perk')).toBe(false);
  lead(9809, 'Vendor 博客随笔', 'https://blog.vendor.example/post'); expect(await post(9809, 'not_a_perk')).toBe(false);
  expect([9808, 9809].map(status)).toEqual(['new', 'new']);
});
it('links a duplicate of a listed perk only when every stated amount is already listed', async () => {
  offer('vendor-signup-10', 'Vendor 注册送 10 美元');
  lead(9810, 'Vendor 注册送 10 美元，速领'); expect(await post(9810, 'duplicate_published', { matchId: 'offer:vendor-signup-10' })).toBe(true);
  expect(f.sqlite.prepare('SELECT status, offer_id FROM leads WHERE id=9810').get()).toEqual({ status: 'linked', offer_id: 'vendor-signup-10' });
  lead(9811, 'Vendor 程序员节送 1B token'); expect(await post(9811, 'duplicate_published', { matchId: 'offer:vendor-signup-10' })).toBe(false);
  offer('vendor-reset', 'Vendor 额度重置', '["reset"]');
  lead(9812, 'Vendor 福利来了'); expect(await post(9812, 'duplicate_published', { matchId: 'offer:vendor-reset' })).toBe(false);
  expect([9811, 9812].map(status)).toEqual(['new', 'new']);
});

const call = async (path: string, body: unknown, token: string, env: Record<string, string>) => {
  const r = await worker.fetch(new Request(`https://local.test/api/${path}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    { DB: f.db, INGEST_TOKEN: 'lead-model-ingest-01', ADMIN_TOKEN: 'lead-model-admin-0123456', SCREENING_MODE: 'shadow', ...env } as any, {} as any);
  return { status: r.status, body: await r.json() as any };
};
// 2026-10-29 A: an unknown-vendor lead is kept for platform discovery unless a trusted model already said "not a perk".
it('closes an unknown-vendor lead the trusted model judged not a perk instead of keeping it for review', async () => {
  lead(9820, '农业银行Visa信用卡X AI/Cursor/OpenRouter/GitHub 支付返现10%');
  expect(await post(9820, 'not_a_perk', { trusted: '' })).toBe(false);
  const r = await call('ingest/leads/9820/status', { status: 'reviewing', note: '白名单外的平台：农业银行' }, 'lead-model-ingest-01', { SCREENING_LEAD_MODELS: MODEL });
  expect(r.body).toMatchObject({ ok: true, closedByScreening: true });
  expect(status(9820)).toBe('rejected');
  lead(9821, 'Vendor 新用户送 5 美元');
  await post(9821, 'not_a_perk', { trusted: '' });
  await call('ingest/leads/9821/status', { status: 'reviewing', note: '白名单外的平台：Vendor' }, 'lead-model-ingest-01', { SCREENING_LEAD_MODELS: MODEL });
  expect(status(9821)).toBe('reviewing');
});
// 2026-10-29 B: recorded verdicts on still-open leads are applied by a dry-run-first backfill.
it('backfills recorded verdicts on open leads, dry run first', async () => {
  lead(9830, '特斯拉 App 适配苹果折叠 iPhone'); lead(9831, 'Vendor 新用户送 5 美元');
  await post(9830, 'not_a_perk', { trusted: '' }); await post(9831, 'not_a_perk', { trusted: '' });
  const env = { SCREENING_LEAD_MODELS: MODEL };
  const dry = await call('admin/screening/lead-verdicts/apply', {}, 'lead-model-admin-0123456', env);
  expect(dry.body.results).toEqual([{ leadId: 9830, verdict: 'not_a_perk', confidence: 0.95, action: 'closed' }, { leadId: 9831, verdict: 'not_a_perk', confidence: 0.95, action: 'keep' }]);
  expect(status(9830)).toBe('new');
  await call('admin/screening/lead-verdicts/apply', { dryRun: false }, 'lead-model-admin-0123456', env);
  expect([status(9830), status(9831)]).toEqual(['rejected', 'new']);
});
