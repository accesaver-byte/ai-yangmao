import { z } from 'zod';
import { REASON_CATEGORIES, reasonCodeForCategory, type ReasonCategory, type ScreeningRule } from '../../shared/screening/types';
import { matchTitleRule } from '../../shared/screening/gate0';
import type { LeadResolution } from '../../shared/lead-review';

/**
 * Intake filter (2026-10-16). The owner's early rejections (lead dismissals, identity-card rejections) teach which
 * leads never belong here — not AI, coupons and shopping vouchers, relay stations, account pools, personal giveaways.
 * Recurring title words are proposed as rules; an owner-approved rule closes matching leads the moment they arrive,
 * before triage, search or review spend anything. Rules are only learned from content categories: "duplicate"
 * means already listed and "unverifiable" means no official source yet — neither says "never capture this".
 */
export const BLOCKABLE_CATEGORIES = ['non_ai', 'relay_station', 'account_pool', 'personal_giveaway', 'ordinary_discount'] as const satisfies readonly ReasonCategory[];
const MIN_HITS = 3;
// Filler words that recur in any forum title; a rule on them would say nothing about the content.
const CJK_FILLER = /^(一下|分享|回复|帮帮|帮忙|大家|佬友|今天|一个|还有|有没有|免费|福利|领取|活动|求助|请问|已经|可以|不要|快来|最新|送个|来了)$/;
const STOP = new Set(['the', 'and', 'for', 'with', 'you', 'free', 'api', 'new', 'get', 'now', 'are', 'from', 'this', 'that', 'pro', 'plus', 'max']);

const escape = (term: string) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Candidate terms in a title: Latin words, and 2–6 character runs inside Chinese text. */
export function titleTerms(title: string): Set<string> {
  const text = title.normalize('NFKC').toLowerCase(), terms = new Set<string>();
  for (const m of text.matchAll(/[a-z][a-z0-9.+-]{2,}/g)) if (!STOP.has(m[0])) terms.add(m[0]);
  for (const run of text.match(/[一-鿿]{2,}/g) ?? []) for (let n = 2; n <= Math.min(6, run.length); n++) for (let i = 0; i + n <= run.length; i++) terms.add(run.slice(i, i + n));
  return terms;
}

type Labeled = { id: number; title: string; origin: string; category: ReasonCategory };
export type RuleSuggestion = { pattern: string; category: ReasonCategory; scopeKind: 'global' | 'origin'; scopeValue: string | null; hits: number; examples: string[]; exampleRefs: string[] };

/** Positive titles: anything that turned out to be a real perk. A rule matching one of them is refused. */
async function positiveTitles(db: D1Database): Promise<string[]> {
  const offers = await db.prepare("SELECT title FROM offers WHERE review_state='approved' ORDER BY rowid DESC LIMIT 4000").all<{ title: string }>();
  const leads = await db.prepare("SELECT title FROM leads WHERE status='linked' AND title IS NOT NULL ORDER BY id DESC LIMIT 4000").all<{ title: string }>();
  return [...offers.results, ...leads.results].map(r => r.title);
}

/** Greedy set cover over terms that only ever appear in rejected titles of one category. */
export function mineSuggestions(labeled: Labeled[], positives: string[], known: Set<string>, vocabulary: string[] = []): RuleSuggestion[] {
  const positiveTerms = new Set<string>(); for (const t of positives) for (const term of titleTerms(t)) positiveTerms.add(term);
  // Product and model names (Haiku, Kimi, 豆包…) can sit in junk titles too, but must never become a block rule.
  const vocab = vocabulary.map(v => v.normalize('NFKC').toLowerCase()).filter(v => v.length >= 2);
  const usable = (term: string) => !CJK_FILLER.test(term) && !vocab.some(v => v.includes(term) || (term.length >= 3 && term.includes(v)));
  const out: RuleSuggestion[] = [];
  for (const category of BLOCKABLE_CATEGORIES) {
    const rows = labeled.filter(l => l.category === category);
    const hits = new Map<string, Set<number>>();
    for (const row of rows) for (const term of titleTerms(row.title)) if (!positiveTerms.has(term) && usable(term)) (hits.get(term) ?? hits.set(term, new Set()).get(term)!).add(row.id);
    const ranked = [...hits].filter(([term, ids]) => ids.size >= MIN_HITS && !known.has(escape(term))).sort((a, b) => b[1].size - a[1].size || Math.min(b[0].length, 4) - Math.min(a[0].length, 4) || a[0].length - b[0].length); // equal coverage: a whole word (~4 chars) over a fragment
    const covered = new Set<number>();
    for (const [term, ids] of ranked) {
      if ([...ids].every(id => covered.has(id))) continue;
      ids.forEach(id => covered.add(id));
      const matched = rows.filter(r => ids.has(r.id)), origins = new Map<string, number>();
      matched.forEach(r => origins.set(r.origin, (origins.get(r.origin) ?? 0) + 1));
      const [topOrigin, topCount] = [...origins].sort((a, b) => b[1] - a[1])[0];
      const scoped = topCount === matched.length;
      out.push({ pattern: escape(term), category, scopeKind: scoped ? 'origin' : 'global', scopeValue: scoped ? topOrigin : null, hits: ids.size, examples: matched.slice(0, 5).map(r => r.title), exampleRefs: matched.slice(0, 20).map(r => `lead:${r.id}`) });
      if (out.filter(s => s.category === category).length >= 8) break;
    }
  }
  return out.sort((a, b) => b.hits - a.hits).slice(0, 30);
}

export async function suggestIntakeRules(db: D1Database): Promise<RuleSuggestion[]> {
  const since = new Date(Date.now() - 180 * 86400_000).toISOString();
  const labeled = await db.prepare(`SELECT l.id, l.title, l.origin, d.category FROM decision_labels d JOIN leads l ON d.subject_kind='lead' AND d.subject_id=CAST(l.id AS TEXT)
    WHERE d.actor_kind='owner' AND d.labeled_at>=? AND l.title IS NOT NULL AND d.category IN (SELECT value FROM json_each(?)) ORDER BY l.id DESC LIMIT 3000`).bind(since, JSON.stringify(BLOCKABLE_CATEGORIES)).all<Labeled>();
  const known = new Set((await db.prepare(`SELECT pattern FROM screening_rules WHERE kind='title_pattern' AND pattern IS NOT NULL`).all<{ pattern: string }>()).results.map(r => r.pattern));
  const platforms = await db.prepare(`SELECT name, aliases FROM platforms`).all<{ name: string; aliases: string | null }>();
  const models = await db.prepare(`SELECT DISTINCT m.value model FROM offers o, json_each(o.models) m WHERE o.review_state='approved' LIMIT 3000`).all<{ model: string }>();
  const vocabulary = [...platforms.results.flatMap(p => [p.name, ...(JSON.parse(p.aliases || '[]') as string[])]), ...models.results.flatMap(m => String(m.model).split(/[\s/]+/))];
  return mineSuggestions(labeled.results, await positiveTitles(db), known, vocabulary);
}

export const ruleInput = z.object({
  pattern: z.string().trim().min(2).max(200),
  category: z.enum(REASON_CATEGORIES).refine(c => (BLOCKABLE_CATEGORIES as readonly string[]).includes(c), '入口过滤只用于非 AI、优惠券/普通折扣、中转站、账号池、个人分享'),
  scopeKind: z.enum(['global', 'origin', 'source']).default('global'),
  scopeValue: z.string().trim().min(1).max(100).nullable().default(null),
  description: z.string().trim().max(300).optional(),
  exampleRefs: z.array(z.string().max(60)).max(20).default([]),
  status: z.enum(['active', 'declined']).default('active'),
  force: z.boolean().default(false),
}).refine(v => v.scopeKind === 'global' || !!v.scopeValue, { message: '限定来源时必须填写来源', path: ['scopeValue'] });

export class RuleError extends Error { constructor(public status: 400 | 404 | 409, message: string, public conflicts: string[] = []) { super(message); } }

export async function createIntakeRule(db: D1Database, raw: unknown, actor: string) {
  const parsed = ruleInput.safeParse(raw);
  if (!parsed.success) throw new RuleError(400, parsed.error.issues.map(i => i.message).join('；'));
  const input = parsed.data;
  try { new RegExp(input.pattern, 'iu'); } catch { throw new RuleError(400, '规则不是有效的正则表达式'); }
  const rule: ScreeningRule = { id: 'rule-' + crypto.randomUUID(), kind: 'title_pattern', scopeKind: input.scopeKind, scopeValue: input.scopeKind === 'global' ? null : input.scopeValue, category: input.category, description: input.description || `标题含「${input.pattern}」`, pattern: input.pattern, status: input.status };
  if (input.status === 'active' && !input.force) {
    // Never block a kind of title that has already produced a real perk.
    const conflicts = (await positiveTitles(db)).filter(title => new RegExp(input.pattern, 'iu').test(title)).slice(0, 5);
    if (conflicts.length) throw new RuleError(409, '这条规则会命中已上架或已关联的真实福利，请改写得更具体', conflicts);
  }
  const now = new Date().toISOString();
  await db.prepare(`INSERT INTO screening_rules(id,kind,scope_kind,scope_value,category,description,pattern,example_refs_json,status,author,created_at,decided_at,decided_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(rule.id, rule.kind, rule.scopeKind, rule.scopeValue, rule.category, rule.description, rule.pattern, JSON.stringify(input.exampleRefs), rule.status, actor, now, now, actor).run();
  return rule;
}

export async function listIntakeRules(db: D1Database) {
  return (await db.prepare(`SELECT id, scope_kind scopeKind, scope_value scopeValue, category, description, pattern, status, hits, created_at createdAt, decided_by decidedBy, retired_reason retiredReason FROM screening_rules WHERE kind='title_pattern' ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, created_at DESC LIMIT 200`).all()).results;
}

export async function retireIntakeRule(db: D1Database, id: string, reason: string, actor: string) {
  const r = await db.prepare(`UPDATE screening_rules SET status='retired', retired_reason=?, decided_at=?, decided_by=? WHERE id=? AND status='active'`).bind(reason.slice(0, 300), new Date().toISOString(), actor, id).run();
  if (!r.meta.changes) throw new RuleError(404, '没有这条启用中的规则');
}

export async function activeTitleRules(db: D1Database): Promise<ScreeningRule[]> {
  const rows = await db.prepare(`SELECT id, kind, scope_kind, scope_value, category, description, pattern, status FROM screening_rules WHERE status='active' AND kind='title_pattern'`).all<{ id: string; kind: 'title_pattern'; scope_kind: ScreeningRule['scopeKind']; scope_value: string | null; category: ScreeningRule['category']; description: string; pattern: string | null; status: ScreeningRule['status'] }>();
  return rows.results.map(row => ({ id: row.id, kind: row.kind, scopeKind: row.scope_kind, scopeValue: row.scope_value, category: row.category, description: row.description, pattern: row.pattern, status: row.status }));
}

type LeadRow = { id: number; url: string; status: string; raw: string | null; title: string | null; resolution: string | null; offer_id: string | null };
/** The closed resolution an intake rule leaves on a lead (also written directly at intake). */
export function ruleResolution(rule: ScreeningRule, key: string | number): LeadResolution & { ruleId: string; reasonCode: string } {
  return { status: 'closed', jobId: `rule-${rule.id}-${key}`, attempts: 0, inconclusive: 0, checkedAt: new Date().toISOString(), nextAttemptAt: null, reason: `入口过滤：${rule.description}`, queries: [], candidates: [], ruleId: rule.id, reasonCode: reasonCodeForCategory(rule.category) };
}

/**
 * Close one open lead because an owner-approved rule matched it: one guarded UPDATE, not the identity refusal path
 * (~10 queries per lead). These leads never become offers, and the URL key already stops the same post coming back.
 */
export async function closeLeadByRule(db: D1Database, lead: LeadRow, rule: ScreeningRule): Promise<boolean> {
  const current = lead.resolution ? JSON.parse(lead.resolution) as { identityTaskIds?: string[]; spotCheck?: { verdict?: string } } : null;
  if (current?.identityTaskIds?.length || current?.spotCheck?.verdict === 'wrong') return false;
  const r = await db.prepare(`UPDATE leads SET status='rejected', resolution=? WHERE id=? AND status IN ('new','reviewing') AND resolution IS ?`).bind(JSON.stringify(ruleResolution(rule, lead.id)), lead.id, lead.resolution).run();
  return !!r.meta.changes;
}

/** Sweep the open backlog with an approved rule; bounded per request (identity mode caps queries), call again while `more`. */
export async function applyRuleToOpenLeads(db: D1Database, rule: ScreeningRule, limit = 30): Promise<{ closed: number; more: boolean }> {
  const open = await db.prepare(`SELECT id, url, status, raw, title, resolution, offer_id, origin FROM leads WHERE status IN ('new','reviewing') AND title IS NOT NULL ORDER BY id DESC LIMIT 2000`).all<LeadRow & { origin: string }>();
  const matching = open.results.filter(lead => {
    const resolution = JSON.parse(lead.resolution || '{}') as { identityTaskIds?: string[]; spotCheck?: { verdict?: string } };
    return !resolution.identityTaskIds?.length && resolution.spotCheck?.verdict !== 'wrong' && matchTitleRule({ title: lead.title ?? '', origin: lead.origin, platformId: null, sourceId: null }, [rule]);
  });
  let closed = 0;
  for (const lead of matching.slice(0, limit)) if (await closeLeadByRule(db, lead, rule)) closed++;
  if (closed) await db.prepare('UPDATE screening_rules SET hits=hits+? WHERE id=?').bind(closed, rule.id).run();
  return { closed, more: matching.length > limit };
}
