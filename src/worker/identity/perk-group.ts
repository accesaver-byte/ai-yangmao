import { samePerk, textSimilarity, type PerkView } from '../../shared/identity/perk-anchors';

/**
 * Group repeated reports of one perk into one review card (2026-10-16). The same perk arrives from many pages in
 * different words (OpenCode 11×, Vercel trial 9×, MiniMax Design 6× in one week), and each used to open its own card.
 * A new unresolved candidate joins an open identity card for the same vendor whose first report it matches; the card
 * shows every source and the owner still decides. Capped at 10 candidates — a claim-group rejection covers at most 10.
 */
const GROUP_MAX = 10, GROUP_WINDOW_DAYS = 21;

function view(raw: string): PerkView | null {
  try {
    const c = (JSON.parse(raw) as { candidate?: Record<string, unknown> }).candidate ?? {};
    if (typeof c.platformId !== 'string' || typeof c.title !== 'string') return null;
    return { platformId: c.platformId, title: c.title, valueText: typeof c.valueText === 'string' ? c.valueText : '', models: Array.isArray(c.models) ? c.models.filter((m): m is string => typeof m === 'string') : [], requirements: Array.isArray(c.requirements) ? c.requirements.filter((m): m is string => typeof m === 'string') : [] };
  } catch { return null; }
}

export async function findPerkGroup(db: D1Database, candidateId: string, candidateRaw: string): Promise<string | null> {
  const me = view(candidateRaw);
  if (!me) return null;
  const since = new Date(Date.now() - GROUP_WINDOW_DAYS * 86400_000).toISOString();
  const rows = await db.prepare(`SELECT t.task_key, (SELECT count(*) FROM task_candidates x WHERE x.task_id=t.id) n,
      (SELECT c.raw_candidate_json FROM task_candidates tc JOIN intake_candidates c ON c.id=tc.candidate_id WHERE tc.task_id=t.id ORDER BY c.id LIMIT 1) raw
    FROM review_tasks t WHERE t.kind='identity' AND t.entity_id IS NULL AND t.state IN ('open','checking','manual') AND t.created_at>=?
      AND t.task_key LIKE 'identity:%' AND t.task_key<>? ORDER BY t.created_at DESC LIMIT 120`).bind(since, 'identity:' + candidateId).all<{ task_key: string; n: number; raw: string | null }>();
  let best: { key: string; score: number } | null = null;
  for (const row of rows.results) {
    if (row.n >= GROUP_MAX || !row.raw) continue;
    const other = view(row.raw);
    if (!other || !samePerk(me, other)) continue;
    const score = textSimilarity(`${me.title} ${me.valueText}`, `${other.title} ${other.valueText}`);
    if (!best || score > best.score) best = { key: row.task_key, score };
  }
  return best?.key ?? null;
}

type OpenCard = { id: string; task_key: string; n: number; raw: string | null; created_at: string; revision: number; material_revision: number };
export type RegroupPlan = { primary: string; title: string; absorbed: { id: string; title: string }[] }[];

/**
 * One-off regroup of cards opened before grouping existed (2026-10-16). Same matching as new reports; the oldest card of
 * each group keeps the decision, the others hand over their candidates and are cancelled; leads waiting on a cancelled
 * card are pointed at the surviving one. Leased cards (someone is working on them) are left alone. Bounded per call
 * (identity requests share a 50-query budget): run until `remaining` is 0.
 */
export async function regroupOpenCards(db: D1Database, options: { dryRun: boolean; maxMerges?: number }): Promise<{ plan: RegroupPlan; merged: number; remaining: number }> {
  const now = new Date().toISOString();
  const cards = (await db.prepare(`SELECT t.id, t.task_key, t.created_at, t.revision, t.material_revision, (SELECT count(*) FROM task_candidates x WHERE x.task_id=t.id) n,
      (SELECT c.raw_candidate_json FROM task_candidates tc JOIN intake_candidates c ON c.id=tc.candidate_id WHERE tc.task_id=t.id ORDER BY c.id LIMIT 1) raw
    FROM review_tasks t WHERE t.kind='identity' AND t.entity_id IS NULL AND t.state IN ('open','checking','manual') AND (t.lease_until IS NULL OR t.lease_until<?)
    ORDER BY t.created_at, t.id LIMIT 400`).bind(now).all<OpenCard>()).results;
  const groups: { primary: OpenCard; view: PerkView; size: number; absorbed: OpenCard[] }[] = [];
  for (const card of cards) {
    const v = card.raw ? view(card.raw) : null;
    if (!v) continue;
    const home = groups.find(g => g.size + card.n <= GROUP_MAX && samePerk(g.view, v));
    if (home) { home.absorbed.push(card); home.size += card.n; } else groups.push({ primary: card, view: v, size: card.n, absorbed: [] });
  }
  const merging = groups.filter(g => g.absorbed.length);
  const plan: RegroupPlan = merging.map(g => ({ primary: g.primary.id, title: g.view.title, absorbed: g.absorbed.map(a => ({ id: a.id, title: (a.raw && view(a.raw)?.title) || '' })) }));
  const total = merging.reduce((sum, g) => sum + g.absorbed.length, 0);
  if (options.dryRun) return { plan, merged: 0, remaining: total };
  let merged = 0, budget = options.maxMerges ?? 7; // 6 statements per merge + the read + primary bumps stay under 50
  for (const g of merging) {
    const take = g.absorbed.slice(0, budget);
    if (!take.length) break;
    const statements: D1PreparedStatement[] = [];
    for (const a of take) {
      statements.push(
        db.prepare(`UPDATE OR IGNORE task_candidates SET task_id=? WHERE task_id=?`).bind(g.primary.id, a.id),
        db.prepare(`DELETE FROM task_candidates WHERE task_id=?`).bind(a.id),
        db.prepare(`UPDATE intake_candidates SET task_id=? WHERE task_id=?`).bind(g.primary.id, a.id),
        db.prepare(`UPDATE leads SET resolution=replace(resolution, ?, ?) WHERE status IN ('new','reviewing') AND resolution LIKE ?`).bind(a.id, g.primary.id, `%${a.id}%`),
        db.prepare(`UPDATE review_tasks SET state='cancelled', revision=revision+1, lease_token=NULL, lease_until=NULL WHERE id=? AND state IN ('open','checking','manual') AND revision=?`).bind(a.id, a.revision),
      );
    }
    statements.push(db.prepare(`UPDATE review_tasks SET revision=revision+1, material_revision=material_revision+1 WHERE id=? AND state IN ('open','checking','manual')`).bind(g.primary.id));
    await db.batch(statements);
    merged += take.length; budget -= take.length;
    if (budget <= 0) break;
  }
  return { plan, merged, remaining: total - merged };
}
