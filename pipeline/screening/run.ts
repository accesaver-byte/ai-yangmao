import { api } from '../lib';
import { DeferError } from '../llm';
import { findNearDuplicate, gateVerdict, matchTitleRule, type GateSubject } from '../../src/shared/screening/gate0';
import type { LegacyIdentityReceipt } from '../identity-client';
import type { OfferIn } from '../../src/shared/ingest';
import { itemId } from '../../src/shared/screening/item-id';
import { screeningMode, type MemorySnapshot, type ScreeningVerdict, type UrgencyResult } from '../../src/shared/screening/types';
import { loadMemory } from './memory';
import { screenSubject, SCREENING_PROMPT_VERSION, type ScreeningSubject } from './screener';

export type ScreeningStats = { screened: number; gate0: number; byVerdict: Record<string, number>; urgent: number; deferred: number; memoryRecords: number };

type QueueItem = { itemId: string; tier: 'P0' | 'P1' | 'P2' | 'P3'; discoveredAt: string; subject: { kind: 'lead' | 'task'; id?: string; leadId?: number; taskId?: string; candidateId?: string | null; title?: string; url?: string; text?: string; truncated?: boolean; origin?: string | null; platformId?: string | null; platformIds?: string[] } };

function blank(): ScreeningStats {
  return { screened: 0, gate0: 0, byVerdict: {}, urgent: 0, deferred: 0, memoryRecords: 0 };
}

function gateSubject(item: QueueItem): GateSubject {
  return { ref: item.itemId, kind: item.subject.kind === 'task' ? 'candidate' : 'lead', url: item.subject.url ?? '', origin: item.subject.origin ?? null, platformId: item.subject.platformId ?? item.subject.platformIds?.[0] ?? null, title: item.subject.title ?? '', openingText: (item.subject.text ?? '').slice(0, 200) };
}

async function postVerdict(item: QueueItem, verdict: ScreeningVerdict, meta: { model: string; calibrated: boolean; contextHash: string; downgradeReasons: string[] }) {
  await api('/screening/verdicts', {
    requestId: `${meta.model}:${item.itemId}:${meta.contextHash}`, itemId: item.itemId,
    subject: { kind: item.subject.kind === 'task' ? 'task' : 'lead', leadId: item.subject.leadId, taskId: item.subject.taskId, platformId: item.subject.platformId ?? null, origin: item.subject.origin ?? null, discoveredAt: item.discoveredAt },
    verdict, ...meta, promptVersion: SCREENING_PROMPT_VERSION,
  });
}

export async function runScreening(o: { ids?: string[]; deadlineAt: number; dry: boolean }): Promise<ScreeningStats> {
  const stats = blank();
  if (screeningMode({ SCREENING_MODE: process.env.SCREENING_MODE }) === 'off') return stats;
  if (!process.env.API_BASE?.trim()) throw new Error('explicit API_BASE required');
  const memory = await loadMemory();
  stats.memoryRecords = memory.records.length;
  const query = new URLSearchParams({ limit: '50' });
  if (o.ids?.length) query.set('ids', o.ids.join(','));
  const queue = await api<{ items: QueueItem[] }>(`/screening/queue?${query}`);
  const normalUntil = Math.min(o.deadlineAt, Date.now() + 10 * 60_000);
  for (const item of queue.items) {
    const urgent = item.tier === 'P0' || item.tier === 'P1';
    if (!urgent && Date.now() >= normalUntil) { stats.deferred++; continue; }
    if (urgent) stats.urgent++;
    const subject = gateSubject(item);
    const rule = matchTitleRule({ title: subject.title, origin: subject.origin, platformId: subject.platformId, sourceId: null }, memory.rules);
    const near = rule ? null : findNearDuplicate(subject, memory, new Date());
    if (rule || near) {
      const verdict = gateVerdict(rule ? { rule } : near!, subject, memory);
      if (!o.dry) await postVerdict(item, verdict, { model: 'gate0', calibrated: false, contextHash: 'gate0', downgradeReasons: [] });
      stats.gate0++; stats.screened++; stats.byVerdict[verdict.verdict] = (stats.byVerdict[verdict.verdict] ?? 0) + 1;
      continue;
    }
    const screeningSubject: ScreeningSubject = {
      itemId: item.itemId, kind: subject.kind, leadId: item.subject.leadId, taskId: item.subject.taskId, candidateId: item.subject.candidateId ?? undefined,
      origin: subject.origin, url: subject.url, title: subject.title, text: item.subject.text ?? '', truncated: item.subject.truncated === true,
      platformIds: item.subject.platformIds ?? (subject.platformId ? [subject.platformId] : []), discoveredAt: item.discoveredAt, deterministicUrgency: verdictUrgency(item.tier),
    };
    try {
      const screened = await screenSubject(screeningSubject, memory, { purpose: urgent ? 'urgent' : 'normal', deadlineAt: o.deadlineAt });
      if (!o.dry) await postVerdict(item, screened.verdict, screened);
      stats.screened++; stats.byVerdict[screened.verdict.verdict] = (stats.byVerdict[screened.verdict.verdict] ?? 0) + 1;
    } catch (error) {
      if (!(error instanceof DeferError)) throw error;
      if (item.tier === 'P0' && !o.dry) await api(`/screening/items/${encodeURIComponent(item.itemId)}/escalate`, { requestId: `escalate:${item.itemId}`, suggestion: 'screening_unavailable', note: error.message });
      else stats.deferred++;
    }
  }
  return stats;
}

function verdictUrgency(tier: QueueItem['tier']): UrgencyResult {
  return { tier, deadline: null, signals: [], quote: null };
}

export async function screenCandidateReceipts(results: LegacyIdentityReceipt[], offers: OfferIn[], memory: MemorySnapshot, o: { deadlineAt: number; dry: boolean; log: (...a: unknown[]) => void }): Promise<void> {
  if (screeningMode({ SCREENING_MODE: process.env.SCREENING_MODE }) === 'off') return;
  for (const result of results) {
    const taskId = result.identityReceipt?.taskId;
    if (result.identityReceipt?.outcome !== 'needs_identity_review' || !taskId) continue;
    const offer = offers.find(item => item.id === result.id);
    const leadId = offer?.leadId;
    if (leadId) {
      try {
        const prior = await api<{ decision: { verdict: string; urgency_json?: string } | null }>(`/screening/items/lead:${leadId}`);
        if (prior.decision?.verdict === 'new_candidate') {
          const verdict: ScreeningVerdict = { verdict: 'new_candidate', matchId: null, ruleId: null, reasonCategory: null, occurrenceCheck: null, confidence: 1, evidenceQuote: offer?.title ?? '', explanation: '沿用线索筛选结果', urgency: verdictUrgency('P3') };
          if (!o.dry) await postVerdict({ itemId: itemId('task', taskId), tier: 'P3', discoveredAt: new Date().toISOString(), subject: { kind: 'task', taskId, title: offer?.title, url: offer?.evidence.url, origin: null } }, verdict, { model: 'derived', calibrated: false, contextHash: 'derived', downgradeReasons: [] });
          continue;
        }
      } catch { /* screen the candidate when the lead verdict is unavailable */ }
    }
    const subject: ScreeningSubject = {
      itemId: itemId('task', taskId), kind: 'candidate', taskId, candidateId: result.identityReceipt?.candidateId, origin: null, url: offer?.evidence.url ?? '', title: offer?.title ?? '', text: offer?.valueText ?? '', truncated: false,
      platformIds: offer ? [offer.platformId] : [], discoveredAt: new Date().toISOString(), deterministicUrgency: verdictUrgency('P3'),
    };
    try {
      const screened = await screenSubject(subject, memory, { purpose: 'normal', deadlineAt: o.deadlineAt });
      if (!o.dry) await postVerdict({ itemId: subject.itemId, tier: screened.verdict.urgency.tier, discoveredAt: subject.discoveredAt, subject: { kind: 'task', taskId, title: subject.title, url: subject.url } }, screened.verdict, screened);
    } catch (error) {
      if (!(error instanceof DeferError)) throw error;
      o.log('candidate screening deferred', taskId);
    }
  }
}
