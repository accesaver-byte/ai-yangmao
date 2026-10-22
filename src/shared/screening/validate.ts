import { screeningVerdictSchema, type MemoryRecord, type ScreeningVerdict, type UrgencyResult } from './types';

export type VerdictContext = {
  subjectText: string;
  supplied: Map<string, MemoryRecord>;
  crossPlatformRefs: Set<string>;
  subjectPlatformIds: string[];
  activeRuleIds: Set<string>;
  subjectDates: { claimStart?: string | null; claimEnd?: string | null };
  deterministicUrgency: UrgencyResult;
};

const duplicateVerdicts = new Set(['duplicate_published', 'duplicate_pending', 'duplicate_rejected']);
const norm = (value: string) => value.normalize('NFKC').replace(/\s+/g, ' ').trim();

function unsure(ctx: VerdictContext, partial?: Partial<ScreeningVerdict>): ScreeningVerdict {
  return {
    verdict: 'unsure', matchId: partial?.matchId ?? null, ruleId: partial?.ruleId ?? null, reasonCategory: partial?.reasonCategory ?? null,
    occurrenceCheck: partial?.occurrenceCheck ?? null, confidence: partial?.confidence ?? 0, evidenceQuote: partial?.evidenceQuote ?? '',
    explanation: partial?.explanation ?? '', urgency: ctx.deterministicUrgency,
  };
}

export function validateVerdict(raw: unknown, ctx: VerdictContext): { verdict: ScreeningVerdict; downgradeReasons: string[] } {
  // Optional fields a model leaves out are not a wrong judgement: default the nullable ones, and urgency comes from the
  // deterministic detector anyway. verdict, confidence and evidenceQuote stay required.
  const filled = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? { matchId: null, ruleId: null, reasonCategory: null, occurrenceCheck: null, explanation: '', ...(raw as Record<string, unknown>), urgency: (raw as { urgency?: unknown }).urgency ?? ctx.deterministicUrgency }
    : raw;
  const parsed = screeningVerdictSchema.safeParse(filled);
  if (!parsed.success) return { verdict: unsure(ctx), downgradeReasons: ['schema_invalid'] };
  const verdict = parsed.data;
  const reasons: string[] = [];
  const match = verdict.matchId ? ctx.supplied.get(verdict.matchId) : undefined;
  if (verdict.matchId && !match) reasons.push('unknown_match');
  if (match && duplicateVerdicts.has(verdict.verdict) && match.platformId && !ctx.subjectPlatformIds.includes(match.platformId) && !ctx.crossPlatformRefs.has(verdict.matchId!)) reasons.push('platform_mismatch');
  const quote = norm(verdict.evidenceQuote);
  if (!quote || !norm(ctx.subjectText).includes(quote)) reasons.push('quote_not_verbatim');
  if (verdict.verdict === 'duplicate_rejected' && match && match.actorKind !== 'owner') reasons.push('non_authoritative_precedent');
  if (verdict.verdict === 'rejected_by_rule' && (!verdict.ruleId || !ctx.activeRuleIds.has(verdict.ruleId))) reasons.push('inactive_rule');
  if (match?.recurring && !verdict.occurrenceCheck) reasons.push('occurrence_check_missing');
  if (match?.recurring && verdict.occurrenceCheck && outside(ctx.subjectDates, match)) reasons.push('outside_matched_round');
  if (reasons.length) return { verdict: unsure(ctx, verdict), downgradeReasons: reasons };
  if ((verdict.urgency.tier === 'P0' || verdict.urgency.tier === 'P1') && (!verdict.urgency.quote || !norm(ctx.subjectText).includes(norm(verdict.urgency.quote)))) {
    return { verdict: { ...verdict, urgency: ctx.deterministicUrgency }, downgradeReasons: ['urgency_quote_missing'] };
  }
  return { verdict, downgradeReasons: [] };
}

function outside(dates: { claimStart?: string | null; claimEnd?: string | null }, match: MemoryRecord): boolean {
  if (dates.claimStart && match.claimStart && dates.claimStart < match.claimStart) return true;
  if (dates.claimStart && match.claimEnd && dates.claimStart > match.claimEnd) return true;
  if (dates.claimEnd && match.claimEnd && dates.claimEnd > match.claimEnd) return true;
  if (dates.claimEnd && match.claimStart && dates.claimEnd < match.claimStart) return true;
  return false;
}
