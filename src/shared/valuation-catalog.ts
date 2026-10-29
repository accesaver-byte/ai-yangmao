import type { Valuation } from './valuation';

export type ValuationPriceSource = Valuation['sources'][number];
export type ValuationCurrency = 'USD' | 'CNY' | 'INR';
export type PriceAuthority = 'platform' | 'provider' | 'openrouter';
export type ModelPriceClass = 'general_text' | 'coding' | 'medical_text' | 'embedding' | 'rerank' | 'translation' | 'safety';

interface PriceBase {
  id: string;
  platformId: string;
  currency: ValuationCurrency;
  authority: PriceAuthority;
  /** A purchase specification, never a claim about the free entitlement. */
  specification: string;
  sources: readonly ValuationPriceSource[];
  /** Operational revalidation policy; this does not claim an official price guarantee. */
  maxAgeDays: number;
}
export interface PackagePrice extends PriceBase {
  kind: 'subscription' | 'package';
  plan: string;
  amount: number;
  billingPeriod: 'month' | 'year' | 'one_off';
  priceType: 'regular' | 'promotion';
  entryTier: boolean;
  packageUnits?: number;
  unit?: string;
}
export interface TokenModelPrice extends PriceBase {
  kind: 'token_model';
  model: string;
  modelClass: ModelPriceClass;
  inputPrice: number;
  outputPrice: number;
  tokenPriceUnits: number;
  inputMode: 'uncached';
  /** Only prechecked generic proxy candidates may participate in cheapest selection. */
  genericProxyEligible: boolean;
}
export type ValuationPrice = PackagePrice | TokenModelPrice;
interface ValuationFactMetadata {
  value: number;
  source: ValuationPriceSource;
  currency: ValuationCurrency;
  priceId: string;
  platformId: string;
  specification: string;
  model?: string;
  plan?: string;
  billingPeriod?: PackagePrice['billingPeriod'];
  unit?: string;
  authority?: PriceAuthority;
}
/** Numbers remain inseparable from their currency, purpose and matching purchase specification. */
export type ValuationCatalogFact = ValuationFactMetadata & (
  | { kind: 'price'; purpose: 'amount' | 'inputPrice' | 'outputPrice' }
  | { kind: 'units'; purpose: 'packageUnits' | 'tokenPriceUnits' }
  | { kind: 'fx'; purpose?: never }
);
export type ValuationFactCatalog = Record<string, ValuationCatalogFact>;

const source = (url: string, checkedAt: string, excerpt: string, priceBasis: string): ValuationPriceSource =>
  ({ url, checkedAt, excerpt, priceBasis });
const checked = '2026-10-11T08:01:16Z';
const modelChecked = '2026-10-11T08:04:38.100371+00:00';
const openaiSource = source('https://learn.chatgpt.com/docs/pricing', '2026-10-11T08:01:23.289781Z',
  'Individual monthly plans: Go $8; Plus $20; Pro plans $100, $200 or $500 USD per month. ChatGPT Work and Codex share usage.',
  'current_personal_monthly_catalog');
const glmSource = source('https://bigmodel.cn/glm-coding', '2026-10-11T08:01:23.289781Z',
  'Lite：¥94.4/月、¥118/月；Pro：¥430.4/月、¥538/月；Max：¥862.4/月、¥1078/月。采用每档未打折月价118、538、1078作为月订阅基准。',
  'current_regular_monthly_reference');
const monthly = (id: string, platformId: string, plan: string, amount: number, currency: ValuationCurrency,
  entryTier: boolean, specification: string, sources: readonly ValuationPriceSource[],
  pool?: { packageUnits: number; unit: string }): PackagePrice => ({
  id, platformId, kind: 'subscription', plan, amount, currency, billingPeriod: 'month', priceType: 'regular',
  entryTier, specification, authority: 'platform', sources, maxAgeDays: 30, ...pool,
});

/** Derived only from the frozen 2026-10-11 V2 manifest and its retained price evidence.
 * No accepted activity amount, entitlement quantity, workload multiplier or third-party quota is a catalog fact.
 * OpenRouter remains a same-model/spec fallback; no synthetic OpenRouter prices are introduced here.
 */
export const VALUATION_PRICE_CATALOG: readonly ValuationPrice[] = [
  monthly('chatgpt-go', 'openai', 'ChatGPT Go', 8, 'USD', true, 'individual/monthly', [openaiSource]),
  monthly('chatgpt-plus', 'openai', 'ChatGPT Plus', 20, 'USD', false, 'individual/monthly', [openaiSource]),
  monthly('chatgpt-pro100', 'openai', 'ChatGPT Pro100', 100, 'USD', false, 'individual/monthly/Pro100', [openaiSource]),
  monthly('chatgpt-pro200', 'openai', 'ChatGPT Pro200', 200, 'USD', false, 'individual/monthly/Pro200', [openaiSource]),
  monthly('chatgpt-pro500', 'openai', 'ChatGPT Pro500', 500, 'USD', false, 'individual/monthly/Pro500', [openaiSource]),
  monthly('elevenlabs-starter', 'elevenlabs', 'ElevenLabs Starter', 6, 'USD', true, 'monthly/credits', [
    source('https://elevenlabs.io/pricing', checked, 'Starter $6 (30,000 credits)', 'official_entry_monthly_package_used_as_benchmark'),
  ], { packageUnits: 30_000, unit: 'credits' }),
  monthly('elevenlabs-creator', 'elevenlabs', 'ElevenLabs Creator', 22, 'USD', false, 'monthly/credits', [
    source('https://elevenlabs.io/pricing', checked, 'Creator $22 (121,000 credits, $11 for the first month)', 'official_creator_regular_monthly_package_benchmark'),
  ], { packageUnits: 121_000, unit: 'credits' }),
  monthly('lovable-pro-build', 'lovable', 'Lovable Pro', 25, 'USD', true, 'monthly/build-credits', [
    source('https://docs.lovable.dev/introduction/subscription-plans', checked, '100 | $25 | $250 ($21/month)', 'official_pro_entry_monthly_price'),
  ], { packageUnits: 100, unit: 'build_credits' }),
  { id: 'lovable-pro-ai-topup', platformId: 'lovable', kind: 'package', plan: 'Lovable Pro top-up', amount: 15,
    currency: 'USD', authority: 'platform', billingPeriod: 'one_off', priceType: 'regular', entryTier: true,
    packageUnits: 50, unit: 'ai_gateway_credits', specification: 'Pro/top-up/AI-gateway-credits', maxAgeDays: 30,
    sources: [source('https://docs.lovable.dev/introduction/credits-and-usage', checked,
      '$15 per 50 credits | $0.30 per credit', 'official_pro_topup_benchmark')] },
  monthly('oiioii-base', 'oiioii', 'OiiOii BASE', 17, 'USD', true, 'monthly/guaranteed-purchased-credits', [
    source('https://www.oiioii.ai/price', checked, '$17/ Mo,1 credit = $0.013\nGet 1000 Credits instantly + 310 Credits from check-ins',
      'official_base_package_guaranteed_and_conditional_credit_split'),
  ], { packageUnits: 1_000, unit: 'credits' }),
  monthly('dreamina-basic', 'dreamina', 'Dreamina Basic', 15, 'USD', true, 'international-USD/monthly/credits', [
    source('https://dreamina.capcut.com/pricing/dreamina-price', '2026-10-11T07:56:54.755122+00:00',
      'USD 1.50 for the first month, then USD 15.00/month. Cancel anytime.The subscription will automatically renew.\n1575 credits/month',
      'current_normal_monthly_renewal_price'),
  ], { packageUnits: 1_575, unit: 'credits' }),
  monthly('glm-coding-lite', 'zhipu', 'GLM Coding Lite', 118, 'CNY', true, 'personal/regular-monthly', [glmSource]),
  monthly('glm-coding-pro', 'zhipu', 'GLM Coding Pro', 538, 'CNY', false, 'personal/regular-monthly', [glmSource]),
  monthly('glm-coding-max', 'zhipu', 'GLM Coding Max', 1_078, 'CNY', false, 'personal/regular-monthly', [glmSource]),
  { id: 'swe-2', platformId: 'devin', kind: 'token_model', model: 'SWE-2', modelClass: 'coding', currency: 'USD',
    authority: 'platform', inputPrice: 3, outputPrice: 15, tokenPriceUnits: 1_000_000, inputMode: 'uncached',
    genericProxyEligible: false, specification: 'SWE-2/list-price/uncached-input', maxAgeDays: 30,
    sources: [source('https://docs.devin.ai/desktop/models', '2026-10-10T03:03:01.841653+00:00',
      'SWE-2 is free for self-serve plans through October 15, 2026. List pricing ($3.00/1M input, $15.00/1M output, $0.30/1M cache input) applies afterward.',
      'current_reference')] },
  { id: 'baichuan-m3-plus', platformId: 'baichuan', kind: 'token_model', model: 'Baichuan-M3-Plus', modelClass: 'medical_text',
    currency: 'CNY', authority: 'provider', inputPrice: 0.005, outputPrice: 0.009, tokenPriceUnits: 1_000, inputMode: 'uncached',
    genericProxyEligible: false, specification: '32k/model-tokens/excludes-separately-billed-medical-search', maxAgeDays: 30,
    sources: [source('https://platform.baichuan-ai.com/prices', modelChecked,
      '模型调用 Baichuan-M3-Plus 32k 00:00 ~ 24:00 输入：0.005元/千tokens\n输出：0.009元/千tokens', 'same_version_official_model_price')] },
  { id: 'baidu-ernie-4.5-turbo-32k', platformId: 'baidu', kind: 'token_model', model: 'ERNIE-4.5-Turbo-32K', modelClass: 'general_text',
    currency: 'CNY', authority: 'provider', inputPrice: 0.8, outputPrice: 3.2, tokenPriceUnits: 1_000_000, inputMode: 'uncached',
    genericProxyEligible: true, specification: '32k/online-postpaid/uncached-input/excludes-search', maxAgeDays: 30,
    sources: [source('https://cloud.baidu.com/doc/qianfan/s/wmh4sv6ya', modelChecked,
      '| ERNIE-4.5-Turbo-32K | 推理服务 | 输入 | 0.0008 | 0.00032 | 元/千tokens |\n| 输出 | 0.0032 | 0.00128 | 元/千tokens |',
      'current_official_paid_online_model_proxy; ordinary postpaid per-1000 price converted to per-million')] },
  { id: 'tencent-qwen3.5-flash', platformId: 'tencent', kind: 'token_model', model: 'Qwen3.5-Flash', modelClass: 'general_text',
    currency: 'CNY', authority: 'platform', inputPrice: 0.2, outputPrice: 2, tokenPriceUnits: 1_000_000, inputMode: 'uncached',
    genericProxyEligible: true, specification: 'Guangzhou/online/input-context-0-to-128k/uncached', maxAgeDays: 30,
    sources: [source('https://cloud.tencent.com/document/product/1823/130055', modelChecked,
      'Qwen3.5-Flash 输入长度（0, 128k]-0.2 2 0.02', 'current_official_paid_general_text_proxy; CNY per-million input/output/cache-input')] },
  // 2026-10-18: five recent perks (WorkBuddy, OpenCode ×3, DeepSeek) went unvalued for want of this provider price.
  // Off-peak is half of peak and covers most hours; V2 takes the lower applicable rate.
  { id: 'deepseek-v4.1-flash', platformId: 'deepseek', kind: 'token_model', model: 'DeepSeek-V4.1-Flash', modelClass: 'general_text', currency: 'USD',
    authority: 'provider', inputPrice: 0.15, outputPrice: 0.6, tokenPriceUnits: 1_000_000, inputMode: 'uncached',
    genericProxyEligible: false, specification: 'DeepSeek-V4.1-Flash-1017/off-peak/uncached-input', maxAgeDays: 30,
    sources: [source('https://api-docs.deepseek.com/quick_start/pricing/', '2026-10-18T04:20:00Z',
      '1M INPUT TOKENS (CACHE MISS) OFF-PEAK $0.15 $0.66 PEAK $0.3 $1.32 1M OUTPUT TOKENS OFF-PEAK $0.6 $1.98 PEAK $1.2 $3.96',
      'same_version_official_model_price; off-peak (half of peak) is the lower applicable rate')] },
  // 2026-10-28: unvalued perks (Kimi K3.1 Pro compensation, JetBrains AI credits, ZCode GLM-5.3 tokens) had no matching price.
  monthly('kimi-code-plus', 'moonshot', 'Kimi Code Plus', 19, 'USD', true, 'individual/monthly-billing', [
    source('https://www.kimi.com/code', '2026-10-28T23:40:00Z', 'Plus $15 / month $19 Billed annually $180', 'official_entry_monthly_billing_price (annual-billing $15 not used)'),
  ]),
  monthly('kimi-code-pro', 'moonshot', 'Kimi Code Pro', 39, 'USD', false, 'individual/monthly-billing', [
    source('https://www.kimi.com/code', '2026-10-28T23:40:00Z', 'Pro $31 / month $39 Billed annually $372', 'official_regular_monthly_billing_price'),
  ]),
  monthly('kimi-code-max', 'moonshot', 'Kimi Code Max', 99, 'USD', false, 'individual/monthly-billing', [
    source('https://www.kimi.com/code', '2026-10-28T23:40:00Z', 'Max $79 / month $99 Billed annually $948', 'official_regular_monthly_billing_price'),
  ]),
  monthly('jetbrains-ai-pro', 'jetbrains', 'JetBrains AI Pro', 10, 'USD', true, 'monthly/ai-credits', [
    source('https://www.jetbrains.com/help/ai-assistant/licensing-and-subscriptions.html', '2026-10-28T23:40:00Z',
      'Each AI credit equals $1 USD charged in your local currency.', 'official_credit_unit_price; AI Pro $10 USD for 10 AI credits per 30-days'),
  ], { packageUnits: 10, unit: 'ai_credits' }),
  { id: 'glm-5.3', platformId: 'zhipu', kind: 'token_model', model: 'GLM-5.3', modelClass: 'general_text', currency: 'CNY',
    authority: 'platform', inputPrice: 8, outputPrice: 28, tokenPriceUnits: 1_000_000, inputMode: 'uncached',
    genericProxyEligible: false, specification: 'GLM-5.3/1M-context/uncached-input', maxAgeDays: 30,
    sources: [source('https://bigmodel.cn/pricing', '2026-10-28T23:40:00Z', 'GLM-5.3 输入单价 8元 / M 输出单价 28元 / M 缓存命中 2元 / M',
      'same_version_official_model_price; CNY per-million input/output')] },
  { id: 'glm-5.3-flash', platformId: 'zhipu', kind: 'token_model', model: 'GLM-5.3-Flash', modelClass: 'general_text', currency: 'CNY',
    authority: 'platform', inputPrice: 0.8, outputPrice: 2.8, tokenPriceUnits: 1_000_000, inputMode: 'uncached',
    genericProxyEligible: false, specification: 'GLM-5.3-Flash/uncached-input', maxAgeDays: 30,
    sources: [source('https://bigmodel.cn/pricing', '2026-10-28T23:40:00Z', 'GLM-5.3-Flash 0.8元 / M 2.8元 / M 0.23元 / M',
      'same_version_official_model_price; CNY per-million input/output')] },
  // 2026-10-19 credit-pack benchmarks for platforms whose free/sign-up credits kept valuing as unknown. Official pages only;
  // an official top-up price takes priority over plan arithmetic, otherwise the lower applicable plan rate.
  monthly('meshy-pro', 'meshy', 'Meshy Pro', 20, 'USD', true, 'monthly/credits', [
    source('https://www.meshy.ai/pricing', '2026-10-19T03:30:00Z', 'Billed monthly, $ 20 / month Subscribe Now Privileges: 🔥 Access to the World\'s First 3D Agent NEW 1,000 monthly credits (up to 100 assets)',
      'official_entry_monthly_package_regular_price; $10 first month is a new-user promotion'),
  ], { packageUnits: 1_000, unit: 'credits' }),
  monthly('vidu-standard', 'vidu', 'Vidu Standard', 8.25, 'USD', true, 'yearly-billed/monthly-equivalent/credits', [
    source('https://www.vidu.com/pricing', '2026-10-19T03:30:00Z', '$8.25/month$10\n\nBilled yearly as $99\n\n800 credits monthly\n\n100 credits = $1.03',
      'official_entry_plan; yearly-billed rate is the lower applicable rate and matches the page\'s own 100 credits = $1.03'),
  ], { packageUnits: 800, unit: 'credits' }),
  { id: 'tripo-credits-topup', platformId: 'tripo', kind: 'package', plan: 'Tripo credit top-up', amount: 10,
    currency: 'USD', authority: 'platform', billingPeriod: 'one_off', priceType: 'regular', entryTier: true,
    packageUnits: 1_000, unit: 'credits', specification: 'top-up/credits/smallest-pack', maxAgeDays: 30,
    sources: [source('https://www.tripo3d.ai/pricing', '2026-10-19T03:30:00Z', '$10\n\n1000 credits', 'official_topup_benchmark; top-up price preferred over plan arithmetic')] },
  { id: 'qoder-credit-pack', platformId: 'qoder', kind: 'package', plan: 'Qoder Credit Pack', amount: 20,
    currency: 'USD', authority: 'platform', billingPeriod: 'one_off', priceType: 'regular', entryTier: true,
    packageUnits: 1_500, unit: 'credits', specification: 'credit-pack/1-month-validity', maxAgeDays: 30,
    sources: [source('https://docs.qoder.com/account/pricing', '2026-10-19T03:30:00Z', '| Price | $20 USD / 1,500 Credits |', 'official_topup_benchmark; paid subscribers can buy packs')] },
  // 2026-10-19: four perks (Command Code, MiniMax Code, Cline, OpenCode) offer MiniMax-M3.1-Flash free; provider list price.
  { id: 'minimax-m3.1-flash', platformId: 'minimax', kind: 'token_model', model: 'MiniMax-M3.1-Flash', modelClass: 'general_text', currency: 'USD',
    authority: 'provider', inputPrice: 0.15, outputPrice: 0.6, tokenPriceUnits: 1_000_000, inputMode: 'uncached',
    genericProxyEligible: false, specification: 'MiniMax-M3.1-Flash/standard/uncached-input', maxAgeDays: 30,
    sources: [source('https://platform.minimax.io/docs/pricing/overview', '2026-10-19T04:00:00Z',
      'Model Input Output Prompt caching Read MiniMax-M3.1-Flash $0.15 / M tokens $0.60 / M tokens $0.015 / M tokens',
      'same_version_official_model_price; standard tier')] },
];

export const VALUATION_FX_SNAPSHOT = {
  id: 'ecb-2026-10-09', date: '2026-10-09', maxAgeDays: 7,
  rates: { CNY: 0.14942927245572862, INR: 0.010337972166998012 },
  source: source('https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml', '2026-10-09',
    "<Cube time='2026-10-09'>\n<Cube currency='USD' rate='1.1206'/>\n<Cube currency='CNY' rate='7.4992'/>\n<Cube currency='INR' rate='108.3965'/>",
    'official_fx_reference; USD/CNY=1.1206/7.4992; USD/INR=1.1206/108.3965'),
} as const;

function freezeSnapshot(value: object): void {
  for (const child of Object.values(value)) if (child && typeof child === 'object') freezeSnapshot(child);
  Object.freeze(value);
}
freezeSnapshot(VALUATION_PRICE_CATALOG);
freezeSnapshot(VALUATION_FX_SNAPSHOT);

/** Compare UTC source days; future, malformed, and expired snapshots cannot produce trusted facts. */
export function valuationSourceIsFresh(checkedAt: string, maxAgeDays: number, now: Date | string = new Date()): boolean {
  const current = new Date(now).getTime();
  const captured = new Date(checkedAt).getTime();
  if (!Number.isFinite(current) || !Number.isFinite(captured) || !Number.isFinite(maxAgeDays) || maxAgeDays < 0) return false;
  if (!/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(checkedAt)
    || (checkedAt.length === 10 && new Date(captured).toISOString().slice(0, 10) !== checkedAt)) return false;
  const day = 86_400_000;
  const ageDays = Math.floor(current / day) - Math.floor(captured / day);
  return ageDays >= 0 && ageDays <= maxAgeDays;
}
export function valuationPriceIsFresh(price: ValuationPrice, now: Date | string = new Date()): boolean {
  return price.sources.length > 0 && price.sources.every(s => valuationSourceIsFresh(s.checkedAt, price.maxAgeDays, now));
}
export function lookupValuationPrice(id: string, now: Date | string = new Date()): ValuationPrice | null {
  const price = VALUATION_PRICE_CATALOG.find(p => p.id === id);
  return price && valuationPriceIsFresh(price, now) ? price : null;
}
export function valuationPriceFacts(price: ValuationPrice, now: Date | string = new Date()): ValuationFactCatalog {
  if (!valuationPriceIsFresh(price, now)) return {};
  const facts: ValuationFactCatalog = {};
  const primary = price.sources[0];
  const metadata = { source: primary, currency: price.currency, priceId: price.id, platformId: price.platformId,
    specification: price.specification, authority: price.authority,
    ...(price.kind === 'token_model' ? { model: price.model }
      : { plan: price.plan, billingPeriod: price.billingPeriod, ...(price.unit ? { unit: price.unit } : {}) }) };
  const putPrice = (purpose: 'amount' | 'inputPrice' | 'outputPrice', value: number) => {
    facts[`${price.id}.${purpose}`] = { ...metadata, value, kind: 'price', purpose };
  };
  const putUnits = (purpose: 'packageUnits' | 'tokenPriceUnits', value: number) => {
    facts[`${price.id}.${purpose}`] = { ...metadata, value, kind: 'units', purpose };
  };
  if (price.kind === 'token_model') {
    putPrice('inputPrice', price.inputPrice); putPrice('outputPrice', price.outputPrice); putUnits('tokenPriceUnits', price.tokenPriceUnits);
  } else {
    putPrice('amount', price.amount);
    if (price.packageUnits !== undefined) putUnits('packageUnits', price.packageUnits);
  }
  return facts;
}
export function getValuationFactCatalog(now: Date | string = new Date()): ValuationFactCatalog {
  const facts = Object.assign({}, ...VALUATION_PRICE_CATALOG.map(p => valuationPriceFacts(p, now))) as ValuationFactCatalog;
  const fx = VALUATION_FX_SNAPSHOT;
  if (valuationSourceIsFresh(fx.date, fx.maxAgeDays, now)) {
    for (const currency of ['CNY', 'INR'] as const) facts[`${fx.id}.${currency}`] = {
      value: fx.rates[currency], source: fx.source, kind: 'fx', currency, priceId: fx.id, platformId: 'ecb', specification: `USD/${currency}`,
    };
  }
  return facts;
}

/** The extractor may name facts; it must never author their numeric values. */
export function getValuationCatalogPrompt(now: Date | string = new Date()): string {
  const rows = VALUATION_PRICE_CATALOG.filter(p => valuationPriceIsFresh(p, now)).map(p => ({
    id: p.id, platformId: p.platformId, kind: p.kind, currency: p.currency, specification: p.specification,
    ...(p.kind === 'token_model' ? { model: p.model, modelClass: p.modelClass, genericProxyEligible: p.genericProxyEligible }
      : { plan: p.plan, billingPeriod: p.billingPeriod, entryTier: p.entryTier, unit: p.unit }),
    factIds: Object.keys(valuationPriceFacts(p, now)),
  }));
  const fx = VALUATION_FX_SNAPSHOT;
  return JSON.stringify({ prices: rows, fx: valuationSourceIsFresh(fx.date, fx.maxAgeDays, now)
    ? { date: fx.date, factIds: Object.keys(fx.rates).map(currency => `${fx.id}.${currency}`) } : null });
}

export interface ValuationPriceQuery {
  platformId: string;
  kind: ValuationPrice['kind'];
  id?: string;
  plan?: string;
  model?: string;
  specification?: string;
  unit?: string;
  /** Must be deliberately selected by the extraction/valuation policy, never inferred from an opaque credit count. */
  selection?: 'entry_monthly' | 'exact' | 'cheapest_generic';
  inputTokens?: number;
  outputTokens?: number;
}
const authorityOrder: Record<PriceAuthority, number> = { platform: 0, provider: 1, openrouter: 2 };
/** Exact model/spec matching preserves platform -> provider -> same-version OpenRouter priority.
 * Cheapest proxy candidates exclude specialized and free models; median-of-models remains the engine's responsibility.
 */
export function selectValuationPrice(query: ValuationPriceQuery, now: Date | string = new Date(),
  catalog: readonly ValuationPrice[] = VALUATION_PRICE_CATALOG): ValuationPrice | null {
  let candidates = catalog.filter(p => p.platformId === query.platformId && p.kind === query.kind && valuationPriceIsFresh(p, now)
    && (!query.id || p.id === query.id) && (!query.specification || p.specification === query.specification)
    && (!query.model || (p.kind === 'token_model' && p.model === query.model))
    && (!query.plan || (p.kind !== 'token_model' && p.plan === query.plan))
    && (!query.unit || (p.kind !== 'token_model' && p.unit === query.unit)));
  if (query.selection === 'exact' && !query.id && !query.plan && !query.model) return null;
  if (query.kind !== 'token_model') {
    candidates = candidates.filter(p => p.kind !== 'token_model' && p.priceType === 'regular' && p.amount > 0
      && (query.kind !== 'subscription' || p.billingPeriod === 'month')
      && (query.id || query.plan || p.entryTier));
    // An unresolved unit/specification is ambiguous, not permission to select a different credit ledger.
    if (new Set(candidates.map(p => p.specification)).size > 1 && !query.id && !query.plan) return null;
    return candidates.sort((a, b) => authorityOrder[a.authority] - authorityOrder[b.authority]
      || (a as PackagePrice).amount - (b as PackagePrice).amount)[0] ?? null;
  }
  candidates = candidates.filter(p => p.kind === 'token_model' && Number.isFinite(p.inputPrice) && Number.isFinite(p.outputPrice)
    && Number.isFinite(p.tokenPriceUnits) && p.inputPrice > 0 && p.outputPrice > 0 && p.tokenPriceUnits > 0);
  if (query.selection === 'cheapest_generic') {
    const input = query.inputTokens;
    const output = query.outputTokens;
    if (input === undefined || output === undefined || !Number.isFinite(input) || !Number.isFinite(output)
      || input < 0 || output < 0 || input + output <= 0) return null;
    const allModels = candidates.filter((p): p is TokenModelPrice => p.kind === 'token_model' && p.genericProxyEligible
      && ['general_text', 'coding'].includes(p.modelClass) && p.inputPrice > 0 && p.outputPrice > 0);
    // Resolve each model's trusted channel first; a cheaper fallback cannot override its available platform price.
    const preferred = new Map<string, TokenModelPrice>();
    for (const price of allModels.sort((a, b) => authorityOrder[a.authority] - authorityOrder[b.authority])) {
      const key = JSON.stringify([price.model, price.specification, price.currency]);
      if (!preferred.has(key)) preferred.set(key, price);
    }
    const models = [...preferred.values()];
    // No cross-currency cheapness comparison without a fresh, explicit FX calculation.
    if (new Set(models.map(p => p.currency)).size > 1) return null;
    return models.sort((a, b) => (input * a.inputPrice + output * a.outputPrice) / a.tokenPriceUnits
      - (input * b.inputPrice + output * b.outputPrice) / b.tokenPriceUnits || a.id.localeCompare(b.id))[0] ?? null;
  }
  if (!query.model && !query.id) return null;
  if (new Set(candidates.map(p => p.specification)).size > 1 && !query.specification && !query.id) return null;
  return candidates.sort((a, b) => authorityOrder[a.authority] - authorityOrder[b.authority])[0] ?? null;
}
