import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/worker/index';
import { identityDb } from './fixtures/identity/db';
import { readUrgentReviews, urgentReviewQueue } from '../src/worker/screening/urgent-review';
import { IdentityStore } from '../src/worker/identity/store';
import { IdentityService } from '../src/worker/identity/service';
import { terms } from './fixtures/identity/terms';

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
async function request(path: string, body?: unknown, token = 'admin-test-token-123456', extraEnv = {}) {
  const r = await worker.fetch(new Request(`https://local.test/api/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
    { DB: f.db, ADMIN_TOKEN: 'admin-test-token-123456', INGEST_TOKEN: 'ingest-test-token-123', REVIEWER_TOKENS: 'reviewer:reviewer-test-token-123456', ...extraEnv } as never, {} as ExecutionContext);
  return { status: r.status, body: await r.json() as any };
}

describe('紧急福利本地第一版', () => {
  it('本月内截止的线索仍可领取自动核实，交由月初规则结案而不是滞留', async () => {
    lead(2, '限量兑换码');
    f.sqlite.exec("INSERT INTO screening_items(id,subject_kind,subject_id,state,tier,tier_by,deadline,discovered_at,due_at,updated_at) VALUES('lead:2','lead','2','awaiting_verify','P0','gate0','2026-10-18T00:00:01Z','2026-10-17T23:00:00Z','2026-10-18T00:00:00Z','2026-10-18T00:00:00Z')");
    vi.setSystemTime(new Date('2026-10-18T00:00:02Z'));
    expect((await request('ingest/lead-reviews/queue?ids=2', undefined, 'ingest-test-token-123')).body.jobs.map((r: any) => r.id)).toEqual([2]);
    expect((await request('ingest/lead-reviews/2/claim', {}, 'ingest-test-token-123')).body.claimed).toBe(true);
  });
  it('活动截止后仍可领取官方核实，只是不再加急', async () => {
    offer('deadline-claim', '2026-10-18');
    vi.setSystemTime(new Date('2026-10-19T00:00:00Z'));
    expect((await readUrgentReviews(f.db, new Date())).find(r => r.id === 'deadline-claim')).toMatchObject({ expired: true, tier: 'P3' });
    expect((await request('ingest/official-reviews/deadline-claim/claim', {}, 'ingest-test-token-123')).body.claimed).toBe(true);
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
  it('过期、已结案、未登录和审核员不能修改管理员的全局排序', async () => {
    offer('soon', '2026-10-18'); const row = (await urgentReviewQueue(f.db)).urgent[0];
    const body = { key: row.key, expectedVersion: row.version, suppressed: true };
    expect((await request('admin/screening/urgency', body, '')).status).toBe(401);
    expect((await request('admin/screening/urgency', body, 'reviewer-test-token-123456')).status).toBe(403);
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

async function rawIdentityTask() {
  const store = new IdentityStore(f.db), service = new IdentityService(f.db);
  const text = '今天发放限量兑换码，领取截止 2026-10-18。';
  const observation = await store.recordObservation({ requestId: 'urgent-observation', originalUrl: 'https://vendor.example/urgent',
    finalUrl: 'https://vendor.example/urgent', sourceId: 'vendor-source', text, fetchKind: 'direct', observedAt: now.toISOString() });
  const facts = terms(); facts.issuerProductId = { state: 'unknown' };
  const [candidate] = await store.recordCandidates({ requestId: 'urgent-candidate', observationId: observation.observationId,
    extractionVersion: 'v1', extractionComplete: true, leadIds: [1], candidates: [{ inputId: 'urgent',
      span: { start: 0, end: text.length, quote: text }, quotes: [{ id: 'quote-1', start: 0, end: text.length, quote: text }], facts,
      rawCandidate: { title: '今天发放限量兑换码', valueText: text, endKind: 'date', claimEnd: '2026-10-18', sourceTz: 'UTC' } }] });
  const result = await service.resolveCandidate(candidate.candidateId, 'urgent-resolve');
  return { taskId: result.taskId!, candidateId: candidate.candidateId, service };
}

describe('PR #90 review 回归', () => {
  it('真实入库且没有 display version 的候选按包装内的权益日期进入紧急区', async () => {
    const { taskId } = await rawIdentityTask();
    expect(f.sqlite.prepare('SELECT version_id FROM review_tasks WHERE id=?').get(taskId)).toEqual({ version_id: null });
    expect((await urgentReviewQueue(f.db)).urgent.find(row => row.id === taskId)).toMatchObject({
      title: '今天发放限量兑换码', deadline: '2026-10-18T23:59:59.000Z', tier: 'P0' });
  });

  it('真实身份任务领取只改执行版本，不清除不紧急偏好；候选内容变更会解除偏好', async () => {
    const { taskId, candidateId, service } = await rawIdentityTask();
    const row = (await urgentReviewQueue(f.db)).urgent.find(row => row.id === taskId)!;
    expect((await request('admin/screening/urgency', { key: row.key, expectedVersion: row.version, suppressed: true })).status).toBe(200);
    const before = f.sqlite.prepare('SELECT revision,material_revision FROM review_tasks WHERE id=?').get(taskId) as any;
    await service.claimTask(taskId, { requestId: 'urgent-claim', expectedRevision: before.revision });
    const after = f.sqlite.prepare('SELECT revision,material_revision FROM review_tasks WHERE id=?').get(taskId) as any;
    expect(after.revision).toBeGreaterThan(before.revision); expect(after.material_revision).toBe(before.material_revision);
    expect((await urgentReviewQueue(f.db)).urgencyDismissed.find(row => row.id === taskId)?.version).toBe(row.version);
    f.sqlite.prepare("UPDATE intake_candidates SET raw_candidate_json=json_set(raw_candidate_json,'$.candidate.title','新的领取条件') WHERE id=?").run(candidateId);
    expect((await urgentReviewQueue(f.db)).urgent.some(row => row.id === taskId)).toBe(true);
  });

  it('普通活动领取官方核实任务后不紧急偏好仍有效', async () => {
    offer('lease-stable', '2026-10-18');
    f.sqlite.prepare("UPDATE offers SET evidence=json_set(evidence,'$.tier','media','$.url','https://community.example/urgent') WHERE id='lease-stable'").run();
    const row = (await urgentReviewQueue(f.db)).urgent[0];
    await request('admin/screening/urgency', { key: row.key, expectedVersion: row.version, suppressed: true });
    expect((await request('ingest/official-reviews/lease-stable/claim', {}, 'ingest-test-token-123')).body.claimed).toBe(true);
    expect((await urgentReviewQueue(f.db)).urgencyDismissed[0]?.version).toBe(row.version);
    expect((await urgentReviewQueue(f.db)).urgent).toHaveLength(0);
  });

  it('enforce 下关联 14 个合法活动的真实回执保持在整个请求 50 条 SQL 预算以内', async () => {
    const ids = Array.from({ length: 14 }, (_, n) => `budget-${n}`);
    ids.forEach(id => offer(id, '2026-10-18', 'approved'));
    const jobId = '00000000-0000-4000-8000-000000000090';
    f.sqlite.prepare("UPDATE leads SET title='Vendor 免费 API 额度',resolution=? WHERE id=1").run(JSON.stringify({ status: 'checking', jobId, attempts: 1,
      inconclusive: 0, checkedAt: now.toISOString(), nextAttemptAt: null, reason: 'checking', queries: [], candidates: [] }));
    const statements: string[] = []; f.inject(sql => { statements.push(sql); });
    const result = await request('ingest/lead-reviews/1/result', { jobId, outcome: 'linked', offerIds: ids,
      reason: '已关联官方活动', queries: [], candidates: [] }, 'ingest-test-token-123', { IDENTITY_MODE: 'enforce' });
    expect(result.body).not.toHaveProperty('error');
    expect(result.status).toBe(200); expect(result.body.status).toBe('linked');
    expect(statements.length).toBeLessThanOrEqual(50);
    expect(statements.some(sql => sql.includes('review_urgency_preferences'))).toBe(false);
    expect(f.sqlite.prepare('SELECT status FROM leads WHERE id=1').get()).toEqual({ status: 'linked' });
  });

  it('普通 claim 不读取紧急投影，不扫描其他线索或活动', async () => {
    lead(2, '今天发放兑换码');
    const statements: string[] = []; f.inject(sql => { statements.push(sql); });
    expect((await request('ingest/lead-reviews/2/claim', {}, 'ingest-test-token-123')).body.claimed).toBe(true);
    expect(statements.some(sql => sql.includes('FROM screening_items') || sql.includes('review_urgency_preferences'))).toBe(false);
  });

  it('未应用偏好迁移时审核与核实队列可用，仅排序写入明确返回 503', async () => {
    offer('migration-pending', '2026-10-18'); lead(2, '今天发放兑换码');
    f.sqlite.exec('DROP TABLE review_urgency_preferences');
    for (const [path, token] of [['admin/queue', 'admin-test-token-123456'], ['ingest/lead-reviews/queue', 'ingest-test-token-123'], ['ingest/official-reviews/queue', 'ingest-test-token-123']]) {
      expect((await request(path, undefined, token)).status).toBe(200);
    }
    const row = (await urgentReviewQueue(f.db)).urgent[0];
    expect((await request('admin/screening/urgency', { key: row.key, expectedVersion: row.version, suppressed: true })).status).toBe(503);
  });

  it('数据库故障不能伪装成缺迁移降级', async () => {
    f.inject(sql => { if (sql.includes('review_urgency_preferences')) throw new Error('database unavailable'); });
    await expect(urgentReviewQueue(f.db)).rejects.toThrow('database unavailable');
  });

  it('清理已结束超过 30 天的偏好时保留仍在待审的人工选择', async () => {
    offer('active', '2026-10-18');
    f.sqlite.exec("INSERT INTO review_urgency_preferences(subject_key,subject_version,suppressed,actor,updated_at) VALUES('offer:gone','old',1,'admin','2026-09-01'),('lead:1','active',1,'admin','2026-09-01')");
    const row = (await urgentReviewQueue(f.db)).urgent.find(row => row.id === 'active')!;
    await request('admin/screening/urgency', { key: row.key, expectedVersion: row.version, suppressed: true });
    expect(f.sqlite.prepare('SELECT subject_key FROM review_urgency_preferences ORDER BY subject_key').all()).toEqual([{ subject_key: 'lead:1' }, { subject_key: 'offer:active' }]);
  });
});
