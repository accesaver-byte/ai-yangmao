import { drizzle } from 'drizzle-orm/d1';
import { and, inArray, sql } from 'drizzle-orm';
import * as s from '../../db/schema';
import { claimEndAt } from '../../shared/lifecycle';
import { classifyUrgency, compareQueueOrder, latestUsefulReviewAt } from '../../shared/screening/urgency';
import { sha256, stableJson } from '../../shared/identity/normalize';
import { canonicalOffers } from '../identity/canonical';
import { canonicalLeadProjection } from '../identity/lead-projection';

type Tier = 'P0' | 'P1' | 'P2' | 'P3';
type Subject = {
  key: string; kind: 'lead' | 'task' | 'offer'; id: string; title: string; text: string; url: string;
  discoveredAt: string; revision: unknown; deadline: string | null; stage: string; offerId?: string;
};
type Screening = { id: string; tier: Tier; tier_by: string; deadline: string | null; urgency_quote: string | null; signals_json: string; revision: number };
export type UrgentReview = Omit<Subject, 'text' | 'revision'> & {
  tier: Tier; reason: string; version: string; suppressed: boolean; expired: boolean; latestUsefulReviewAt: string | null;
};

function timing(value: Record<string, any>): string | null {
  try {
    const end = claimEndAt(value as never);
    return end && Number.isFinite(end.getTime()) ? end.toISOString() : null;
  } catch { return null; } // 不从缺失或非法时区猜测截止时刻。
}
const parsed = (text: string | null): Record<string, any> => {
  try { return JSON.parse(text || '{}'); } catch { return {}; }
};

/** 只读投影：每次重算倒计时，已结案/过期任务自然退出，不改审核状态。 */
export async function readUrgentReviews(db: D1Database, now = new Date()): Promise<UrgentReview[]> {
  const d = drizzle(db, { schema: s });
  const [offers, proposals, leads, taskRows, screenRows, prefs] = await Promise.all([
    d.select().from(s.offers).where(and(canonicalOffers, sql`(${s.offers.reviewState}='pending'
      OR EXISTS(SELECT 1 FROM offer_proposals p WHERE p.offer_id=${s.offers.id})
      OR EXISTS(SELECT 1 FROM benefit_entities e JOIN review_tasks t ON t.entity_id=e.id
        WHERE e.canonical_offer_id=${s.offers.id} AND e.state='active' AND t.state IN ('open','checking','manual')))`)),
    d.select().from(s.offerProposals),
    d.select().from(s.leads).where(inArray(s.leads.status, ['new', 'reviewing'])),
    db.prepare(`SELECT t.id,t.kind,t.state,t.revision,t.created_at,e.canonical_offer_id,rd.basis_json,
      v.display_candidate_json,c.raw_candidate_json,c.id candidate_id
      FROM review_tasks t LEFT JOIN benefit_entities e ON e.id=t.entity_id
      LEFT JOIN benefit_versions v ON v.id=t.version_id AND v.entity_id=e.id
      LEFT JOIN review_decisions rd ON rd.id=t.decision_id
      LEFT JOIN task_candidates tc ON tc.task_id=t.id LEFT JOIN intake_candidates c ON c.id=tc.candidate_id
      WHERE t.state IN ('open','checking','manual') AND (e.id IS NULL OR e.state='active') ORDER BY t.id,c.id`).all<{
        id: string; kind: string; state: string; revision: number; created_at: string; canonical_offer_id: string | null;
        display_candidate_json: string | null; raw_candidate_json: string | null; candidate_id: string | null; basis_json: string | null;
      }>(),
    db.prepare(`SELECT id,tier,tier_by,deadline,urgency_quote,signals_json,revision FROM screening_items
      WHERE id IN (SELECT 'lead:'||id FROM leads WHERE status IN ('new','reviewing')
        UNION SELECT 'task:'||id FROM review_tasks WHERE state IN ('open','checking','manual'))`).all<Screening>(),
    db.prepare('SELECT subject_key,subject_version,suppressed FROM review_urgency_preferences').all<{ subject_key: string; subject_version: string; suppressed: number }>(),
  ]);
  const screens = new Map(screenRows.results.map(row => [row.id, row]));
  const preferences = new Map(prefs.results.map(row => [row.subject_key, row]));
  const subjects: Subject[] = [];
  const managed = new Set(taskRows.results.map(t => t.canonical_offer_id).filter(Boolean));
  const byOffer = new Map(offers.map(o => [o.id, o]));
  const byProposal = new Map(proposals.map(p => [p.offerId, p]));
  for (const o of offers) {
    const proposal = byProposal.get(o.id);
    if (managed.has(o.id) || o.withdrawnAt || (o.reviewState !== 'pending' && !proposal)) continue;
    const target = { ...o, ...(proposal?.candidate || {}) };
    subjects.push({ key: `offer:${o.id}`, kind: 'offer', id: o.id, offerId: o.id, title: target.title,
      text: target.valueText, url: target.evidence?.url || '', discoveredAt: o.discoveredAt,
      revision: [o.updatedAt, proposal?.updatedAt, target], deadline: timing(target), stage: '活动待审：核对领取条件和官方依据后决定' });
  }
  const grouped = new Map<string, typeof taskRows.results>();
  for (const row of taskRows.results) grouped.set(row.id, [...(grouped.get(row.id) || []), row]);
  for (const [id, rows] of grouped) {
    const t = rows[0];
    const original = t.canonical_offer_id ? byOffer.get(t.canonical_offer_id) : null;
    if (original?.withdrawnAt && parsed(t.basis_json).visibilityReopen !== true) continue;
    const candidates = rows.map(r => ({ ...original, ...parsed(r.display_candidate_json || r.raw_candidate_json) }));
    const ends = candidates.map(timing).filter((x): x is string => !!x).sort();
    const chosenEnd = ends.find(end => Date.parse(end) > now.getTime()) || ends[0];
    const candidate = candidates.find(c => timing(c) === chosenEnd) || candidates[0];
    subjects.push({ key: `task:${id}`, kind: 'task', id, offerId: t.canonical_offer_id || undefined,
      title: candidate.title || '待核对活动', text: candidates.map(c => `${c.title || ''}\n${c.valueText || ''}`).join('\n'),
      url: candidate.evidence?.url || '', discoveredAt: t.created_at, revision: [t.revision, rows.map(r => [r.candidate_id, r.raw_candidate_json, r.display_candidate_json])],
      deadline: chosenEnd || null, stage: ['identity', 'merge_conflict'].includes(t.kind) ? '权益查重：先确认是不是同一次福利' : '活动待审：沿用原审核检查' });
  }
  for (const l of await canonicalLeadProjection(db, leads)) {
    if (!['new', 'reviewing'].includes(l.status) || l.resolution?.identityTaskIds?.length) continue;
    subjects.push({ key: `lead:${l.id}`, kind: 'lead', id: String(l.id), title: l.title || '待核实线索',
      text: (l.raw || '').split('[研判]')[0], url: l.url, discoveredAt: l.createdAt,
      revision: [l.title, l.raw, l.url, l.createdAt], deadline: null,
      stage: l.status === 'new' ? '等待研判：尚未形成可发布活动' : l.resolution?.status === 'manual' ? '核实受阻：需要人工查看官方依据' : '官方核实中：尚未批准' });
  }
  return Promise.all(subjects.map(async subject => {
    const screen = screens.get(subject.key);
    const deadline = subject.deadline || (screen?.deadline && Number.isFinite(Date.parse(screen.deadline)) ? screen.deadline : null);
    const age = now.getTime() - Date.parse(subject.discoveredAt);
    const expired = !!deadline && Date.parse(deadline) <= now.getTime();
    // “今天发码”只能短时提级，旧转帖不能因今天重新读取而一直紧急。
    const recent = Number.isFinite(age) && age >= 0 && age <= 24 * 3600_000;
    const urgency = classifyUrgency({ title: recent ? subject.title : '', text: recent ? subject.text : '', claimEndAt: deadline ? new Date(deadline) : null }, now);
    let tier: Tier = urgency.tier;
    if (!expired && recent && screen && screen.tier < tier) tier = screen.tier;
    if (expired) tier = 'P3';
    const version = await sha256(stableJson([subject.key, subject.revision, deadline, screen?.revision, screen?.tier_by]));
    const pref = preferences.get(subject.key);
    const suppressed = pref?.subject_version === version ? !!pref.suppressed : screen?.tier_by === 'owner' && screen.tier === 'P3';
    const { text: _text, revision: _revision, ...publicSubject } = subject;
    return { ...publicSubject, deadline, tier, version, suppressed, expired,
      reason: expired ? '已截止，保留原审核记录，不再加急' : deadline ? '按领取截止时间加急' : urgency.quote || screen?.urgency_quote || '筛选记录提示可能限量或短时发放，仍需核实',
      latestUsefulReviewAt: latestUsefulReviewAt(deadline, tier) };
  }));
}

export function urgentFirst(a: UrgentReview, b: UrgentReview): number {
  return compareQueueOrder({ ...a, tier: a.suppressed ? 'P3' : a.tier }, { ...b, tier: b.suppressed ? 'P3' : b.tier });
}

export async function urgentReviewQueue(db: D1Database, now = new Date()) {
  const rows = (await readUrgentReviews(db, now)).filter(r => !r.expired && (r.tier === 'P0' || r.tier === 'P1')).sort(urgentFirst);
  return { urgent: rows.filter(r => !r.suppressed), urgencyDismissed: rows.filter(r => r.suppressed) };
}
