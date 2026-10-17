import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/worker/index';
import { identityDb } from './fixtures/identity/db';
import { readUrgentReviews, urgentReviewQueue } from '../src/worker/screening/urgent-review';

let f: ReturnType<typeof identityDb>;
const now = new Date('2026-10-18T00:00:00Z');
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(now); f = identityDb(); });
afterEach(() => { f.sqlite.close(); vi.useRealTimers(); });
function offer(id: string, end: string, state = 'pending') {
  f.sqlite.prepare(`INSERT INTO offers(id,platform_id,title,type,modalities,claim_method,requirements,audience,value_text,end_kind,claim_end,source_tz,evidence,steps,review_state,discovered_at)
    VALUES(?,'vendor',?,'trial','["text"]','signup','["none"]','all','免费额度','date',?,'UTC',?,'[]',?,'2026-10-17T22:00:00Z')`)
    .run(id, id, end, JSON.stringify({ url: 'https://vendor.example/a', tier: 'site', capturedAt: now.toISOString(), excerpts: {} }), state);
}
function lead(id: number, title: string, created = '2026-10-17T23:00:00Z') {
  f.sqlite.prepare("INSERT INTO leads(id,origin,url,title,status,created_at) VALUES(?,'linuxdo',?,?,'reviewing',?)").run(id, `https://community.example/${id}`, title, created);
}
async function request(path: string, body?: unknown, token = 'admin-test-token-123456') {
  const r = await worker.fetch(new Request(`https://local.test/api/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
    { DB: f.db, ADMIN_TOKEN: 'admin-test-token-123456', INGEST_TOKEN: 'ingest-test-token-123', REVIEWER_TOKENS: 'reviewer:reviewer-test-token-123456' } as never, {} as ExecutionContext);
  return { status: r.status, body: await r.json() as any };
}

describe('紧急福利本地第一版', () => {
  it('队列读取后才截止的线索不能继续领取自动核实任务', async () => {
    lead(2, '限量兑换码');
    f.sqlite.exec("INSERT INTO screening_items(id,subject_kind,subject_id,state,tier,tier_by,deadline,discovered_at,due_at,updated_at) VALUES('lead:2','lead','2','awaiting_verify','P0','gate0','2026-10-18T00:00:01Z','2026-10-17T23:00:00Z','2026-10-18T00:00:00Z','2026-10-18T00:00:00Z')");
    expect((await request('ingest/lead-reviews/queue?ids=2', undefined, 'ingest-test-token-123')).body.jobs.map((r: any) => r.id)).toEqual([2]);
    vi.setSystemTime(new Date('2026-10-18T00:00:02Z'));
    expect((await request('ingest/lead-reviews/2/claim', {}, 'ingest-test-token-123')).body.claimed).toBe(false);
    expect(f.sqlite.prepare('SELECT resolution FROM leads WHERE id=2').get()).toEqual({ resolution: null });
  });
  it('活动截止后不领取官方核实任务，也不写入 checking 状态', async () => {
    offer('deadline-claim', '2026-10-18');
    vi.setSystemTime(new Date('2026-10-19T00:00:00Z'));
    expect((await request('ingest/official-reviews/deadline-claim/claim', {}, 'ingest-test-token-123')).body.claimed).toBe(false);
    expect(f.sqlite.prepare("SELECT official_review FROM offers WHERE id='deadline-claim'").get()).toEqual({ official_review: null });
  });
  it('截止时间决定排序，过期和已批准活动不进入紧急区；读取不改变审核状态', async () => {
    offer('soon', '2026-10-18'); offer('later', '2026-10-20'); offer('expired', '2026-10-17'); offer('approved', '2026-10-18', 'approved');
    const before = f.sqlite.prepare('SELECT * FROM offers ORDER BY id').all();
    expect((await urgentReviewQueue(f.db, now)).urgent.map(r => r.id)).toEqual(['soon', 'later']);
    expect(f.sqlite.prepare('SELECT * FROM offers ORDER BY id').all()).toEqual(before);
    expect((await request('admin/queue')).body.urgent.map((r: any) => r.id)).toEqual(['soon', 'later']);
    vi.setSystemTime(new Date('2026-10-20T12:00:00Z'));
    expect((await urgentReviewQueue(f.db)).urgent.map(r => [r.id, r.tier])).toEqual([['later', 'P0']]);
  });
  it('不紧急可恢复，旧版本偏好不压住修改后的新内容', async () => {
    offer('soon', '2026-10-18');
    const row = (await urgentReviewQueue(f.db)).urgent[0];
    const body = { key: row.key, expectedVersion: row.version, suppressed: true };
    expect((await request('admin/screening/urgency', body)).status).toBe(200);
    expect((await urgentReviewQueue(f.db)).urgent).toHaveLength(0);
    expect((await urgentReviewQueue(f.db)).urgencyDismissed).toHaveLength(1);
    expect((await request('admin/screening/urgency', { ...body, suppressed: false })).status).toBe(200);
    expect((await urgentReviewQueue(f.db)).urgent).toHaveLength(1);
    await request('admin/screening/urgency', body);
    f.sqlite.prepare("UPDATE offers SET title='新的领取条件' WHERE id='soon'").run();
    expect((await request('admin/screening/urgency', body)).status).toBe(409);
    expect((await urgentReviewQueue(f.db)).urgent).toHaveLength(1);
  });
  it('过期、已结案、未登录不能修改排序；审核员可操作', async () => {
    offer('soon', '2026-10-18'); const row = (await urgentReviewQueue(f.db)).urgent[0];
    const body = { key: row.key, expectedVersion: row.version, suppressed: true };
    expect((await request('admin/screening/urgency', body, '')).status).toBe(401);
    expect((await request('admin/screening/urgency', body, 'reviewer-test-token-123456')).status).toBe(200);
    f.sqlite.prepare("UPDATE offers SET review_state='approved' WHERE id='soon'").run();
    expect((await request('admin/screening/urgency', body)).status).toBe(409);
  });
  it('旧今天发码不永久加急，已结案查重任务不再占位', async () => {
    lead(2, '今天发放兑换码'); lead(3, '今天发放兑换码', '2026-10-10T00:00:00Z');
    f.sqlite.exec("INSERT INTO review_tasks(id,task_key,kind) VALUES('t','identity:t','identity')");
    f.sqlite.exec("INSERT INTO screening_items(id,subject_kind,subject_id,state,tier,tier_by,deadline,discovered_at,due_at,updated_at) VALUES('task:t','task','t','owner','P0','screener','2026-10-18T02:00:00Z','2026-10-17T23:00:00Z','2026-10-18T00:00:00Z','2026-10-18T00:00:00Z')");
    expect((await urgentReviewQueue(f.db)).urgent.map(r => r.key)).toEqual(expect.arrayContaining(['task:t', 'lead:2']));
    expect((await urgentReviewQueue(f.db)).urgent.map(r => r.key)).not.toContain('lead:3');
    f.sqlite.exec("UPDATE review_tasks SET state='resolved' WHERE id='t'");
    expect((await urgentReviewQueue(f.db)).urgent.map(r => r.key)).not.toContain('task:t');
  });
  it('按 ID 打开分页外查重任务，不返回其他任务；截止后旧卡不能修改偏好', async () => {
    f.sqlite.exec("INSERT INTO review_tasks(id,task_key,kind) VALUES('a','identity:a','identity'),('z','identity:z','identity')");
    const tasks = await request('admin/identity/tasks?id=z&limit=1');
    expect(tasks.status).toBe(200); expect(tasks.body.tasks.map((t: any) => t.id)).toEqual(['z']);
    offer('deadline', '2026-10-18'); const row = (await urgentReviewQueue(f.db)).urgent[0];
    vi.setSystemTime(new Date('2026-10-19T00:00:00Z'));
    expect((await request('admin/screening/urgency', { key: row.key, expectedVersion: row.version, suppressed: true })).status).toBe(409);
  });
  it('官方核实队列先处理紧急线索，同时保留最老积压名额', async () => {
    for (let id = 2; id <= 6; id++) lead(id, '今天发放兑换码');
    const r = await request('ingest/lead-reviews/queue?limit=4', undefined, 'ingest-test-token-123');
    expect(r.status).toBe(200);
    expect(r.body.jobs.map((r: any) => r.id)).toEqual([2, 3, 4, 1]);
  });
  it('紧急核实超过窗口交人工，不自动批准或关闭', async () => {
    lead(2, '今天发放兑换码', '2026-10-17T22:00:00Z');
    const jobId = '00000000-0000-4000-8000-000000000002';
    f.sqlite.prepare('UPDATE leads SET resolution=? WHERE id=2').run(JSON.stringify({ status: 'checking', jobId, attempts: 1, inconclusive: 0, checkedAt: now.toISOString(), nextAttemptAt: null, reason: 'checking', queries: [], candidates: [] }));
    const r = await request('ingest/lead-reviews/2/result', { jobId, outcome: 'retry', reason: '暂未找到官方证据', queries: [], candidates: [] }, 'ingest-test-token-123');
    expect(r.status).toBe(200); expect(r.body.status).toBe('manual');
    expect(f.sqlite.prepare('SELECT status FROM leads WHERE id=2').get()).toEqual({ status: 'reviewing' });
    expect((await readUrgentReviews(f.db)).find(r => r.key === 'lead:2')?.stage).toContain('人工');
  });
});
