import { aggregateIdentityLead } from './leads';

/**
 * Leads the system and the owner could both leave stuck (2026-10-16 audit):
 * - A lead linked to identity cards is hidden from the lead queue and its own actions are refused until those cards
 *   are decided; but nothing re-read the lead after the owner decided them, so 27 leads sat in "reviewing" since 10-04.
 *   Re-aggregate leads whose cards are all closed: they become linked/closed, or return to the lead queue for the owner.
 * - A lead "checking" for more than a day (its source extraction keeps deferring) said "正在自动复核" forever.
 *   Hand it to the owner as manual with an honest reason.
 * Bounded per call (identity requests share a query budget); the pipeline calls it every run.
 */
export async function sweepStuckLeads(db: D1Database, limit = 5) {
  const settled = (await db.prepare(`SELECT l.id FROM leads l WHERE l.status IN ('new','reviewing')
      AND json_array_length(json_extract(l.resolution,'$.identityTaskIds'))>0
      AND NOT EXISTS(SELECT 1 FROM json_each(json_extract(l.resolution,'$.identityTaskIds')) j JOIN review_tasks t ON t.id=j.value WHERE t.state IN ('open','checking','manual'))
    ORDER BY l.id LIMIT ?`).bind(limit).all<{ id: number }>()).results;
  let reconciled = 0, failed = 0;
  for (const { id } of settled) {
    try {
      const r = await aggregateIdentityLead(db, id);
      if (r) { reconciled++; continue; }
      // No linked candidates to aggregate from: return the lead to the owner's queue rather than leave it hidden.
      const back = await db.prepare(`UPDATE leads SET resolution=json_set(resolution,'$.status','manual','$.identityTaskIds',json('[]'),'$.nextAttemptAt',NULL,
          '$.reason','关联的查重卡已全部处理完，但没有可汇总的结论；请人工判断：关联已有活动、⚡ 快速上架或结束线索。') WHERE id=? AND status IN ('new','reviewing')`).bind(id).run();
      if (back.meta.changes) reconciled++;
    } catch { failed++; }
  }
  const dayAgo = new Date(Date.now() - 86400_000).toISOString(), now = new Date().toISOString();
  const handed = await db.prepare(`UPDATE leads SET resolution=json_set(resolution,'$.status','manual','$.nextAttemptAt',NULL,'$.checkedAt',?,
      '$.reason','自动复核超过 24 小时仍未完成（原文抽取一直推迟），请人工判断：关联已有活动、⚡ 快速上架或结束线索。')
    WHERE status='reviewing' AND json_extract(resolution,'$.status')='checking'
      AND coalesce(json_array_length(json_extract(resolution,'$.identityTaskIds')),0)=0
      AND coalesce(json_extract(resolution,'$.checkedAt'),created_at)<?`).bind(now, dayAgo).run();
  const remaining = (await db.prepare(`SELECT count(*) n FROM leads l WHERE l.status IN ('new','reviewing') AND json_array_length(json_extract(l.resolution,'$.identityTaskIds'))>0
      AND NOT EXISTS(SELECT 1 FROM json_each(json_extract(l.resolution,'$.identityTaskIds')) j JOIN review_tasks t ON t.id=j.value WHERE t.state IN ('open','checking','manual'))`).first<{ n: number }>())?.n ?? 0;
  return { reconciled, failed, handedToOwner: handed.meta.changes ?? 0, remaining };
}
