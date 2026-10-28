import { describe, expect, it } from 'vitest';
import { normalizeFactors } from '../pipeline/valuation-repair';
import { computeCollectedValuation } from '../src/shared/valuation-intake';
import { sha256 } from '../src/shared/identity/normalize';

describe('估值因子交接', () => {
  it('解开模型多包的一层 valuationFactors（AI21 快速上架原样）', () => {
    const inner = { kind: 'direct_usd', amount: { value: 10, sourceId: 'benefit', quote: '$10 credits for 7 days.' }, period: 'one_time' };
    expect(normalizeFactors({ usdEstimate: null, usdMax: null, valuationFactors: inner }, 'Free Trial $10 credits for 7 days.')).toMatchObject(inner);
  });
  it('AIHOT 通道的直接重置按 Plus 月价四分之一估值', async () => {
    const url = 'https://x.com/thsottiaux/status/2114588174249071102', text = '@thsottiaux\n2026-10-26T05:21:22.000Z\nDay 21/ Wonder what happens the remaining seven days. But today is a reset.';
    const quote = 'Day 21/ Wonder what happens the remaining seven days. But today is a reset.';
    const base = { platformId: 'openai', type: 'perk', tags: ['reset'], sourceText: text,
      sourceFetch: { originalUrl: url, finalUrl: url, fetchedUrl: 'https://cdn.syndication.twimg.com/tweet-result?id=2114588174249071102', method: 'first_party_embed' as const, sourceVerified: true, truncated: false, contentHash: await sha256(text) },
      evidence: { url, tier: 'staff', capturedAt: '2026-10-26T06:18:28.339Z', excerpts: { benefit: quote } },
      valuationFactors: { kind: 'plan', price: { catalogId: 'chatgpt-plus.amount' }, billingPeriod: 'month', benchmark: 'plan_fraction', referencePlan: 'ChatGPT Plus', denominator: { ruleId: 'plan_fraction_quarter' }, sources: [{ id: 'benefit', url, checkedAt: '2026-10-26T06:18:28.339Z', excerpt: quote, priceBasis: '管理员授权的单次重置套餐四分之一参照' }] } };
    const priced = await computeCollectedValuation({ ...base, sourceId: 'aihot-resets' }, '2026-10-26T07:00:00.000Z');
    expect(priced.valuation?.usdEstimate).toBe(5);
    // 不是本通道（模型抽取的重置）仍须原文写明额外一次，不放宽。
    const model = await computeCollectedValuation({ ...base, sourceId: 'openai-x' }, '2026-10-26T07:00:00.000Z');
    expect(model.errors).toContain('unsupported_fraction_policy');
  });
});
