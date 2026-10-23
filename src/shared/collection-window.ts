/**
 * Automatic collection takes perks that are running, upcoming, or ended within the current month (admin 2026-10-22,
 * replacing the 2026-10-01 rule that every ended activity enters history). An older post whose perk still runs is
 * current: only a stated end before the first day of this month, in the source's own timezone, keeps a candidate out.
 * Codex resets keep their own policy, and the owner's manual or fast-track entries are not collection.
 */
export function endedBeforeThisMonth(offer: { claimEnd?: string | null; endKind: string; sourceTz: string; tags?: readonly string[] }, now = new Date()): string | null {
  if (!offer.claimEnd || offer.endKind === 'standing' || offer.tags?.includes('reset')) return null;
  let timeZone = offer.sourceTz;
  try { new Intl.DateTimeFormat('en', { timeZone }); } catch { timeZone = 'UTC'; }
  const day = (date: Date) => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
  const end = /^\d{4}-\d{2}-\d{2}$/.test(offer.claimEnd) ? offer.claimEnd : Number.isFinite(Date.parse(offer.claimEnd)) ? day(new Date(offer.claimEnd)) : null;
  if (!end) return null;
  return end < `${day(now).slice(0, 7)}-01` ? end : null;
}
