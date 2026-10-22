import { offerIn } from '../../shared/ingest';
import { introducesNothingNew } from '../../shared/identity/perk-anchors';
import { IdentityService } from '../identity/service';
import { IdentityError } from '../identity/store';
import type { Env } from '../index';

/**
 * The screening model's "duplicate of listed X" closes a dedupe card (admin, 2026-10-22). On real cards the pinned
 * models named the listed perk the owner had linked (13 of 14 crawl re-reads on 10-22, no wrong duplicate), while a
 * week of 253 cards was closed by hand, 75% of them duplicates. Closing is a duplicate refusal naming X, so the
 * existing reopen restores the card; every closure is listed for the owner's spot-check with an undo.
 */
export const MODEL_DUPLICATE_ACTOR = 'policy:screening-duplicate-v1';
const MIN_CONFIDENCE = 0.9;
const RESET = /重置|reset/i, RECURRING = /每月|每日|每周|monthly|daily|weekly/i;

/** Only the pinned models listed here may close; the free router's fallbacks never do. Empty keeps shadow mode. */
export function trustedDuplicateModels(env: Pick<Env, 'SCREENING_DUPLICATE_MODELS'>): string[] {
  return (env.SCREENING_DUPLICATE_MODELS ?? '').split(',').map(model => model.trim()).filter(Boolean);
}

type Verdict = { verdict: string; matchId: string | null; confidence: number };
type ListedOffer = { id: string; platform_id: string; title: string; value_text: string; tags: string; models: string; requirements: string; credit_validity: string | null; steps: string; evidence: string; end_kind: string; claim_start: string | null; claim_end: string | null };

/** Why a verdict may not close its card, or null when every guard holds. */
async function blocked(db: D1Database, taskId: string, verdict: Verdict): Promise<{ reason: string } | { task: { revision: number }; offer: ListedOffer }> {
  if (verdict.verdict !== 'duplicate_published' || !verdict.matchId?.startsWith('offer:')) return { reason: 'not a listed duplicate' };
  if (!(verdict.confidence >= MIN_CONFIDENCE)) return { reason: 'low confidence' };
  const task = await db.prepare(`SELECT kind, state, revision FROM review_tasks WHERE id=?`).bind(taskId).first<{ kind: string; state: string; revision: number }>();
  if (!task || task.kind !== 'identity' || !['open', 'manual'].includes(task.state)) return { reason: 'card not open' };
  // The owner already said "not a duplicate" for one of these sources; the model does not get to close it again.
  if (await db.prepare(`SELECT 1 FROM task_candidates tc JOIN review_decisions r ON r.candidate_id=tc.candidate_id WHERE tc.task_id=? AND r.actor=? AND EXISTS(SELECT 1 FROM review_decisions n WHERE n.supersedes_id=r.id) LIMIT 1`).bind(taskId, MODEL_DUPLICATE_ACTOR).first()) return { reason: 'owner undid an earlier closure' };
  const offer = await db.prepare(`SELECT o.id, o.platform_id, o.title, o.value_text, o.tags, o.models, o.requirements, o.credit_validity, o.steps, o.evidence, o.end_kind, o.claim_start, o.claim_end
    FROM offers o JOIN benefit_entities e ON e.canonical_offer_id=o.id WHERE o.id=? AND o.review_state='approved' AND o.withdrawn_at IS NULL AND e.state='active' AND e.current_approved_version_id IS NOT NULL`)
    .bind(verdict.matchId.slice(6)).first<ListedOffer>();
  if (!offer) return { reason: 'match not listed' };
  const listed = `${offer.title} ${offer.value_text}`;
  // A new reset round, or a new edition of a dated recurring event, reads like the last one.
  if ((JSON.parse(offer.tags || '[]') as string[]).includes('reset') || RESET.test(listed) || (offer.end_kind === 'date' && RECURRING.test(listed))) return { reason: 'recurring or reset perk' };
  const rows = await db.prepare(`SELECT c.raw_candidate_json FROM task_candidates tc JOIN intake_candidates c ON c.id=tc.candidate_id WHERE tc.task_id=? AND c.task_id=tc.task_id LIMIT 11`).bind(taskId).all<{ raw_candidate_json: string }>();
  if (!rows.results.length || rows.results.length > 10) return { reason: 'unbounded card' };
  const evidence = JSON.parse(offer.evidence) as { excerpts?: Record<string, string | undefined> };
  const texts = [offer.title, offer.value_text, offer.credit_validity, ...(JSON.parse(offer.steps || '[]') as string[]), ...Object.values(evidence.excerpts ?? {})].filter((text): text is string => !!text);
  for (const row of rows.results) {
    const parsed = offerIn.safeParse(JSON.parse(row.raw_candidate_json).candidate);
    if (!parsed.success || parsed.data.platformId !== offer.platform_id) return { reason: 'other vendor' };
    const candidate = parsed.data;
    if (candidate.tags.includes('reset') || RESET.test(`${candidate.title} ${candidate.valueText}`)) return { reason: 'recurring or reset perk' };
    // The same guard as the owner-authorized same-page re-read: wording is ignored, a new amount/model/requirement is not.
    if (!introducesNothingNew(candidate, { texts, models: JSON.parse(offer.models || '[]'), requirements: JSON.parse(offer.requirements || '[]') })) return { reason: 'states something new' };
    if (offer.end_kind === 'date' && ((candidate.claimStart && offer.claim_start && candidate.claimStart < offer.claim_start) || (candidate.claimEnd && offer.claim_end && candidate.claimEnd > offer.claim_end))) return { reason: 'outside the listed window' };
  }
  return { task, offer };
}

export async function applyModelDuplicate(db: D1Database, taskId: string, verdict: Verdict, meta: { decisionId: string; model: string }): Promise<'closed_duplicate' | null> {
  try {
    const check = await blocked(db, taskId, verdict);
    if ('reason' in check) return null;
    await new IdentityService(db).decideTask(taskId, {
      requestId: `screening-duplicate:${meta.decisionId}`, expectedRevision: check.task.revision, action: 'reject', actor: MODEL_DUPLICATE_ACTOR, role: 'reviewer', reasonCode: 'duplicate',
      reason: `系统查重：与已上架 ${check.offer.id} 重复（模型 ${meta.model}，置信度 ${verdict.confidence}）；候选未出现新的金额、模型或门槛。`,
    });
    return 'closed_duplicate';
  } catch (error) {
    // A card that changed meanwhile, or a request out of query budget, stays with the owner.
    if (error instanceof IdentityError || (error as Error).name === 'IdentityQueryBudgetError') return null;
    throw error;
  }
}

type ClosedRow = { id: string; model: string; confidence: number; match_ref: string; created_at: string; task_id: string };
export type ModelClosedCard = { decisionId: string; taskId: string; title: string; url: string; offerId: string; offerTitle: string; model: string; confidence: number; closedAt: string };

/** Cards the model closed that the owner has not yet confirmed or undone. */
export async function listModelClosedCards(db: D1Database, days = 7): Promise<ModelClosedCard[]> {
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const rows = await db.prepare(`SELECT d.id, d.model, d.confidence, d.match_ref, d.created_at, i.subject_id task_id FROM screening_decisions d JOIN screening_items i ON i.id=d.item_id
    WHERE d.applied_action='closed_duplicate' AND d.owner_outcome IS NULL AND d.created_at>=? ORDER BY d.created_at DESC LIMIT 100`).bind(since).all<ClosedRow>();
  return Promise.all(rows.results.map(async row => {
    const candidate = await db.prepare(`SELECT json_extract(c.raw_candidate_json,'$.candidate.title') title, json_extract(c.raw_candidate_json,'$.candidate.evidence.url') url
      FROM task_candidates tc JOIN intake_candidates c ON c.id=tc.candidate_id WHERE tc.task_id=? ORDER BY c.id LIMIT 1`).bind(row.task_id).first<{ title: string | null; url: string | null }>();
    const offerId = row.match_ref.slice(6), offer = await db.prepare(`SELECT title FROM offers WHERE id=?`).bind(offerId).first<{ title: string }>();
    return { decisionId: row.id, taskId: row.task_id, title: candidate?.title ?? '', url: candidate?.url ?? '', offerId, offerTitle: offer?.title ?? offerId, model: row.model, confidence: row.confidence, closedAt: row.created_at };
  }));
}

async function closure(db: D1Database, decisionId: string) {
  return db.prepare(`SELECT d.id, d.owner_outcome FROM screening_decisions d WHERE d.id=? AND d.applied_action='closed_duplicate'`).bind(decisionId).first<{ id: string; owner_outcome: string | null }>();
}

export async function confirmModelClosedCard(db: D1Database, decisionId: string, actor: string) {
  const row = await closure(db, decisionId);
  if (!row) throw new IdentityError(404, '没有这条系统查重结案');
  const done = await db.prepare(`UPDATE screening_decisions SET owner_outcome='confirmed', owner_actor=?, owner_at=? WHERE id=? AND owner_outcome IS NULL RETURNING id`).bind(actor, new Date().toISOString(), decisionId).first();
  return { confirmed: !!done };
}

/**
 * "Not a duplicate": reopen the refusals this closure wrote, one per request (query budget), back into the queue.
 * The refusal history stays; reopenDecision writes the superseding decision and a fresh card.
 */
export async function undoModelClosedCard(db: D1Database, decisionId: string, actor: string): Promise<{ more: boolean; taskIds: string[] }> {
  const row = await closure(db, decisionId);
  if (!row) throw new IdentityError(404, '没有这条系统查重结案');
  if (row.owner_outcome === 'undone') return { more: false, taskIds: [] };
  const refusal = await db.prepare(`SELECT r.id, c.revision FROM review_decisions r JOIN intake_candidates c ON c.id=r.candidate_id
    WHERE r.idempotency_key LIKE ? AND r.action='reject' AND NOT EXISTS(SELECT 1 FROM review_decisions n WHERE n.supersedes_id=r.id) ORDER BY r.id LIMIT 1`)
    .bind(`decide:screening-duplicate:${decisionId}:%`).first<{ id: string; revision: number }>();
  const taskIds: string[] = [];
  if (refusal) {
    const opened = await new IdentityService(db).reopenDecision(refusal.id, { requestId: `screening-undo:${decisionId}:${refusal.id}`.slice(0, 200), expectedRevision: refusal.revision,
      reason: '管理员抽查：不是重复，放回查重队列', basis: { description: `管理员确认系统查重结案 ${decisionId} 有误，保留拒绝历史并重新查重；不自动批准。` }, actor });
    taskIds.push(opened.taskId);
  }
  const more = !!await db.prepare(`SELECT 1 FROM review_decisions r WHERE r.idempotency_key LIKE ? AND r.action='reject' AND NOT EXISTS(SELECT 1 FROM review_decisions n WHERE n.supersedes_id=r.id) LIMIT 1`)
    .bind(`decide:screening-duplicate:${decisionId}:%`).first();
  if (!more) await db.prepare(`UPDATE screening_decisions SET owner_outcome='undone', owner_actor=?, owner_at=? WHERE id=? AND owner_outcome IS NULL`).bind(actor, new Date().toISOString(), decisionId).run();
  return { more, taskIds };
}

/**
 * Cards opened before the switch already carry a model verdict and are never screened again. Apply their latest
 * trusted verdict through the same guards; a dry run only reports. Paged by card (query budget): about 3 queries per
 * dry-run card, about 20 per closure.
 */
export async function applyRecordedModelDuplicates(db: D1Database, env: Pick<Env, 'SCREENING_DUPLICATE_MODELS'>, input: { dryRun: boolean; cursor?: string | null }) {
  const models = trustedDuplicateModels(env);
  if (!models.length) throw new IdentityError(409, 'SCREENING_DUPLICATE_MODELS 未设置，模型查重仍为影子模式');
  const limit = input.dryRun ? 10 : 2, [afterAt, afterId] = (input.cursor ?? '').split('|');
  const rows = await db.prepare(`SELECT d.id, d.verdict, d.match_ref, d.confidence, d.model, t.id task_id, t.created_at FROM review_tasks t JOIN screening_items i ON i.subject_kind='task' AND i.subject_id=t.id
    JOIN screening_decisions d ON d.id=i.latest_decision_id WHERE t.kind='identity' AND t.state IN ('open','manual') AND d.applied_action IS NULL AND d.model IN (SELECT value FROM json_each(?))
    AND (t.created_at>? OR (t.created_at=? AND t.id>?)) ORDER BY t.created_at, t.id LIMIT ?`).bind(JSON.stringify(models), afterAt ?? '', afterAt ?? '', afterId ?? '', limit)
    .all<{ id: string; verdict: string; match_ref: string | null; confidence: number; model: string; task_id: string; created_at: string }>();
  const results: { taskId: string; offerId: string | null; outcome: string }[] = [];
  for (const row of rows.results) {
    const verdict = { verdict: row.verdict, matchId: row.match_ref, confidence: row.confidence };
    if (input.dryRun) {
      const check = await blocked(db, row.task_id, verdict);
      results.push({ taskId: row.task_id, offerId: row.match_ref?.slice(6) ?? null, outcome: 'reason' in check ? `keep: ${check.reason}` : 'would close' });
      continue;
    }
    const applied = await applyModelDuplicate(db, row.task_id, verdict, { decisionId: row.id, model: row.model });
    if (applied) await db.prepare('UPDATE screening_decisions SET applied_action=?, applied_at=? WHERE id=? AND applied_at IS NULL').bind(applied, new Date().toISOString(), row.id).run();
    results.push({ taskId: row.task_id, offerId: row.match_ref?.slice(6) ?? null, outcome: applied ? 'closed' : 'kept' });
  }
  const last = rows.results.at(-1);
  return { dryRun: input.dryRun, results, nextCursor: rows.results.length === limit && last ? `${last.created_at}|${last.task_id}` : null };
}
