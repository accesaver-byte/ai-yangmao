import { normUrl, officialStatusKey, similarity } from '../dedupe';
import type { MemoryRecord, MemorySnapshot, ScreeningRule, ScreeningVerdict } from './types';
import { classifyUrgency } from './urgency';

export function urlKey(url: string): string {
  const status = officialStatusKey(url);
  if (status) return status;
  const normalized = normUrl(url);
  const topic = normalized.match(/^linux\.do\/t\/[^/]+\/(\d+)(?:\/\d+)?(?:\?.*)?$/);
  return topic ? `linux.do/t/${topic[1]}` : normalized;
}

export function matchTitleRule(input: { title: string; origin: string | null; platformId: string | null; sourceId: string | null }, rules: ScreeningRule[]): ScreeningRule | null {
  return rules.find(rule => {
    if (rule.status !== 'active' || rule.kind !== 'title_pattern' || !rule.pattern) return false;
    const scope = rule.scopeKind === 'global' || (rule.scopeKind === 'platform' && rule.scopeValue === input.platformId) || (rule.scopeKind === 'source' && rule.scopeValue === input.sourceId) || (rule.scopeKind === 'origin' && rule.scopeValue === input.origin);
    return scope && new RegExp(rule.pattern, 'iu').test(input.title);
  }) ?? null;
}

export type GateSubject = {
  /** The subject's own memory ref (e.g. lead:7675); never a match for itself. */
  ref?: string;
  kind: 'lead' | 'candidate';
  url: string;
  origin: string | null;
  platformId: string | null;
  title: string;
  openingText: string;
  valueText?: string | null;
  claimStart?: string | null;
  claimEnd?: string | null;
};

export type GateMatch = { matchKind: 'decided_url' | 'rejected_lead' | 'linked_offer' | 'offer'; ref: string; similarity: number };

const day = 86400000;
const numbers = (value: string | null | undefined) => (value ?? '').normalize('NFKC').match(/\d[\d,.]*/g)?.map(x => x.replace(/,/g, '')).sort().join('|') ?? '';

function near(subject: GateSubject, record: MemoryRecord): number {
  return similarity(subject.title + subject.openingText.slice(0, 200), record.title + (record.benefitExcerpt ?? '').slice(0, 200));
}

function insideWindow(subject: GateSubject, record: MemoryRecord): boolean {
  const start = subject.claimStart ?? record.claimStart;
  const end = subject.claimEnd ?? record.claimEnd;
  if (record.claimStart && start && start < record.claimStart) return false;
  if (record.claimEnd && end && end > record.claimEnd) return false;
  return true;
}

export function findNearDuplicate(subject: GateSubject, memory: MemorySnapshot, now: Date): GateMatch | null {
  const key = urlKey(subject.url);
  // 2026-10-21: a lead re-screened after it was closed matched its own record as a "rejected repost" (#7675).
  memory = { ...memory, records: memory.records.filter(record => record.ref !== subject.ref) };
  const sameUrl = memory.records.find(record => record.kind === 'lead' && record.urlKey === key && (record.decision === 'linked' || record.decision === 'rejected'));
  if (sameUrl) return { matchKind: 'decided_url', ref: sameUrl.ref, similarity: 1 };
  const recent = (record: MemoryRecord) => !!record.decidedAt && now.getTime() - Date.parse(record.decidedAt) <= 90 * day && now.getTime() >= Date.parse(record.decidedAt);
  const rejected = memory.records.find(record => record.kind === 'lead' && record.decision === 'rejected' && record.actorKind === 'owner' && record.origin === subject.origin && recent(record) && near(subject, record) >= 0.9);
  if (rejected) return { matchKind: 'rejected_lead', ref: rejected.ref, similarity: near(subject, rejected) };
  const linked = memory.records.find(record => record.kind === 'lead' && record.decision === 'linked' && record.actorKind === 'owner' && record.origin === subject.origin && recent(record) && record.linkedOfferId && near(subject, record) >= 0.9);
  if (linked) return { matchKind: 'linked_offer', ref: `offer:${linked.linkedOfferId}`, similarity: near(subject, linked) };
  if (subject.kind === 'candidate') {
    const offer = memory.records.find(record => record.kind === 'offer' && record.platformId === subject.platformId && record.recurring === false && similarity(subject.title, record.title) >= 0.95 && numbers(subject.valueText) === numbers(record.valueText) && insideWindow(subject, record));
    if (offer) return { matchKind: 'offer', ref: offer.ref, similarity: similarity(subject.title, offer.title) };
  }
  return null;
}

export function gateVerdict(match: GateMatch | { rule: ScreeningRule }, subject: GateSubject, memory: MemorySnapshot): ScreeningVerdict {
  const urgency = classifyUrgency({ title: subject.title, text: subject.openingText }, new Date());
  if ('rule' in match) {
    return { verdict: 'rejected_by_rule', matchId: null, ruleId: match.rule.id, reasonCategory: match.rule.category, occurrenceCheck: null, confidence: 1, evidenceQuote: subject.title, explanation: `命中规则：${match.rule.description}`, urgency };
  }
  const record = memory.records.find(item => item.ref === match.ref);
  const decision = match.matchKind === 'rejected_lead' ? 'rejected' : match.matchKind === 'linked_offer' ? 'linked' : record?.decision;
  const verdict = decision === 'rejected' ? 'duplicate_rejected' : decision === 'pending' ? 'duplicate_pending' : 'duplicate_published';
  const explanation = verdict === 'duplicate_rejected' ? '与已拒绝线索相同的转帖' : verdict === 'duplicate_pending' ? '与待审活动相同' : '与已上架活动相同';
  return { verdict, matchId: match.ref, ruleId: null, reasonCategory: record?.reasonCategory ?? null, occurrenceCheck: null, confidence: 1, evidenceQuote: subject.title, explanation, urgency };
}
