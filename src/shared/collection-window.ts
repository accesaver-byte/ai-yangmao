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

/**
 * Old news/blog articles re-read from an official news listing (admin 2026-10-29): xAI's 2024-12-12 "you can currently sign up
 * with $25 free credits" and DeepSeek's 2024 R1-Lite preview reached review because they state no end date. For article pages
 * only (pricing/docs pages, X posts and resets keep the 10-22 rule), a time-limited promo (free / new-user / trial) with no end
 * date whose article is over a year old is treated as stale. Long-running programs (grants, nonprofit pricing, standing credits)
 * are not: a 90-day cut replayed on 09-29..10-29 would have lost ChatGPT for Clinicians, Tinker grants, Manus and the Trae trial.
 * The article date is the candidate's publishedAt, else the first date near the top of the page.
 */
export const STALE_ARTICLE_DAYS = 365;
const STALE_TYPES = new Set(['free', 'new', 'trial']);
const ARTICLE_PATH = /\/(news|blog|blogs|index|press|announcements?|posts?|articles?|stories|insights|newsroom)(\/|$)/i;
const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
export function isArticleUrl(url: string): boolean {
  try { const u = new URL(url); return !/(^|\.)(x|twitter)\.com$/.test(u.hostname) && ARTICLE_PATH.test(u.pathname); } catch { return false; }
}
export function articleDate(publishedAt: string | null | undefined, pageText: string): string | null {
  if (publishedAt && /^\d{4}-\d{2}-\d{2}/.test(publishedAt)) return publishedAt.slice(0, 10);
  const head = pageText.slice(0, 3000);
  const pad = (n: number) => String(n).padStart(2, '0');
  const iso = /\b(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})\b/.exec(head) ?? /(20\d{2})年(\d{1,2})月(\d{1,2})日/.exec(head);
  if (iso) return `${iso[1]}-${pad(+iso[2])}-${pad(+iso[3])}`;
  const en = /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+(\d{1,2}),?\s+(20\d{2})\b/i.exec(head);
  return en ? `${en[3]}-${pad(MONTHS[en[1].toLowerCase()])}-${pad(+en[2])}` : null;
}
export function staleArticle(offer: { type?: string; claimEnd?: string | null; publishedAt?: string | null; tags?: readonly string[] }, url: string, pageText: string, now = new Date()): string | null {
  if (offer.claimEnd || offer.tags?.includes('reset') || !STALE_TYPES.has(offer.type ?? '') || !isArticleUrl(url)) return null;
  const date = articleDate(offer.publishedAt, pageText);
  if (!date) return null;
  return now.getTime() - Date.parse(date + 'T00:00:00Z') > STALE_ARTICLE_DAYS * 86400_000 ? date : null;
}
