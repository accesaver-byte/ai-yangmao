/**
 * Automatic term updates of approved perks (2026-11-24, admin: tiers 1 and 2, live).
 *
 * A same-page re-read keeps the approved terms (reviewed-legacy.ts), which silently dropped a vendor's later deadline:
 * the entry then went to history on the old date. These narrow changes from the perk's own official page now apply
 * without the owner; each is listed in「自动关闭抽查」with undo.
 *   extend_deadline — a later end date, quoted in a validity excerpt that is on the page (tier 1)
 *   end_earlier     — an earlier end date, or an end date for a standing perk, quoted the same way (tier 2)
 *   fewer_models    — the candidate names a strict subset of the approved models (tier 2)
 * Everything else — a new amount, model or requirement, another type or channel, resets and recurring perks — stays
 * with the owner. The re-read match has already checked page, vendor and that nothing new is introduced.
 */
import type { OfferIn } from '../ingest';
import { modelSet, pageContains } from './perk-anchors';

export type AutoUpdateKind = 'extend_deadline' | 'end_earlier' | 'fewer_models';
export type AutoUpdate = { kinds: AutoUpdateKind[]; fields: Partial<OfferIn> };

const EXCLUDED_TAGS = new Set(['reset', 'daily']);
const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every(x => b.includes(x));
const DISPLAY_REQUIREMENTS = new Set(['unknown', 'none', 'net']);
const terms = (r: readonly string[]) => r.filter(x => !DISPLAY_REQUIREMENTS.has(x));

/** The end date is the vendor's own words: a validity quote on the page that carries the new date's year. */
function quotedEnd(next: OfferIn, page: string): boolean {
  const quote = next.evidence.excerpts.validity?.trim();
  if (!quote || !next.claimEnd || !pageContains(page, quote)) return false;
  return quote.normalize('NFKC').includes(next.claimEnd.slice(0, 4));
}

export function classifyTermsUpdate(approved: OfferIn, next: OfferIn, page: string, today = new Date().toISOString().slice(0, 10)): AutoUpdate | null {
  if ([...approved.tags, ...next.tags].some(t => EXCLUDED_TAGS.has(t))) return null;
  if (approved.platformId !== next.platformId || approved.type !== next.type || approved.audience !== next.audience || approved.claimMethod !== next.claimMethod) return null;
  if (!sameSet(terms(approved.requirements), terms(next.requirements))) return null;
  if (next.modalities.some(m => !approved.modalities.includes(m))) return null;
  if (next.claimStart && next.claimStart !== approved.claimStart) return null;
  const kinds: AutoUpdateKind[] = [], fields: Partial<OfferIn> = {};

  const was = modelSet(approved.models), now = modelSet(next.models);
  if (now.size && [...now].some(m => !was.has(m))) return null;
  if (now.size && now.size < was.size) { kinds.push('fewer_models'); fields.models = next.models; }

  const endChanged = next.endKind === 'date' && next.claimEnd && (approved.endKind !== 'date' || next.claimEnd !== approved.claimEnd);
  if (endChanged) {
    if (!quotedEnd(next, page)) return null;
    if (approved.endKind === 'date' && approved.claimEnd && next.claimEnd! > approved.claimEnd) kinds.push('extend_deadline');
    else if (next.claimEnd! >= today) kinds.push('end_earlier');
    else return null; // an end already past is a history question, not an update
    Object.assign(fields, { claimEnd: next.claimEnd, endKind: 'date' as const });
  } else if (next.endKind !== approved.endKind && next.endKind !== 'unknown') return null; // dated → standing is an extension the page does not date

  if (!kinds.length) return null;
  // The public text follows the new terms; the reviewed valuation and approved fields not listed here are kept.
  fields.title = next.title;
  fields.valueText = next.valueText;
  if (next.creditValidity) fields.creditValidity = next.creditValidity;
  fields.evidence = { ...approved.evidence, url: next.evidence.url, capturedAt: next.evidence.capturedAt, excerpts: { ...approved.evidence.excerpts, ...Object.fromEntries(Object.entries(next.evidence.excerpts).filter(([, v]) => v?.trim())) } };
  return { kinds, fields };
}
