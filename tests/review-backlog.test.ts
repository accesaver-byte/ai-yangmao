import { afterEach, beforeEach, expect, it } from 'vitest';
import worker from '../src/worker/index';
import { identityDb } from './fixtures/identity/db';
import { buildNotice } from '../src/worker/admin';

let f: ReturnType<typeof identityDb>;
beforeEach(() => { f = identityDb(); });
afterEach(() => f.sqlite.close());
const env = () => ({ DB: f.db, ADMIN_TOKEN: 'stats-admin-token-0001', INGEST_TOKEN: 'stats-ingest-token-001', IDENTITY_MODE: 'enforce' }) as any;
const openCards = (n: number, createdAt = new Date().toISOString()) => { for (let i = 0; i < n; i++) f.sqlite.prepare("INSERT INTO review_tasks(id,task_key,kind,state,created_at) VALUES(?,?,'identity','manual',?)").run(`t${i}-${createdAt}`, `identity:c${i}-${createdAt}`, createdAt); };

// 2026-10-16: 90 cards piled up before anyone noticed; warn on day one.
it('telegram warns once a day when identity cards pile up', async () => {
  openCards(21);
  const notice = await buildNotice(env(), 'digest', 'telegram');
  const alert = notice.reviewAlerts.find(a => a.key.startsWith('backlog:identity:'));
  expect(alert).toMatchObject({ priority: 0 });
  expect(alert!.title).toContain('21 张卡');
});

it('no backlog warning for a few fresh cards; a stale card alone triggers it', async () => {
  openCards(3);
  expect((await buildNotice(env(), 'digest', 'telegram')).reviewAlerts.some(a => a.key.startsWith('backlog:identity:'))).toBe(false);
  openCards(1, new Date(Date.now() - 50 * 3600_000).toISOString());
  expect((await buildNotice(env(), 'digest', 'telegram')).reviewAlerts.some(a => a.key.startsWith('backlog:identity:'))).toBe(true);
});

it('review stats separate system, rule and owner work', async () => {
  const now = new Date().toISOString();
  f.sqlite.prepare("INSERT INTO leads(id,origin,url,status,title,resolution,created_at) VALUES(9301,'linuxdo','https://x.example/1','rejected','a',?,?)").run(JSON.stringify({ status: 'closed', reason: '模型判断不是 AI 羊毛' }), now);
  f.sqlite.prepare("INSERT INTO leads(id,origin,url,status,title,resolution,created_at) VALUES(9302,'linuxdo','https://x.example/2','rejected','b',?,?)").run(JSON.stringify({ status: 'closed', ruleId: 'r1' }), now);
  f.sqlite.prepare("INSERT INTO leads(id,origin,url,status,title,resolution,created_at) VALUES(9303,'linuxdo','https://x.example/3','rejected','c',?,?)").run(JSON.stringify({ status: 'closed' }), now);
  f.sqlite.prepare("INSERT INTO decision_labels(subject_kind,subject_id,category,actor_kind,label_source,labeled_at) VALUES('lead','9303','non_ai','owner','owner',?)").run(now);
  const r = await worker.fetch(new Request('https://local.test/api/admin/review-stats?days=7', { headers: { Authorization: 'Bearer stats-admin-token-0001' } }), env(), {} as any);
  const body = await r.json() as any;
  expect(r.status).toBe(200);
  expect(body.leads).toMatchObject({ rule: 1, owner: 1 });
  expect(body.leads.system).toBeGreaterThanOrEqual(1);
  expect(body.identity).toMatchObject({ web: 0, agent: 0 });
});
