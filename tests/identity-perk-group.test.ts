import { it, expect } from 'vitest';
import { auditFixture } from './fixtures/identity/audit';
import { unknown } from './fixtures/identity/terms';
import { canonicalTermsSchema } from '../src/shared/identity/types';
import { samePerk } from '../src/shared/identity/perk-anchors';

const facts = canonicalTermsSchema.parse({ schemaVersion: 'terms-v1', issuerProductId: unknown, mechanism: unknown, benefitPools: [], eligibility: unknown, geography: unknown, claimChannels: unknown, costs: unknown, claimWindow: unknown, occurrenceAnchor: unknown });

// 2026-10-16: the same perk reported from several pages in different words opened one card each (Vercel trial 9×).
it('reworded reports of one perk share a review card; a different perk of the same vendor gets its own', async () => {
  const f = auditFixture(); try {
    const report = async (id: string, text: string, patch: Record<string, unknown>) => {
      const o = await f.observation(id, text);
      const c = await f.candidate(id, o, text, facts, patch);
      return (await f.call('ingest/identity-candidates/' + c.candidateId + '/resolve', { requestId: id + '-resolve' })).body;
    };
    const a = await report('trial-a', 'Pro plan includes a 14-day trial with $20 credit.', { id: 'vendor-pro-14-day-trial', title: 'Vendor Pro 14 天免费试用', valueText: 'Pro 套餐 14 天试用，送 20 美元额度' });
    const b = await report('trial-b', 'Start a Pro trial: 14 days and $20 in usage credit.', { id: 'vendor-pro-trial-20-credits', title: 'Vendor Pro 试用送 $20', valueText: '免费试用 Pro 14 天，含 $20 用量额度' });
    const c = await report('signup-c', 'New accounts get 500 free image generations.', { id: 'vendor-signup-images', title: 'Vendor 新用户送 500 次生图', valueText: '新注册送 500 次图像生成' });
    expect(a.taskId).toBeTruthy();
    expect(b.taskId).toBe(a.taskId);
    expect(b.reasonCodes).toContain('grouped_with_open_card');
    expect(c.taskId).not.toBe(a.taskId);
    expect(f.sqlite.prepare('SELECT count(*) n FROM task_candidates WHERE task_id=?').get(a.taskId)).toEqual({ n: 2 });
    // One rejection covers the whole card.
    const rev = (f.sqlite.prepare('SELECT revision FROM review_tasks WHERE id=?').get(a.taskId) as { revision: number }).revision;
    const r = await f.call('admin/identity/tasks/' + a.taskId + '/resolve', { requestId: 'group-reject', expectedRevision: rev, action: 'reject', reasonCategory: 'other', reason: 'Pro 主机试用，不是 AI 额度（整组）' }, true);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(f.sqlite.prepare("SELECT count(*) n FROM intake_candidates WHERE task_id IS NULL AND state='resolved_rejected' AND id IN (SELECT candidate_id FROM task_candidates WHERE task_id=?)").get(a.taskId)).toEqual({ n: 2 });
  } finally { f.sqlite.close(); }
});

it('anchors decide, not wording', () => {
  const v = (title: string, valueText: string, models: string[] = []) => ({ platformId: 'opencode', title, valueText, models });
  expect(samePerk(v('OpenCode Zen 13 个限时免费模型', '13 个模型限时免费', ['Big Pickle', 'GLM-5.3-Flash Free']), v('OpenCode 平台多款模型限时免费调用', 'Zen 上 13 个模型免费', ['big pickle', 'GLM-5.3-Flash']))).toBe(true);
  expect(samePerk(v('注册送 10 美元', '新用户 10 美元额度'), v('注册送 50 美元', '新用户 50 美元额度'))).toBe(false);
  expect(samePerk(v('注册送 10 美元', '新用户 10 美元额度'), { ...v('注册送 10 美元', '新用户 10 美元额度'), platformId: 'other' })).toBe(false);
});

it('a one-off regroup merges cards opened before grouping, moves their candidates and re-points waiting leads', async () => {
  const f = auditFixture(); try {
    const report = async (id: string, text: string, patch: Record<string, unknown>) => {
      const o = await f.observation(id, text);
      const c = await f.candidate(id, o, text, facts, patch);
      return { candidateId: c.candidateId, ...(await f.call('ingest/identity-candidates/' + c.candidateId + '/resolve', { requestId: id + '-resolve' })).body };
    };
    const a = await report('old-a', 'Pro plan includes a 14-day trial with $20 credit.', { id: 'vendor-pro-14-day-trial', title: 'Vendor Pro 14 天免费试用', valueText: 'Pro 套餐 14 天试用，送 20 美元额度' });
    const b = await report('old-b', 'Totally different text at first.', { id: 'vendor-other', title: '完全不同的活动', valueText: '新注册送 500 次图像生成' });
    expect(b.taskId).not.toBe(a.taskId);
    // Before grouping existed the second report kept its own card; make it the same perk in other words.
    const raw = JSON.parse((f.sqlite.prepare('SELECT raw_candidate_json r FROM intake_candidates WHERE id=?').get(b.candidateId) as any).r);
    raw.candidate.title = 'Vendor Pro 试用送 $20'; raw.candidate.valueText = '免费试用 Pro 14 天，含 $20 用量额度';
    f.sqlite.prepare('UPDATE intake_candidates SET raw_candidate_json=? WHERE id=?').run(JSON.stringify(raw), b.candidateId);
    f.sqlite.prepare("INSERT INTO leads(id,origin,url,status,title,resolution) VALUES(9401,'aihot','https://x.example/l','reviewing','Vercel 试用',?)").run(JSON.stringify({ status: 'checking', identityTaskIds: [b.taskId] }));

    const dry = await f.call('admin/identity/regroup', { dryRun: true }, true);
    expect(dry.body.plan).toEqual([{ primary: a.taskId, title: 'Vendor Pro 14 天免费试用', absorbed: [{ id: b.taskId, title: 'Vendor Pro 试用送 $20' }] }]);
    expect((f.sqlite.prepare('SELECT state FROM review_tasks WHERE id=?').get(b.taskId) as any).state).not.toBe('cancelled');

    const run = await f.call('admin/identity/regroup', { dryRun: false }, true);
    expect(run.body).toMatchObject({ merged: 1, remaining: 0 });
    expect(f.sqlite.prepare('SELECT state FROM review_tasks WHERE id=?').get(b.taskId)).toEqual({ state: 'cancelled' });
    expect(f.sqlite.prepare('SELECT count(*) n FROM task_candidates WHERE task_id=?').get(a.taskId)).toEqual({ n: 2 });
    expect(f.sqlite.prepare('SELECT task_id FROM intake_candidates WHERE id=?').get(b.candidateId)).toEqual({ task_id: a.taskId });
    expect(JSON.parse((f.sqlite.prepare('SELECT resolution FROM leads WHERE id=9401').get() as any).resolution).identityTaskIds).toEqual([a.taskId]);
    expect((await f.call('admin/identity/regroup', { dryRun: true }, true)).body.plan).toEqual([]);
  } finally { f.sqlite.close(); }
});
