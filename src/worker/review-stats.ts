/**
 * Who actually did the review work (2026-10-16). Decisions made by the owner, by an agent with the admin token and by
 * the system were indistinguishable, which overstated automation. Identity decisions carry their request ID in the
 * idempotency key: web clicks are `ui-…`, fast-track `fast-track-…`; other admin decisions come from scripts/agents.
 */
export async function reviewStats(db: D1Database, days = 7) {
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const leads = await db.prepare(`SELECT
      sum(status='linked') linked,
      sum(status='rejected' AND json_extract(resolution,'$.ruleId') IS NOT NULL) rule,
      sum(status='rejected' AND json_extract(resolution,'$.ruleId') IS NULL AND NOT EXISTS(SELECT 1 FROM decision_labels d WHERE d.subject_kind='lead' AND d.subject_id=CAST(leads.id AS TEXT) AND d.actor_kind='owner')) system,
      sum(status='rejected' AND EXISTS(SELECT 1 FROM decision_labels d WHERE d.subject_kind='lead' AND d.subject_id=CAST(leads.id AS TEXT) AND d.actor_kind='owner')) owner,
      sum(status IN ('new','reviewing')) open, count(*) total FROM leads WHERE created_at>=?`).bind(since).first<Record<string, number | null>>();
  const tasks = await db.prepare(`SELECT
      sum(t.state='resolved' AND d.idempotency_key LIKE '%ui-%') web,
      sum(t.state='resolved' AND d.idempotency_key LIKE '%fast-track%') fastTrack,
      sum(t.state='resolved' AND d.actor NOT LIKE 'pipeline%' AND d.actor NOT LIKE 'system%' AND d.idempotency_key NOT LIKE '%ui-%' AND d.idempotency_key NOT LIKE '%fast-track%') agent,
      sum(t.state='resolved' AND (d.actor LIKE 'pipeline%' OR d.actor LIKE 'system%')) system,
      sum(t.state IN ('open','checking','manual')) open, count(*) total
    FROM review_tasks t LEFT JOIN review_decisions d ON d.id=t.decision_id WHERE t.created_at>=?`).bind(since).first<Record<string, number | null>>();
  const automatic = await db.prepare(`SELECT
      sum(EXISTS(SELECT 1 FROM json_each(c.receipt_json,'$.reasonCodes') r WHERE r.value='same_source_reread')) reread,
      sum(EXISTS(SELECT 1 FROM json_each(c.receipt_json,'$.reasonCodes') r WHERE r.value='grouped_with_open_card')) grouped
    FROM intake_candidates c JOIN source_observations o ON o.id=c.observation_id WHERE o.observed_at>=? AND c.receipt_json IS NOT NULL`).bind(since).first<Record<string, number | null>>();
  const n = (row: Record<string, number | null> | null, key: string) => Number(row?.[key] ?? 0);
  return {
    days,
    leads: { total: n(leads, 'total'), system: n(leads, 'system') + n(leads, 'linked'), rule: n(leads, 'rule'), owner: n(leads, 'owner'), open: n(leads, 'open') },
    identity: { total: n(tasks, 'total'), system: n(tasks, 'system'), web: n(tasks, 'web'), fastTrack: n(tasks, 'fastTrack'), agent: n(tasks, 'agent'), open: n(tasks, 'open') },
    avoided: { sameSourceReread: n(automatic, 'reread'), groupedIntoOpenCard: n(automatic, 'grouped') },
  };
}
