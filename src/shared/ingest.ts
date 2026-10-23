import {claimEndDerivationSchema,fillCampaignDeadline} from './campaign-deadline';
import {normalizeModelNames} from './model-names';
import {applyNetworkRequirements} from './network-requirements';
import {valuationSourceSchema} from './valuation-intake';
import {membershipSchema} from './membership';
import {sourceFetchSchema} from './identity/fetch-evidence';
import { canonicalTermsSchema } from './identity/types';
// 写入接口的数据校验。采集管线（GitHub Actions）和网站共用这一份。
import { z } from 'zod';
import { OFFER_TYPES } from './lifecycle';
import { valuationSchema, valuationMatchesAmounts } from './valuation';

export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式应为 YYYY-MM-DD').refine(value => {
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}, '日期不存在');
const REQ = /^(none|unknown|phone|card|net|realname|biz|student|invite|targeted|pay:.+|member:.+)$/;

/**
 * Models often write a bare `member` / `pay`, a comma string or upper case. Bare member/pay get a placeholder
 * label (the product's paid subscription when known); anything else invalid becomes `unknown` so a reviewer fills it.
 */
export function normalizeRequirements(value: unknown, platformName?: string): string[] {
  const list = Array.isArray(value) ? value.map(x => String(x).trim()).filter(Boolean)
    : typeof value === 'string' ? value.split(/[,，、/|\s]+/).map(x => x.trim()).filter(Boolean) : [];
  const member = platformName?.trim() ? `member:${platformName.trim()} 付费订阅` : 'member:付费会员';
  const requirements = list.map(x => x.includes(':') ? x : x.toLowerCase())
    .map(x => x === 'member' ? member : x === 'pay' ? 'pay:金额未写明' : x)
    .map(x => REQ.test(x) ? x : 'unknown');
  const unique = [...new Set(requirements)];
  return unique.length > 1 ? unique.filter(x => x !== 'none') : unique.length ? unique : ['unknown'];
}

export const leadIn = z.object({
  origin: z.enum(['aihot', 'email', 'sweep', 'manual', 'telegram', 'hn', 'reddit', 'discord', 'media', 'linuxdo', 'ithome', 'v2ex']),
  url: z.url(),
  title: z.string().max(300).optional(),
  raw: z.string().max(20000).optional(),
});

export const offerIn = z.object({
  identityFacts: canonicalTermsSchema.optional(),
  identityRequestId: z.string().min(1).max(160).optional(),
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{2,80}$/, 'id 只能用小写字母、数字和短横线'),
  platformId: z.string().min(1),
  sourceId: z.string().optional(),
  title: z.string().min(2).max(120),
  type: z.enum(OFFER_TYPES),
  // 文本和编程不再区分（2026-10-01）：旧值 code 并入 text
  modalities: z.array(z.enum(['text', 'code', 'image', 'video', 'audio'])).min(1).transform(m => [...new Set(m.map(x => (x === 'code' ? 'text' : x)))] as ('text' | 'image' | 'video' | 'audio')[]),
  tags: z.array(z.enum(['reset', 'referral', 'discount', 'daily'])).max(8).default([]),
  // 免费可用的具体模型名（官方写法），没有就空数组
  models: z.array(z.string().trim().min(1).max(80)).max(80).default([]).transform(normalizeModelNames),
  claimMethod: z.enum(['auto', 'signup', 'app', 'form', 'topup', 'member', 'code']),
  requirements: z.array(z.string().regex(REQ)).min(1),
  membershipRequirement: membershipSchema.nullable().optional(),
  audience: z.enum(['new', 'old', 'all', 'unclear']).default('unclear'),
  valueText: z.string().min(1).max(200),
  usdEstimate: z.number().nonnegative().nullable().optional(),
  usdMax: z.number().nonnegative().nullable().optional(),
  // Private recipe extracted by the model; Worker calculates and validates its result.
  valuationFactors: z.json().optional(),
  valuationSources: z.array(valuationSourceSchema).max(30).optional(),
  // Collector-computed copies are ignored by intake; administrator/stored validation uses this field.
  valuation: valuationSchema.nullable().optional(),
  claimStart: isoDate.nullable().optional(),
  claimEnd: isoDate.nullable().optional(),
  endKind: z.enum(['date', 'unknown', 'standing']),
  creditValidity: z.string().max(100).nullable().optional(),
  sourceTz: z.string().refine(tz => { try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; } }, '无效的时区'),
  publishedAt: z.union([isoDate, z.iso.datetime({ offset: true })]).nullable().optional(),
  firstChannel: z.string().max(40).optional(),
  leadId: z.number().int().optional(),
  officialReviewJobId: z.string().uuid().optional(),
  leadReviewJobId: z.string().uuid().optional(),
  sameOccurrenceAs: z.string().max(80).optional(),
  // Collector-supplied full source, never model-generated and never stored on the public offer.
  sourceText: z.string().max(250000).optional(),
  sourceFetch: sourceFetchSchema.optional(),
  steps: z.array(z.string().max(200)).max(10).default([]),
  evidence: z.object({
    url: z.url(),
    // media：媒体或社区转述，永远需要人工核对官方原文
    // tested：管理员亲自领到过（官方只在客户端里提示、网上没有公告时用），只能在后台人工设置，采集管线不能写入
    tier: z.enum(['site', 'docs', 'official', 'staff', 'media', 'tested']),
    capturedAt: z.string(),
    claimEndDerivation: claimEndDerivationSchema.optional(),
    /** An announced, unconfirmed reset's landing deadline (AIHOT schedule); the homepage lists it as coming soon until then. */
    landsBy: z.iso.datetime({ offset: true }).optional(),
    pageHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    excerpts: z.object({ benefit: z.string().optional(), eligibility: z.string().optional(), claim: z.string().optional(), validity: z.string().optional() }),
  }),
}).refine(o => o.endKind !== 'date' || !!o.claimEnd, { message: 'endKind=date 时必须有 claimEnd', path: ['claimEnd'] })
  .refine(o => o.usdMax == null || (o.usdEstimate != null && o.usdMax >= o.usdEstimate)
    || (o.type === 'apply' && o.valuation?.period === 'apply_max' && o.valuation.usdMax === o.usdMax), { message: '价值上限必须不小于确定金额；无保底申请须明确申请上限估值', path: ['usdMax'] })
  .refine(o => !o.valuation || valuationMatchesAmounts(o.valuation, o), { message: '估值元数据金额须与条目美元字段一致', path: ['valuation'] })
  .refine(o => !o.valuation || (o.valuation.period === 'apply_max') === (o.type === 'apply'), { message: '申请制估值须使用申请口径，其他活动不能使用申请上限口径', path: ['valuation', 'period'] })
  .refine(o => !o.claimStart || !o.claimEnd || o.claimStart <= o.claimEnd, { message: '领取开始日期不能晚于截止日期', path: ['claimEnd'] })
  .refine(o => (o.type === 'standing' || o.type === 'apply') === (o.endKind === 'standing'), { message: '常驻额度和申请制的 endKind 必须为 standing，其他类型不能是 standing', path: ['endKind'] }).transform(o => applyNetworkRequirements(o));

/** Collection boundary fills a grounded global campaign duration; ordinary stored validation preserves reviewed dates. */
export const collectedOfferIn = offerIn.transform(o => fillCampaignDeadline(o));

export const runIn = z.object({
  kind: z.enum(['collect', 'verify', 'sweep', 'digest', 'health', 'model']),
  startedAt: z.string(),
  finishedAt: z.string(),
  ok: z.boolean(),
  stats: z.record(z.string(), z.unknown()).default({}),
  tokens: z.number().int().nonnegative().default(0),
  costCny: z.number().nonnegative().default(0),
});

export type LeadIn = z.infer<typeof leadIn>;
export type OfferIn = z.infer<typeof offerIn>;
