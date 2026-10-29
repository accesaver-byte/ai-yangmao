import { expect, it } from 'vitest';
import { articleDate, isArticleUrl, staleArticle } from '../src/shared/collection-window';

const now = new Date('2026-10-29T12:00:00Z');
// 2026-10-29: old news articles re-read from official listings reached review with no end date.
it('treats a year-old news promo with no end date as stale', () => {
  expect(staleArticle({ type: 'new', claimEnd: null, publishedAt: '2024-12-12T00:00:00.000Z' }, 'https://x.ai/news/grok-1212', '', now)).toBe('2024-12-12');
});
it('keeps long-running programs, recent articles, dated promos, pricing pages, X posts and resets', () => {
  expect(staleArticle({ type: 'apply', publishedAt: '2025-10-29' }, 'https://thinkingmachines.ai/news/tinker-grants/', '', now)).toBeNull();
  expect(staleArticle({ type: 'free', publishedAt: '2026-04-22' }, 'https://openai.com/index/chatgpt-for-clinicians', '', now)).toBeNull();
  expect(staleArticle({ type: 'free', claimEnd: '2024-12-31', publishedAt: '2024-12-12' }, 'https://x.ai/news/a', '', now)).toBeNull();
  expect(staleArticle({ type: 'new', publishedAt: '2024-12-12' }, 'https://x.ai/api/pricing', '', now)).toBeNull();
  expect(staleArticle({ type: 'new', publishedAt: '2024-12-12' }, 'https://x.com/xai/status/1', '', now)).toBeNull();
  expect(staleArticle({ type: 'free', publishedAt: '2024-12-12', tags: ['reset'] }, 'https://x.ai/news/a', '', now)).toBeNull();
});
it('reads the article date from the page head when the model gave none', () => {
  expect(articleDate(null, 'Grok 2-1212\nDec 12, 2024\nYou can currently sign up')).toBe('2024-12-12');
  expect(articleDate(null, '发布于 2024年11月20日 今天上线')).toBe('2024-11-20');
  expect(articleDate(null, '今天，DeepSeek 全新研发的推理模型正式上线。')).toBeNull();
  expect(isArticleUrl('https://www.deepseek.com/news/r1-lite-preview/')).toBe(true);
});
