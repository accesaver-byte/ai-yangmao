/**
 * Wording-tolerant comparison of perk reports (2026-10-16). The extractor rewords the same perk on every run, and
 * different sources describe it differently, so identity shortcuts compare what actually defines a perk — the
 * vendor, amounts, models and requirements — and treat wording only as a tiebreaker.
 */

/** Fold the drift that does not change meaning: width, case, whitespace, punctuation, digit grouping. */
export function foldText(text: string): string {
  return text.normalize('NFKC').toLowerCase()
    .replace(/(\d),(?=\d{3}\b)/g, '$1')
    .replace(/[\s\p{P}\p{S}]+/gu, '');
}

/** Does the page still carry this approved quote, allowing reflow, punctuation and width changes? */
export function pageContains(page: string, quote: string): boolean {
  const q = foldText(quote);
  return q.length >= 6 && foldText(page).includes(q);
}

const YEAR = /^(19|20)\d{2}$/;
/** Amounts and counts in a text: "10,000" and "1万" are both 10000; "$20" is 20; bare years are dropped. */
export function amounts(text: string): Set<string> {
  const out = new Set<string>(), t = text.normalize('NFKC').replace(/(\d),(?=\d{3}(?:\D|$))/g, '$1');
  for (const m of t.matchAll(/(\d+(?:\.\d+)?)\s*(万|千|k\b|m\b)?/gi)) {
    let n = Number(m[1]);
    const unit = (m[2] ?? '').toLowerCase();
    if (unit === '万') n *= 10_000; else if (unit === '千' || unit === 'k') n *= 1_000; else if (unit === 'm') n *= 1_000_000;
    if (!Number.isFinite(n) || (!unit && YEAR.test(m[1]))) continue;
    out.add(String(n));
  }
  return out;
}

const modelKey = (m: string) => foldText(m).replace(/free$/, '');
export function modelSet(models: readonly string[] = []): Set<string> { return new Set(models.map(modelKey).filter(Boolean)); }

/** Character-bigram Jaccard similarity of two folded texts. */
export function textSimilarity(a: string, b: string): number {
  const grams = (s: string) => { const f = foldText(s), g = new Set<string>(); for (let i = 0; i + 1 < f.length; i++) g.add(f.slice(i, i + 2)); return g; };
  const x = grams(a), y = grams(b);
  if (!x.size || !y.size) return 0;
  let both = 0; for (const g of x) if (y.has(g)) both++;
  return both / (x.size + y.size - both);
}

export type PerkView = { platformId: string; title: string; valueText: string; models?: readonly string[]; requirements?: readonly string[] };
const jaccard = (a: Set<string>, b: Set<string>) => { if (!a.size && !b.size) return 1; let both = 0; for (const v of a) if (b.has(v)) both++; return both / (a.size + b.size - both); };

/**
 * Two reports of the same perk, for grouping into one review card. Same vendor required; then either the amounts and
 * models line up with reasonably similar text, or the text is close on its own. Grouping only merges review work —
 * the owner still sees every source and decides.
 */
export function samePerk(a: PerkView, b: PerkView): boolean {
  if (a.platformId !== b.platformId) return false;
  const text = textSimilarity(`${a.title} ${a.valueText}`, `${b.title} ${b.valueText}`);
  const na = amounts(`${a.title} ${a.valueText}`), nb = amounts(`${b.title} ${b.valueText}`);
  const ma = modelSet(a.models), mb = modelSet(b.models);
  // Both sides state amounts (or models) and they differ: a different perk, however alike the wording.
  const amountsConflict = na.size > 0 && nb.size > 0 && jaccard(na, nb) < 0.5;
  const modelsConflict = ma.size > 0 && mb.size > 0 && jaccard(ma, mb) < 0.3;
  if (amountsConflict || modelsConflict) return false;
  const anchored = (na.size > 0 && nb.size > 0) || (ma.size > 0 && mb.size > 0);
  return (anchored && text >= 0.25) || text >= 0.55;
}

/**
 * A re-read of an approved perk introduces nothing new: every amount, model and requirement it states is already in
 * the approved terms. Wording is ignored; a new number, model or requirement sends it to the owner.
 */
export function introducesNothingNew(candidate: PerkView & { steps?: readonly string[] }, approved: { texts: readonly string[]; models?: readonly string[]; requirements?: readonly string[] }): boolean {
  const known = amounts(approved.texts.join(' '));
  for (const n of amounts(`${candidate.title} ${candidate.valueText}`)) if (!known.has(n)) return false;
  const models = modelSet(approved.models);
  for (const m of modelSet(candidate.models)) if (!models.has(m)) return false;
  const reqs = new Set((approved.requirements ?? []).filter(r => r !== 'unknown'));
  for (const r of candidate.requirements ?? []) if (r !== 'unknown' && r !== 'none' && !reqs.has(r)) return false;
  return true;
}
