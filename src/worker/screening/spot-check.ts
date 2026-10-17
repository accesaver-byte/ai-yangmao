import { z } from 'zod';
import { platformMentioned } from '../../shared/lead-scope';
import { REASON_CATEGORIES, type ReasonCategory } from '../../shared/screening/types';
import { recordOwnerLabel } from './labels';

/**
 * Weekly spot-check of leads the system closed by itself (2026-10-16). Misses here are otherwise invisible, and the
 * owner's verdicts are the calibration labels milestone 2 needs before any model may close leads on its own
 * (close precision ≥97%, zero wrong closes of recurring/reset perks). Likely misses — titles that name a known
 * vendor or carry perk words — come first so a 5-minute skim covers what matters.
 */
const PERK_WORDS = /免费|额度|赠送|白送|送\s*\$?\d|积分|会员|试用|重置|补偿|学生|credits?|free|trial|reset|promo|giveaway|bonus/i;
const SPOT_CHECK_MAX = 15; // admin requests share the identity query budget in enforce mode (2 writes per item)

type Row = { id: number; origin: string; url: string; title: string | null; resolution: string | null; created_at: string };
export type AutoClosed = { id: number; origin: string; url: string; title: string; reason: string; closedBy: 'rule' | 'model'; ruleId: string | null; category: ReasonCategory; likely: boolean; closedAt: string | null };

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
  const rows = await db.prepare(`SELECT l.id, l.origin, l.url, l.title, l.resolution, l.created_at FROM leads l
    WHERE l.status='rejected' AND l.created_at>=? AND l.title IS NOT NULL AND COALESCE(json_extract(l.resolution,'$.spotCheck.verdict'),'')=''
      AND NOT EXISTS(SELECT 1 FROM decision_labels d WHERE d.subject_kind='lead' AND d.subject_id=CAST(l.id AS TEXT) AND d.actor_kind='owner')
    ORDER BY l.id DESC LIMIT 800`).bind(since).all<Row>();
  const rules = new Map((await db.prepare(`SELECT id, category FROM screening_rules`).all<{ id: string; category: ReasonCategory }>()).results.map(r => [r.id, r.category]));
  const platforms = (await db.prepare(`SELECT id, name, aliases FROM platforms WHERE status='approved'`).all<{ id: string; name: string; aliases: string | null }>()).results.map(p => ({ id: p.id, name: p.name, aliases: JSON.parse(p.aliases || '[]') as string[] }));
  const items = rows.results.map(row => {
    const resolution = row.resolution ? JSON.parse(row.resolution) as { reason?: string; ruleId?: string; checkedAt?: string } : {};
    const title = row.title ?? '', reason = resolution.reason ?? '', ruleId = resolution.ruleId ?? null;
    return { id: row.id, origin: row.origin, url: row.url, title, reason, closedBy: ruleId ? 'rule' as const : 'model' as const, ruleId, category: (ruleId && rules.get(ruleId)) || guessCategory(reason),
      likely: PERK_WORDS.test(title) || platforms.some(p => platformMentioned(title, p)), closedAt: resolution.checkedAt ?? row.created_at };
  });
  items.sort((a, b) => Number(b.likely) - Number(a.likely) || b.id - a.id);
  return { items, total: items.length, likely: items.filter(i => i.likely).length };
}

const confirmInput = z.object({ items: z.array(z.object({ id: z.number().int().positive(), category: z.enum(REASON_CATEGORIES) })).min(1).max(SPOT_CHECK_MAX) });

async function setSpotCheck(db: D1Database, id: number, verdict: 'correct' | 'wrong', actor: string): Promise<{ ruleId: string | null } | null> {
  const row = await db.prepare(`SELECT resolution FROM leads WHERE id=? AND status IN ('rejected','linked')`).bind(id).first<{ resolution: string | null }>();
  if (!row) return null;
  const resolution = { ...(row.resolution ? JSON.parse(row.resolution) : {}), spotCheck: { verdict, at: new Date().toISOString(), by: actor } };
  await db.prepare(`UPDATE leads SET resolution=? WHERE id=?`).bind(JSON.stringify(resolution), id).run();
  return { ruleId: (resolution as { ruleId?: string }).ruleId ?? null };
}

/** The owner agrees these closures were right; each becomes an owner label (calibration data). */
export async function confirmAutoClosed(db: D1Database, raw: unknown, actor: string) {
  const { items } = confirmInput.parse(raw);
  let confirmed = 0;
  for (const item of items) {
    if (!await setSpotCheck(db, item.id, 'correct', actor)) continue;
    await recordOwnerLabel(db, { subjectKind: 'lead', subjectId: String(item.id), category: item.category, actor, justification: '抽查确认：自动关闭正确' });
    confirmed++;
  }
  return { confirmed };
}

/** The owner says this closure was wrong. A rule wrong on >10% of at least 10 hits retires itself. */
export async function markWronglyClosed(db: D1Database, id: number, actor: string) {
  const marked = await setSpotCheck(db, id, 'wrong', actor);
  if (!marked) return { ok: false, ruleRetired: false };
  let ruleRetired = false;
  if (marked.ruleId) {
    const rule = await db.prepare(`UPDATE screening_rules SET overrides=overrides+1 WHERE id=? RETURNING hits, overrides, status`).bind(marked.ruleId).first<{ hits: number; overrides: number; status: string }>();
    if (rule && rule.status === 'active' && rule.hits >= 10 && rule.overrides / rule.hits > 0.1) {
      await db.prepare(`UPDATE screening_rules SET status='retired', retired_reason=?, decided_at=?, decided_by=? WHERE id=?`).bind(`抽查误关 ${rule.overrides}/${rule.hits}，超过 10%，自动停用`, new Date().toISOString(), actor, marked.ruleId).run();
      ruleRetired = true;
    }
  }
  return { ok: true, ruleRetired };
}
