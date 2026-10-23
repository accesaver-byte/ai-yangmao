import { expect, it } from 'vitest';
import { auditFixture } from './fixtures/identity/audit';
import { displayOffer } from './fixtures/identity/offer';
import { captureLocalSnapshot, buildBackfillPlan, applyBackfillPage } from '../scripts/identity/backfill';
import { sha256 } from '../src/shared/identity/normalize';
import { IdentityService } from '../src/worker/identity/service';

// 2026-10-22 (admin): an unchanged re-read of content the owner already rejected on the same page closes on that refusal.
const context = { environment: 'synthetic' as const, sourceDatabaseId: 'page-refusal-fixture', sourceCodeSha: 'd'.repeat(40), approvedBy: 'fixture-admin' };
async function setup() {
  const f = auditFixture(), offer = displayOffer();
  await f.call('ingest/offers', [offer], false, { IDENTITY_MODE: 'off' }); f.sqlite.prepare("UPDATE offers SET review_state='approved'").run();
  const plan = await buildBackfillPlan(await captureLocalSnapshot(f.db, context)); await applyBackfillPage(f.db, plan, { environment: 'synthetic', approvedPlanHash: plan.planHash, actor: 'fixture-admin' });
  return { f, offer };
}
const tutorial = 'https://vendor.example/learn/2022', oldQuote = 'Vendor offers 2,000 free API calls per day for every developer.';
async function read(f: ReturnType<typeof auditFixture>, offer: ReturnType<typeof displayOffer>, page: string, fields: Record<string, unknown> = {}, url = tutorial, benefit = oldQuote) {
  const sourceFetch = { originalUrl: url, finalUrl: url, fetchedUrl: url, method: 'direct', sourceVerified: true, truncated: false, contentHash: await sha256(page) };
  const id = 'vendor-tutorial-' + (await sha256(page + url + JSON.stringify(fields))).slice(0, 6);
  const r = await f.call('ingest/offers', [{ ...offer, id, title: 'Vendor 每天 2,000 次免费调用', type: 'standing', endKind: 'standing', valueText: '每天 2,000 次免费 API 调用', ...fields, evidence: { ...offer.evidence, url, excerpts: { benefit } }, sourceText: page, sourceFetch, identityRequestId: 'tut-' + id }]);
  // Like the pipeline: a resolution deferred by the per-request query budget continues in its own request.
  const pending = r.body.results[0].pendingResolution;
  return (pending ? (await f.call(`ingest/identity-candidates/${pending.candidateId}/resolve`, pending)).body : r.body.results[0].identityReceipt) as { outcome: string; taskId: string; candidateId: string; reasonCodes: string[] };
}
async function ownerReject(f: ReturnType<typeof auditFixture>, receipt: { taskId: string }, reasonCategory = 'duplicate') {
  const rev = (f.sqlite.prepare('SELECT revision FROM review_tasks WHERE id=?').get(receipt.taskId) as { revision: number }).revision;
  const r = await f.call(`admin/identity/tasks/${receipt.taskId}/resolve`, { requestId: 'reject-' + receipt.taskId.slice(0, 8), expectedRevision: rev, action: 'reject', reasonCategory, reason: '旧口径，与已上架条目重复' }, true);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
}
const openCards = (f: ReturnType<typeof auditFixture>) => (f.sqlite.prepare("SELECT count(*) n FROM review_tasks WHERE state IN ('open','manual','checking')").get() as { n: number }).n;

it('an unchanged re-read of a rejected passage closes on the owner refusal instead of opening a card', async () => {
  const { f, offer } = await setup(); try {
    const first = await read(f, offer, `Tutorial\n${oldQuote}\nComments: 3`);
    expect(first.outcome).toBe('needs_identity_review');
    await ownerReject(f, first);
    const before = openCards(f);
    const again = await read(f, offer, `Tutorial\n${oldQuote}\nComments: 7`, { title: 'Vendor 免费 API 调用每日 2,000 次' });
    expect(again).toMatchObject({ outcome: 'duplicate_rejected', reasonCodes: ['same_page_refusal'] });
    expect(openCards(f)).toBe(before);
    const applied = f.sqlite.prepare("SELECT identity_basis_json FROM identity_refusal_applications WHERE candidate_id=?").get(again.candidateId) as { identity_basis_json: string };
    expect(JSON.parse(applied.identity_basis_json)).toMatchObject({ reason: 'same_page_refusal', page: expect.stringContaining('vendor.example/learn/2022') });
  } finally { f.sqlite.close(); }
});
it('a re-read with a new amount, another page, or a different passage still reaches the owner', async () => {
  const { f, offer } = await setup(); try {
    await ownerReject(f, await read(f, offer, `Tutorial\n${oldQuote}`));
    expect((await read(f, offer, `Tutorial\n${oldQuote}\nNow 5,000 calls for students.`, { valueText: '每天 2,000 次免费调用，学生 5,000 次' })).outcome).not.toBe('duplicate_rejected');
    expect((await read(f, offer, `Other\n${oldQuote}`, {}, 'https://vendor.example/learn/3033')).outcome).not.toBe('duplicate_rejected');
    const fresh = 'New developers get 300 bonus calls in their first week.';
    expect((await read(f, offer, `Tutorial\n${oldQuote}\n${fresh}`, { valueText: '新开发者首周 300 次', title: 'Vendor 新开发者首周 300 次' }, tutorial, fresh)).outcome).not.toBe('duplicate_rejected');
  } finally { f.sqlite.close(); }
});
it('only the owner’s refusals count, and never an evidence-gap refusal', async () => {
  const { f, offer } = await setup(); try {
    const gap = await read(f, offer, `Tutorial\n${oldQuote}`);
    await ownerReject(f, gap, 'unverifiable');
    expect((await read(f, offer, `Tutorial\n${oldQuote}\n(更新)`)).outcome).not.toBe('duplicate_rejected');
  } finally { f.sqlite.close(); }
  const second = await setup(); try {
    const card = await read(second.f, second.offer, `Tutorial\n${oldQuote}`);
    const rev = (second.f.sqlite.prepare('SELECT revision FROM review_tasks WHERE id=?').get(card.taskId) as { revision: number }).revision;
    await new IdentityService(second.f.db).decideTask(card.taskId, { requestId: 'policy-reject', expectedRevision: rev, action: 'reject', actor: 'policy:test', role: 'reviewer', reasonCode: 'duplicate', reason: '系统结案' });
    expect((await read(second.f, second.offer, `Tutorial\n${oldQuote}\n(更新)`)).outcome).not.toBe('duplicate_rejected');
  } finally { second.f.sqlite.close(); }
});
it('lists remembered refusals and undo puts the content back in review for good', async () => {
  const { f, offer } = await setup(); try {
    const first = await read(f, offer, `Tutorial\n${oldQuote}`); await ownerReject(f, first);
    await read(f, offer, `Tutorial\n${oldQuote}\nComments: 9`);
    const list = await f.call('admin/screening/spot-check/refusals', undefined, true);
    expect(list.body.refusals).toEqual([expect.objectContaining({ title: 'Vendor 每天 2,000 次免费调用', url: tutorial, closedReads: 1 })]);
    const undo = await f.call(`admin/screening/spot-check/refusals/${list.body.refusals[0].decisionId}/undo`, {}, true);
    expect(undo.status, JSON.stringify(undo.body)).toBe(200);
    expect(f.sqlite.prepare('SELECT state FROM review_tasks WHERE id=?').get(undo.body.taskId)).toEqual({ state: 'open' });
    expect((await f.call('admin/screening/spot-check/refusals', undefined, true)).body.refusals).toEqual([]);
    expect((await read(f, offer, `Tutorial\n${oldQuote}\nComments: 12`)).outcome).not.toBe('duplicate_rejected');
  } finally { f.sqlite.close(); }
});
it('reports a source re-read without new perks and lets the owner disable it with a reason', async () => {
  const { f, offer } = await setup(); try {
    f.sqlite.prepare("INSERT INTO sources(id,platform_id,kind,url,tier) VALUES('vendor-tutorial','vendor','web_list',?,'site')").run(tutorial);
    for (let i = 0; i < 5; i++) await read(f, offer, `Tutorial\n${oldQuote}\nComments: ${i}`, { sourceId: 'vendor-tutorial' });
    const noisy = await f.call('admin/screening/noisy-sources', undefined, true);
    expect(noisy.body.sources).toEqual([expect.objectContaining({ id: 'vendor-tutorial', reads: 5, newPerks: 0, enabled: true })]);
    expect((await f.call('admin/sources/vendor-tutorial/enabled', { on: false }, true)).status).toBe(400);
    const off = await f.call('admin/sources/vendor-tutorial/enabled', { on: false, reason: '整页是过时教程' }, true);
    expect(off.body).toEqual({ ok: true, enabled: false });
    expect(JSON.parse((f.sqlite.prepare("SELECT config FROM sources WHERE id='vendor-tutorial'").get() as { config: string }).config).enabledChange).toMatchObject({ on: false, reason: '整页是过时教程' });
  } finally { f.sqlite.close(); }
});
