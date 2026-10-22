import { afterEach, beforeEach, expect, it } from 'vitest';
import worker from '../src/worker/index';
import { identityDb } from './fixtures/identity/db';

let f: ReturnType<typeof identityDb>;
beforeEach(() => { f = identityDb(); });
afterEach(() => f.sqlite.close());
const none = { tier: 'P3', deadline: null, signals: [], quote: null };
const post = async (leadId: number, verdict: string, matchId: string, gate0Mode = 'auto') => {
  const body = { requestId: `gate0:${leadId}:${matchId}:${gate0Mode}`, itemId: `lead:${leadId}`, subject: { kind: 'lead', leadId, discoveredAt: new Date().toISOString() },
    verdict: { verdict, matchId, ruleId: null, reasonCategory: null, occurrenceCheck: null, confidence: 1, evidenceQuote: 'x', explanation: 'x', urgency: none },
    model: 'gate0', calibrated: false, promptVersion: 'screening-v2', contextHash: 'gate0', downgradeReasons: [] };
  const r = await worker.fetch(new Request('https://local.test/api/ingest/screening/verdicts', { method: 'POST', headers: { Authorization: 'Bearer gate0-ingest-token-01', 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    { DB: f.db, INGEST_TOKEN: 'gate0-ingest-token-01', SCREENING_MODE: 'shadow', SCREENING_GATE0_MODE: gate0Mode } as any, {} as any);
  return { status: r.status, body: await r.json() as any };
};
const lead = (id: number, title: string) => f.sqlite.prepare("INSERT INTO leads(id,origin,url,status,title) VALUES(?,'linuxdo',?,'new',?)").run(id, `https://linux.do/t/topic/${id}`, title);
const matched = () => f.sqlite.prepare("INSERT INTO leads(id,origin,url,status,title) VALUES(9600,'linuxdo','https://linux.do/t/topic/9600','rejected','某中转站送余额')").run();
const offer = (id: string, title: string, tags = '[]') => f.sqlite.prepare("INSERT INTO offers(id,platform_id,title,value_text,type,claim_method,requirements,audience,end_kind,source_tz,modalities,tags,evidence,review_state,discovered_at,updated_at) VALUES(?, 'vendor', ?, '新用户 10 美元', 'new', 'signup', '[\"none\"]', 'new', 'unknown', 'UTC', '[\"text\"]', ?, '{\"url\":\"https://vendor.example\",\"tier\":\"site\",\"capturedAt\":\"2026-10-01\",\"excerpts\":{}}', 'approved', '2026-10-01', '2026-10-01')").run(id, title, tags);

// Stage 2, 2026-10-21: gate0 verdicts take effect on their own.
it('closes a repost of a rejected lead and links a lead matching a listed perk', async () => {
  matched(); lead(9701, '某中转站送余额'); lead(9702, 'Vendor 注册送 10 美元');
  offer('vendor-signup-10', 'Vendor 注册送 10 美元');
  const dbg = await post(9701, 'duplicate_rejected', 'lead:9600'); expect(dbg.body.applied, JSON.stringify(dbg)).toBe(true);
  expect((await post(9702, 'duplicate_published', 'offer:vendor-signup-10')).body.applied).toBe(true);
  expect(f.sqlite.prepare('SELECT status FROM leads WHERE id=9701').get()).toEqual({ status: 'rejected' });
  expect(f.sqlite.prepare('SELECT status, offer_id FROM leads WHERE id=9702').get()).toEqual({ status: 'linked', offer_id: 'vendor-signup-10' });
  expect(f.sqlite.prepare("SELECT count(*) n FROM screening_decisions WHERE applied_at IS NOT NULL").get()).toEqual({ n: 2 });
});
it('never touches reset or recurring perks, and does nothing unless the switch is auto', async () => {
  matched(); lead(9703, 'Codex 额度重置第 11 轮'); lead(9704, 'Vendor 注册送 10 美元'); lead(9705, '某中转站送余额');
  offer('vendor-daily', 'Vendor 每日免费额度', '["daily"]');
  expect((await post(9703, 'duplicate_rejected', 'lead:9600')).body.applied).toBe(false);
  expect((await post(9704, 'duplicate_published', 'offer:vendor-daily')).body.applied).toBe(false);
  expect((await post(9705, 'duplicate_rejected', 'lead:9600', 'shadow')).body.applied).toBe(false);
  expect(f.sqlite.prepare("SELECT count(*) n FROM leads WHERE id IN (9703,9704,9705) AND status='new'").get()).toEqual({ n: 3 });
});

it('a lead whose amounts conflict with the listed perk is not auto-linked as a duplicate', async () => {
  matched(); lead(9706, 'Vendor 注册送 50 美元（新活动）');
  offer('vendor-signup-10b', 'Vendor 注册送 10 美元');
  expect((await post(9706, 'duplicate_published', 'offer:vendor-signup-10b')).body.applied).toBe(false);
  expect(f.sqlite.prepare('SELECT status FROM leads WHERE id=9706').get()).toEqual({ status: 'new' });
});

// 2026-10-21: the owner can undo a system "duplicate" link from the spot-check list and get the lead back in the queue.
it('an auto-linked duplicate appears in the spot-check list and can be returned to the queue', async () => {
  matched(); lead(9707, 'Vendor 注册送 10 美元'); offer('vendor-signup-10c', 'Vendor 注册送 10 美元');
  expect((await post(9707, 'duplicate_published', 'offer:vendor-signup-10c')).body.applied).toBe(true);
  const adminCall = async (path: string, body?: unknown) => { const r = await worker.fetch(new Request('https://local.test/api/admin/' + path, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: 'Bearer gate0-admin-token-001', 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }), { DB: f.db, ADMIN_TOKEN: 'gate0-admin-token-001', IDENTITY_MODE: 'enforce' } as any, {} as any); return { status: r.status, body: await r.json() as any }; };
  const list = await adminCall('screening/spot-check');
  const item = list.body.items.find((i: any) => i.id === 9707);
  expect(item).toMatchObject({ closedBy: 'gate0_link' });
  const back = await adminCall('screening/spot-check/9707/wrong', { expectedVersion: item.expectedVersion });
  expect(back.status, JSON.stringify(back.body)).toBe(200);
  const row = f.sqlite.prepare('SELECT status, offer_id, resolution FROM leads WHERE id=9707').get() as any;
  expect(row.status).toBe('reviewing');
  expect(row.offer_id).toBeNull();
  expect(JSON.parse(row.resolution).spotCheck.verdict).toBe('wrong');
});
