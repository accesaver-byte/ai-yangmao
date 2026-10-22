import { expect, it } from 'vitest';
import { auditFixture } from './fixtures/identity/audit';
import { displayOffer } from './fixtures/identity/offer';
import { captureLocalSnapshot, buildBackfillPlan, applyBackfillPage } from '../scripts/identity/backfill';
import { sha256 } from '../src/shared/identity/normalize';

// 2026-10-22 (admin): the pinned screening model's "duplicate of listed X" closes a dedupe card, with an undo.
const context = { environment: 'synthetic' as const, sourceDatabaseId: 'model-dup-fixture', sourceCodeSha: 'c'.repeat(40), approvedBy: 'fixture-admin' };
const TRUSTED = 'pinned/model-a:free';
const env = { SCREENING_MODE: 'shadow', SCREENING_DUPLICATE_MODELS: TRUSTED };
const none = { tier: 'P3', deadline: null, signals: [], quote: null };
async function setup() {
  const f = auditFixture(), offer = displayOffer();
  await f.call('ingest/offers', [offer], false, { IDENTITY_MODE: 'off' }); f.sqlite.prepare("UPDATE offers SET review_state='approved'").run();
  const plan = await buildBackfillPlan(await captureLocalSnapshot(f.db, context)); await applyBackfillPage(f.db, plan, { environment: 'synthetic', approvedPlanHash: plan.planHash, actor: 'fixture-admin' });
  return { f, offer };
}
/** A re-read from a page the owner never confirmed: a dedupe card. */
async function card(f: ReturnType<typeof auditFixture>, offer: ReturnType<typeof displayOffer>, valueText = '新用户注册后可获得 10 美元 API 赠额', url = 'https://vendor.example/zh/rewards') {
  const page = `价格\n活动 signup-2026 赠送 10 美元。\n${valueText}`;
  const sourceFetch = { originalUrl: url, finalUrl: url, fetchedUrl: url, method: 'direct', sourceVerified: true, truncated: false, contentHash: await sha256(page) };
  const r = await f.call('ingest/offers', [{ ...offer, id: 'vendor-zh-' + (await sha256(page)).slice(0, 6), title: '注册即送 API 额度', valueText, evidence: { ...offer.evidence, url, excerpts: { benefit: '活动 signup-2026 赠送 10 美元。' } }, sourceText: page, sourceFetch, identityRequestId: 'card-' + (await sha256(page)).slice(0, 10) }]);
  const receipt = r.body.results[0].identityReceipt; expect(receipt.outcome).toBe('needs_identity_review'); return receipt as { taskId: string; candidateId: string };
}
async function verdict(f: ReturnType<typeof auditFixture>, taskId: string, matchId: string, opts: { model?: string; confidence?: number; verdict?: string; env?: Record<string, string> } = {}) {
  const body = { requestId: `${opts.model ?? TRUSTED}:task:${taskId}:${matchId}`, itemId: `task:${taskId}`, subject: { kind: 'task', taskId, discoveredAt: new Date().toISOString() },
    verdict: { verdict: opts.verdict ?? 'duplicate_published', matchId, ruleId: null, reasonCategory: null, occurrenceCheck: null, confidence: opts.confidence ?? 0.97, evidenceQuote: 'x', explanation: 'x', urgency: none },
    model: opts.model ?? TRUSTED, calibrated: false, promptVersion: 'screening-v2', contextHash: 'h', downgradeReasons: [] };
  return f.call('ingest/screening/verdicts', body, false, opts.env ?? env);
}
const state = (f: ReturnType<typeof auditFixture>, taskId: string) => (f.sqlite.prepare('SELECT state FROM review_tasks WHERE id=?').get(taskId) as { state: string }).state;

it('a trusted duplicate verdict closes the card as a duplicate refusal naming the listed perk', async () => {
  const { f, offer } = await setup(); try {
    const c = await card(f, offer);
    const r = await verdict(f, c.taskId, `offer:${offer.id}`);
    expect(r.body.applied, JSON.stringify(r.body)).toBe(true);
    expect(state(f, c.taskId)).toBe('resolved');
    expect(f.sqlite.prepare("SELECT action, reason_code, actor, reason_text FROM review_decisions WHERE candidate_id=? AND action='reject'").get(c.candidateId)).toMatchObject({ action: 'reject', reason_code: 'duplicate', actor: 'policy:screening-duplicate-v1', reason_text: expect.stringContaining(offer.id) });
    expect(f.sqlite.prepare("SELECT applied_action FROM screening_decisions").get()).toEqual({ applied_action: 'closed_duplicate' });
    expect(f.sqlite.prepare('SELECT review_state, value_text FROM offers WHERE id=?').get(offer.id)).toEqual({ review_state: 'approved', value_text: offer.valueText });
  } finally { f.sqlite.close(); }
});
it.each([
  ['an untrusted fallback model', { model: 'openrouter/random:free' }],
  ['low confidence', { confidence: 0.6 }],
  ['a verdict that is not a listed duplicate', { verdict: 'new_candidate' }],
  ['shadow mode (no trusted models set)', { env: { SCREENING_MODE: 'shadow' } }],
])('keeps the card open for %s', async (_label, opts) => {
  const { f, offer } = await setup(); try {
    const c = await card(f, offer);
    expect((await verdict(f, c.taskId, `offer:${offer.id}`, opts)).body.applied).toBe(false);
    expect(state(f, c.taskId)).not.toBe('resolved');
  } finally { f.sqlite.close(); }
});
it('keeps a card that states a new amount', async () => {
  const { f, offer } = await setup(); try {
    const added = await card(f, offer, '新用户注册后可获得 10 美元 API 赠额，另送 500 积分');
    expect((await verdict(f, added.taskId, `offer:${offer.id}`)).body.applied).toBe(false);
    expect(state(f, added.taskId)).not.toBe('resolved');
  } finally { f.sqlite.close(); }
});
it('keeps a card whose listed match is a reset or a recurring dated perk', async () => {
  const { f, offer } = await setup(); try {
    f.sqlite.prepare("UPDATE offers SET title='Vendor 每周额度重置' WHERE id=?").run(offer.id);
    const c = await card(f, offer);
    expect((await verdict(f, c.taskId, `offer:${offer.id}`)).body.applied).toBe(false);
    expect(state(f, c.taskId)).not.toBe('resolved');
  } finally { f.sqlite.close(); }
});
it('lists a model closure for spot-check, confirms it, or undoes it back into the dedupe queue', async () => {
  const { f, offer } = await setup(); try {
    // A second report of the same perk joins an open card, so each closure gets its own card here.
    const a = await card(f, offer); await verdict(f, a.taskId, `offer:${offer.id}`);
    const b = await card(f, offer, '新用户注册后可获得 10 美元 API 赠额（另一页）', 'https://vendor.example/ja/rewards'); await verdict(f, b.taskId, `offer:${offer.id}`);
    const list = await f.call('admin/screening/spot-check/cards', undefined, true);
    expect(list.body.cards).toHaveLength(2);
    expect(list.body.cards[0]).toMatchObject({ offerId: offer.id, title: '注册即送 API 额度' });
    const byTask = Object.fromEntries(list.body.cards.map((c: { taskId: string; decisionId: string }) => [c.taskId, c.decisionId]));
    expect((await f.call(`admin/screening/spot-check/cards/${byTask[a.taskId]}/confirm`, {}, true)).body).toEqual({ confirmed: true });
    const undo = await f.call(`admin/screening/spot-check/cards/${byTask[b.taskId]}/undo`, {}, true);
    expect(undo.status, JSON.stringify(undo.body)).toBe(200);
    expect(undo.body.more).toBe(false);
    const reopened = undo.body.taskIds[0];
    expect(f.sqlite.prepare('SELECT kind, state FROM review_tasks WHERE id=?').get(reopened)).toEqual({ kind: 'identity', state: 'open' });
    expect(f.sqlite.prepare("SELECT count(*) n FROM review_decisions WHERE candidate_id=? AND action='reject'").get(b.candidateId)).toEqual({ n: 1 });
    expect((await f.call('admin/screening/spot-check/cards', undefined, true)).body.cards).toEqual([]);
    // The reopened card is the owner's now: a later duplicate verdict on it does not close it again.
    expect((await verdict(f, reopened, `offer:${offer.id}`)).body.applied).toBe(false);
    expect(state(f, reopened)).not.toBe('resolved');
  } finally { f.sqlite.close(); }
});
it('the backfill reports first and closes recorded trusted verdicts only when asked', async () => {
  const { f, offer } = await setup(); try {
    const c = await card(f, offer);
    expect((await verdict(f, c.taskId, `offer:${offer.id}`, { env: { SCREENING_MODE: 'shadow' } })).body.applied).toBe(false);
    const dry = await f.call('admin/screening/model-duplicates/apply', {}, true, env);
    expect(dry.body).toMatchObject({ dryRun: true, results: [{ taskId: c.taskId, offerId: offer.id, outcome: 'would close' }] });
    expect(state(f, c.taskId)).not.toBe('resolved');
    const run = await f.call('admin/screening/model-duplicates/apply', { dryRun: false }, true, env);
    expect(run.body.results).toEqual([{ taskId: c.taskId, offerId: offer.id, outcome: 'closed' }]);
    expect(state(f, c.taskId)).toBe('resolved');
    expect((await f.call('admin/screening/model-duplicates/apply', {}, true, { SCREENING_MODE: 'shadow' })).status).toBe(409);
  } finally { f.sqlite.close(); }
});
