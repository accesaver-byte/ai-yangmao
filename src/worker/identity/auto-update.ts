/**
 * Automatic term updates of approved perks (2026-11-24, admin: tiers 1 and 2, live). The same-page re-read queues a
 * qualifying change (shared/identity/auto-update.ts); this sweep applies it through the ordinary identity edit and
 * approval path, so every publication guard still runs. A change a guard refuses stays as an ordinary update card for
 * the owner. Undo restores the previous approved terms and stops automatic updates for that perk.
 */
import { offerIn, type OfferIn } from '../../shared/ingest';
import { classifyTermsUpdate } from '../../shared/identity/auto-update';
import { entityOfferVersion } from './canonical';
import { IdentityService } from './service';
import { IdentityError } from './store';
import type { ReviewedLegacyMatch } from './reviewed-legacy';

export const AUTO_UPDATE_ACTOR = 'policy:auto-update-v1';
const KIND_TEXT: Record<string, string> = { extend_deadline: '延期', end_earlier: '提前结束', fewer_models: '模型减少' };

export async function queueAutoTermUpdate(db: D1Database, reviewed: ReviewedLegacyMatch, candidateId: string, raw: string, page: string) {
  const next = offerIn.safeParse(JSON.parse(raw).candidate), approved = offerIn.safeParse(JSON.parse(reviewed.display));
  if (!next.success || !approved.success) return null;
  const update = classifyTermsUpdate(approved.data, next.data, page);
  if (!update) return null;
  // After the owner undid one automatic update of this perk, its changes go back to the owner.
  if (await db.prepare("SELECT 1 FROM auto_term_updates WHERE entity_id=? AND state IN ('undone','queued') LIMIT 1").bind(reviewed.entityId).first()) return null;
  const previous = Object.fromEntries(Object.keys(update.fields).map(key => [key, (approved.data as Record<string, unknown>)[key] ?? null]));
  return { id: crypto.randomUUID(), entity_id: reviewed.entityId, offer_id: reviewed.offerId, candidate_id: candidateId, base_version_id: reviewed.versionId,
    kinds_json: JSON.stringify(update.kinds), fields_json: JSON.stringify(update.fields), previous_json: JSON.stringify(previous) };
}

type Row = { id: string; entity_id: string; offer_id: string; base_version_id: string; kinds_json: string; fields_json: string; previous_json: string; state: string; decision_id: string | null };

/** Edit then approve as one policy decision. Returns the approval decision ID. */
async function publish(db: D1Database, offerId: string, entityId: string, fields: Record<string, unknown> | Partial<OfferIn>, requestId: string, actor: string, role: 'admin', reason: string) {
  const service = new IdentityService(db);
  const entity = await db.prepare("SELECT id,business_revision FROM benefit_entities WHERE id=? AND state='active'").bind(entityId).first<{ id: string; business_revision: number }>();
  const offer = await db.prepare('SELECT updated_at FROM offers WHERE id=?').bind(offerId).first<{ updated_at: string }>();
  if (!entity || !offer) throw new IdentityError(409, '条目已不存在');
  const edit = await service.editManagedOffer(offerId, { requestId: requestId + ':edit', expectedOfferVersion: entityOfferVersion(entity, offer.updated_at), fields, actor });
  if (!edit.taskId) return null; // display-only edit applied directly
  return (await service.decideTask(edit.taskId, { requestId: requestId + ':approve', expectedRevision: edit.revision, action: 'approve', actor, role, reason, reasonCode: 'other' })).decisionId;
}

export async function applyQueuedAutoTermUpdates(db: D1Database, limit = 3) {
  const rows = (await db.prepare("SELECT * FROM auto_term_updates WHERE state='queued' ORDER BY created_at LIMIT ?").bind(limit).all<Row>()).results;
  const results: { id: string; state: string; detail?: string }[] = [];
  for (const row of rows) {
    const finish = async (state: string, detail: string | null, decisionId: string | null = null) => {
      await db.prepare("UPDATE auto_term_updates SET state=?, detail=?, decision_id=?, applied_at=? WHERE id=? AND state='queued'").bind(state, detail, decisionId, new Date().toISOString(), row.id).run();
      results.push({ id: row.id, state, ...(detail ? { detail } : {}) });
    };
    const current = await db.prepare("SELECT current_approved_version_id v FROM benefit_entities WHERE id=?").bind(row.entity_id).first<{ v: string | null }>();
    if (current?.v !== row.base_version_id) { await finish('skipped', '已批准版本已变化'); continue; }
    if (await db.prepare("SELECT 1 FROM review_tasks WHERE entity_id=? AND kind IN ('initial','terms_change','evidence_reopen') AND state IN ('open','checking','manual') LIMIT 1").bind(row.entity_id).first()) { await finish('skipped', '已有待审更新，交管理员处理'); continue; }
    const kinds = (JSON.parse(row.kinds_json) as string[]).map(k => KIND_TEXT[k] ?? k).join('、');
    try {
      const decisionId = await publish(db, row.offer_id, row.entity_id, JSON.parse(row.fields_json), 'auto-update:' + row.id, AUTO_UPDATE_ACTOR, 'admin', `自动条款更新（${kinds}）：同一官方页面重读，2026-11-24 管理员授权`);
      await finish('applied', null, decisionId);
    } catch (error) {
      // The edit may have opened an update card before a guard refused approval; it stays for the owner.
      await finish('failed', error instanceof Error ? error.message.slice(0, 500) : String(error));
    }
  }
  return results;
}

export async function listAutoTermUpdates(db: D1Database, days = 7) {
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const rows = await db.prepare(`SELECT u.id, u.offer_id offerId, o.title, u.kinds_json, u.fields_json, u.previous_json, u.state, u.detail, u.applied_at appliedAt
    FROM auto_term_updates u LEFT JOIN offers o ON o.id=u.offer_id WHERE u.state IN ('applied','failed') AND u.owner_at IS NULL AND u.created_at>=? ORDER BY u.created_at DESC LIMIT 100`).bind(since).all<Record<string, string>>();
  return rows.results.map(r => ({ id: r.id, offerId: r.offerId, title: r.title, state: r.state, detail: r.detail, appliedAt: r.appliedAt, kinds: JSON.parse(r.kinds_json), after: JSON.parse(r.fields_json), before: JSON.parse(r.previous_json) }));
}

export async function confirmAutoTermUpdate(db: D1Database, id: string, actor: string) {
  const done = await db.prepare("UPDATE auto_term_updates SET owner_actor=?, owner_at=? WHERE id=? AND state='applied' AND owner_at IS NULL RETURNING id").bind(actor, new Date().toISOString(), id).first();
  return { confirmed: !!done };
}

/** Restore the approved terms from before the update; the update stays in the revision history. */
export async function undoAutoTermUpdate(db: D1Database, id: string, actor: string) {
  const row = await db.prepare('SELECT * FROM auto_term_updates WHERE id=?').bind(id).first<Row>();
  if (!row || row.state !== 'applied') throw new IdentityError(404, '没有这条已应用的自动更新');
  const current = await db.prepare('SELECT v.id FROM benefit_entities e JOIN review_decisions d ON d.id=? AND d.version_id=e.current_approved_version_id JOIN benefit_versions v ON v.id=e.current_approved_version_id WHERE e.id=?').bind(row.decision_id, row.entity_id).first();
  if (!current) throw new IdentityError(409, '该条目在自动更新后已有新的批准版本，请在条目页手动处理');
  const previous = JSON.parse(row.previous_json) as Partial<OfferIn>;
  await publish(db, row.offer_id, row.entity_id, previous, 'auto-update-undo:' + row.id, actor, 'admin', '管理员撤销自动条款更新，恢复原批准条款');
  await db.prepare("UPDATE auto_term_updates SET state='undone', owner_actor=?, owner_at=? WHERE id=?").bind(actor, new Date().toISOString(), id).run();
  return { undone: true };
}
