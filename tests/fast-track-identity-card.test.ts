import { it, expect } from 'vitest';
import { auditFixture } from './fixtures/identity/audit';
import { unknown } from './fixtures/identity/terms';
import { canonicalTermsSchema } from '../src/shared/identity/types';

// 2026-10-16: fast-track is offered at every review stage; from a stuck 权益活动查重 card the task closes once the offer is live.
it('fast-track from an identity card publishes the offer and closes the task as a duplicate of it', async () => {
  const f = auditFixture(); try {
    const text = 'Campaign students-2026 gives verified students three months of membership for free.';
    const observation = await f.observation('ft-identity', text);
    const facts = canonicalTermsSchema.parse({ schemaVersion: 'terms-v1', issuerProductId: unknown, mechanism: unknown, benefitPools: [], eligibility: unknown, geography: unknown, claimChannels: unknown, costs: unknown, claimWindow: unknown, occurrenceAnchor: unknown });
    const candidate = await f.candidate('ft-identity', observation, text, facts, { id: 'candidate-students', title: '学生认证免费 3 个月会员', valueText: '学生认证后免费 3 个月会员' });
    const task = (await f.call('ingest/identity-candidates/' + candidate.candidateId + '/resolve', { requestId: 'ft-identity-task' })).body;
    expect(task.outcome).toBe('needs_identity_review');

    const created = await f.call('admin/fast-track', { platformId: 'vendor', url: 'https://vendor.example/students', benefit: '学生认证后免费领 3 个月会员', identityTaskId: task.taskId }, true);
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    expect((await f.call('admin/fast-track', { platformId: 'vendor', url: 'https://vendor.example/x', benefit: '注册赠额', identityTaskId: 'missing-task' }, true)).status).toBe(404);

    await f.call(`ingest/fast-track/${created.body.jobId}/claim`, {});
    const fields = { title: '学生认证免费 3 个月会员', type: 'gift', modalities: ['text'], claimMethod: 'app', requirements: ['student'], audience: 'all', valueText: '学生认证后免费领 3 个月会员', endKind: 'unknown', sourceTz: 'UTC', steps: ['完成学生认证'], excerpts: { benefit: 'Campaign students-2026 gives verified students three months of membership for free.' } };
    let r = await f.call(`ingest/fast-track/${created.body.jobId}/result`, { fields, sourceText: text, model: 'free' });
    for (let i = 0; r.body.state === 'publishing' && i < 10; i++) r = await f.call(`ingest/fast-track/${created.body.jobId}/advance`, {});
    expect(r.body.state, JSON.stringify(r.body)).toBe('published');

    expect(f.sqlite.prepare('SELECT state FROM review_tasks WHERE id=?').get(task.taskId)).toEqual({ state: 'resolved' });
    const decision = f.sqlite.prepare("SELECT action,reason_code,reason_text FROM review_decisions WHERE candidate_id=?").get(candidate.candidateId) as any;
    expect(decision).toMatchObject({ action: 'reject', reason_code: 'duplicate' });
    expect(decision.reason_text).toContain(r.body.offerId);
    expect((await f.call('admin/fast-track', undefined, true)).body.jobs[0]).toMatchObject({ identityTaskId: task.taskId, state: 'published' });
  } finally { f.sqlite.close(); }
});
