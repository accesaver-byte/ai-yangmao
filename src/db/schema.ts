import type { LeadResolution } from '../shared/lead-review';
import type { OfficialReview } from '../shared/official-review';
import type { Valuation } from '../shared/valuation';
// D1 表结构。字段含义见 docs/design.md §5。
// JSON 字段存为 TEXT，读取时再解析。
import { sql } from 'drizzle-orm';
import { index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

const now = sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`;

export const platforms = sqliteTable('platforms', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  type: text('type', { enum: ['lab', 'cloud', 'infra', 'tool', 'new'] }).notNull(),
  status: text('status', { enum: ['pending', 'approved', 'rejected'] }).notNull().default('pending'),
  site: text('site'),
  xHandles: text('x_handles', { mode: 'json' }).$type<string[]>().notNull().default(sql`'[]'`),
  staffHandles: text('staff_handles', { mode: 'json' }).$type<string[]>().notNull().default(sql`'[]'`),
  wechat: text('wechat'),
  notes: text('notes'),
  createdAt: text('created_at').notNull().default(now),
  updatedAt: text('updated_at').notNull().default(now),
});

export const sources = sqliteTable('sources', {
  id: text('id').primaryKey(),
  platformId: text('platform_id').references(() => platforms.id),
  kind: text('kind', { enum: ['rss', 'web_list', 'json', 'aihot', 'email', 'manual', 'sweep', 'hn', 'reddit', 'discord', 'feed'] }).notNull(),
  url: text('url').notNull(),
  tier: text('tier', { enum: ['site', 'docs', 'official', 'staff', 'lead'] }).notNull(),
  config: text('config', { mode: 'json' }).$type<Record<string, unknown>>().notNull().default(sql`'{}'`),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  autoPublish: integer('auto_publish', { mode: 'boolean' }).notNull().default(false),
  cleanStreak: integer('clean_streak').notNull().default(0),
  lastOkAt: text('last_ok_at'),
  lastError: text('last_error'),
  failStreak: integer('fail_streak').notNull().default(0),
  createdAt: text('created_at').notNull().default(now),
});

export const offers = sqliteTable('offers', {
  id: text('id').primaryKey(),
  platformId: text('platform_id').notNull().references(() => platforms.id),
  title: text('title').notNull(),
  type: text('type', { enum: ['new', 'trial', 'free', 'perk', 'topup', 'gift', 'standing', 'apply'] }).notNull(),
  // 标签（受控词表，见 src/shared/spec.ts TAGS）：额度重置、邀请奖励、首月折扣、每日刷新等；重置时钟等栏目按它取数
  tags: text('tags', { mode: 'json' }).$type<string[]>().notNull().default(sql`'[]'`),
  // 这条福利里免费可用的具体模型（“按模型找”按它汇总：某个模型在哪些平台免费）
  models: text('models', { mode: 'json' }).$type<string[]>().notNull().default(sql`'[]'`),
  modalities: text('modalities', { mode: 'json' }).$type<string[]>().notNull(),
  claimMethod: text('claim_method', { enum: ['auto', 'signup', 'app', 'form', 'topup', 'member', 'code'] }).notNull(),
  requirements: text('requirements', { mode: 'json' }).$type<string[]>().notNull(),
  audience: text('audience', { enum: ['new', 'old', 'all', 'unclear'] }).notNull().default('unclear'),
  valueText: text('value_text').notNull(),
  usdEstimate: real('usd_estimate'),
  // V1 的真实权益上限；申请无保底时 usdEstimate 可为空，不用于模型成本范围。
  usdMax: real('usd_max'),
  valuation: text('valuation', { mode: 'json' }).$type<Valuation | null>(),
  claimStart: text('claim_start'),
  claimEnd: text('claim_end'),
  endKind: text('end_kind', { enum: ['date', 'unknown', 'standing'] }).notNull(),
  creditValidity: text('credit_validity'),
  sourceTz: text('source_tz').notNull().default('UTC'),
  publishedAt: text('published_at'),
  discoveredAt: text('discovered_at').notNull().default(now),
  lastVerifiedAt: text('last_verified_at'),
  verifyResult: text('verify_result'),
  withdrawnAt: text('withdrawn_at'),
  withdrawnReason: text('withdrawn_reason'),
  // 管理员的使用心得（如免费模型好不好用），只能在后台写，采集和模型提案不会覆盖
  adminNote: text('admin_note'),
  // 内部核验记录（漏抓原因、核验程度、证据截图位置），只给管理员看，公开接口会去掉
  reviewMemo: text('review_memo'),
  officialReview: text('official_review', { mode: 'json' }).$type<OfficialReview | null>(),
  // 审核建议（仅管理员可见）：审批卡片顶部显示“建议通过 / 作为历史 / 建议拒绝 / 需要你判断”和理由
  reviewSuggestion: text('review_suggestion', { mode: 'json' }).$type<{ verdict: 'approve' | 'history' | 'reject' | 'judge'; code?: string | null; reason: string; by?: string; at?: string } | null>(),
  reviewState: text('review_state', { enum: ['pending', 'approved', 'rejected'] }).notNull().default('pending'),
  evidence: text('evidence', { mode: 'json' }).$type<Evidence>().notNull(),
  steps: text('steps', { mode: 'json' }).$type<string[]>().notNull().default(sql`'[]'`),
  firstChannel: text('first_channel'),
  sourceId: text('source_id').references(() => sources.id),
  createdAt: text('created_at').notNull().default(now),
  updatedAt: text('updated_at').notNull().default(now),
}, t => [index('offers_review_idx').on(t.reviewState), index('offers_platform_idx').on(t.platformId)]);

export interface Evidence {
  url: string;
  tier: 'site' | 'docs' | 'official' | 'staff' | 'media' | 'tested';
  capturedAt: string;
  pageHash?: string;
  excerpts: { benefit?: string; eligibility?: string; claim?: string; validity?: string };
}

export const snapshots = sqliteTable('snapshots', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  sourceId: text('source_id').notNull().references(() => sources.id),
  url: text('url').notNull(),
  hash: text('hash').notNull(),
  text: text('text'),
  fetchedAt: text('fetched_at').notNull().default(now),
}, t => [index('snapshots_source_idx').on(t.sourceId, t.fetchedAt)]);

export const leads = sqliteTable('leads', {
  resolution: text('resolution', { mode: 'json' }).$type<LeadResolution | null>(),
  id: integer('id').primaryKey({ autoIncrement: true }),
  origin: text('origin', { enum: ['aihot', 'email', 'sweep', 'manual', 'telegram', 'hn', 'reddit', 'discord', 'media', 'linuxdo', 'ithome', 'v2ex'] }).notNull(),
  url: text('url').notNull(),
  title: text('title'),
  raw: text('raw'),
  status: text('status', { enum: ['new', 'reviewing', 'linked', 'rejected'] }).notNull().default('new'),
  offerId: text('offer_id').references(() => offers.id),
  createdAt: text('created_at').notNull().default(now),
}, t => [uniqueIndex('leads_url_uq').on(t.url)]);

export const offerRevisions = sqliteTable('offer_revisions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  offerId: text('offer_id').notNull().references(() => offers.id),
  at: text('at').notNull().default(now),
  diff: text('diff', { mode: 'json' }).$type<{ field: string; from: unknown; to: unknown }[]>().notNull(),
  evidenceHash: text('evidence_hash'),
  evidenceBefore: text('evidence_before', { mode: 'json' }).$type<Evidence>(),
  evidenceAfter: text('evidence_after', { mode: 'json' }).$type<Evidence>(),
  // pipeline：官方页面变化引起；admin：管理员人工修改（用作模型的纠错样本）
  author: text('author', { enum: ['pipeline', 'admin'] }).notNull().default('pipeline'),
}, t => [index('revisions_offer_idx').on(t.offerId)]);

/** 对已上架权益的条款提案：审核前保留公开的上一个已通过版本。 */
export const offerProposals = sqliteTable('offer_proposals', {
  offerId: text('offer_id').primaryKey().references(() => offers.id),
  candidate: text('candidate', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
  diff: text('diff', { mode: 'json' }).$type<{ field: string; from: unknown; to: unknown }[]>().notNull(),
  manualFields: text('manual_fields', { mode: 'json' }).$type<string[]>().notNull().default(sql`'[]'`),
  detectedAt: text('detected_at').notNull().default(now),
  updatedAt: text('updated_at').notNull().default(now),
});

export const reviews = sqliteTable('reviews', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  offerId: text('offer_id').notNull().references(() => offers.id),
  action: text('action', { enum: ['approve', 'reject', 'edit'] }).notNull(),
  editedFields: text('edited_fields', { mode: 'json' }).$type<string[]>().notNull().default(sql`'[]'`),
  reviewer: text('reviewer'),
  reason: text('reason'),
  // 拒绝 / 修改的快捷理由，便于统计：paid_bundle 付费套餐自带、not_ai 不是 AI 额度、wrong_platform 平台归错、duplicate 重复、expired 已过期、vague 额度不明、insufficient_evidence 证据不足、wrong_type 分类错、wrong_field 字段错、other 其他
  reasonCode: text('reason_code'),
  at: text('at').notNull().default(now),
});

/** Rejected updates remain remembered independently of the ephemeral proposal queue. */
export const rejectedOfferUpdates = sqliteTable('rejected_offer_updates', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  // Unique per rejection command; links all statements in the guarded transaction.
  decisionKey: text('decision_key').unique(),
  offerId: text('offer_id').notNull().references(() => offers.id),
  evidence: text('evidence', { mode: 'json' }).$type<Evidence>().notNull(),
  diff: text('diff', { mode: 'json' }).$type<{field:string;from:unknown;to:unknown}[]>().notNull(),
  at: text('at').notNull().default(now),
}, t => [index('rejected_updates_offer_idx').on(t.offerId)]);

export const notifications = sqliteTable('notifications', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  offerId: text('offer_id').notNull().references(() => offers.id),
  stage: text('stage', { enum: ['new', 'changed', 'ending', 'ended', 'urgent'] }).notNull(),
  channel: text('channel', { enum: ['telegram', 'feishu'] }).notNull(),
  status: text('status', { enum: ['pending', 'sent', 'failed', 'unknown'] }).notNull().default('pending'),
  messageId: text('message_id'),
  sentAt: text('sent_at'),
}, t => [uniqueIndex('notifications_uq').on(t.offerId, t.stage, t.channel)]);

/** 一条实际消息的发送尝试。先占位，只有发送方收到成功回执后才写 notifications。 */
export const deliveries = sqliteTable('deliveries', {
  id: text('id').primaryKey(),
  fingerprint: text('fingerprint').notNull().unique(),
  channel: text('channel', { enum: ['telegram', 'feishu'] }).notNull(),
  kind: text('kind', { enum: ['digest', 'urgent', 'health'] }).notNull(),
  status: text('status', { enum: ['pending', 'sent', 'unknown', 'released'] }).notNull().default('pending'),
  payload: text('payload', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
  error: text('error'),
  createdAt: text('created_at').notNull().default(now),
  updatedAt: text('updated_at').notNull().default(now),
});

export const runs = sqliteTable('runs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  kind: text('kind', { enum: ['collect', 'verify', 'sweep', 'digest', 'health', 'model'] }).notNull(),
  startedAt: text('started_at').notNull().default(now),
  finishedAt: text('finished_at'),
  ok: integer('ok', { mode: 'boolean' }),
  stats: text('stats', { mode: 'json' }).$type<Record<string, unknown>>().notNull().default(sql`'{}'`),
  tokens: integer('tokens').notNull().default(0),
  costCny: real('cost_cny').notNull().default(0),
}, t => [index('runs_kind_idx').on(t.kind, t.startedAt)]);

/** 英文原文 → 中文译文的缓存（飞书日报用）。同一段文字只翻译一次。 */
export const translations = sqliteTable('translations', {
  hash: text('hash').primaryKey(), // 原文的 SHA-256
  source: text('source').notNull(),
  zh: text('zh').notNull(),
  createdAt: text('created_at').notNull().default(now),
});
