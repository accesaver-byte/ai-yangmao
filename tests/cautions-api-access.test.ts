import { expect, it } from 'vitest';
import { tidy } from '../pipeline/llm';
import { toOffer } from '../pipeline/offer-draft';
import { offerIn } from '../src/shared/ingest';
import type { Source } from '../pipeline/collectors';

// 2026-10-26: official cautions and agent access, kept only as the page states them.
const src = { id: 'gw', kind: 'web_list', tier: 'docs', platformId: 'vendor', url: 'https://vendor.example/docs' } as Source;
const text = 'Free models\nBase URL: https://api.vendor.example/v1\nUse model vendor/free-mini. Free models may log prompts.';
const base = { key: 'gw', platformId: 'vendor', title: 'Vendor 免费模型', type: 'standing', modalities: ['text'], models: [], tags: [], claimMethod: 'signup', requirements: ['net'], audience: 'all', valueText: '免费模型可调用', usdEstimate: null, claimStart: null, claimEnd: null, endKind: 'standing', creditValidity: null, sourceTz: 'UTC', steps: [], excerpts: { benefit: 'Use model vendor/free-mini.' } };
it('keeps cautions and an endpoint whose URL and model IDs are on the page, and passes the schema', () => {
  const o = toOffer(src, tidy({ ...base, cautions: ['免费模型可能记录提示词'], apiAccess: { baseUrl: 'https://api.vendor.example/v1', format: 'openai', modelIds: ['vendor/free-mini', 'vendor/made-up'] } } as never), src.url, text);
  expect(o.evidence.cautions).toEqual(['免费模型可能记录提示词']);
  expect(o.evidence.apiAccess).toEqual({ baseUrl: 'https://api.vendor.example/v1', format: 'openai', modelIds: ['vendor/free-mini'] });
  expect(offerIn.safeParse(o).success).toBe(true);
});
it('drops an endpoint the page does not show', () => {
  const o = toOffer(src, tidy({ ...base, apiAccess: { baseUrl: 'https://guessed.example/v1', format: 'openai', modelIds: [] } } as never), src.url, text);
  expect(o.evidence.apiAccess).toBeUndefined();
  expect(o.evidence.cautions).toBeUndefined();
});
