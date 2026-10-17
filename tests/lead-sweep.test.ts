import { afterEach, beforeEach, expect, it } from 'vitest';
import worker from '../src/worker/index';
import { identityDb } from './fixtures/identity/db';
import { identityReviewPresentation } from '../src/worker/identity/review-presentation';

let f: ReturnType<typeof identityDb>;
beforeEach(() => { f = identityDb(); });
afterEach(() => f.sqlite.close());
const sweep = async () => { const r = await worker.fetch(new Request('https://local.test/api/ingest/lead-sweep', { method: 'POST', headers: { Authorization: 'Bearer sweep-ingest-token-001', 'Content-Type': 'application/json' }, body: '{}' }), { DB: f.db, INGEST_TOKEN: 'sweep-ingest-token-001', IDENTITY_MODE: 'enforce' } as any, {} as any); return { status: r.status, body: await r.json() as any }; };

// 2026-10-16 audit: places where neither the system nor the owner could move an item.
it('a lead whose identity cards are all decided leaves the hidden state instead of waiting forever', async () => {
  f.sqlite.prepare("INSERT INTO review_tasks(id,task_key,kind,state) VALUES('done-task','identity:done','identity','resolved')").run();
  f.sqlite.prepare("INSERT INTO review_tasks(id,task_key,kind,state) VALUES('open-task','identity:open','identity','manual')").run();
  f.sqlite.prepare("INSERT INTO leads(id,origin,url,status,title,resolution) VALUES(9601,'aihot','https://x.example/a','reviewing','已决定的线索',?)").run(JSON.stringify({ status: 'manual', identityTaskIds: ['done-task'] }));
  f.sqlite.prepare("INSERT INTO leads(id,origin,url,status,title,resolution) VALUES(9602,'aihot','https://x.example/b','reviewing','仍在审核的线索',?)").run(JSON.stringify({ status: 'manual', identityTaskIds: ['open-task'] }));
  const r = await sweep();
  expect(r.status).toBe(200);
  expect(r.body.remaining).toBe(0);
  const a = JSON.parse((f.sqlite.prepare('SELECT resolution FROM leads WHERE id=9601').get() as any).resolution);
  expect(a.identityTaskIds ?? []).not.toContain('done-task');
  expect(JSON.parse((f.sqlite.prepare('SELECT resolution FROM leads WHERE id=9602').get() as any).resolution).identityTaskIds).toEqual(['open-task']);
});

it('a lead stuck in automatic review for over a day is handed to the owner with an honest reason', async () => {
  const old = new Date(Date.now() - 30 * 3600_000).toISOString();
  f.sqlite.prepare("INSERT INTO leads(id,origin,url,status,title,resolution,created_at) VALUES(9603,'discord','https://x.example/c','reviewing','抽取一直推迟的线索',?,?)").run(JSON.stringify({ status: 'checking', checkedAt: old, nextAttemptAt: null }), old);
  f.sqlite.prepare("INSERT INTO leads(id,origin,url,status,title,resolution) VALUES(9604,'discord','https://x.example/d','reviewing','刚开始复核的线索',?)").run(JSON.stringify({ status: 'checking', checkedAt: new Date().toISOString() }));
  expect((await sweep()).body.handedToOwner).toBe(1);
  expect(JSON.parse((f.sqlite.prepare('SELECT resolution FROM leads WHERE id=9603').get() as any).resolution)).toMatchObject({ status: 'manual' });
  expect(JSON.parse((f.sqlite.prepare('SELECT resolution FROM leads WHERE id=9604').get() as any).resolution).status).toBe('checking');
});

it('a card whose history is unusable is decidable by the owner, not excluded from both sides', () => {
  const view = identityReviewPresentation({ kind: 'identity', suggestion_json: JSON.stringify({ kind: 'identity_preparation_v1', status: 'history_unusable', productId: 'vendor', cursor: null, scanned: 3, entries: [], sourceObservationId: null, sourceUrl: null, reason: '历史身份缺少可展示的活动内容，暂不能交给人工判断。', nextAttemptAt: null }) }, []);
  expect(view.reviewPreparation).toMatchObject({ canDecide: true });
  expect(view.reviewPreparation.reason).not.toContain('暂不能交给人工');
});
