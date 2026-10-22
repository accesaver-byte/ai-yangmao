import { afterEach, beforeEach, expect, it } from 'vitest';
import worker from '../src/worker/index';
import { identityDb } from './fixtures/identity/db';

let f: ReturnType<typeof identityDb>;
beforeEach(() => { f = identityDb(); });
afterEach(() => f.sqlite.close());

// 2026-10-22: a 117-item digest could not be confirmed — one statement per mark exceeded the 50-statement admin budget.
it('the owner can confirm a large stuck digest as delivered', async () => {
  const marks = Array.from({ length: 60 }, (_, i) => ({ offerId: `big-${i}`, stage: 'new' }));
  for (const m of marks) f.sqlite.prepare("INSERT INTO offers(id,platform_id,title,value_text,type,claim_method,requirements,audience,end_kind,source_tz,modalities,tags,evidence,review_state,discovered_at,updated_at) VALUES(?, 'vendor', 't', 'v', 'new', 'signup', '[\"none\"]', 'new', 'unknown', 'UTC', '[\"text\"]', '[]', '{\"url\":\"https://vendor.example\",\"tier\":\"site\",\"capturedAt\":\"2026-10-01\",\"excerpts\":{}}', 'approved', '2026-10-01', '2026-10-01')").run(m.offerId);
  marks.push({ offerId: 'deleted-offer', stage: 'new' });
  f.sqlite.prepare("INSERT INTO deliveries(id,fingerprint,channel,kind,status,payload,created_at) VALUES('big','big-fp','telegram','digest','pending',?, '2026-10-08T13:01:02Z')").run(JSON.stringify({ kind: 'digest', marks, items: {} }));
  const r = await worker.fetch(new Request('https://local.test/api/admin/notify/big/resolve', { method: 'POST', headers: { Authorization: 'Bearer big-admin-token-0001', 'Content-Type': 'application/json' }, body: JSON.stringify({ outcome: 'delivered', reason: '两周前的旧日报，不重发' }) }),
    { DB: f.db, ADMIN_TOKEN: 'big-admin-token-0001', IDENTITY_MODE: 'enforce' } as any, {} as any);
  expect(r.status, await r.clone().text()).toBe(200);
  expect(f.sqlite.prepare("SELECT status FROM deliveries WHERE id='big'").get()).toEqual({ status: 'sent' });
  expect(f.sqlite.prepare("SELECT count(*) n FROM notifications WHERE stage='new' AND offer_id LIKE 'big-%'").get()).toEqual({ n: 60 });
});
