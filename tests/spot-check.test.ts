import { afterEach, beforeEach, expect, it } from 'vitest';
import worker from '../src/worker/index';
import { identityDb } from './fixtures/identity/db';
import { IdentityStore } from '../src/worker/identity/store';
import { aggregateIdentityLead } from '../src/worker/identity/leads';
import { closeLeadByRule, applyRuleToOpenLeads } from '../src/worker/screening/intake-rules';
import { IdentityService } from '../src/worker/identity/service';
import { unknownIdentityTerms } from '../src/worker/identity/adapters';
import { displayOffer } from './fixtures/identity/offer';
import { terms, known } from './fixtures/identity/terms';
import { guessCategory } from '../src/worker/screening/spot-check';

let f: ReturnType<typeof identityDb>;
beforeEach(() => { f = identityDb(); });
afterEach(() => f.sqlite.close());
const env = () => ({ DB: f.db, ADMIN_TOKEN: 'spot-admin-token-0001', INGEST_TOKEN: 'spot-ingest-token-001', REVIEWER_TOKENS: 'rev:spot-reviewer-token-1', IDENTITY_MODE: 'enforce', SCREENING_MODE: 'shadow' }) as any;
async function call(path: string, body?: unknown, token = 'spot-admin-token-0001') {
  const r = await worker.fetch(new Request('https://local.test/api/' + path, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }), env(), {} as any);
  return { status: r.status, body: await r.json() as any };
}
const closed = (id: number, title: string, resolution: Record<string, unknown>) => f.sqlite.prepare("INSERT INTO leads(id,origin,url,status,title,resolution,created_at) VALUES(?,'linuxdo',?,'rejected',?,?,?)")
  .run(id, `https://linux.do/t/topic/${id}`, title, JSON.stringify({ status: 'closed', checkedAt: new Date().toISOString(), ...resolution }), new Date().toISOString());

// 2026-10-16: the owner skims what the system closed by itself; likely misses first; verdicts become calibration labels.
it('lists auto-closed leads the owner has not looked at, likely misses first', async () => {
  closed(9001, '飞牛万兆交换机发布', { reason: '模型判断不是 AI 羊毛' });
  closed(9002, 'Vendor 注册免费送 10 美元额度', { reason: '模型判断不是 AI 羊毛' });
  closed(9003, '外卖红包券天天领', { reason: '入口过滤：标题含「外卖」', ruleId: 'r1' });
  closed(9004, '已经人工处理过的线索', { reason: '中转站' });
  f.sqlite.prepare("INSERT INTO decision_labels(subject_kind,subject_id,category,actor_kind,label_source,labeled_at) VALUES('lead','9004','relay_station','owner','owner',?)").run(new Date().toISOString());
  const { body } = await call('admin/screening/spot-check');
  expect(body.items.map((i: any) => i.id)).toEqual([9002, 9003, 9001]);
  expect(body.items[0]).toMatchObject({ likely: true, closedBy: 'model', category: 'non_ai' });
  expect(body.items[1]).toMatchObject({ closedBy: 'rule', ruleId: 'r1' });
  expect((await call('admin/screening/spot-check', undefined, 'spot-reviewer-token-1')).status).toBe(403);
});

it('confirming records owner labels and removes the leads from the list', async () => {
  closed(9010, '某中转站送余额', { reason: '中转站送额度，不收' });
  const r = await call('admin/screening/spot-check/confirm', { items: [{ id: 9010, category: 'relay_station' }] });
  expect(r.body).toEqual({ confirmed: 1 });
  expect(f.sqlite.prepare("SELECT category, actor_kind FROM decision_labels WHERE subject_kind='lead' AND subject_id='9010'").get()).toEqual({ category: 'relay_station', actor_kind: 'owner' });
  expect((await call('admin/screening/spot-check')).body.items).toEqual([]);
  expect((await call('admin/screening/spot-check/confirm', { items: Array.from({ length: 16 }, (_, i) => ({ id: i + 9100, category: 'non_ai' })) })).status).toBe(400);
});

it('a rule wrong on more than 10% of at least 10 hits retires itself', async () => {
  f.sqlite.exec("INSERT INTO screening_rules(id,kind,scope_kind,category,description,pattern,status,hits,created_at) VALUES('r9','title_pattern','global','non_ai','标题含「月卡」','月卡','active',10,'2026-10-16T00:00:00Z')");
  closed(9020, 'Kimi 会员月卡免费领', { ruleId: 'r9', reason: '入口过滤' });
  closed(9021, '可灵月卡活动', { ruleId: 'r9', reason: '入口过滤' });
  expect((await call('admin/screening/spot-check/9020/wrong', {})).body).toMatchObject({ ok: true, ruleRetired: false }); // 1/10
  expect((await call('admin/screening/spot-check/9021/wrong', {})).body).toMatchObject({ ok: true, ruleRetired: true }); // 2/10 > 10%
  expect(f.sqlite.prepare("SELECT status, overrides FROM screening_rules WHERE id='r9'").get()).toEqual({ status: 'retired', overrides: 2 });
});

it('guesses the category from the closing reason', () => {
  expect(guessCategory('river.ai 是中转站送额度，不收。')).toBe('relay_station');
  expect(guessCategory('火山方舟套餐账号分享，不收账号池。')).toBe('account_pool');
  expect(guessCategory('与已上架活动相同')).toBe('duplicate');
  expect(guessCategory('模型判断不是 AI 羊毛')).toBe('non_ai');
});

async function rejectedClaim(leadId = 1, key = 'claim') {
  const store = new IdentityStore(f.db), service = new IdentityService(f.db);
  const text = 'Campaign signup-2026 grants 10 USD.';
  const observation = await store.recordObservation({ requestId: key, originalUrl: 'https://community.example/' + key, finalUrl: 'https://community.example/' + key,
    text, fetchKind: 'indirect', observedAt: new Date().toISOString() });
  const [candidate] = await store.recordCandidates({ requestId: 'intake-' + key, observationId: observation.observationId, extractionVersion: 'canonical-v1', extractionComplete: true, leadIds: [leadId],
    candidates: [{ inputId: key, span: { start: 0, end: text.length, quote: text }, quotes: [{ id: 'quote-1', quote: text, start: 0, end: text.length }], facts: unknownIdentityTerms(), rawCandidate: {} }] });
  const resolved = await service.resolveCandidate(candidate.candidateId, 'resolve-' + key);
  const decision = await service.decideTask(resolved.taskId!, { requestId: 'reject-' + key, expectedRevision: 0, action: 'reject', reason: '模型判断不是 AI 羊毛', actor: 'pipeline:screen', role: 'admin' });
  f.sqlite.prepare("UPDATE leads SET status='rejected',title='Vendor 免费活动',resolution=? WHERE id=?").run(JSON.stringify({ status: 'closed', reason: '模型判断不是 AI 羊毛', checkedAt: new Date().toISOString() }), leadId);
  return { ...candidate, refusalId: decision.decisionId };
}

it('wrong restores a rejected identity claim as pending review and preserves immutable refusal history', async () => {
  const original = await rejectedClaim();
  const list = await call('admin/screening/spot-check');
  const r = await call('admin/screening/spot-check/1/wrong', { expectedVersion: list.body.items[0].expectedVersion });
  expect(r.status).toBe(200);
  expect(r.body).toMatchObject({ ok: true, more: false, recovery: { state: 'completed', taskIds: [expect.any(String)] } });
  expect(f.sqlite.prepare('SELECT status FROM leads WHERE id=1').get()).toEqual({ status: 'reviewing' });
  expect(f.sqlite.prepare('SELECT action FROM review_decisions WHERE id=?').get(original.refusalId)).toEqual({ action: 'reject' });
  expect(f.sqlite.prepare('SELECT action FROM review_decisions WHERE supersedes_id=?').get(original.refusalId)).toEqual({ action: 'reopen' });
  expect(f.sqlite.prepare('SELECT state FROM intake_candidates WHERE id=?').get(original.candidateId)).toEqual({ state: 'pending_identity' });
  expect(f.sqlite.prepare('SELECT state FROM review_tasks WHERE id=?').get(r.body.recovery.taskIds[0])).toEqual({ state: 'open' });
  expect(f.sqlite.prepare('SELECT count(*) n FROM offers').get()).toEqual({ n: 0 });
  const repeat = await call('admin/screening/spot-check/1/wrong', {});
  expect(repeat.body.recovery).toEqual(r.body.recovery);
  expect(f.sqlite.prepare("SELECT count(*) n FROM review_decisions WHERE action='reopen'").get()).toEqual({ n: 1 });
});

it('repairs a legacy wrong marker regardless of age without recounting overrides or retaining a correct label', async () => {
  await rejectedClaim();
  f.sqlite.exec("INSERT INTO screening_rules(id,kind,scope_kind,category,description,pattern,status,hits,overrides,created_at) VALUES('legacy-rule','title_pattern','global','non_ai','test','活动','active',10,1,'2020-01-01')");
  f.sqlite.prepare("UPDATE leads SET created_at='2020-01-01',resolution=? WHERE id=1").run(JSON.stringify({ status: 'closed', reason: '模型判断不是 AI 羊毛', ruleId: 'legacy-rule', spotCheck: { verdict: 'wrong', at: '2020-01-02', by: 'admin' } }));
  f.sqlite.prepare("INSERT INTO decision_labels(subject_kind,subject_id,category,actor_kind,label_source,justification,labeled_at) VALUES('lead','1','non_ai','owner','owner','抽查确认：自动关闭正确','2020-01-01')").run();
  const list = await call('admin/screening/spot-check');
  expect(list.body.items).toMatchObject([{ id: 1, recoveryPending: true }]);
  const response = await call('admin/screening/spot-check/1/wrong', {});
  expect(response.body).toMatchObject({ recovery: { state: 'completed' } });
  expect(f.sqlite.prepare("SELECT overrides FROM screening_rules WHERE id='legacy-rule'").get()).toEqual({ overrides: 1 });
  expect(f.sqlite.prepare("SELECT count(*) n FROM decision_labels WHERE subject_kind='lead' AND subject_id='1'").get()).toEqual({ n: 0 });
  expect((await call('admin/screening/spot-check')).body.items).toEqual([]);
});

it('restores rule-only closures, counts their override once, and rejects stale spotcheck actions', async () => {
  closed(9030, 'Vendor 免费额度', { reason: '入口过滤', ruleId: 'r' });
  f.sqlite.exec("INSERT INTO screening_rules(id,kind,scope_kind,category,description,pattern,status,hits,created_at) VALUES('r','title_pattern','global','non_ai','test','免费','active',10,'2020-01-01')");
  const snapshot = (await call('admin/screening/spot-check')).body.items[0].expectedVersion;
  const first = await call('admin/screening/spot-check/9030/wrong', { expectedVersion: snapshot });
  expect(first.body).toMatchObject({ recovery: { state: 'completed', taskIds: [] }, more: false });
  expect(f.sqlite.prepare('SELECT status FROM leads WHERE id=9030').get()).toEqual({ status: 'reviewing' });
  expect((await call('admin/screening/spot-check/confirm', { items: [{ id: 9030, category: 'non_ai', expectedVersion: snapshot }] })).body).toEqual({ confirmed: 0 });
  expect((await call('admin/screening/spot-check/9030/wrong', { expectedVersion: snapshot })).status).toBe(409);
  expect((await call('admin/screening/spot-check/9030/wrong', { expectedVersion: first.body.expectedVersion })).status).toBe(200);
  expect(f.sqlite.prepare("SELECT overrides FROM screening_rules WHERE id='r'").get()).toEqual({ overrides: 1 });
  expect((await call('admin/screening/spot-check/9030/wrong', {}, 'spot-reviewer-token-1')).status).toBe(403);
});

it('leaves a linked approved canonical item published while correcting its old closure marker', async () => {
  const store = new IdentityStore(f.db), service = new IdentityService(f.db), facts = terms(); facts.occurrenceAnchor = known('signup-2026');
  const text = 'Campaign signup-2026 grants 10 USD.';
  const obs = await store.recordObservation({ requestId: 'approved', originalUrl: 'https://vendor.example/rewards', finalUrl: 'https://vendor.example/rewards', sourceId: 'vendor-source', text, fetchKind: 'direct', observedAt: new Date().toISOString() });
  const [candidate] = await store.recordCandidates({ requestId: 'approved-intake', observationId: obs.observationId, extractionVersion: 'canonical-v1', extractionComplete: true, leadIds: [1], candidates: [{ inputId: 'approved', span: { start: 0, end: text.length, quote: text }, quotes: [{ id: 'quote-1', start: 0, end: text.length, quote: text }], facts, rawCandidate: displayOffer() }] });
  const resolved = await service.resolveCandidate(candidate.candidateId, 'approved-resolve');
  await service.decideTask(resolved.taskId!, { requestId: 'approved-decision', expectedRevision: 0, action: 'approve', actor: 'admin', role: 'admin' });
  f.sqlite.prepare("UPDATE leads SET status='linked',offer_id=?,resolution=? WHERE id=1").run(resolved.canonicalOfferId, JSON.stringify({ reason: '旧自动关闭标记' }));
  const response = await call('admin/screening/spot-check/1/wrong', {});
  expect(response.body).toMatchObject({ recovery: { state: 'completed' } });
  expect(f.sqlite.prepare('SELECT status,offer_id FROM leads WHERE id=1').get()).toEqual({ status: 'linked', offer_id: resolved.canonicalOfferId });
  expect(f.sqlite.prepare('SELECT review_state FROM offers').get()).toEqual({ review_state: 'approved' });
  expect(f.sqlite.prepare("SELECT count(*) n FROM review_decisions WHERE action='reopen'").get()).toEqual({ n: 0 });
});

it('continues one refusal per request under fifty SQL statements and leaves a durable pending marker', async () => {
  await rejectedClaim(1, 'one');
  await rejectedClaim(1, 'two');
  let count = 0; f.inject(() => { count++; if (count > 50) throw new Error('D1 request statement budget'); });
  const first = await call('admin/screening/spot-check/1/wrong', {});
  expect(first.status).toBe(200); expect(first.body).toMatchObject({ more: true, recovery: { state: 'pending' } }); expect(count).toBeLessThanOrEqual(50);
  expect(f.sqlite.prepare('SELECT status FROM leads WHERE id=1').get()).toEqual({ status: 'rejected' });
  count = 0;
  const second = await call('admin/screening/spot-check/1/wrong', { expectedVersion: first.body.expectedVersion });
  expect(second.status).toBe(200); expect(second.body).toMatchObject({ more: false, recovery: { state: 'completed', taskIds: [expect.any(String), expect.any(String)] } }); expect(count).toBeLessThanOrEqual(50);
  expect(f.sqlite.prepare('SELECT status FROM leads WHERE id=1').get()).toEqual({ status: 'reviewing' });
  expect(f.sqlite.prepare("SELECT count(*) n FROM review_decisions WHERE action='reopen'").get()).toEqual({ n: 2 });
});

it('a maximum bounded ten-candidate entity refusal can be restored in one request within D1 budget', async () => {
  const store = new IdentityStore(f.db), service = new IdentityService(f.db), facts = terms(); facts.occurrenceAnchor = known('signup-2026');
  const text = 'Campaign signup-2026 grants 10 USD.';
  let taskId = '';
  for (let index = 0; index < 10; index++) {
    const obs = await store.recordObservation({ requestId: 'ten-ob-' + index, originalUrl: 'https://vendor.example/ten-' + index, finalUrl: 'https://vendor.example/ten-' + index, sourceId: 'vendor-source', text, fetchKind: 'direct', observedAt: new Date().toISOString() });
    const [candidate] = await store.recordCandidates({ requestId: 'ten-' + index, observationId: obs.observationId, extractionVersion: 'canonical-v1', extractionComplete: true, leadIds: [1], candidates: [{ inputId: 'ten-' + index, span: { start: 0, end: text.length, quote: text }, quotes: [{ id: 'quote-1', start: 0, end: text.length, quote: text }], facts, rawCandidate: displayOffer() }] });
    taskId = (await service.resolveCandidate(candidate.candidateId, 'ten-resolve-' + index)).taskId!;
  }
  const revision = Number(f.sqlite.prepare('SELECT revision FROM review_tasks WHERE id=?').get(taskId)?.revision);
  await service.decideTask(taskId, { requestId: 'ten-reject', expectedRevision: revision, action: 'reject', actor: 'admin', role: 'admin' });
  f.sqlite.prepare("UPDATE leads SET status='rejected',title='Vendor 免费活动',resolution=? WHERE id=1").run(JSON.stringify({ status: 'closed', reason: '错误关闭' }));
  let statements = 0; f.inject(() => { statements++; if (statements > 50) throw new Error('D1 query budget'); });
  const result = await call('admin/screening/spot-check/1/wrong', {});
  expect(result.status).toBe(200); expect(statements).toBeLessThanOrEqual(50);
  expect(result.body).toMatchObject({ more: false, recovery: { state: 'completed' } });
  expect(f.sqlite.prepare("SELECT count(*) n FROM intake_candidates WHERE state='pending_identity'").get()).toEqual({ n: 10 });
  expect(f.sqlite.prepare('SELECT review_state FROM offers').get()).toEqual({ review_state: 'rejected' });
});

it('parallel wrong requests count one override and preserve one durable recovery', async () => {
  f.sqlite.exec("INSERT INTO screening_rules(id,kind,scope_kind,category,description,pattern,status,hits,created_at) VALUES('parallel','title_pattern','global','non_ai','test','免费','active',10,'2020-01-01')");
  closed(9040, 'Vendor 免费活动', { reason: '入口过滤', ruleId: 'parallel' });
  const snapshot = (await call('admin/screening/spot-check')).body.items[0].expectedVersion;
  const outcomes = await Promise.all([call('admin/screening/spot-check/9040/wrong', { expectedVersion: snapshot }), call('admin/screening/spot-check/9040/wrong', { expectedVersion: snapshot })]);
  expect(outcomes.map(r => r.status).sort()).toEqual([200, 409]);
  expect(f.sqlite.prepare("SELECT overrides FROM screening_rules WHERE id='parallel'").get()).toEqual({ overrides: 1 });
  expect(f.sqlite.prepare('SELECT status FROM leads WHERE id=9040').get()).toEqual({ status: 'reviewing' });
});

it('an interruption after reopening remains repairable without another reopen decision', async () => {
  await rejectedClaim();
  let interrupted = false;
  f.inject(sql => { if (!interrupted && sql.includes('SELECT DISTINCT t.id FROM lead_candidate_links')) { interrupted = true; throw new Error('simulated interruption after identity commit'); } });
  expect((await call('admin/screening/spot-check/1/wrong', {})).status).toBe(500);
  f.inject();
  const pending = (await call('admin/screening/spot-check')).body.items[0]; expect(pending.recoveryPending).toBe(true);
  const repaired = await call('admin/screening/spot-check/1/wrong', { expectedVersion: pending.expectedVersion });
  expect(repaired.body).toMatchObject({ more: false, recovery: { state: 'completed', taskIds: [expect.any(String)] } });
  expect(f.sqlite.prepare("SELECT count(*) n FROM review_decisions WHERE action='reopen'").get()).toEqual({ n: 1 });
});

it('identity aggregation retains the wrong correction audit and recovered task history', async () => {
  await rejectedClaim();
  const response = await call('admin/screening/spot-check/1/wrong', {});
  const before = JSON.parse(String(f.sqlite.prepare('SELECT resolution FROM leads WHERE id=1').get()?.resolution));
  await aggregateIdentityLead(f.db, 1);
  const after = JSON.parse(String(f.sqlite.prepare('SELECT resolution FROM leads WHERE id=1').get()?.resolution));
  expect(after.spotCheck).toEqual(before.spotCheck);
  expect(after.identityTaskIds).toEqual(response.body.recovery.taskIds);
  expect(after.status).toBe('manual');
});

it('an explicit wrong correction survives both direct and swept title rule closure', async () => {
  closed(9050, 'Vendor 免费活动', { reason: '入口过滤' });
  await call('admin/screening/spot-check/9050/wrong', {});
  const rule = { id: 'cannot-reclose', kind: 'title_pattern' as const, scopeKind: 'global' as const, scopeValue: null, category: 'non_ai' as const, description: 'test', pattern: '免费', status: 'active' as const };
  const lead = f.sqlite.prepare('SELECT id,url,status,raw,title,resolution,offer_id FROM leads WHERE id=9050').get() as any;
  expect(await closeLeadByRule(f.db, lead, rule)).toBe(false);
  expect(await applyRuleToOpenLeads(f.db, rule)).toEqual({ closed: 0, more: false });
  expect(f.sqlite.prepare('SELECT status FROM leads WHERE id=9050').get()).toEqual({ status: 'reviewing' });
});

it('a corrected owner confirmation removes its old rejection label and retains the previous verdict for audit', async () => {
  closed(9060, 'Vendor 免费活动', { reason: '模型判断不是 AI 羊毛' });
  expect((await call('admin/screening/spot-check/confirm', { items: [{ id: 9060, category: 'non_ai' }] })).body).toEqual({ confirmed: 1 });
  expect((await call('admin/screening/spot-check/9060/wrong', {})).status).toBe(200);
  const saved = JSON.parse(String(f.sqlite.prepare('SELECT resolution FROM leads WHERE id=9060').get()?.resolution));
  expect(saved.spotCheck).toMatchObject({ verdict: 'wrong', previous: { verdict: 'correct' }, recovery: { previousReason: '模型判断不是 AI 羊毛' } });
  expect(saved.reason).toBe('管理员抽查确认误关，恢复待审');
  expect(f.sqlite.prepare("SELECT count(*) n FROM decision_labels WHERE subject_kind='lead' AND subject_id='9060'").get()).toEqual({ n: 0 });
});

it('fifteen correct confirmations stay within one fifty-statement admin request', async () => {
  const items = Array.from({ length: 15 }, (_, index) => ({ id: 9070 + index, category: 'non_ai' }));
  for (const item of items) closed(item.id, '普通新闻', { reason: '新闻' });
  let count = 0; f.inject(() => { count++; if (count > 50) throw new Error('D1 query budget'); });
  expect((await call('admin/screening/spot-check/confirm', { items })).body).toEqual({ confirmed: 15 });
  expect(count).toBeLessThanOrEqual(50);
});
