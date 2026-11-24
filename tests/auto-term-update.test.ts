import { expect, it } from 'vitest';
import { auditFixture } from './fixtures/identity/audit';
import { displayOffer } from './fixtures/identity/offer';
import { captureLocalSnapshot, buildBackfillPlan, applyBackfillPage } from '../scripts/identity/backfill';
import { sha256 } from '../src/shared/identity/normalize';
import { classifyTermsUpdate } from '../src/shared/identity/auto-update';
import { applyQueuedAutoTermUpdates, listAutoTermUpdates, undoAutoTermUpdate, AUTO_UPDATE_ACTOR } from '../src/worker/identity/auto-update';
import type { OfferIn } from '../src/shared/ingest';

// 2026-11-24 (admin): tier 1 (later deadline) and tier 2 (earlier end, fewer models) apply automatically from the perk's own page.
const base = (): OfferIn => ({ ...displayOffer(), type: 'free', endKind: 'date', claimEnd: '2026-12-31', models: ['model-v1', 'model-v2'] });
const page = 'Rewards\nCampaign signup-2026 grants 10 USD.\nAll new accounts qualify.\nOffer ends March 31, 2027.';
const withEnd = (o: OfferIn, claimEnd: string, validity = 'Offer ends March 31, 2027.'): OfferIn => ({ ...o, claimEnd, evidence: { ...o.evidence, excerpts: { ...o.evidence.excerpts, validity } } });

it('classifies a later quoted deadline, an earlier end and fewer models', () => {
  expect(classifyTermsUpdate(base(), withEnd(base(), '2027-03-31'), page, '2026-11-24')).toMatchObject({ kinds: ['extend_deadline'], fields: { claimEnd: '2027-03-31', endKind: 'date' } });
  const earlier = 'Rewards\nOffer ends December 15, 2026.';
  expect(classifyTermsUpdate(base(), withEnd(base(), '2026-12-15', 'Offer ends December 15, 2026.'), earlier, '2026-11-24')?.kinds).toEqual(['end_earlier']);
  expect(classifyTermsUpdate({ ...base(), endKind: 'standing', claimEnd: null }, withEnd(base(), '2027-03-31'), page, '2026-11-24')?.kinds).toEqual(['end_earlier']);
  expect(classifyTermsUpdate(base(), { ...base(), models: ['model-v1'] }, page, '2026-11-24')).toMatchObject({ kinds: ['fewer_models'], fields: { models: ['model-v1'] } });
});

it('leaves everything else with the owner', () => {
  const next = withEnd(base(), '2027-03-31');
  expect(classifyTermsUpdate(base(), base(), page)).toBeNull(); // wording only
  expect(classifyTermsUpdate(base(), withEnd(base(), '2027-03-31', 'Offer ends soon.'), page)).toBeNull(); // date not quoted
  expect(classifyTermsUpdate(base(), withEnd(base(), '2027-03-31', 'Offer ends March 31, 2027 for students.'), page)).toBeNull(); // quote not on page
  expect(classifyTermsUpdate(base(), { ...next, models: ['model-v1', 'model-v3'] }, page)).toBeNull(); // new model
  expect(classifyTermsUpdate(base(), { ...next, requirements: ['student'] }, page)).toBeNull(); // stricter or looser threshold
  expect(classifyTermsUpdate(base(), { ...next, type: 'new' }, page)).toBeNull();
  expect(classifyTermsUpdate(base(), { ...next, modalities: ['text', 'image'] }, page)).toBeNull();
  expect(classifyTermsUpdate({ ...base(), tags: ['reset'] }, { ...next, tags: ['reset'] }, page)).toBeNull();
  expect(classifyTermsUpdate(base(), { ...next, endKind: 'standing', claimEnd: null }, page)).toBeNull(); // dated → standing
  expect(classifyTermsUpdate(base(), withEnd(base(), '2026-11-01', 'Offer ends November 1, 2026.'), 'Offer ends November 1, 2026.', '2026-11-24')).toBeNull(); // already past
});

const context = { environment: 'synthetic' as const, sourceDatabaseId: 'auto-update', sourceCodeSha: 'd'.repeat(40), approvedBy: 'fixture-admin' };
async function setup() {
  const f = auditFixture(), offer = base();
  await f.call('ingest/offers', [offer], false, { IDENTITY_MODE: 'off' }); f.sqlite.prepare("UPDATE offers SET review_state='approved'").run();
  const plan = await buildBackfillPlan(await captureLocalSnapshot(f.db, context)); await applyBackfillPage(f.db, plan, { environment: 'synthetic', approvedPlanHash: plan.planHash, actor: 'fixture-admin' });
  return { f, offer };
}
async function reread(f: ReturnType<typeof auditFixture>, offer: OfferIn, text: string, patch: Partial<OfferIn>) {
  const url = offer.evidence.url, sourceFetch = { originalUrl: url, finalUrl: url, fetchedUrl: url, method: 'direct', sourceVerified: true, truncated: false, contentHash: await sha256(text) };
  const id = 'vendor-signup-' + (await sha256(text + JSON.stringify(patch))).slice(0, 6);
  const r = await f.call('ingest/offers', [{ ...offer, ...patch, id, sourceText: text, sourceFetch, identityRequestId: 'reread-' + id }]);
  // Like the pipeline: a resolution deferred by the per-request query budget continues in its own request.
  const pending = r.body.results[0].pendingResolution;
  return (pending ? (await f.call(`ingest/identity-candidates/${pending.candidateId}/resolve`, pending)).body : r.body.results[0].identityReceipt) as { outcome: string; reasonCodes: string[] };
}

it('a later deadline on the perk’s own page is applied, listed for spot-check, and undo restores the old terms', async () => {
  const { f, offer } = await setup(); try {
    const receipt = await reread(f, offer, page, withEnd(offer, '2027-03-31'));
    expect(receipt).toMatchObject({ outcome: 'duplicate_approved', reasonCodes: ['same_source_reread', 'auto_update_queued'] });
    const [applied] = await applyQueuedAutoTermUpdates(f.db);
    expect(applied, JSON.stringify(applied)).toMatchObject({ state: 'applied' });
    expect(f.sqlite.prepare('SELECT claim_end, review_state FROM offers WHERE id=?').get(offer.id)).toEqual({ claim_end: '2027-03-31', review_state: 'approved' });
    expect(f.sqlite.prepare("SELECT actor FROM review_decisions WHERE action='approve' ORDER BY created_at DESC LIMIT 1").get()).toEqual({ actor: AUTO_UPDATE_ACTOR });
    const [listed] = await listAutoTermUpdates(f.db);
    expect(listed).toMatchObject({ kinds: ['extend_deadline'], before: { claimEnd: '2026-12-31' }, after: { claimEnd: '2027-03-31' } });
    await undoAutoTermUpdate(f.db, listed.id, 'admin');
    expect(f.sqlite.prepare('SELECT claim_end, review_state FROM offers WHERE id=?').get(offer.id)).toEqual({ claim_end: '2026-12-31', review_state: 'approved' });
    // After an undo the next re-read of that perk is not updated automatically again.
    expect((await reread(f, offer, page + '\n', withEnd(offer, '2027-03-31'))).reasonCodes).not.toContain('auto_update_queued');
  } finally { f.sqlite.close(); }
});

it('an unchanged re-read still just confirms the approved terms', async () => {
  const { f, offer } = await setup(); try {
    const receipt = await reread(f, offer, page, { title: '注册即送 API 赠额' });
    expect(receipt.outcome).toBe('duplicate_approved');
    expect(receipt.reasonCodes).not.toContain('auto_update_queued');
    expect(await applyQueuedAutoTermUpdates(f.db)).toEqual([]);
  } finally { f.sqlite.close(); }
});
