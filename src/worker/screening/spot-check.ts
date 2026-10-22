import { reopenLeadClosure } from '../identity/lead-closure';
import { IdentityService } from '../identity/service';
import { IdentityError } from '../identity/store';
import { sha256 } from '../../shared/identity/normalize';
import { z } from 'zod';
import { platformMentioned } from '../../shared/lead-scope';
import { REASON_CATEGORIES, type ReasonCategory } from '../../shared/screening/types';

/**
 * Weekly spot-check of leads the system closed by itself (2026-10-16). Misses here are otherwise invisible, and the
 * owner's verdicts are the calibration labels milestone 2 needs before any model may close leads on its own
 * (close precision ≥97%, zero wrong closes of recurring/reset perks). Likely misses — titles that name a known
 * vendor or carry perk words — come first so a 5-minute skim covers what matters.
 */
const PERK_WORDS = /免费|额度|赠送|白送|送\s*\$?\d|积分|会员|试用|重置|补偿|学生|credits?|free|trial|reset|promo|giveaway|bonus/i;
const SPOT_CHECK_MAX = 15; // admin requests share the identity query budget in enforce mode (2 writes per item)

type Row = { status: string; offer_id: string | null; id: number; origin: string; url: string; title: string | null; resolution: string | null; created_at: string };
export type AutoClosed = { id: number; origin: string; url: string; title: string; reason: string; closedBy: 'rule' | 'model' | 'gate0_link'; ruleId: string | null; category: ReasonCategory; likely: boolean; closedAt: string | null; expectedVersion: string; recoveryPending: boolean };

export function guessCategory(reason: string): ReasonCategory {
  if (/重复|已收录|已有条目|已关联|已上架/.test(reason)) return 'duplicate';
  if (/已结束|过期|已截止/.test(reason)) return 'expired';
  if (/中转/.test(reason)) return 'relay_station';
  if (/账号|号池|拼车/.test(reason)) return 'account_pool';
  if (/个人|送码|分享码|兑换码/.test(reason)) return 'personal_giveaway';
  if (/付费套餐|套餐自带/.test(reason)) return 'paid_bundle';
  if (/折扣|打折/.test(reason)) return 'ordinary_discount';
  if (/新闻|发布|定价|价格/.test(reason)) return 'model_news_only';
  return 'non_ai';
}

export async function listAutoClosed(db: D1Database, days = 7): Promise<{ items: AutoClosed[]; total: number; likely: number }> {
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const rows = await db.prepare(`SELECT l.id, l.status, l.offer_id, l.origin, l.url, l.title, l.resolution, l.created_at FROM leads l
    WHERE l.title IS NOT NULL AND ((json_extract(l.resolution,'$.spotCheck.verdict')='wrong' AND (l.status='rejected' OR COALESCE(json_extract(l.resolution,'$.spotCheck.recovery.state'),'')<>'completed')) OR (((l.status='linked' AND json_extract(l.resolution,'$.gate0')=1) OR l.status='rejected') AND l.created_at>=? AND COALESCE(json_extract(l.resolution,'$.spotCheck.verdict'),'')=''
      AND NOT EXISTS(SELECT 1 FROM decision_labels d WHERE d.subject_kind='lead' AND d.subject_id=CAST(l.id AS TEXT) AND d.actor_kind='owner')))
    ORDER BY CASE WHEN json_extract(l.resolution,'$.spotCheck.verdict')='wrong' THEN 0 ELSE 1 END,l.id DESC LIMIT 800`).bind(since).all<Row>();
  const rules = new Map((await db.prepare(`SELECT id, category FROM screening_rules`).all<{ id: string; category: ReasonCategory }>()).results.map(r => [r.id, r.category]));
  const platforms = (await db.prepare(`SELECT id, name, aliases FROM platforms WHERE status='approved'`).all<{ id: string; name: string; aliases: string | null }>()).results.map(p => ({ id: p.id, name: p.name, aliases: JSON.parse(p.aliases || '[]') as string[] }));
  const items = await Promise.all(rows.results.map(async row => {
    const resolution = row.resolution ? JSON.parse(row.resolution) as { reason?: string; ruleId?: string; checkedAt?: string } : {};
    const title = row.title ?? '', reason = resolution.reason ?? '', ruleId = resolution.ruleId ?? null;
    return { id: row.id, origin: row.origin, url: row.url, title, reason, closedBy: row.status === 'linked' ? 'gate0_link' as const : ruleId ? 'rule' as const : 'model' as const, ruleId, category: (ruleId && rules.get(ruleId)) || guessCategory(reason),
      likely: PERK_WORDS.test(title) || platforms.some(p => platformMentioned(title, p)), closedAt: resolution.checkedAt ?? row.created_at, expectedVersion: await leadVersion(row), recoveryPending: JSON.parse(row.resolution || '{}').spotCheck?.verdict === 'wrong' };
  }));
  items.sort((a, b) => Number(b.likely) - Number(a.likely) || b.id - a.id);
  return { items, total: items.length, likely: items.filter(i => i.likely).length };
}

const confirmInput = z.object({ items: z.array(z.object({ id: z.number().int().positive(), category: z.enum(REASON_CATEGORIES), expectedVersion: z.string().optional() })).min(1).max(SPOT_CHECK_MAX) });

type LeadState = Pick<Row, 'id' | 'status' | 'offer_id' | 'resolution'>;
async function leadVersion(row: LeadState): Promise<string> { return sha256(JSON.stringify([row.id, row.status, row.offer_id, row.resolution])); }
async function readLead(db: D1Database, id: number) { return db.prepare('SELECT id,status,offer_id,resolution FROM leads WHERE id=?').bind(id).first<LeadState>(); }
function sameLead(row: LeadState) { return { sql: "id=? AND status=? AND offer_id IS ? AND resolution IS ?", args: [row.id, row.status, row.offer_id, row.resolution] }; }

/** Correct confirmations and wrong corrections compete on the same lead snapshot. */
export async function confirmAutoClosed(db: D1Database, raw: unknown, actor: string) {
  const { items } = confirmInput.parse(raw);
  let confirmed = 0;
  for (const item of items) {
    const row = await readLead(db, item.id);
    if (!row || row.status !== 'rejected') continue;
    if (item.expectedVersion && item.expectedVersion !== await leadVersion(row)) throw new IdentityError(409, '抽查记录已更新，请刷新后再确认');
    const resolution = JSON.parse(row.resolution || '{}');
    if (resolution.spotCheck?.verdict === 'wrong') continue;
    const next = JSON.stringify({ ...resolution, spotCheck: { verdict: 'correct', at: new Date().toISOString(), by: actor, operationId: crypto.randomUUID() } });
    const guard = sameLead(row);
    // Keep the label in the same transaction, and guard it with this write's unique snapshot.
    const result = await db.batch([
      db.prepare(`UPDATE leads SET resolution=? WHERE ${guard.sql} RETURNING id`).bind(next, ...guard.args),
      db.prepare(`INSERT INTO decision_labels(subject_kind,subject_id,category,actor_kind,label_source,justification,labeled_at)
        SELECT 'lead',CAST(id AS TEXT),?,'owner','owner','抽查确认：自动关闭正确',? FROM leads WHERE id=? AND resolution=?
        ON CONFLICT(subject_kind,subject_id) DO UPDATE SET category=excluded.category,actor_kind='owner',label_source='owner',justification=excluded.justification,labeled_at=excluded.labeled_at`)
        .bind(item.category, new Date().toISOString(), row.id, next),
    ]);
    if (result[0].results.length) confirmed++;
  }
  return { confirmed };
}

// Restrict restoration to refusals actually attached to this lead's candidates.
// Immutable refusal history stays intact; reopenDecision writes the superseding decision.
const refusalFrom = `FROM review_decisions d WHERE d.action='reject'
  AND json_extract(d.basis_json,'$.visibilityAction') IS NULL
  AND NOT EXISTS(SELECT 1 FROM review_decisions newer WHERE newer.supersedes_id=d.id)
  AND EXISTS(SELECT 1 FROM lead_candidate_links l JOIN intake_candidates c ON c.id=l.candidate_id WHERE l.lead_id=? AND
    (d.candidate_id=c.id OR d.id=c.decision_id OR (d.entity_id=c.entity_id AND d.version_id=c.version_id AND json_extract(d.scope_json,'$.kind')='exact_version')
      OR EXISTS(SELECT 1 FROM identity_refusal_applications a WHERE a.candidate_id=c.id AND a.decision_id=d.id AND a.facts_hash=c.facts_hash)))`;

/** Each request restores at most one refusal; progress is durable and can be continued after interruption. */
export async function markWronglyClosed(db: D1Database, id: number, actor: string, expectedVersion?: string) {
  let row = await readLead(db, id);
  if (!row || !['rejected', 'linked', 'reviewing', 'new'].includes(row.status)) return { ok: false, ruleRetired: false };
  if (expectedVersion && expectedVersion !== await leadVersion(row)) throw new IdentityError(409, '抽查记录已更新，请刷新后继续恢复');
  let resolution = JSON.parse(row.resolution || '{}');
  if (!['rejected', 'linked'].includes(row.status) && resolution.spotCheck?.verdict !== 'wrong') return { ok: false, ruleRetired: false };
  let ruleRetired = false;
  if (resolution.spotCheck?.verdict !== 'wrong' || !resolution.spotCheck?.recovery) {
    const firstWrong = resolution.spotCheck?.verdict !== 'wrong';
    const now = new Date().toISOString(), operationId = crypto.randomUUID();
    resolution = { ...resolution, spotCheck: { ...resolution.spotCheck, verdict: 'wrong', at: resolution.spotCheck?.verdict === 'wrong' ? resolution.spotCheck.at : now,
      by: actor, previous: resolution.spotCheck?.verdict === 'correct' ? resolution.spotCheck : undefined,
      recovery: { state: 'pending', operationId, taskIds: [], previousStatus: row.status, previousReason: resolution.reason ?? null } } };
    const next = JSON.stringify(resolution), guard = sameLead(row);
    const statements = [db.prepare(`UPDATE leads SET resolution=? WHERE ${guard.sql} RETURNING id`).bind(next, ...guard.args),
      db.prepare(`DELETE FROM decision_labels WHERE subject_kind='lead' AND subject_id=? AND EXISTS(SELECT 1 FROM leads WHERE id=? AND resolution=?)`).bind(String(id), id, next)];
    if (firstWrong && resolution.ruleId) {
      statements.push(db.prepare(`UPDATE screening_rules SET overrides=overrides+1 WHERE id=? AND EXISTS(SELECT 1 FROM leads WHERE id=? AND resolution=?)`).bind(resolution.ruleId, id, next));
      statements.push(db.prepare(`UPDATE screening_rules SET status='retired',retired_reason='抽查误关超过 10%，自动停用',decided_at=?,decided_by=? WHERE id=? AND status='active' AND hits>=10 AND overrides*1.0/hits>0.1 AND EXISTS(SELECT 1 FROM leads WHERE id=? AND resolution=?) RETURNING id`).bind(now, actor, resolution.ruleId, id, next));
    }
    const written = await db.batch(statements);
    if (!written[0].results.length) throw new IdentityError(409, '抽查记录已更新，请刷新后继续恢复');
    ruleRetired = statements.length === 4 && written[3].results.length > 0;
    row = { ...row, resolution: next };
  }
  const recovery = resolution.spotCheck.recovery;
  if (recovery.state === 'completed' && row.status !== 'rejected') return { ok: true, ruleRetired, expectedVersion: await leadVersion(row), recovery, more: false };
  // Already-linked and approved canonical records retain their publication and linkage.
  const approved = await db.prepare(`SELECT o.id FROM offers o WHERE o.review_state='approved' AND (o.id=? OR EXISTS(SELECT 1 FROM lead_candidate_links l JOIN intake_candidates c ON c.id=l.candidate_id JOIN benefit_entities e ON e.id=c.entity_id WHERE l.lead_id=? AND e.canonical_offer_id=o.id AND e.current_approved_version_id IS NOT NULL)) LIMIT 1`).bind(row.offer_id, id).first<{ id: string }>();
  // 2026-10-21: a link made by gate0 (system, not a person) is exactly what the owner may be correcting — a genuine new
  // perk taken for a duplicate. Undo it and return the lead to the queue; human/approved links are still preserved.
  const systemLink = row.status === 'linked' && resolution.gate0 === true;
  const preserveLinked = !systemLink && (row.status === 'linked' || !!approved);
  const refusal = preserveLinked ? null : await db.prepare(`SELECT d.id, (SELECT extraction_version FROM intake_candidates WHERE id=d.candidate_id) extraction_version, coalesce((SELECT business_revision FROM benefit_entities WHERE id=d.entity_id),
    (SELECT revision FROM intake_candidates WHERE id=d.candidate_id),
    (SELECT c.revision FROM review_tasks t JOIN task_candidates tc ON tc.task_id=t.id JOIN intake_candidates c ON c.id=tc.candidate_id WHERE t.decision_id=d.id ORDER BY c.id LIMIT 1)) revision ${refusalFrom} ORDER BY d.id LIMIT 1`).bind(id).first<{ id: string; revision: number; extraction_version: string|null }>();
  if (refusal) {
    if(refusal.extraction_version==='lead-closure-v1'){
      await reopenLeadClosure(db,{leadId:id,decisionId:refusal.id,expectedRevision:refusal.revision,requestId:`spot:${id}:${recovery.operationId}:${refusal.id}`,actor});
      recovery.reanalysisRequested=true;
    }else{
    const opened = await new IdentityService(db).reopenDecision(refusal.id, { requestId: `spot:${id}:${recovery.operationId}:${refusal.id}`.slice(0, 200), expectedRevision: refusal.revision,
      reason: '管理员抽查确认误关，恢复待审', basis: { description: `管理员确认线索 #${id} 原自动关闭有误，保留拒绝历史并重新审核；不自动批准。` }, actor });
    recovery.taskIds = [...new Set([...recovery.taskIds, opened.taskId])];
    }
  }
  const openTasks = await db.prepare(`SELECT DISTINCT t.id FROM lead_candidate_links l JOIN task_candidates tc ON tc.candidate_id=l.candidate_id JOIN review_tasks t ON t.id=tc.task_id WHERE l.lead_id=? AND t.state IN ('open','checking','manual')`).bind(id).all<{ id: string }>();
  recovery.taskIds = [...new Set([...recovery.taskIds, ...openTasks.results.map(t => t.id)])];
  const more = !preserveLinked && !!await db.prepare(`SELECT d.id ${refusalFrom} LIMIT 1`).bind(id).first();
  recovery.state = more ? 'pending' : 'completed';
  if (!more) recovery.completedAt = new Date().toISOString();
  if(!preserveLinked&&!recovery.taskIds.length&&!recovery.reanalysisRequested)recovery.reanalysisRequested=!!await db.prepare("SELECT 1 FROM lead_candidate_links l JOIN intake_candidates c ON c.id=l.candidate_id WHERE l.lead_id=? AND c.extraction_version='lead-closure-v1' AND json_extract(c.receipt_json,'$.reasonCodes[0]')='lead_reanalysis_requested' LIMIT 1").bind(id).first();
  const reanalyze=!more&&!preserveLinked&&recovery.reanalysisRequested&&!recovery.taskIds.length;
  const nextStatus = more ? row.status : preserveLinked ? 'linked' : 'reviewing';
  const next = JSON.stringify({ ...resolution, ...(!more && !preserveLinked ? { status: reanalyze?'retry':'manual', jobId: `spot-recovery-${recovery.operationId}`, attempts: 0, inconclusive: 0, checkedAt: new Date().toISOString(), nextAttemptAt: reanalyze?new Date().toISOString():null, queries: resolution.queries ?? [], candidates: resolution.candidates ?? [], identityTaskIds: recovery.taskIds, reason: reanalyze?'管理员确认误关，重新读取正文并研判官方权益':'管理员抽查确认误关，恢复待审' } : {}), spotCheck: { ...resolution.spotCheck, recovery } });
  const guard = sameLead(row);
  const noRefusal = !more && !preserveLinked ? ` AND NOT EXISTS(SELECT 1 ${refusalFrom})` : '';
  const saved = await db.prepare(`UPDATE leads SET status=?,offer_id=?,resolution=? WHERE ${guard.sql}${noRefusal} RETURNING id`).bind(nextStatus, (systemLink ? null : approved?.id ?? row.offer_id), next, ...guard.args, ...(!more && !preserveLinked ? [id] : [])).first();
  if (!saved) throw new IdentityError(409, '抽查记录已更新，请刷新后继续恢复');
  return { ok: true, ruleRetired, expectedVersion: await leadVersion({ ...row, status: nextStatus, offer_id: (systemLink ? null : approved?.id ?? row.offer_id), resolution: next }), recovery, more };
}
