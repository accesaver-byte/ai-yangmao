import { IdentityService } from '../identity/service';
import { IdentityError } from '../identity/store';

/**
 * Refusal memory review (2026-10-22, admin): re-reads closed because the owner had already rejected the same passage on
 * the same page, one row per remembered refusal. Undo reopens that refusal: its content goes back to review and the
 * memory stops applying, while the refusal history is kept.
 */
export type RememberedRefusal = { decisionId: string; title: string; url: string; reason: string; decidedAt: string; closedReads: number; lastClosedAt: string };

export async function listPageRefusals(db: D1Database, days = 7): Promise<RememberedRefusal[]> {
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const rows = await db.prepare(`SELECT a.decision_id, COUNT(*) reads, MAX(json_extract(a.identity_basis_json,'$.appliedAt')) last_at, d.reason_text, d.created_at decided_at,
      json_extract(p.raw_candidate_json,'$.candidate.title') title, json_extract(p.raw_candidate_json,'$.candidate.evidence.url') url
    FROM identity_refusal_applications a JOIN review_decisions d ON d.id=a.decision_id JOIN intake_candidates p ON p.id=d.candidate_id
    WHERE json_extract(a.identity_basis_json,'$.reason')='same_page_refusal' AND json_extract(a.identity_basis_json,'$.appliedAt')>=?
      AND NOT EXISTS(SELECT 1 FROM review_decisions n WHERE n.supersedes_id=d.id)
    GROUP BY a.decision_id ORDER BY last_at DESC LIMIT 100`).bind(since).all<{ decision_id: string; reads: number; last_at: string; reason_text: string; decided_at: string; title: string | null; url: string | null }>();
  return rows.results.map(row => ({ decisionId: row.decision_id, title: row.title ?? '', url: row.url ?? '', reason: row.reason_text, decidedAt: row.decided_at, closedReads: row.reads, lastClosedAt: row.last_at }));
}

export async function undoPageRefusal(db: D1Database, decisionId: string, actor: string): Promise<{ taskId: string }> {
  const row = await db.prepare(`SELECT c.revision FROM review_decisions d JOIN intake_candidates c ON c.id=d.candidate_id
    WHERE d.id=? AND d.action='reject' AND d.entity_id IS NULL AND EXISTS(SELECT 1 FROM identity_refusal_applications a WHERE a.decision_id=d.id AND json_extract(a.identity_basis_json,'$.reason')='same_page_refusal')`)
    .bind(decisionId).first<{ revision: number }>();
  if (!row) throw new IdentityError(404, '没有这条被沿用的拒绝');
  const opened = await new IdentityService(db).reopenDecision(decisionId, { requestId: `page-refusal-undo:${decisionId}`.slice(0, 200), expectedRevision: row.revision,
    reason: '管理员抽查：这条拒绝不应继续沿用，恢复审核', basis: { description: `管理员确认同页重读沿用拒绝 ${decisionId} 不合适，保留拒绝历史并重新审核；不自动批准。` }, actor });
  return { taskId: opened.taskId };
}

/**
 * Sources that keep being re-read without yielding a new perk: a weekly list for the owner to blacklist dead pages.
 * Counts reads (candidates), how many reached a card, how many closed on their own, and new approved perks.
 */
export type NoisySource = { id: string; url: string; platformId: string | null; enabled: boolean; reads: number; cards: number; autoClosed: number; newPerks: number };

export async function listNoisySources(db: D1Database, days = 30, minReads = 5): Promise<NoisySource[]> {
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const rows = await db.prepare(`SELECT s.id, s.url, s.platform_id, s.enabled, x.reads, x.cards, x.auto_closed,
      (SELECT COUNT(*) FROM offers f WHERE f.source_id=s.id AND f.review_state='approved' AND f.created_at>=?) new_perks
    FROM (SELECT json_extract(c.raw_candidate_json,'$.candidate.sourceId') source_id, COUNT(*) reads,
        SUM(EXISTS(SELECT 1 FROM task_candidates tc WHERE tc.candidate_id=c.id)) cards,
        SUM(c.state IN ('resolved_same','resolved_rejected') AND NOT EXISTS(SELECT 1 FROM task_candidates tc WHERE tc.candidate_id=c.id)) auto_closed
      FROM intake_candidates c JOIN source_observations o ON o.id=c.observation_id LEFT JOIN source_observation_fetches f ON f.id=c.source_fetch_id
      WHERE coalesce(f.observed_at,o.observed_at)>=? GROUP BY 1) x JOIN sources s ON s.id=x.source_id
    WHERE x.reads>=? ORDER BY new_perks, x.cards DESC, x.reads DESC LIMIT 60`).bind(since, since, minReads)
    .all<{ id: string; url: string; platform_id: string | null; enabled: number; reads: number; cards: number; auto_closed: number; new_perks: number }>();
  return rows.results.filter(row => row.new_perks === 0).map(row => ({ id: row.id, url: row.url, platformId: row.platform_id, enabled: !!row.enabled, reads: row.reads, cards: row.cards, autoClosed: row.auto_closed, newPerks: row.new_perks }));
}
