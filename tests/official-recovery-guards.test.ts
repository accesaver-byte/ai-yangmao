import { afterEach, beforeEach, expect, it } from 'vitest';
import worker from '../src/worker/index';
import { IdentityService } from '../src/worker/identity/service';
import { IdentityStore } from '../src/worker/identity/store';
import { unknownIdentityTerms } from '../src/worker/identity/adapters';
import { openRouterEvidenceGap } from '../src/shared/official-lead-policy';
import { recordOwnerLabel } from '../src/worker/screening/labels';
import { identityDb } from './fixtures/identity/db';
import { displayOffer } from './fixtures/identity/offer';
import { known, terms } from './fixtures/identity/terms';

let f: ReturnType<typeof identityDb>;
beforeEach(() => { f = identityDb(); });
afterEach(() => f.sqlite.close());
const openRouterPost = 'https://x.com/OpenRouter/status/2110755162214338984';
const oldReason = '历史错误：只是模型新闻，没有免费额度';
const env = () => ({ DB: f.db, ADMIN_TOKEN: 'recovery-admin-token-0001', INGEST_TOKEN: 'recovery-ingest-token-001', IDENTITY_MODE: 'enforce' }) as any;

async function corrections() {
  const response = await worker.fetch(new Request('https://local.test/api/ingest/corrections?limit=100', {
    headers: { Authorization: 'Bearer recovery-ingest-token-001' },
  }), env(), {} as ExecutionContext);
  expect(response.status).toBe(200);
  return (await response.json() as { corrections: string[] }).corrections;
}

async function recover() {
  const response = await worker.fetch(new Request('https://local.test/api/admin/screening/spot-check/1/wrong', {
    method: 'POST', headers: { Authorization: 'Bearer recovery-admin-token-0001', 'Content-Type': 'application/json' }, body: '{}',
  }), env(), {} as ExecutionContext);
  expect(response.status).toBe(200);
  return await response.json() as { recovery: { state: string; taskIds: string[] } };
}

async function rejectedEntity(openRouter = false) {
  const store = new IdentityStore(f.db), service = new IdentityService(f.db), facts = terms();
  facts.occurrenceAnchor = known('signup-2026');
  const url = openRouter ? openRouterPost : 'https://vendor.example/rewards';
  if (openRouter) {
    f.sqlite.exec(`INSERT INTO platforms(id,name,type,status,site,x_handles) VALUES('openrouter','OpenRouter','infra','approved','https://openrouter.ai','["@OpenRouter"]')`);
    facts.issuerProductId = known('openrouter');
    f.sqlite.prepare('UPDATE leads SET url=? WHERE id=1').run(url);
  }
  const text = 'Campaign signup-2026 grants 10 USD.';
  const observation = await store.recordObservation({ requestId: 'entity-observation', originalUrl: url, finalUrl: url,
    ...(!openRouter ? { sourceId: 'vendor-source' } : {}), text, fetchKind: 'direct', observedAt: new Date().toISOString() });
  const display = displayOffer();
  if (openRouter) { display.platformId = 'openrouter'; display.evidence.url = url; display.evidence.tier = 'official'; }
  const [candidate] = await store.recordCandidates({ requestId: 'entity-candidate', observationId: observation.observationId,
    extractionVersion: 'test', extractionComplete: true, leadIds: [1], candidates: [{ inputId: 'entity',
      span: { start: 0, end: text.length, quote: text }, quotes: [{ id: 'quote-1', start: 0, end: text.length, quote: text }], facts, rawCandidate: display }] });
  const receipt = await service.resolveCandidate(candidate.candidateId, 'entity-resolve');
  // A supported category permits creation of historical refusal state without bypassing the current guard.
  const refusal = await service.decideTask(receipt.taskId!, { requestId: 'entity-reject', expectedRevision: 0,
    action: 'reject', actor: 'admin', role: 'admin', reasonCode: openRouter ? 'paid_bundle' : 'other',
    reason: openRouter ? '官方条款确认属于付费套餐内含权益' : oldReason });
  f.sqlite.prepare("UPDATE leads SET status='rejected',title='官方活动',resolution=? WHERE id=1")
    .run(JSON.stringify({ status: 'closed', reason: openRouter ? '历史已关闭' : oldReason }));
  return { service, refusal, candidate };
}

it('removes a superseded entity refusal from corrections while retaining its immutable review history', async () => {
  const { refusal } = await rejectedEntity();
  expect((await corrections()).some(line => line.includes(oldReason))).toBe(true);
  expect((await recover()).recovery.state).toBe('completed');
  expect(f.sqlite.prepare('SELECT action FROM review_decisions WHERE supersedes_id=?').get(refusal.decisionId)).toEqual({ action: 'reopen' });
  expect(f.sqlite.prepare('SELECT reason FROM reviews WHERE decision_id=?').get(refusal.decisionId)).toEqual({ reason: oldReason });
  expect((await corrections()).some(line => line.includes(oldReason))).toBe(false);
});

it('keeps a fresh valid owner rejection label after an earlier wrong-closure recovery', async () => {
  const store = new IdentityStore(f.db), service = new IdentityService(f.db);
  const text = 'The official terms confirm this feature requires a paid subscription.';
  const observation = await store.recordObservation({ requestId: 'claim-observation', originalUrl: 'https://vendor.example/news',
    finalUrl: 'https://vendor.example/news', sourceId: 'vendor-source', text, fetchKind: 'direct', observedAt: new Date().toISOString() });
  const [candidate] = await store.recordCandidates({ requestId: 'claim-candidate', observationId: observation.observationId,
    extractionVersion: 'test', extractionComplete: true, leadIds: [1], candidates: [{ inputId: 'claim',
      span: { start: 0, end: text.length, quote: text }, quotes: [{ id: 'quote-1', start: 0, end: text.length, quote: text }],
      facts: unknownIdentityTerms(), rawCandidate: { title: '重新核实的付费套餐权益', platformId: 'vendor' } }] });
  const receipt = await service.resolveCandidate(candidate.candidateId, 'claim-resolve');
  await service.decideTask(receipt.taskId!, { requestId: 'claim-old-reject', expectedRevision: 0, action: 'reject', actor: 'admin', role: 'admin', reason: oldReason });
  f.sqlite.prepare("UPDATE leads SET status='rejected',title='原先错误关闭的线索',resolution=? WHERE id=1").run(JSON.stringify({ status: 'closed', reason: oldReason }));
  const recovered = await recover();
  const freshReason = '重新核对官方条款，确认为付费套餐内含权益';
  await service.decideTask(recovered.recovery.taskIds[0], { requestId: 'claim-fresh-reject', expectedRevision: 0,
    action: 'reject', actor: 'admin', role: 'admin', reasonCode: 'paid_bundle', reason: freshReason });
  await recordOwnerLabel(f.db, { subjectKind: 'candidate', subjectId: candidate.candidateId,
    category: 'paid_bundle', actor: 'admin', justification: freshReason });
  expect(f.sqlite.prepare("SELECT count(*) n FROM review_decisions d WHERE d.action='reject' AND NOT EXISTS(SELECT 1 FROM review_decisions newer WHERE newer.supersedes_id=d.id)").get()).toEqual({ n: 1 });
  expect((await corrections()).some(line => line.includes(freshReason))).toBe(true);
});

it('protects a reopened entity task from another missing-evidence OpenRouter rejection', async () => {
  const { service, refusal } = await rejectedEntity(true);
  const entity = f.sqlite.prepare('SELECT business_revision FROM benefit_entities').get()!;
  const reopened = await service.reopenDecision(refusal.decisionId, { requestId: 'official-reopen', expectedRevision: Number(entity.business_revision),
    reason: '先前拒绝需重新核实', basis: { description: '管理员要求补读官方模型链接后重新审核' }, actor: 'admin' });
  expect(f.sqlite.prepare('SELECT kind FROM review_tasks WHERE id=?').get(reopened.taskId)).toEqual({ kind: 'evidence_reopen' });
  await expect(service.decideTask(reopened.taskId, { requestId: 'official-repeat-reject', expectedRevision: 0,
    action: 'reject', actor: 'admin', role: 'admin', reasonCode: 'insufficient_evidence', reason: '没有免费额度，证据不足' })).rejects.toMatchObject({ status: 409 });
  expect(f.sqlite.prepare('SELECT state FROM review_tasks WHERE id=?').get(reopened.taskId)).toEqual({ state: 'open' });
});

it.each([
  '@OpenRouter\nTry it: https://t.co/example',
  '@OpenRouter\n2026-10-15T15:30:21.000Z\nTry it: https://t.co/example',
])('recognizes a navigation-only embed with an optional date header: %s', text => {
  expect(openRouterEvidenceGap(openRouterPost, 'other', '模型判断不是 AI 羊毛', text)).toBe(true);
});
