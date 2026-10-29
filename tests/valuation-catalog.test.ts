import { describe, expect, it } from 'vitest';
import {
  getValuationCatalogPrompt, getValuationFactCatalog, lookupValuationPrice, selectValuationPrice,
  VALUATION_FX_SNAPSHOT, VALUATION_PRICE_CATALOG, valuationPriceFacts, valuationSourceIsFresh,
  type PackagePrice, type TokenModelPrice, type ValuationPrice,
} from '../src/shared/valuation-catalog';

const now = '2026-10-11T12:00:00Z';
const packagePrice = (id: string): PackagePrice => lookupValuationPrice(id, now) as PackagePrice;
const tokenPrice = (id: string): TokenModelPrice => lookupValuationPrice(id, now) as TokenModelPrice;

describe('frozen V2 reusable price facts', () => {
  it('retains source-priced plans without treating reset or multiplier outputs as prices', () => {
    const facts = getValuationFactCatalog(now);
    expect(facts['chatgpt-plus.amount'].value).toBe(20);
    expect(facts['elevenlabs-starter.amount'].value).toBe(6);
    expect(facts['elevenlabs-starter.packageUnits'].value).toBe(30_000);
    expect(facts['elevenlabs-creator.amount'].value).toBe(22);
    expect(facts['lovable-pro-build.amount'].value).toBe(25);
    expect(facts['lovable-pro-build.packageUnits'].value).toBe(100);
    expect(facts['lovable-pro-ai-topup.amount'].value).toBe(15);
    expect(facts['lovable-pro-ai-topup.packageUnits'].value).toBe(50);
    expect(facts['oiioii-base.amount'].value).toBe(17);
    expect(facts['oiioii-base.packageUnits'].value).toBe(1_000);
    expect(facts['dreamina-basic.amount'].value).toBe(15);
    expect(facts['dreamina-basic.packageUnits'].value).toBe(1_575);
    expect(facts['glm-coding-lite.amount'].value).toBe(118);
    expect(facts['glm-coding-pro.amount'].value).toBe(538);
    expect(facts['chatgpt-plus.amount'].value / 4).toBe(5);
    expect(facts).not.toHaveProperty('chatgpt-plus.resetValue');
    expect(facts).not.toHaveProperty('baichuan-m3-plus.workloadMultiplier');
    expect(facts).not.toHaveProperty('poe.dailyQuantity');
    expect(facts).not.toHaveProperty('adobe-photoshop.amount');
    expect(facts).not.toHaveProperty('tapnow.activityValue');
  });
  it('preserves token units, model versions and purchase specifications', () => {
    expect(tokenPrice('swe-2')).toMatchObject({ model: 'SWE-2', inputPrice: 3, outputPrice: 15, tokenPriceUnits: 1_000_000 });
    expect(tokenPrice('baichuan-m3-plus')).toMatchObject({ model: 'Baichuan-M3-Plus', inputPrice: 0.005,
      outputPrice: 0.009, tokenPriceUnits: 1_000, modelClass: 'medical_text', genericProxyEligible: false });
    expect(tokenPrice('baidu-ernie-4.5-turbo-32k')).toMatchObject({ inputPrice: 0.8, outputPrice: 3.2, tokenPriceUnits: 1_000_000 });
    expect(tokenPrice('tencent-qwen3.5-flash')).toMatchObject({ inputPrice: 0.2, outputPrice: 2, tokenPriceUnits: 1_000_000 });
    expect(tokenPrice('tencent-qwen3.5-flash').specification).toContain('0-to-128k');
    for (const fact of Object.values(getValuationFactCatalog(now))) {
      expect(fact.source.checkedAt).toBeTruthy();
      expect(fact.source.priceBasis).toBeTruthy();
      expect(fact.source.excerpt).toBeTruthy();
      expect(new URL(fact.source.url).protocol).toBe('https:');
    }
    expect(new Set(VALUATION_PRICE_CATALOG.map(p => p.id)).size).toBe(VALUATION_PRICE_CATALOG.length);
  });
  it('uses the dated ECB snapshot and expires FX independently of prices', () => {
    const facts = getValuationFactCatalog(now);
    expect(facts['ecb-2026-10-09.CNY'].value).toBe(0.14942927245572862);
    expect(facts['ecb-2026-10-09.INR'].value).toBe(0.010337972166998012);
    expect(VALUATION_FX_SNAPSHOT.date).toBe('2026-10-09');
    const later = getValuationFactCatalog('2026-10-17');
    expect(later['chatgpt-plus.amount'].value).toBe(20);
    expect(later).not.toHaveProperty('ecb-2026-10-09.CNY');
    // Every price has a 30-day life; the newest entries (Kimi, JetBrains, GLM-5.3) were checked 2026-10-28.
    expect(getValuationFactCatalog('2026-11-28')).toEqual({});
    expect(getValuationFactCatalog('2026-10-08')).toEqual({});
    expect(lookupValuationPrice('chatgpt-plus', '2026-11-11')).toBeNull();
    expect(valuationPriceFacts(packagePrice('chatgpt-plus'), '2026-11-11')).toEqual({});
  });
  it('retains currency and purchase identity metadata on every trusted numeric fact', () => {
    const facts = getValuationFactCatalog(now);
    expect(facts['glm-coding-lite.amount']).toMatchObject({ currency: 'CNY', kind: 'price', purpose: 'amount',
      priceId: 'glm-coding-lite', platformId: 'zhipu', plan: 'GLM Coding Lite', billingPeriod: 'month',
      specification: 'personal/regular-monthly' });
    expect(facts['baichuan-m3-plus.inputPrice']).toMatchObject({ currency: 'CNY', kind: 'price', purpose: 'inputPrice',
      priceId: 'baichuan-m3-plus', platformId: 'baichuan', model: 'Baichuan-M3-Plus' });
    expect(facts['baichuan-m3-plus.outputPrice']).toMatchObject({ kind: 'price', purpose: 'outputPrice', priceId: 'baichuan-m3-plus' });
    expect(facts['baichuan-m3-plus.tokenPriceUnits']).toMatchObject({ currency: 'CNY', kind: 'units', purpose: 'tokenPriceUnits',
      value: 1_000, priceId: 'baichuan-m3-plus', model: 'Baichuan-M3-Plus' });
    expect(facts['lovable-pro-build.packageUnits']).toMatchObject({ kind: 'units', purpose: 'packageUnits', currency: 'USD',
      plan: 'Lovable Pro', priceId: 'lovable-pro-build', unit: 'build_credits' });
    expect(facts['ecb-2026-10-09.CNY']).toMatchObject({ currency: 'CNY', kind: 'fx', priceId: 'ecb-2026-10-09',
      platformId: 'ecb', specification: 'USD/CNY' });
    expect(facts['ecb-2026-10-09.INR']).toMatchObject({ currency: 'INR', kind: 'fx', specification: 'USD/INR' });
    for (const [id, fact] of Object.entries(facts)) {
      expect(id.startsWith(`${fact.priceId}.`)).toBe(true);
      expect(fact.currency).toBeTruthy(); expect(fact.platformId).toBeTruthy(); expect(fact.specification).toBeTruthy();
      if (fact.kind !== 'fx') expect(id.endsWith(`.${fact.purpose}`)).toBe(true);
    }
  });
  it('rejects future, malformed and invalid source days', () => {
    expect(valuationSourceIsFresh('2026-10-12', 30, now)).toBe(false);
    expect(valuationSourceIsFresh('2026-02-30', 30, '2026-03-01')).toBe(false);
    expect(valuationSourceIsFresh('yesterday', 30, now)).toBe(false);
    expect(valuationSourceIsFresh('2026-10-11', 30, 'bad')).toBe(false);
    expect(valuationSourceIsFresh('2026-10-11', -1, now)).toBe(false);
  });
  it('keeps prices and source objects immutable and extractor prompt free of amounts', () => {
    expect(Object.isFrozen(VALUATION_PRICE_CATALOG)).toBe(true);
    expect(Object.isFrozen(packagePrice('chatgpt-plus'))).toBe(true);
    expect(Object.isFrozen(packagePrice('chatgpt-plus').sources[0])).toBe(true);
    const prompt = JSON.parse(getValuationCatalogPrompt(now));
    expect(prompt.prices.find((p: { id: string }) => p.id === 'chatgpt-plus').factIds).toEqual(['chatgpt-plus.amount']);
    expect(getValuationCatalogPrompt(now)).not.toContain('"amount":');
    expect(getValuationCatalogPrompt(now)).not.toContain('"packageUnits":');
    expect(getValuationCatalogPrompt(now)).not.toContain('0.149429');
    expect(JSON.parse(getValuationCatalogPrompt('2026-11-28'))).toEqual({ prices: [], fx: null });
  });
});

describe('V2 price selection', () => {
  it('defaults to normal monthly entry plans and honors an explicitly named regular plan', () => {
    expect(selectValuationPrice({ platformId: 'elevenlabs', kind: 'subscription' }, now)?.id).toBe('elevenlabs-starter');
    expect(selectValuationPrice({ platformId: 'elevenlabs', kind: 'subscription', plan: 'ElevenLabs Creator' }, now)?.id).toBe('elevenlabs-creator');
    expect(selectValuationPrice({ platformId: 'openai', kind: 'subscription', id: 'chatgpt-plus' }, now)?.id).toBe('chatgpt-plus');
    const regular = packagePrice('elevenlabs-starter');
    const variants: ValuationPrice[] = [regular,
      { ...regular, id: 'starter-promo', priceType: 'promotion', amount: 1 },
      { ...regular, id: 'starter-annual', billingPeriod: 'year', amount: 2 },
      { ...regular, id: 'enterprise', entryTier: false, amount: 3 }];
    expect(selectValuationPrice({ platformId: 'elevenlabs', kind: 'subscription' }, now, variants)?.id).toBe('elevenlabs-starter');
    expect(selectValuationPrice({ platformId: 'elevenlabs', kind: 'subscription', id: 'starter-promo' }, now, variants)).toBeNull();
  });
  it('matches ledgers, platforms, model versions and context specifications exactly', () => {
    expect(selectValuationPrice({ platformId: 'lovable', kind: 'subscription', unit: 'ai_gateway_credits' }, now)).toBeNull();
    expect(selectValuationPrice({ platformId: 'lovable', kind: 'package', unit: 'ai_gateway_credits' }, now)?.id).toBe('lovable-pro-ai-topup');
    expect(selectValuationPrice({ platformId: 'openai', kind: 'subscription', id: 'elevenlabs-starter' }, now)).toBeNull();
    expect(selectValuationPrice({ platformId: 'devin', kind: 'token_model', model: 'SWE-1.5' }, now)).toBeNull();
    expect(selectValuationPrice({ platformId: 'tencent', kind: 'token_model', model: 'Qwen3.5-Flash', specification: '256k' }, now)).toBeNull();
    const base = tokenPrice('tencent-qwen3.5-flash');
    expect(selectValuationPrice({ platformId: 'tencent', kind: 'token_model', model: base.model }, now,
      [base, { ...base, id: 'qwen-large-context', specification: '256k', inputPrice: 0.8 }])).toBeNull();
  });
  it('retains platform then provider then same-spec OpenRouter priority', () => {
    const model = tokenPrice('swe-2');
    const candidates: ValuationPrice[] = [
      { ...model, id: 'router', authority: 'openrouter', inputPrice: 0.01 },
      { ...model, id: 'provider', authority: 'provider', inputPrice: 0.1 }, model];
    const query = { platformId: 'devin', kind: 'token_model' as const, model: 'SWE-2' };
    expect(selectValuationPrice(query, now, candidates)?.id).toBe('swe-2');
    expect(selectValuationPrice(query, now, candidates.slice(0, 2))?.id).toBe('provider');
    expect(selectValuationPrice(query, now, candidates.slice(0, 1))?.id).toBe('router');
    expect(selectValuationPrice(query, '2026-11-11', candidates)).toBeNull();
  });
  it('prices cheapest generic candidates by actual input/output workload and excludes specialized/free models', () => {
    const base = tokenPrice('tencent-qwen3.5-flash');
    const variants: ValuationPrice[] = [base,
      { ...base, id: 'input-cheap-output-expensive', inputPrice: 0.01, outputPrice: 100 },
      ...(['embedding', 'rerank', 'translation', 'safety', 'medical_text'] as const).map(modelClass =>
        ({ ...base, id: modelClass, modelClass, inputPrice: 0.001, outputPrice: 0.001 })),
      { ...base, id: 'free', inputPrice: 0, outputPrice: 0 }];
    const query = { platformId: 'tencent', kind: 'token_model' as const, selection: 'cheapest_generic' as const,
      inputTokens: 1_000_000, outputTokens: 200_000 };
    expect(selectValuationPrice(query, now, variants)?.id).toBe(base.id);
    expect(selectValuationPrice(query, now, [base, { ...base, id: 'router-cheaper', authority: 'openrouter',
      inputPrice: 0.01, outputPrice: 0.01 }])?.id).toBe(base.id);
    expect(selectValuationPrice({ ...query, outputTokens: undefined }, now, variants)).toBeNull();
    expect(selectValuationPrice({ ...query, outputTokens: Number.NaN }, now, variants)).toBeNull();
    expect(selectValuationPrice({ ...query, platformId: 'baichuan' }, now)).toBeNull();
    expect(selectValuationPrice(query, now, [base, { ...base, id: 'usd', currency: 'USD' }])).toBeNull();
    expect(selectValuationPrice({ platformId: 'tencent', kind: 'token_model', selection: 'exact' }, now)).toBeNull();
    expect(selectValuationPrice({ platformId: 'tencent', kind: 'token_model', model: base.model }, now,
      [{ ...base, inputPrice: 0, outputPrice: 0 }])).toBeNull();
  });
});
