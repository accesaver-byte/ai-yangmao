import { expect, it } from 'vitest';
import { tidy } from '../pipeline/llm';
import { toOffer } from '../pipeline/offer-draft';
import { offerIn } from '../src/shared/ingest';
import type { Source } from '../pipeline/collectors';

// 2026-10-23 (admin): announced-but-not-live perks go to Coming Soon, with their expected time when the post gives one.
const src = { id: 'vendor-news', kind: 'web_list', tier: 'site', platformId: 'vendor', url: 'https://vendor.example/news' } as Source;
const base = { key: 'launch', platformId: 'vendor', title: 'Vendor 新模型限时免费', type: 'free', modalities: ['text'], models: [], tags: [], claimMethod: 'signup', requirements: ['net'], audience: 'all', valueText: '新模型上线后限时免费', usdEstimate: null, claimStart: null, claimEnd: null, endKind: 'unknown', creditValidity: null, sourceTz: 'UTC', steps: [], publishedAt: '2026-10-23', excerpts: { benefit: 'The new model will be free for everyone starting next week.' } } as never;
const text = 'News\nThe new model will be free for everyone starting next week.';
it('records an announced perk as upcoming, with its stated time when given, and it passes the ingest schema', () => {
  const undated = toOffer(src, tidy({ ...(base as object), notYetLive: true } as never), 'https://vendor.example/news', text);
  expect(undated.evidence.upcoming).toEqual({ announcedAt: '2026-10-23' });
  const dated = toOffer(src, tidy({ ...(base as object), notYetLive: true, liveBy: '2026-11-01' } as never), 'https://vendor.example/news', text);
  expect(dated.evidence.upcoming).toEqual({ announcedAt: '2026-10-23', by: '2026-11-01' });
  expect(offerIn.safeParse(dated).success).toBe(true);
});
it('leaves a perk that is already live without an upcoming marker, and drops a liveBy that is not a date', () => {
  expect(toOffer(src, tidy(base), 'https://vendor.example/news', text).evidence.upcoming).toBeUndefined();
  expect(toOffer(src, tidy({ ...(base as object), notYetLive: true, liveBy: 'soon' } as never), 'https://vendor.example/news', text).evidence.upcoming).toEqual({ announcedAt: '2026-10-23' });
});
