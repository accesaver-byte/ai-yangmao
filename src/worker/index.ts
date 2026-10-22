import {aiHotResetRoutes} from './aihot-resets';
import { sourceUnhealthy } from '../shared/source-health';
import {readCollectionStatus} from './collection-status';
import { commentRoutes } from './comments';
import {publicationError} from './publication';
import {agentRoutes,handleAgentMcp} from './agent';
import {quotaCircuitOpen,tripQuotaCircuit} from './quota-circuit';
import {readMembershipCatalog,collectedMembership} from './membership';
import {ensureRelatedReadIndexes} from './d1-read-indexes';
import {snapshotActive,snapshotResponse,quotaFailure} from './public-snapshot';
import {closeIdentityLead} from './identity/lead-closure';
import {canonicalOffers,resolveCanonicalOffer} from './identity/canonical';
import { withIdentityQueryBudget,IdentityQueryBudgetError } from './identity/budget';
import { aggregateIdentityLead } from './identity/leads';
import { adaptLegacyOffer,identitySelected } from './identity/adapters';
import { identityIngestRoutes } from './identity/routes';
import {leadScopeMismatch} from '../shared/lead-scope';
import { leadReviewRoutes } from './lead-review';
import { officialReviewRoutes } from './official-review';
import { sameBenefit, ambiguousReset } from '../shared/dedupe';
import { officialTier, officialActivityMismatch } from '../shared/official-review';
import { resetEventDay } from '../shared/reset-event';
import { selectLeads } from '../shared/leads';
import { changedOfficialTerms, changedOfficialBenefit, rejectedTermsStillPresent } from '../shared/review-stability';
import { publicSafeValuation, valuationMatchesAmounts } from '../shared/valuation';
import { normalizeModelNames } from '../shared/model-names';
import { computeCollectedValuation, protectedValuationFields, valuationSourceSchema } from '../shared/valuation-intake';
import { sourceFetchSchema } from '../shared/identity/fetch-evidence';
import { isReviewField, reviewChanges } from '../shared/spec';
// Cloudflare Worker 入口：/api/* 走这里，其余由静态资源（网站页面）处理。
import { and, desc, eq, gte, inArray, sql, getTableColumns } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import * as s from '../db/schema';
import { isoDate, leadIn, offerIn, collectedOfferIn, runIn } from '../shared/ingest';
import { differentOccurrence, findDuplicate, crossPlatformDuplicate, sameRecurringCreditPlan, sameModelAnnouncement, sameEvidenceBenefit } from '../shared/dedupe';
import { gateVerdict, matchTitleRule, urlKey } from '../shared/screening/gate0';
import { activeTitleRules, ruleResolution } from './screening/intake-rules';
import { SCREENING_PROMPT_VERSION } from '../shared/screening/version';
import { reasonCodeForCategory, screeningMode } from '../shared/screening/types';
import type { ScreeningRule } from '../shared/screening/types';
import { classifyUrgency, systemDueAt } from '../shared/screening/urgency';
import { ScreeningStore } from './screening/store';
import { screeningIngestRoutes } from './screening/routes';
import { activeOnDate, isClaimable, liveStatus, missingEvidence } from '../shared/lifecycle';
import { admin } from './admin';
import { feishuAdmin, runScheduled } from './feishu';
import { fastTrackReviewInput, advanceFastTrack, claimFastTrack, FastTrackError, fastTrackQueue, submitFastTrackResult } from './fast-track';

export interface Env {
  DB: D1Database;
  AGENT_FORCE_SNAPSHOT?:boolean;
  AGENT_READ_KEY?:D1Database;
  D1_PUBLIC_SNAPSHOT_UNTIL?:string;
  D1_REPAIR_RELATED_INDEXES?:string;
  ASSETS: Fetcher;
  INGEST_TOKEN: string;
  IDENTITY_MODE?: 'off' | 'shadow' | 'enforce';
  IDENTITY_CANARY_PLATFORMS?: string;
  HISTORICAL_MERGE_ENABLED?: string;
  IDENTITY_HISTORY_ENVIRONMENT?: 'synthetic'|'redacted_local'|'production';
  IDENTITY_HISTORY_SOURCE_SHA?: string;
  ADMIN_TOKEN: string;
  CF_ANALYTICS_TOKEN?: string; // Cloudflare 账户分析只读令牌，采集健康页显示今日 D1 读取量
  CF_ACCOUNT_ID?: string;
  REVIEWER_TOKENS?: string; // 审核员密钥，格式 名字:密钥,名字:密钥；只能审核、补录、补信源
  DAILY_TOKEN_CAP?: string;
  MONTHLY_COST_CAP_CNY?: string;
  FEISHU_WEBHOOK?: string; // 飞书群自定义机器人
  FEISHU_SECRET?: string; // 签名校验密钥
  GEMINI_API_KEY?: string; // 飞书日报把英文翻译成中文
  GEMINI_MODEL?: string;
  GH_DISPATCH_TOKEN?: string; // 只对本仓库有 Actions 写权限的令牌，用于准点触发采集
  GH_REPO?: string;
  SCREENING_MODE?: string;
  /** 'auto' applies gate0's deterministic repost/duplicate verdicts to leads; model verdicts follow SCREENING_MODE. */
  SCREENING_GATE0_MODE?: string;
  SCREENING_MONTHLY_CAP_CNY?: string;
  OPENROUTER_FREE_DAILY?: string;
  SCREENING_URGENT_RESERVE?: string;
  SCREENING_BACKFILL_DAILY?: string;
}

const app = new Hono<{ Bindings: Env }>();
const db = (env: Env) => drizzle(env.DB, { schema: s });
type OfferRow = typeof s.offers.$inferSelect;

app.use('/api/*',async(c,next)=>{
 if(snapshotActive(c.env.D1_PUBLIC_SNAPSHOT_UNTIL)||quotaCircuitOpen()){
  if(c.req.path==='/api/mcp'||c.req.path.startsWith('/api/agent')){c.env={...c.env,AGENT_FORCE_SNAPSHOT:true};return next();}
  if(c.req.path==='/api/health')return c.json({ok:true,dataMode:'approved-snapshot',readOnly:true});
  const response=c.req.method==='GET'?await snapshotResponse(c.req.raw,c.env.ASSETS):null;
  return response??c.json({error:'数据库当日读取额度已用尽，目前只读浏览，留言、审核和采集暂时暂停',degraded:true,readOnly:true},503);
 }
 return next();
});
app.onError(async(error,c)=>{
 if(!quotaFailure(error))return c.json({error:'服务暂不可用，请稍后重试'},500);
 tripQuotaCircuit();
 const response=c.req.method==='GET'?await snapshotResponse(c.req.raw,c.env.ASSETS):null;
 return response??c.json({error:'数据库当日读取额度已用尽，目前只读浏览，留言、审核和采集暂时暂停',degraded:true,readOnly:true},503);
});

// 初期不让搜索引擎收录；接口不缓存旧状态太久
app.use('/api/*', async (c, next) => {
  if(c.env.IDENTITY_MODE==='enforce'||/\/api\/(?:ingest\/(?:identity-|observations|candidates)|admin\/identity)/.test(c.req.path))c.env={...c.env,AGENT_READ_KEY:c.env.DB,DB:withIdentityQueryBudget(c.env.DB)};
  await next();
  c.header('X-Robots-Tag', 'noindex');
  if(c.req.method==='GET'&&c.req.path.startsWith('/api/offers')&&c.res.headers.get('Cache-Control')!=='no-store')c.header('Cache-Control','no-cache');
  if (c.req.method === 'GET' && !c.res.headers.get('Cache-Control')) c.header('Cache-Control', 'public, max-age=60');
});

// 公开的羊毛和平台列表在 Cloudflare 边缘缓存 5 分钟：访客再多，数据库每 5 分钟每个地址只查一次（D1 免费版每天限读 500 万行）。
// 审核通过后最多 5 分钟出现在网站上。
const EDGE_TTL = 300;
for (const path of ['/api/offers', '/api/platforms', '/api/meta', '/api/coverage']) app.use(path, async (c, next) => {
  if (c.req.method !== 'GET' || typeof caches === 'undefined') return next();
  // Schema changes must not serve a cached pre-valuation response to the new UI.
  const cacheUrl = new URL(c.req.url);
  cacheUrl.searchParams.delete('fresh');
  cacheUrl.searchParams.set('__response_schema', 'valuation-v2-public-inputs');
  if(path==='/api/meta'||path==='/api/coverage')cacheUrl.searchParams.set('__collection_schema','partial-fetch-v1');
  if(path==='/api/offers'){const state=await c.env.DB.prepare('SELECT generation FROM identity_public_state WHERE id=1').first<{generation:number}>();if(!state)return next();cacheUrl.searchParams.set('__canonical_generation',String(state.generation));}
  const key = new Request(cacheUrl, { method: 'GET' });
  const edgeCache = (caches as CacheStorage & { default: Cache }).default;
  if (!edgeCache) return next();
  const hit = await edgeCache.match(key);
  if (hit) return new Response(hit.body, hit);
  await next();
  if (c.res.status !== 200) return;
  const res = new Response(c.res.clone().body, c.res);
  res.headers.set('Cache-Control', `public, max-age=60, s-maxage=${EDGE_TTL}`);
  c.executionCtx.waitUntil(edgeCache.put(key, res));
});

// 公开接口不输出内部核验记录
app.route('/api/agent',agentRoutes);
app.route('/api', commentRoutes);
app.all('/api/mcp',c=>{let ctx:Pick<ExecutionContext,'waitUntil'>|undefined;try{ctx=c.executionCtx;}catch{}return handleAgentMcp(c.req.raw,c.env,ctx);});

const withStatus = (o: OfferRow, now: Date) => {
  const { reviewMemo: _memo, reviewSuggestion: _suggestion, officialReview: _officialReview, withdrawnReason: _withdrawnReason, valuation: rawValuation, ...pub } = o;
  const valuation = publicSafeValuation(rawValuation);
  return { ...pub, models: normalizeModelNames(o.models), valuation: valuation && valuationMatchesAmounts(valuation, o) ? valuation : null,
    status: liveStatus(o, now), missingEvidence: missingEvidence(o.evidence.excerpts) };
};

app.get('/api/health', c => c.json({ ok: true, time: new Date().toISOString() }));
app.get('/api/memberships',async c=>{const catalog=await readMembershipCatalog(c.env.DB);c.header('Cache-Control','no-store');return c.json(catalog);});

app.get('/api/meta', async c => c.json(await readCollectionStatus(c.env.DB)));

/** 覆盖范围页：监控了哪些渠道、健康状况。不含任何密钥或内部地址以外的信息。 */
app.get('/api/coverage', async c => {
  const d = db(c.env);
  const srcs = await d.select({ kind: s.sources.kind, enabled: s.sources.enabled, failStreak: s.sources.failStreak, lastOkAt: s.sources.lastOkAt, createdAt: s.sources.createdAt, platformId: s.sources.platformId, url: s.sources.url, config: s.sources.config }).from(s.sources);
  const [{ n: platforms }] = await d.select({ n: sql<number>`count(*)` }).from(s.platforms).where(eq(s.platforms.status, 'approved'));
  const collection = await readCollectionStatus(c.env.DB);
  const byKind: Record<string, { total: number; enabled: number; failing: number }> = {};
  const unhealthy = (x: typeof srcs[number]) => sourceUnhealthy(x);
  for (const x of srcs) {
    const k = (byKind[x.kind] ??= { total: 0, enabled: 0, failing: 0 });
    k.total++; if (x.enabled) k.enabled++; if (x.enabled && unhealthy(x)) k.failing++;
  }
  return c.json({ platforms, sources: srcs.filter(x => x.enabled).length, byKind, ...collection,
    officialPages: srcs.filter(x => x.enabled && x.platformId).map(x => ({ platformId: x.platformId, url: x.url, kind: x.kind, healthy: !!x.lastOkAt && !unhealthy(x) })) }); // 未成功采集过的信源不算“健康”，但新登记 12 小时内也不算失效
});

const listQuery = z.object({
  view: z.enum(['claimable', 'all']).default('claimable'),
  type: z.string().optional(),
  modality: z.string().optional(),
  platform: z.string().optional(),
  on: isoDate.optional(),
  tz: z.string().max(80).refine(tz => { try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; } }, '无效的时区').default('Asia/Shanghai'),
});

app.get('/api/offers', async c => {
  const q = listQuery.safeParse(c.req.query());
  if (!q.success) return c.json({ error: '查询参数不正确', issues: q.error.issues }, 400);
  const { view, type, modality, platform, on, tz } = q.data;
  const now = new Date();
  const d = db(c.env);
  const approvedPlatforms = new Set((await d.select({ id: s.platforms.id }).from(s.platforms).where(eq(s.platforms.status, 'approved'))).map(p => p.id));
  const conds = [eq(s.offers.reviewState, 'approved'),canonicalOffers];
  if (type) conds.push(eq(s.offers.type, type as OfferRow['type']));
  if (platform) conds.push(eq(s.offers.platformId, platform));
  let rows = (await d.select().from(s.offers).where(and(...conds))).filter(o => approvedPlatforms.has(o.platformId)).map(o => withStatus(o, now));
  if (modality) rows = rows.filter(o => o.modalities.includes(modality));
  if (on) rows = rows.filter(o => o.status !== 'stale' && activeOnDate(o, on, tz));
  else if (view === 'claimable') rows = rows.filter(o => isClaimable(o.status));
  return c.json({ count: rows.length, offers: rows });
});

app.get('/api/offers/:id', async c => {
  const d = db(c.env);
  let route;try{route=await resolveCanonicalOffer(c.env.DB,c.req.param('id'));}catch{return c.json({error:'没有这条羊毛'},404);}
  const [o] = await d.select().from(s.offers).where(and(eq(s.offers.id, route.offerId), eq(s.offers.reviewState, 'approved'),canonicalOffers));
  if (!o) return c.json({ error: '没有这条羊毛' }, 404);
  const [platform] = await d.select().from(s.platforms).where(eq(s.platforms.id, o.platformId));
  if (platform?.status !== 'approved') return c.json({ error: '没有这条羊毛' }, 404);
  // 修订包含旧的审核文案和人工纠错，完整记录只由管理员接口提供。
  return c.json({ offer: withStatus(o, new Date()), platform,requestedOfferId:c.req.param('id'),canonicalOfferId:route.offerId });
});

app.get('/api/platforms', async c => {
  const rows = await db(c.env).select().from(s.platforms).where(eq(s.platforms.status, 'approved')).orderBy(s.platforms.type, s.platforms.name);
  return c.json({ count: rows.length, platforms: rows });
});

app.get('/api/platforms/:id', async c => {
  const d = db(c.env);
  const [p] = await d.select().from(s.platforms).where(and(eq(s.platforms.id, c.req.param('id')), eq(s.platforms.status, 'approved')));
  if (!p) return c.json({ error: '没有这个平台' }, 404);
  const now = new Date();
  const rows = (await d.select().from(s.offers).where(and(eq(s.offers.platformId, p.id), eq(s.offers.reviewState, 'approved'),canonicalOffers))).map(o => withStatus(o, now));
  return c.json({ platform: p, offers: rows });
});

const xml = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]!);
app.get('/rss.xml', async c => {
  const now = new Date();
  const approvedPlatforms = new Set((await db(c.env).select({ id: s.platforms.id }).from(s.platforms).where(eq(s.platforms.status, 'approved'))).map(p => p.id));
  const offers = (await db(c.env).select().from(s.offers).where(and(eq(s.offers.reviewState, 'approved'),canonicalOffers)).orderBy(desc(s.offers.discoveredAt)).limit(100))
    .filter(offer => approvedPlatforms.has(offer.platformId) && isClaimable(liveStatus(offer, now)));
  const items = offers.map(offer => `<item><title>${xml(offer.title)}</title><link>https://ai-yangmao.com/#offer-${xml(offer.id)}</link><guid isPermaLink="false">${xml(offer.id)}</guid><pubDate>${new Date(offer.discoveredAt).toUTCString()}</pubDate><description>${xml(`${offer.valueText}；领取证据：${offer.evidence.url}`)}</description></item>`).join('');
  return c.body(`<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>AI 羊毛牧场 · 当前可领</title><link>https://ai-yangmao.com/</link><description>经过审核且仍可领取的 AI 额度与权益</description>${items}</channel></rss>`, 200, { 'Content-Type': 'application/rss+xml; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Robots-Tag': 'noindex' });
});

/* ---------- 写入接口（采集管线专用，Bearer 密钥） ---------- */
const ingest = new Hono<{ Bindings: Env }>();
ingest.use('*', async (c, next) => {
  const token = c.req.header('Authorization')?.replace(/^Bearer\s+/i, '');
  if (!c.env.INGEST_TOKEN || c.env.INGEST_TOKEN.length < 16 || token !== c.env.INGEST_TOKEN) return c.json({ error: '密钥不正确' }, 401);
  c.header('Cache-Control', 'no-store');
  await next();
});

ingest.route('/', identityIngestRoutes);
ingest.route('/aihot-resets',aiHotResetRoutes);
ingest.route('/screening', screeningIngestRoutes);
ingest.route('/official-reviews', officialReviewRoutes);
ingest.route('/lead-reviews', leadReviewRoutes);

ingest.post('/leads', async c => {
  const body = z.array(leadIn).max(100).safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: '数据格式不正确', issues: body.error.issues }, 400);
  if (!body.data.length) return c.json({ created: 0 });
  const mode = screeningMode(c.env);
  const stamped = body.data.map(row => ({ ...row, urlKey: urlKey(row.url) }));
  const taken = await c.env.DB.prepare(`SELECT url, url_key FROM leads WHERE url IN (SELECT value FROM json_each(?1)) OR (url_key IS NOT NULL AND url_key IN (SELECT value FROM json_each(?2)))`).bind(JSON.stringify(stamped.map(row => row.url)), JSON.stringify(stamped.map(row => row.urlKey))).all<{ url: string; url_key: string | null }>();
  const seenUrl = new Set(taken.results.map(row => row.url));
  const seenKey = new Set(taken.results.flatMap(row => row.url_key ? [row.url_key] : []));
  const duplicates: typeof stamped = [];
  const fresh = stamped.filter(row => {
    if (seenUrl.has(row.url) || seenKey.has(row.urlKey)) { duplicates.push(row); return false; }
    seenUrl.add(row.url); seenKey.add(row.urlKey); return true;
  });
  // Owner-approved intake rules (2026-10-16) close a lead on arrival in every mode except off. They depend only on title and
  // origin, so a matching lead is written already closed: no extra query per lead, which a whole linux.do chunk can need.
  const rules = mode !== 'off' && fresh.length ? await activeTitleRules(c.env.DB) : [];
  const matchedRule = new Map<string, ScreeningRule>();
  const rows = fresh.map(row => {
    const rule = matchTitleRule({ title: row.title ?? '', origin: row.origin, platformId: null, sourceId: null }, rules);
    if (!rule) return { ...row, resolution: null };
    matchedRule.set(row.url, rule);
    return { ...row, status: 'rejected' as const, resolution: ruleResolution(rule, row.url) };
  });
  // D1 单条语句最多 100 个绑定参数：每行绑定 origin、url、title、raw、status、url_key、resolution 共 7 个，一批最多 14 行。
  // （2026-10-13 加 url_key 后仍按 20 行一批，超过 16 条新线索的整批写入全部失败，linux.do 连续失败。）
  let created = 0, filtered = 0;
  const createdRows: { id: number; url: string }[] = [];
  const perBatch = Math.floor(100 / 7);
  for (let i = 0; i < rows.length; i += perBatch) {
    const res = await db(c.env).insert(s.leads).values(rows.slice(i, i + perBatch)).onConflictDoNothing().returning({ id: s.leads.id, url: s.leads.url });
    created += res.length;
    createdRows.push(...res);
  }
  if (mode !== 'off' && createdRows.length) {
    const store = new ScreeningStore(c.env.DB);
    const now = new Date(), hits = new Map<string, number>();
    for (const row of createdRows) {
      const input = fresh.find(item => item.url === row.url)!;
      const urgency = classifyUrgency({ title: input.title ?? '', text: input.raw ?? '' }, now);
      await store.upsertItem({ subjectKind: 'lead', subjectId: String(row.id), origin: input.origin, state: 'awaiting_screen', tier: urgency.tier, deadline: urgency.deadline, signals: urgency.signals, urgencyQuote: urgency.quote, tierBy: 'gate0', discoveredAt: now.toISOString(), dueAt: systemDueAt(urgency.tier, now.toISOString()) });
      const rule = matchedRule.get(row.url);
      if (!rule) continue;
      const subject = { kind: 'lead' as const, url: input.url, origin: input.origin, platformId: null, title: input.title ?? '', openingText: input.raw ?? '' };
      const verdict = gateVerdict({ rule }, subject, { generatedAt: now.toISOString(), records: [], rules, profiles: [], calibrations: [] });
      const decision = await store.recordDecision({ requestId: `gate0:${row.id}:${rule.id}`, itemId: `lead:${row.id}`, verdict: verdict.verdict, matchRef: verdict.matchId, ruleId: verdict.ruleId, reasonCategory: verdict.reasonCategory, occurrenceCheck: verdict.occurrenceCheck, confidence: verdict.confidence, evidenceQuote: verdict.evidenceQuote, explanation: verdict.explanation, urgency: verdict.urgency, model: 'gate0', calibrated: false, promptVersion: SCREENING_PROMPT_VERSION, contextHash: 'gate0', mode: mode === 'auto' ? 'auto' : mode === 'suggest' ? 'suggest' : 'shadow' });
      await store.markApplied(decision.id, 'closed'); filtered++; hits.set(rule.id, (hits.get(rule.id) ?? 0) + 1);
    }
    for (const [ruleId, n] of hits) await c.env.DB.prepare('UPDATE screening_rules SET hits=hits+? WHERE id=?').bind(n, ruleId).run();
  }
  for (const row of duplicates) {
    const existing = await c.env.DB.prepare(`SELECT id, title, raw FROM leads WHERE url=? OR (url_key IS NOT NULL AND url_key=?) LIMIT 1`).bind(row.url, row.urlKey).first<{ id: number; title: string | null; raw: string | null }>();
    if (!existing) continue;
    const title = row.title ?? existing.title;
    const raw = row.raw ?? existing.raw;
    if ((title ?? '') === (existing.title ?? '') && (raw ?? '') === (existing.raw ?? '')) continue;
    await db(c.env).update(s.leads).set({ title: title ?? null, raw: raw ?? null }).where(eq(s.leads.id, existing.id));
    await c.env.DB.prepare(`UPDATE screening_items SET latest_decision_id=NULL, updated_at=? WHERE subject_kind='lead' AND subject_id=?`).bind(new Date().toISOString(), String(existing.id)).run();
  }
  return c.json({ created, skipped: body.data.length - created, filtered });
});

/**
 * 新羊毛或已有羊毛的新版本。默认进待审；满足以下全部条件才自动上架：
 * 平台已准入、信源已放开自动上架、不是员工账号来源、四项证据齐全。
 * 已上架的羊毛内容变化时写修订记录，并重新进待审（除非满足自动上架条件）。
 */
ingest.post('/valuation-preview', async c => {
  const parsed=z.object({platformId:z.string().min(1),type:z.string().min(1),sourceUrl:z.url(),sourceText:z.string().max(250000).optional(),sourceFetch:sourceFetchSchema.optional(),valuationFactors:z.json().optional(),valuationSources:z.array(valuationSourceSchema).max(30).optional(),tags:z.array(z.string()).optional(),models:z.array(z.string()).optional(),capturedAt:z.string().optional(),benefitQuote:z.string().optional()}).safeParse(await c.req.json().catch(()=>null));
  if(!parsed.success)return c.json({error:'invalid valuation preview payload',issues:parsed.error.issues},400);
  const input=parsed.data;
  return c.json(await computeCollectedValuation({...input,evidence:{url:input.sourceUrl,tier:'official',capturedAt:input.capturedAt??new Date().toISOString(),excerpts:{benefit:input.benefitQuote}}}));
});
ingest.post('/offers', async c => {
  // Valuation is reviewed data. Drop a collector/model-supplied copy before amount validation.
  const extractionIn = z.preprocess(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    const { valuation: _valuation, usdEstimate:_estimate, usdMax:_max, ...fields } = value as Record<string, unknown>;
    return {...fields,usdEstimate:null,usdMax:null};
  }, collectedOfferIn);
  const rawOffers = await c.req.json().catch(() => null);
  const body = z.array(extractionIn).max(50).safeParse(rawOffers);
  if (!body.success) return c.json({ error: '数据格式不正确', issues: body.error.issues }, 400);
  if(c.env.IDENTITY_MODE==='enforce'&&body.data.length>1)return c.json({error:'enforce intake accepts one item per request to stay within the D1 query budget'},400);
  const d = db(c.env);
  const pids = [...new Set(body.data.map(o => o.platformId))];
  const plats = pids.length ? await d.select().from(s.platforms).where(inArray(s.platforms.id, pids)) : [];
  const sids = [...new Set(body.data.map(o => o.sourceId).filter((x): x is string => !!x))];
  const srcs = sids.length ? await d.select().from(s.sources).where(inArray(s.sources.id, sids)) : [];
  const results: Record<string,unknown>[] = [];
  const legacyProducts=pids.filter(id=>!identitySelected(c.env,id));
  const mergedProducts=new Set(legacyProducts.length?(await c.env.DB.prepare('SELECT value platformId FROM json_each(?) product WHERE EXISTS(SELECT 1 FROM benefit_entities e WHERE e.platform_id=product.value AND e.routing_generation>0)').bind(JSON.stringify(legacyProducts)).all<{platformId:string}>()).results.map(r=>r.platformId):[]);
  // 硬性去重的比对范围：这些平台下的全部条目（含已拒绝，避免拒掉的换个 ID 又回来）
  const loadPeers = async () => pids.length ? (await d.select({ id: s.offers.id, platformId: s.offers.platformId, title: s.offers.title, valueText: s.offers.valueText, evidence: s.offers.evidence, tags: s.offers.tags, publishedAt: s.offers.publishedAt, claimStart: s.offers.claimStart, claimEnd: s.offers.claimEnd, sourceTz: s.offers.sourceTz, reviewState: s.offers.reviewState, type:s.offers.type, claimMethod:s.offers.claimMethod, requirements:s.offers.requirements, audience:s.offers.audience, models:s.offers.models, modalities:s.offers.modalities })
    .from(s.offers).where(canonicalOffers)).map(x => ({ ...x, evidenceUrl: x.evidence.url, eventDay: resetEventDay(x) })) : [];
  let peersCache: Awaited<ReturnType<typeof loadPeers>> | null = null;
  const membershipCatalog=body.data.some(o=>o.membershipRequirement||o.requirements.some(r=>r.startsWith('member:')))?await readMembershipCatalog(c.env.DB):null;
  for (const o of body.data) {
    const valuationPlatform=plats.find(p=>p.id===o.platformId);
    const officialValuationSource=valuationPlatform&&officialTier(o.evidence.url,valuationPlatform,srcs.filter(s=>s.platformId===o.platformId));
    const computed=await computeCollectedValuation({...o,sourceFetch:o.sourceFetch?{...o.sourceFetch,sourceVerified:o.sourceFetch.sourceVerified&&!!officialValuationSource}:undefined});
    o.valuation=computed.valuation;o.usdEstimate=computed.valuation?.usdEstimate??null;o.usdMax=computed.valuation?.usdMax??null;
    if(membershipCatalog)o.membershipRequirement=collectedMembership(o.requirements,o.membershipRequirement,membershipCatalog);
    if(mergedProducts.has(o.platformId)){results.push({id:o.id,error:'identity canonical writes paused; enable the reconciled product enforce path',retryable:true});continue;}
    if(o.leadReviewJobId){
      const [lead]=o.leadId?await d.select().from(s.leads).where(eq(s.leads.id,o.leadId)):[];
      if(!lead||lead.status!=='reviewing'||lead.resolution?.jobId!==o.leadReviewJobId||lead.resolution.status!=='checking'){
        results.push({id:o.id,error:'线索复核任务已失效'});continue;
      }
    }
    if(o.leadId){
      const [lead]=await d.select().from(s.leads).where(eq(s.leads.id,o.leadId));
      const issuer=plats.find(p=>p.id===o.platformId);
      const officialSources=issuer?await d.select().from(s.sources).where(eq(s.sources.platformId,issuer.id)):[];
      const mismatch=!lead||!issuer?'原线索或发放平台不存在':leadScopeMismatch(lead,issuer,officialSources,o);
      if(mismatch){results.push({id:o.id,error:mismatch});continue;}
    }
    try {
      const adapted=await adaptLegacyOffer(c.env,o,(rawOffers as unknown[])[body.data.indexOf(o)]);
      if(adapted){results.push(adapted);continue;}
    } catch(error){results.push({id:o.id,error:(error as Error).message,retryable:true});continue;}
    const peers=peersCache??(peersCache=await loadPeers());
    const eventDay = resetEventDay(o);
    const sameId = peers.find(x=>x.id===o.id);
    const identity={...o,evidenceUrl:o.evidence.url,eventDay};
    const ambiguous=peers.find(x=>x.platformId===o.platformId&&ambiguousReset(identity,x));
    if (!o.officialReviewJobId && sameId) {
      // Only reset events have independently grounded per-event identity here. A repost date
      // cannot split a stable ID for an already-reviewed ordinary limited offer.
      if(differentOccurrence(identity,sameId) && (eventDay || sameId.eventDay))o.id = `${o.id.slice(0,69)}-${eventDay ?? o.claimStart}`;
      else if(ambiguousReset(identity,sameId)){
        const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(o.evidence.url)))).slice(0,5).map(x=>x.toString(16).padStart(2,'0')).join('');
        o.id=`${o.id.slice(0,69)}-${hash}`;
      }
    }
    const plat = plats.find(p => p.id === o.platformId);
    if (!peers.some(x => x.id === o.id)) {
      const cross = crossPlatformDuplicate(identity,peers);
      if(cross){results.push({id:o.id,duplicateId:cross.id,skipped:`与已上架的 ${cross.id} 重复，实际平台为 ${cross.platformId}`});continue;}
      const dup = findDuplicate({ ...identity,id:o.id }, peers);
      if (dup?.reviewState === 'rejected') { results.push({ id: o.id, duplicateId:dup.id,skipped: `与已拒绝的 ${dup.id} 重复` }); continue; }
      if (dup) o.id = dup.id; // 并入已有条目，走正常的更新和人工字段保护
    }
    // 同一批里后面的条目也要和前面的比
    if (!peers.some(x => x.id === o.id)) peers.push({ id: o.id, platformId: o.platformId, title: o.title, valueText: o.valueText, evidence: o.evidence as never, reviewState: 'pending',type:o.type,claimMethod:o.claimMethod,requirements:o.requirements,audience:o.audience,models:o.models??[],modalities:o.modalities, evidenceUrl: o.evidence.url, eventDay, tags:o.tags ?? [],publishedAt:o.publishedAt ?? null,claimStart:o.claimStart ?? null,claimEnd:o.claimEnd ?? null,sourceTz:o.sourceTz ?? 'UTC' });
    if (!plat) { results.push({ id: o.id, error: `平台 ${o.platformId} 不在白名单里，先建平台` }); continue; }
    if (o.evidence.tier === 'tested') { results.push({ id: o.id, error: '“管理员实测”只能在后台人工设置' }); continue; }
    const src = srcs.find(x => x.id === o.sourceId);
    const missing = missingEvidence(o.evidence.excerpts);
    const sameOfficialHost = src && (() => { try { return new URL(src.url).hostname.toLowerCase() === new URL(o.evidence.url).hostname.toLowerCase(); } catch { return false; } })();
    const auto = plat.status === 'approved' && !!src?.enabled && sameOfficialHost && src.platformId === o.platformId && src.autoPublish && !!officialTier(o.evidence.url,plat,[src])
      && ['site', 'docs', 'official'].includes(src.tier) && src.tier === o.evidence.tier
      && !o.requirements.some(r=>r.startsWith('member:')) && (!o.membershipRequirement||o.membershipRequirement.status==='not_required')
      && !o.officialReviewJobId && !o.leadReviewJobId && !ambiguous && missing.length === 0 && !/未写明|不明确/.test(o.valueText) && !o.requirements.some(requirement => requirement === 'unknown' || /未写明/.test(requirement));
    const [prev] = await d.select().from(s.offers).where(eq(s.offers.id, o.id));
    if(o.leadReviewJobId&&prev){
      if(o.sameOccurrenceAs!==prev.id&&!sameEvidenceBenefit(identity,{...prev,evidenceUrl:prev.evidence.url,eventDay:resetEventDay(prev)})&&!sameBenefit(o,prev)&&!sameRecurringCreditPlan(identity,{...prev,evidenceUrl:prev.evidence.url,eventDay:resetEventDay(prev)})&&!sameModelAnnouncement(identity,{...prev,evidenceUrl:prev.evidence.url,eventDay:resetEventDay(prev)})){results.push({id:o.id,error:'生成的ID与已有活动冲突，尚未证明同一活动，请人工核对'});continue;}
      results.push({id:prev.id,linkedExisting:true,reviewState:prev.reviewState});continue;
    }
    const [existingProposal] = prev ? await d.select().from(s.offerProposals).where(eq(s.offerProposals.offerId, o.id)) : [];
    const nowIso = new Date().toISOString();
    if (o.officialReviewJobId && (prev?.officialReview?.jobId !== o.officialReviewJobId || prev.officialReview.status !== 'checking' || prev.officialReview.inputVersion !== `${prev.updatedAt}|${existingProposal?.updatedAt??''}`)) { results.push({id:o.id,error:'官方复核任务已失效'}); continue; }
    if(o.officialReviewJobId && prev){
      const mismatch=officialActivityMismatch(existingProposal?{...prev,...existingProposal.candidate}:prev,o);
      if(mismatch){results.push({id:o.id,error:mismatch});continue;}
    }
    // An approved record is the baseline. A model's differing output alone is never a new review.
    if (prev?.reviewState === 'approved') {
      const rejected = await d.select().from(s.rejectedOfferUpdates).where(eq(s.rejectedOfferUpdates.offerId, prev.id));
      const officialSources = await d.select({url:s.sources.url,tier:s.sources.tier}).from(s.sources).where(eq(s.sources.platformId,prev.platformId));
      const trusted = prev.platformId === o.platformId && !!officialTier(o.evidence.url, plat, officialSources);
      const changed = trusted && changedOfficialTerms(prev.evidence, o.evidence, o.sourceText);
      const repeat = rejected.some(r => rejectedTermsStillPresent(r.evidence, o.evidence, o.sourceText));
      if (!changed || repeat) {
        results.push({id:o.id,unchanged:true,reviewState:'approved',reviewSuppressed:repeat?'rejected_terms':'no_proven_terms_change',
          ...(o.officialReviewJobId?{skipped:'没有新的官方条款依据，保留已审核版本及人工提案'}:{})});
        continue; // Keep manual proposals and verification metadata; the /verify route verifies source health.
      }
    }
    const { identityFacts: _identityFacts, identityRequestId: _identityRequestId, leadId, leadReviewJobId, officialReviewJobId, sameOccurrenceAs, sourceFetch: _sourceFetch, sourceText, valuationFactors:_recipe,valuationSources:_prices, valuation: _pipelineValuation, ...od } = o;
    const row = {
      ...od, usdEstimate: o.usdEstimate ?? null, usdMax: o.usdMax ?? null, valuation: o.valuation ?? null, claimStart: o.claimStart ?? null, claimEnd: o.claimEnd ?? null,
      creditValidity: o.creditValidity ?? null, publishedAt: o.publishedAt ?? null, sourceId: o.sourceId ?? null,
      lastVerifiedAt: o.evidence.tier === 'media' ? null : nowIso, verifyResult: o.evidence.tier === 'media' ? '线索待核验，尚无可采信的官方证据' : '官方页面已抽取字段', updatedAt: nowIso,
    };
    // 人工改过的字段是已经核准的事实，后续模型提案不得静默覆盖。
    if (prev) {
      // Structured reviewed values belong to the administrator; extraction cannot recalculate them.

      const adminRevisions = await d.select({ diff: s.offerRevisions.diff }).from(s.offerRevisions)
        .where(and(eq(s.offerRevisions.offerId, prev.id), eq(s.offerRevisions.author, 'admin')));
      const protectedFields = protectedValuationFields(prev, [
        ...adminRevisions.flatMap(revision => revision.diff.map(change => change.field)),
        ...(existingProposal?.manualFields ?? []),
      ]);
      // 人工改过的字段一律保留（2026-10-03）：原先“摘录变了就放开”的例外让模型每次换一句摘录就能改掉管理员确认过的内容。
      // Grounded replacement of benefit facts can update the proposed wording, even when digits stay the same.
      const benefitChanged = changedOfficialBenefit(prev.evidence, o.evidence, o.sourceText);
      for (const field of protectedFields) {
        // A proven replacement of official terms needs its new evidence approved with the new facts.
        if (prev.reviewState === 'approved' && field === 'evidence' && !existingProposal?.manualFields.includes(field)
          && changedOfficialTerms(prev.evidence, o.evidence, o.sourceText)) continue;
        // Only proven benefit changes may replace an old edit; an active manual proposal always wins.
        if (prev.reviewState === 'approved' && field === 'valueText' && benefitChanged && !existingProposal?.manualFields.includes(field)) continue;
        if (field in row) (row as Record<string, unknown>)[field] = existingProposal?.manualFields.includes(field)
          ? existingProposal.candidate[field] : (prev as Record<string, unknown>)[field];
      }
    }
    if (!prev) {
      if(o.leadReviewJobId){
        const values={...row,...(ambiguous?{reviewMemo:`同日另有重置记录 ${ambiguous.id}，请区分独立发放和同次活动的进度回复。`}:{}),reviewState:'pending'};
        const columns=getTableColumns(s.offers);
        const pairs=Object.entries(values).filter(([key,value])=>value!==undefined&&key in columns)
          .map(([key,value])=>{const column=columns[key as keyof typeof columns];return {name:column.name,value:value===null?null:column.mapToDriverValue(value as never)};});
        const saved=await c.env.DB.prepare(`INSERT INTO offers (${pairs.map(p=>p.name).join(',')}) SELECT ${pairs.map(()=>'?').join(',')} WHERE EXISTS (SELECT 1 FROM leads WHERE id=? AND status='reviewing' AND json_extract(resolution,'$.jobId')=? AND json_extract(resolution,'$.status')='checking') ON CONFLICT(id) DO NOTHING RETURNING id`)
          .bind(...pairs.map(p=>p.value),o.leadId!,o.leadReviewJobId).all<{id:string}>();
        if(!saved.results.length){results.push({id:o.id,error:'线索状态已变化或条目已存在，请读回'});continue;}
        results.push({id:o.id,created:true,reviewState:'pending',missingEvidence:missing});continue;
      }
      await d.insert(s.offers).values({ ...row, ...(ambiguous?{reviewMemo:`同日另有重置记录 ${ambiguous.id}。不同公告尚不能证明独立发放，请区分第二次发放与同次活动的预告/确认/进度回复。`}:{}), reviewState: auto ? 'approved' : 'pending' });
      // 调用方在整条线索的所有候选完成后才确认关联，部分失败不能提前吞掉线索。
      results.push({ id: o.id, created: true, reviewState: auto ? 'approved' : 'pending', missingEvidence: missing });
      continue;
    }
    if (prev.reviewState === 'approved') {
      // 未抽到的可空字段不是官方取消：保留已审核的值，不制造“丢字段”提案。
      for (const field of ['usdEstimate', 'usdMax', 'claimStart', 'claimEnd', 'publishedAt'] as const) {
        if (row[field] == null && prev[field] != null && !(['usdEstimate','usdMax'].includes(field) && prev.valuation?.inputs.calculationEngine==='v2-auto')) (row as Record<string, unknown>)[field] = prev[field];
      }
      if (!o.claimEnd && o.endKind === 'unknown' && o.type === prev.type && prev.endKind === 'date') row.endKind = prev.endKind;
      if (row.audience === 'unclear') row.audience = prev.audience;
      if (row.requirements.includes('unknown')) row.requirements = prev.requirements;
      row.steps = prev.steps;
      row.creditValidity = prev.creditValidity;
      // 已审核条目的展示性字段不随模型措辞漂移（2026-10-03：一轮采集对刚审过的 16 条提出了只改标题措辞、按输入能力加模态、把文档日期当发布时间的提案）
      row.title = prev.title; row.modalities = prev.modalities as typeof row.modalities; row.sourceTz = prev.sourceTz;
      row.claimMethod = prev.claimMethod; row.audience = prev.audience;
      if (prev.publishedAt) row.publishedAt = prev.publishedAt;
      // Equal digits do not mean equal benefits (100/day and 100/month differ).
      if (!changedOfficialBenefit(prev.evidence, o.evidence, o.sourceText)) row.valueText = prev.valueText;
      row.sourceId = prev.sourceId;
      // 新提案也不能因模型漏摘录丢掉已审核证据。
      if (row.evidence.url === prev.evidence.url) {
        const excerpts = { ...prev.evidence.excerpts };
        for (const key of ['benefit', 'eligibility', 'claim', 'validity'] as const) {
          const quote = row.evidence.excerpts[key];
          if (quote?.trim()) excerpts[key] = quote;
        }
        row.evidence = { ...row.evidence, excerpts };
      }
      // Preserve every field currently being edited by a reviewer, including presentation fields.
      for (const field of existingProposal?.manualFields ?? []) {
        if (field in row && field in existingProposal!.candidate) (row as Record<string,unknown>)[field] = existingProposal!.candidate[field];
      }
    }
    // Retaining approved fields can make an individually valid extraction invalid after merge.
    const merged = offerIn.safeParse({...row,sourceId:row.sourceId ?? undefined,firstChannel:row.firstChannel ?? undefined});
    if (!merged.success) { results.push({id:o.id,error:'合并已审核字段后未通过完整校验：'+merged.error.issues.map(x=>x.message).join('；')});continue; }
    const diff: {field:string;from:unknown;to:unknown}[] = reviewChanges(prev, row);
    const baseCurrent=sql`EXISTS (SELECT 1 FROM offers WHERE id=${o.id} AND updated_at=${prev.updatedAt} AND review_state=${prev.reviewState})`;
    const jobCurrent=o.officialReviewJobId?sql`json_extract(${s.offers.officialReview},'$.jobId')=${o.officialReviewJobId} AND json_extract(${s.offers.officialReview},'$.status')='checking'`:undefined;
    if(o.officialReviewJobId){
      const others=await d.select().from(s.offers).where(and(eq(s.offers.platformId,row.platformId),inArray(s.offers.reviewState,['pending','approved'])));
      const duplicate=others.find(other=>other.id!==o.id && other.evidence.tier!=='media' && sameBenefit(row,other));
      if(duplicate){results.push({id:o.id,error:`官方补全后与 ${duplicate.id} 相同，请管理员核对合并，保留原线索`});continue;}
    }
    if(prev.reviewState==='pending' && prev.evidence.tier!=='media' && row.evidence.tier==='media' && !diff.length) {
      results.push({id:o.id,unchanged:true});continue; // 相同条款的社区转述不降级已找到的官方证据。
    }
    // 待审草稿还未核准：只补证据、步骤或有效期也必须落库；已审核条目仍按业务字段提案。
    if (prev.reviewState === 'pending') {
      const meaningfulEvidence = (e: typeof row.evidence) => [e.url,e.tier,e.excerpts.benefit ?? null,e.excerpts.eligibility ?? null,e.excerpts.claim ?? null,e.excerpts.validity ?? null];
      for (const field of ['steps','creditValidity','evidence'] as const) {
        const before = field === 'evidence' ? meaningfulEvidence(prev.evidence) : prev[field];
        const after = field === 'evidence' ? meaningfulEvidence(row.evidence) : row[field];
        if (JSON.stringify(before) !== JSON.stringify(after)) diff.push({field,from:prev[field],to:row[field]});
      }
    }
    if (!diff.length) {
      if(o.officialReviewJobId && existingProposal){results.push({id:o.id,skipped:'官方材料未形成可应用的条款更新，保留提案供管理员判断'});continue;}
      if (existingProposal && o.evidence.tier !== 'media') await d.delete(s.offerProposals).where(and(eq(s.offerProposals.offerId, o.id),eq(s.offerProposals.updatedAt,existingProposal.updatedAt),baseCurrent));
      // 只刷新自动核验元数据，保留已审核文案、摘录及可选字段，模型漏摘录不能清空它们。
      const sameEvidencePage = prev.evidence.url === o.evidence.url && prev.evidence.tier !== 'tested' && o.evidence.tier !== 'media';
      if (prev.reviewState === 'approved' && sameEvidencePage) {
        await d.update(s.offers).set({ lastVerifiedAt: nowIso, verifyResult: '必要业务字段没有变化',
          evidence: { ...prev.evidence, capturedAt: nowIso, pageHash: o.evidence.pageHash ?? prev.evidence.pageHash }, updatedAt: nowIso }).where(and(eq(s.offers.id, o.id),eq(s.offers.updatedAt,prev.updatedAt),eq(s.offers.reviewState,prev.reviewState),jobCurrent));
      }
      results.push({ id: o.id, unchanged: true });
      continue;
    }
    if (prev.reviewState === 'rejected') {
      results.push({ id: o.id, unchanged: true, reviewState: 'rejected' });
      continue;
    }
    if (prev.reviewState === 'approved') {
      // 公开的已审核版本在提案通过前仍保持不变。
      if(existingProposal && JSON.stringify(existingProposal.diff)===JSON.stringify(diff)
        && JSON.stringify((existingProposal.candidate.evidence as typeof row.evidence)?.excerpts)===JSON.stringify(row.evidence.excerpts)
        && (existingProposal.candidate.evidence as typeof row.evidence)?.url===row.evidence.url
        && (existingProposal.candidate.evidence as typeof row.evidence)?.tier===row.evidence.tier){results.push({id:o.id,unchanged:true});continue;}
      const changed=existingProposal
        ? await d.update(s.offerProposals).set({candidate:row,diff,manualFields:existingProposal.manualFields,updatedAt:nowIso})
          .where(and(eq(s.offerProposals.offerId,o.id),eq(s.offerProposals.updatedAt,existingProposal.updatedAt),baseCurrent,
            o.officialReviewJobId?sql`EXISTS (SELECT 1 FROM offers WHERE id=${o.id} AND ${jobCurrent})`:undefined)).returning({id:s.offerProposals.offerId})
        : await c.env.DB.prepare('INSERT INTO offer_proposals (offer_id,candidate,diff,manual_fields,detected_at,updated_at) SELECT ?,?,?,\'[]\',?,? WHERE EXISTS (SELECT 1 FROM offers WHERE id=? AND updated_at=? AND review_state=\'approved\') ON CONFLICT (offer_id) DO NOTHING RETURNING offer_id AS id')
          .bind(o.id,JSON.stringify(row),JSON.stringify(diff),nowIso,nowIso,o.id,prev.updatedAt).all<{id:string}>().then(r=>r.results);
      if(!changed.length){results.push({id:o.id,error:'复核期间条目或提案已更新，保留管理员操作'});continue;}
      results.push({ id: o.id, changed: diff.map(x => x.field), reviewState: 'pending_update', missingEvidence: missing });
      continue;
    }
    // Evaluate the merged row, after restoring all manual qualification fields.
    const canAutoPublish=auto&&!row.requirements.some(r=>r.startsWith('member:'))&&(!row.membershipRequirement||row.membershipRequirement.status==='not_required')&&!await publicationError(c.env,{...prev,...row} as OfferRow);
    const reviewState = canAutoPublish ? 'approved' : 'pending';
    const changed = await d.update(s.offers).set({ ...row, reviewState }).where(and(eq(s.offers.id,o.id),eq(s.offers.updatedAt,prev.updatedAt),eq(s.offers.reviewState,prev.reviewState),jobCurrent)).returning({id:s.offers.id});
    if(!changed.length){results.push({id:o.id,error:'复核期间条目已更新，保留管理员操作'});continue;}
    if (existingProposal) await d.delete(s.offerProposals).where(and(eq(s.offerProposals.offerId, o.id),eq(s.offerProposals.updatedAt,existingProposal.updatedAt)));
    results.push({ id: o.id, changed: diff.map(x => x.field), reviewState, missingEvidence: missing });
  }
  const leadReconcilePending:number[]=[];
  for(const leadId of new Set(body.data.flatMap(o=>o.leadId?[o.leadId]:[]))){
    const failed=body.data.some((o,i)=>o.leadId===leadId&&'error' in results[i]);
    if(results.some(r=>r.pendingResolution)){leadReconcilePending.push(leadId);continue;}
    try {await aggregateIdentityLead(c.env.DB,leadId,failed);}catch(error){if(!(error instanceof IdentityQueryBudgetError))throw error;leadReconcilePending.push(leadId);}
  }
  return c.json({ results,leadReconcilePending });
});

/** 管线取待抓的信源，附带上次的内容哈希，用于判断有没有变化。 */
ingest.get('/sources', async c => {
  const d = db(c.env);
  const rows = await d.select().from(s.sources).where(eq(s.sources.enabled, true));
  const last = await c.env.DB.prepare(
    'SELECT source_id, hash, text FROM snapshots WHERE id IN (SELECT MAX(id) FROM snapshots GROUP BY source_id)',
  ).all<{ source_id: string; hash: string; text: string | null }>();
  const snap = Object.fromEntries(last.results.map(r => [r.source_id, r]));
  const plats = await d.select({ id: s.platforms.id, name: s.platforms.name, status: s.platforms.status }).from(s.platforms);
  return c.json({ sources: rows.map(r => ({ ...r, lastHash: snap[r.id]?.hash ?? null, lastText: ['rss', 'web_list', 'json'].includes(r.kind) ? snap[r.id]?.text ?? null : null, platform: plats.find(p => p.id === r.platformId) ?? null })) });
});

/** 兼容旧采集器：已批准条款不再进入定期证据复抓队列。 */
ingest.get('/verification-queue', async c => {
  return c.json({ offers: [] });
});

/** 兼容旧采集器：验证请求只确认对象，不再改写已批准证据或状态。 */
ingest.post('/verify', async c => {
  const body = z.object({ offerId: z.string(), url: z.url(), finalUrl: z.url().optional(), text: z.string().max(250000),
    trustedDirect: z.boolean().optional(), pageHash: z.string().regex(/^[a-f0-9]{64}$/).optional(), processedChange: z.boolean().optional() }).safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: '核验数据不正确', issues: body.error.issues }, 400);
  const d = db(c.env);
  const [o] = await d.select().from(s.offers).where(and(eq(s.offers.id, body.data.offerId),canonicalOffers));
  if (!o || o.reviewState !== 'approved' || o.evidence.url !== body.data.url) return c.json({ error: '证据或活动不匹配' }, 404);
  if (body.data.trustedDirect !== true) return c.json({ verified: false, sourceUnverified: true });
  return c.json({ verified: false, notRequired: true, unchanged: true });
});

/** 一次抓取的结果：成功时记录内容哈希（变化才存快照），失败时累计连续失败次数。 */
ingest.post('/snapshots', async c => {
  const body = z.object({
    sourceId: z.string(), url: z.string(), ok: z.boolean(), deferred: z.boolean().optional(),
    hash: z.string().optional(), text: z.string().max(60000).optional(), error: z.string().max(500).optional(),
  }).safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: '数据格式不正确', issues: body.error.issues }, 400);
  const b = body.data, d = db(c.env), nowIso = new Date().toISOString();
  const [src] = await d.select().from(s.sources).where(eq(s.sources.id, b.sourceId));
  if (!src) return c.json({ error: '没有这个信源' }, 404);
  if (!b.ok) {
    await d.update(s.sources).set({ failStreak: src.failStreak + 1, lastError: b.error ?? '抓取失败' }).where(eq(s.sources.id, b.sourceId));
    return c.json({ failStreak: src.failStreak + 1 });
  }
  // deferCount：内容有变化但这一轮没能抽取（免费模型都不可用）的连续次数，用来决定是否动用付费兜底
  const cfg = { ...(src.config ?? {}) } as Record<string, unknown>;
  cfg.deferCount = b.deferred ? Number(cfg.deferCount ?? 0) + 1 : b.hash ? 0 : Number(cfg.deferCount ?? 0);
  await d.update(s.sources).set({ failStreak: 0, lastError: null, lastOkAt: nowIso, config: cfg }).where(eq(s.sources.id, b.sourceId));
  if (!b.hash) return c.json({ changed: false, deferCount: cfg.deferCount });
  const [prev] = await d.select({ hash: s.snapshots.hash }).from(s.snapshots).where(eq(s.snapshots.sourceId, b.sourceId)).orderBy(desc(s.snapshots.id)).limit(1);
  if (prev?.hash === b.hash) return c.json({ changed: false });
  await d.insert(s.snapshots).values({ sourceId: b.sourceId, url: b.url, hash: b.hash, text: b.text ?? null });
  return c.json({ changed: true });
});

/** 线索研判：取待处理的线索、回写处理结果。 */
ingest.get('/leads', async c => {
  const requested = Number(c.req.query('limit') ?? 50);
  const limit = Number.isFinite(requested) ? Math.max(1, Math.min(100, Math.floor(requested))) : 50;
  const rows = await db(c.env).select().from(s.leads).where(eq(s.leads.status, 'new'));
  return c.json({ leads: selectLeads(rows, limit), backlog: rows.length });
});
ingest.post('/leads/:id/status', async c => {
  const b = z.object({ status: z.enum(['linked', 'rejected', 'reviewing']), offerId: z.string().optional(), note: z.string().max(500).optional() }).safeParse(await c.req.json().catch(() => null));
  if (!b.success) return c.json({ error: '数据格式不正确' }, 400);
  const [lead] = await db(c.env).select().from(s.leads).where(eq(s.leads.id, Number(c.req.param('id'))));
  if (!lead) return c.json({ error: '没有这条线索' }, 404);
  const identity=await aggregateIdentityLead(c.env.DB,lead.id,b.data.status==='reviewing');
  if(identity)return c.json({ok:true,identityHandled:true,...identity});
  if(lead.status!=='new')return c.json({error:'线索状态已变化，请使用线索复核结果接口'},409);
  const originOfferId=b.data.offerId;
  if(b.data.offerId)b.data.offerId=(await resolveCanonicalOffer(c.env.DB,b.data.offerId)).offerId;
  if (b.data.status === 'linked') {
    if (!b.data.offerId) return c.json({ error: '已关联必须提供已入库条目' }, 400);
    const [saved] = await db(c.env).select().from(s.offers).where(eq(s.offers.id, b.data.offerId));
    if (!saved) return c.json({ error: '条目尚未成功入库，线索不能标记已关联' }, 409);
    const [platform]=await db(c.env).select().from(s.platforms).where(eq(s.platforms.id,saved.platformId));
    const sources=await db(c.env).select().from(s.sources).where(eq(s.sources.platformId,saved.platformId));
    const mismatch=platform?leadScopeMismatch(lead,platform,sources,saved):'发放平台不存在';
    if(mismatch)return c.json({error:mismatch},400);
  }
  const raw = b.data.note ? `${lead.raw ?? ''}\n[研判] ${b.data.note}`.slice(-20000) : lead.raw;
  const resolution=b.data.status==='linked'&&b.data.offerId?{status:'linked' as const,jobId:'legacy-link-'+crypto.randomUUID(),attempts:0,inconclusive:0,checkedAt:new Date().toISOString(),nextAttemptAt:null,reason:b.data.note??'已关联现有活动',queries:[],candidates:[],offerIds:[b.data.offerId],originOfferIds:originOfferId?[originOfferId]:[]}:null;
  if(c.env.IDENTITY_MODE==='enforce'&&b.data.status==='rejected'){const closed={status:'closed' as const,jobId:crypto.randomUUID(),attempts:0,inconclusive:0,checkedAt:new Date().toISOString(),nextAttemptAt:null,reason:b.data.note??'既有研判拒绝线索',queries:[],candidates:[],offerIds:b.data.offerId?[b.data.offerId]:[]};await closeIdentityLead(c.env.DB,lead,closed,raw??lead.title??closed.reason,{actor:'pipeline:triage',raw});return c.json({ok:true,identityHandled:true});}
  await db(c.env).update(s.leads).set({ status: b.data.status, resolution, offerId: b.data.offerId ?? lead.offerId, raw }).where(and(eq(s.leads.id, lead.id),eq(s.leads.status,'new')));
  return c.json({ ok: true });
});

/**
 * 最近的人工纠正（修改字段、拒绝理由），给模型当"过去的纠正"参考。
 * 优先同一信源，其次同一平台，再其次全局最近；最多 limit 条，每条一行中文。
 */
ingest.get('/corrections', async c => {
  const platform = c.req.query('platform') ?? '', source = c.req.query('source') ?? '', limit = Math.min(100, Number(c.req.query('limit') ?? 10));
  const since = new Date(Date.now() - Number(c.req.query('days') ?? 3650) * 86400_000).toISOString();
  // 只取最近的记录（按主键倒序，读行数有上限）。旧写法对每条修订做相关子查询，单次读几万行，采集时每个信源调一次，曾经用光 D1 每日免费读额度。
  const recentRevs = await c.env.DB.prepare(`SELECT v.offer_id oid, v.diff d, v.at at, v.author author FROM offer_revisions v ORDER BY v.id DESC LIMIT 400`).all<{ oid: string; d: string; at: string; author: string }>();
  const recentRevs2 = recentRevs.results.filter(v => v.author === 'admin' && v.at >= since).slice(0, 200);
  const recentReviews = await c.env.DB.prepare(`SELECT r.offer_id oid, r.action, r.reason, r.reason_code code, r.reviewer, r.at FROM reviews r
    WHERE NOT EXISTS(SELECT 1 FROM review_decisions newer WHERE newer.supersedes_id=r.decision_id)
      AND NOT EXISTS(SELECT 1 FROM review_decisions refusal JOIN lead_candidate_links lc ON lc.candidate_id=refusal.candidate_id JOIN leads origin ON origin.id=lc.lead_id
        WHERE refusal.id=r.decision_id AND json_extract(origin.resolution,'$.spotCheck.verdict')='wrong'
        AND julianday(r.at)<=julianday(coalesce(json_extract(origin.resolution,'$.spotCheck.at'),'9999-12-31T00:00:00Z')))
    ORDER BY r.id DESC LIMIT 600`).all<{ oid: string; action: string; reason: string | null; code: string | null; reviewer: string | null; at: string }>();
  const ids = [...new Set([...recentRevs2.map(v => v.oid), ...recentReviews.results.map(r => r.oid)])];
  const offerRows = ids.length ? (await c.env.DB.prepare(`SELECT id, platform_id p, source_id src, title t, value_text v FROM offers WHERE id IN (SELECT value FROM json_each(?1))`).bind(JSON.stringify(ids)).all<{ id: string; p: string; src: string | null; t: string; v: string }>()).results : [];
  const offerById = new Map(offerRows.map(o => [o.id, o]));
  const editReason = (oid: string, at: string) => recentReviews.results.filter(r => r.oid === oid && r.action === 'edit')
    .sort((a, b) => Math.abs(Date.parse(a.at) - Date.parse(at)) - Math.abs(Date.parse(b.at) - Date.parse(at)))[0]?.reason ?? null;
  const edits = { results: recentRevs2.filter(v => offerById.has(v.oid)).map(v => { const o = offerById.get(v.oid)!; return { p: o.p, src: o.src, t: o.t, d: v.d, reason: editReason(v.oid, v.at), at: v.at }; }) };
  const rejects = { results: recentReviews.results.filter(r => r.action === 'reject' && (r.reviewer ?? '') !== 'system' && (r.reason || r.code) && r.at >= since && offerById.has(r.oid))
    .slice(0, 200).map(r => { const o = offerById.get(r.oid)!; return { p: o.p, src: o.src, t: o.t, v: o.v, reason: r.reason, code: r.code, at: r.at }; }) };
  const CODE: Record<string, string> = { paid_bundle: '付费套餐自带的额度', not_ai: '不是 AI 使用额度', wrong_platform: '平台归错', duplicate: '重复', expired: '已过期', vague: '额度不明确', insufficient_evidence: '证据不足', wrong_type: '分类错', wrong_field: '字段错', other: '其他' };
  const items = [
    ...edits.results.map(e => ({ p: e.p, src: e.src, at: e.at, line: `「${e.t}」人工修改：${(JSON.parse(e.d) as { field: string; from: unknown; to: unknown }[]).filter(x => JSON.stringify(x.from) !== JSON.stringify(x.to)).map(x => `${x.field} ${JSON.stringify(x.from)} → ${JSON.stringify(x.to)}`).join('；')}${e.reason ? `（理由：${e.reason}）` : ''}` })),
    ...rejects.results.map(r => ({ p: r.p, src: r.src, at: r.at, line: `「${r.t}」（${r.v.slice(0, 40)}）被拒绝：${[r.code ? CODE[r.code] ?? r.code : '', r.reason ?? ''].filter(Boolean).join('，')}` })),
  ];
  // Early rejections (lead dismissals, identity-card rejections) teach triage what never to capture. Only content
  // categories: "duplicate"/"unverifiable"/"expired" say nothing about whether this kind of lead belongs here.
  const EARLY: Record<string, string> = { non_ai: '与 AI 无关（含优惠券、购物券）', relay_station: '中转站', account_pool: '账号池', personal_giveaway: '个人分享/送码', paid_bundle: '付费套餐自带', ordinary_discount: '普通折扣/优惠券', model_news_only: '只是模型或价格新闻' };
  const early = await c.env.DB.prepare(`SELECT d.subject_kind kind, d.category, d.justification why, d.labeled_at at, l.title lt, l.origin lo, ic.raw_candidate_json cj
    FROM decision_labels d LEFT JOIN leads l ON d.subject_kind='lead' AND l.id=CAST(d.subject_id AS INTEGER) LEFT JOIN intake_candidates ic ON d.subject_kind='candidate' AND ic.id=d.subject_id
    WHERE d.actor_kind='owner' AND d.labeled_at>=? AND d.category IN (SELECT value FROM json_each(?))
      AND (d.subject_kind<>'lead' OR coalesce(json_extract(l.resolution,'$.spotCheck.verdict'),'')<>'wrong' OR julianday(d.labeled_at)>julianday(coalesce(json_extract(l.resolution,'$.spotCheck.at'),'9999-12-31T00:00:00Z')))
      AND (d.subject_kind<>'candidate' OR EXISTS(SELECT 1 FROM review_decisions refusal
        WHERE (refusal.candidate_id=ic.id OR refusal.id=ic.decision_id) AND refusal.action='reject'
          AND NOT EXISTS(SELECT 1 FROM review_decisions newer WHERE newer.supersedes_id=refusal.id)
          AND NOT EXISTS(SELECT 1 FROM lead_candidate_links lc JOIN leads origin ON origin.id=lc.lead_id WHERE lc.candidate_id=ic.id AND json_extract(origin.resolution,'$.spotCheck.verdict')='wrong'
            AND (julianday(d.labeled_at)<=julianday(coalesce(json_extract(origin.resolution,'$.spotCheck.at'),'9999-12-31T00:00:00Z'))
              OR julianday(refusal.created_at)<=julianday(coalesce(json_extract(origin.resolution,'$.spotCheck.at'),'9999-12-31T00:00:00Z'))))))
      ORDER BY d.labeled_at DESC LIMIT 200`)
    .bind(since, JSON.stringify(Object.keys(EARLY))).all<{ kind: string; category: string; why: string | null; at: string; lt: string | null; lo: string | null; cj: string | null }>();
  for (const e of early.results) {
    let title = e.lt, p: string | null = null;
    if (e.kind === 'candidate' && e.cj) { try { const raw = JSON.parse(e.cj) as { candidate?:{title?:unknown;platformId?:unknown}; title?: unknown; platformId?: unknown }; const j=raw.candidate??raw; title = typeof j.title === 'string' ? j.title : null; p = typeof j.platformId === 'string' ? j.platformId : null; } catch { /* unreadable candidate */ } }
    if (!title) continue;
    const why = e.why && !/^管理员(忽略|关闭)线索$/.test(e.why) ? `，${e.why.slice(0, 160)}` : '';
    items.push({ p: p ?? '', src: null, at: e.at, line: `${e.kind === 'lead' ? '线索' : '候选'}「${title.slice(0, 80)}」${e.lo ? `（${e.lo}）` : ''}在入口阶段被拒：${EARLY[e.category]}${why}` });
  }
  const rank = (x: { p: string; src: string | null }) => (source && x.src === source ? 0 : platform && x.p === platform ? 1 : 2);
  items.sort((a, b) => rank(a) - rank(b) || (a.at < b.at ? 1 : -1));
  return c.json({ corrections: items.slice(0, limit).map(x => x.line), total: items.length });
});

/** Private compatibility index; rejected history and incomplete pages are explicit. */
ingest.get('/offers-index', async c => {
  const input=z.object({cursor:z.string().max(200).optional(),product:z.string().max(200).optional()}).safeParse(c.req.query());
  if(!input.success)return c.json({error:'invalid index cursor'},400);
  const {cursor,product}=input.data;
  const rows=await c.env.DB.prepare(`SELECT o.id,o.platform_id AS platformId,o.title,o.value_text AS valueText,o.claim_start AS claimStart,o.claim_end AS claimEnd,o.source_tz AS sourceTz,o.published_at AS publishedAt,o.tags,o.review_state AS reviewState,json_extract(o.evidence,'$.url') AS evidenceUrl,json_extract(o.evidence,'$.excerpts') AS excerpts,
    (SELECT d.scope_json FROM benefit_entities e JOIN review_decisions d ON d.entity_id=e.id WHERE e.canonical_offer_id=o.id AND d.action='reject' AND NOT EXISTS(SELECT 1 FROM review_decisions newer WHERE newer.supersedes_id=d.id) ORDER BY d.created_at DESC LIMIT 1) AS rejectionScope
    FROM offers o WHERE o.id>? AND (? IS NULL OR o.platform_id=?) ORDER BY o.id LIMIT 251`).bind(cursor??'',product??null,product??null).all<Record<string,unknown>>();
  const visible=rows.results.slice(0,250);
  return c.json({offers:visible.map(row=>({...row,tags:JSON.parse(String(row.tags)),excerpts:row.excerpts?JSON.parse(String(row.excerpts)):null,rejectionScope:row.rejectionScope?JSON.parse(String(row.rejectionScope)):null})),complete:rows.results.length<=250,nextCursor:rows.results.length>250?String(visible.at(-1)!.id):null});
});

/** 模型预算：今日 token、本月费用。 */
ingest.post('/model-budget/reserve', async c => {
  const body = z.object({
    provider: z.string().max(40), tokens: z.number().int().positive().max(400000), costCny: z.number().nonnegative().max(1000),
    line: z.enum(['extraction', 'screening']).optional(), pool: z.enum(['openrouter-free']).optional(), purpose: z.enum(['urgent', 'normal', 'backfill']).optional(),
  }).safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: '预算预留参数不正确' }, 400);
  const line = body.data.line ?? 'extraction';
  const tokenCap = Number(c.env.DAILY_TOKEN_CAP ?? 0);
  const costCap = line === 'screening' ? Number(c.env.SCREENING_MONTHLY_CAP_CNY ?? 72) : Number(c.env.MONTHLY_COST_CAP_CNY ?? 72);
  const freeDaily = Number(c.env.OPENROUTER_FREE_DAILY ?? 1000);
  const urgentReserve = Number(c.env.SCREENING_URGENT_RESERVE ?? 200);
  const backfillDaily = Number(c.env.SCREENING_BACKFILL_DAILY ?? 400);
  if ([tokenCap, costCap, freeDaily, urgentReserve, backfillDaily].some(value => !Number.isFinite(value) || value < 0)) return c.json({ error: '服务端预算配置不正确' }, 503);
  const nowIso = new Date().toISOString(), today = nowIso.slice(0, 10), month = nowIso.slice(0, 7);
  const stats = JSON.stringify({ state: 'reserved', provider: body.data.provider, line, pool: body.data.pool ?? null, purpose: body.data.purpose ?? null });
  const nonUrgentCap = Math.max(0, freeDaily - urgentReserve);
  // 一条 INSERT ... WHERE 同时判定与占用余额，多个并发采集任务也不能越过上限。
  const reserved = await c.env.DB.prepare(`INSERT INTO runs (kind,started_at,finished_at,ok,stats,tokens,cost_cny)
    SELECT 'model', ?1, ?1, 0, ?2, ?3, ?4
    WHERE (?6 = 0 OR (SELECT COALESCE(SUM(tokens),0) FROM runs WHERE substr(started_at,1,10)=?5) + ?3 <= ?6)
      AND (SELECT COALESCE(SUM(cost_cny),0) FROM runs WHERE substr(started_at,1,7)=?7 AND (
        (?9 = 'screening' AND json_extract(stats,'$.line')='screening')
        OR (?9 <> 'screening' AND (json_extract(stats,'$.line') IS NULL OR json_extract(stats,'$.line')='extraction'))
      )) + ?4 <= ?8
      AND (?10 IS NULL OR (
        (SELECT COUNT(*) FROM runs WHERE substr(started_at,1,10)=?5 AND json_extract(stats,'$.pool')='openrouter-free') + 1 <= ?11
        AND (?12 = 'urgent' OR (SELECT COUNT(*) FROM runs WHERE substr(started_at,1,10)=?5 AND json_extract(stats,'$.pool')='openrouter-free' AND json_extract(stats,'$.purpose') IN ('normal','backfill')) + 1 <= ?13)
        AND (?12 <> 'backfill' OR (SELECT COUNT(*) FROM runs WHERE substr(started_at,1,10)=?5 AND json_extract(stats,'$.pool')='openrouter-free' AND json_extract(stats,'$.purpose')='backfill') + 1 <= ?14)
      ))
    RETURNING id`).bind(nowIso, stats, body.data.tokens, body.data.costCny, today, tokenCap, month, costCap, line, body.data.pool ?? null, freeDaily, body.data.purpose ?? '', nonUrgentCap, backfillDaily).first<{ id: number }>();
  if (reserved) return c.json({ id: reserved.id });
  const poolFull = body.data.pool === 'openrouter-free';
  return c.json({ error: '模型预算不足，本次调用已推迟', quota: poolFull ? 'pool_exhausted' : 'cost_exhausted' }, 429);
});

ingest.post('/model-budget/:id/settle', async c => {
  const body = z.object({ provider: z.string().max(40), tokens: z.number().int().nonnegative().max(400000), costCny: z.number().nonnegative().max(1000) })
    .safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: '模型用量不正确' }, 400);
  const id = Number(c.req.param('id'));
  if (!Number.isSafeInteger(id) || id <= 0) return c.json({ error: '预留记录无效' }, 400);
  const [record] = await db(c.env).select().from(s.runs).where(and(eq(s.runs.id, id), eq(s.runs.kind, 'model')));
  if (!record) return c.json({ error: '没有这次模型调用' }, 404);
  if ((record.stats as { state?: string }).state === 'settled') return c.json({ ok: true, alreadySettled: true });
  if (body.data.tokens > record.tokens || body.data.costCny > record.costCny + 0.000001) return c.json({ error: '实际用量超出预留，请保留预留并人工核对' }, 409);
  const previous = record.stats ?? {};
  await db(c.env).update(s.runs).set({ tokens: body.data.tokens, costCny: body.data.costCny,
    stats: { ...previous, state: 'settled', provider: body.data.provider }, ok: true, finishedAt: new Date().toISOString() }).where(eq(s.runs.id, id));
  return c.json({ ok: true });
});

ingest.get('/budget', async c => {
  const today = new Date().toISOString().slice(0, 10), month = today.slice(0, 7);
  const r = await c.env.DB.prepare(
    "SELECT COALESCE(SUM(CASE WHEN substr(started_at,1,10)=?1 THEN tokens END),0) AS tokens_today, COALESCE(SUM(CASE WHEN substr(started_at,1,7)=?2 THEN cost_cny END),0) AS cost_month FROM runs",
  ).bind(today, month).first<{ tokens_today: number; cost_month: number }>();
  return c.json({ tokensToday: r?.tokens_today ?? 0, costMonthCny: r?.cost_month ?? 0 });
});

ingest.post('/runs', async c => {
  const body = runIn.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: '数据格式不正确', issues: body.error.issues }, 400);
  const [r] = await db(c.env).insert(s.runs).values(body.data).returning({ id: s.runs.id });
  return c.json({ id: r.id });
});

/** 快速上架读取队列：流水线领取任务、用免费模型补字段、交回结果，再分步完成上架。 */
const fastTrackFailure = (c: Context<{ Bindings: Env }>, error: unknown) => {
  if (error instanceof FastTrackError) return c.json({ error: error.message }, error.status);
  if (error instanceof z.ZodError) return c.json({ error: '数据格式不正确', issues: error.issues }, 400);
  throw error;
};
ingest.get('/fast-track/queue', async c => c.json({ jobs: await fastTrackQueue(c.env.DB) }));
ingest.get('/fast-track/:id/review-input',async c=>{try{return c.json(await fastTrackReviewInput(c.env.DB,c.req.param('id')));}catch(error){return fastTrackFailure(c,error);}});
ingest.post('/fast-track/:id/claim', async c => {
  const job = await claimFastTrack(c.env.DB, c.req.param('id'));
  return job ? c.json({ job }) : c.json({ error: '任务已被领取或已结束' }, 409);
});
ingest.post('/fast-track/:id/result', async c => {
  try { return c.json(await submitFastTrackResult(c.env, c.req.param('id'), await c.req.json().catch(() => null))); } catch (error) { return fastTrackFailure(c, error); }
});
ingest.post('/fast-track/:id/advance', async c => {
  try { return c.json(await advanceFastTrack(c.env, c.req.param('id'))); } catch (error) { return fastTrackFailure(c, error); }
});

app.route('/api/ingest', ingest);
app.route('/api/admin', feishuAdmin); // 先于 admin 注册：/api/admin/feishu/*、/api/admin/collect/*
app.route('/api/admin', admin);
app.all('/api/*', c => c.json({ error: '没有这个接口' }, 404));

export default {
  fetch: (req, env, ctx) => app.fetch(req, env, ctx),
  // 定时任务：飞书日报（东京 09:00）、每小时加急检查、每 6 小时触发采集
  scheduled: (controller, env, ctx) => { if(snapshotActive(env.D1_PUBLIC_SNAPSHOT_UNTIL)||quotaCircuitOpen())return;ctx.waitUntil((async()=>{if(env.D1_REPAIR_RELATED_INDEXES==='1')await ensureRelatedReadIndexes(env.DB);await runScheduled(controller.cron, env);})()); },
} satisfies ExportedHandler<Env>;
