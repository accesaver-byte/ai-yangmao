import {AIHOT_RESET_SOURCE,AIHOT_RESET_URL} from '../shared/aihot-reset';
import { parseDiscordChannelLink, registerDiscordPublisher, unmappedDiscordOrigins } from './discord-publishers';
import { learnWechatAccount } from './wechat-accounts';
import type {MembershipRequirement} from '../shared/membership';
import {membershipAdminRoutes,prepareMembershipFields,MembershipError} from './membership';
import {needsEvidence,reviewPreparation} from '../shared/review-preparation';
import {closeIdentityLead} from './identity/lead-closure';
import {ownerRejectInput,recordOwnerLabel} from './screening/labels';
import {visibilityState,visibilityView} from './identity/visibility';
import {canonicalLeadProjection} from './identity/lead-projection';
import {notificationInheritance} from './identity/notification-inheritance';
import {noticeIdentities,pendingIdentityNotices,identityReviewAlerts,identityGuard,deliveryIdentityGuard,reviewAlertOverlap} from './identity/notifications';
import {canonicalOffers,resolveCanonicalOffer,entityOfferVersion} from './identity/canonical';
import { identityAdminRoutes } from './identity/routes';
import { screeningAdminRoutes } from './screening/routes';
import { reviewStats } from './review-stats';
import { IdentityService } from './identity/service';
import { IdentityError } from './identity/store';
import { sha256,stableJson } from '../shared/identity/normalize';
import { publicationError, validateStoredOffer } from './publication';
import {ADMIN_RETRY_REASON,WECHAT_FAST_TRACK_REASON,leadTask,leadReviewVersion,leadReviewDue,type LeadResolution} from '../shared/lead-review';
import { leadPriority } from '../shared/leads';
import { isReviewField } from '../shared/spec';
import { createComment, removeComment, legacyNoteStatement, commentMutationGuard, commentBodyLimit } from './comments';
// 管理接口（Bearer ADMIN_TOKEN）：审核、编辑、补录、日报、健康检查。
// 调用方：Hermes Agent 的"AI 羊毛牧场"技能（scripts/ym.ts），以后还有网页后台。
import { and, desc, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import * as s from '../db/schema';
import { claimEndAt, isClaimable, liveStatus, missingEvidence } from '../shared/lifecycle';
import { offerIn } from '../shared/ingest';
import { SECTIONS, blocking, checkOffer } from '../shared/spec';
import { haoScore } from '../shared/score';
import { officialTier, officialReviewDue } from '../shared/official-review';
import { sameBenefit } from '../shared/dedupe';
import { parseValuation } from '../shared/valuation';
import { offerRefFromInput } from '../shared/offer-ref';
import { sourceHealthReason, sourceUnhealthy } from '../shared/source-health';
import type { Env } from './index';
import { advanceFastTrack, completeFastTrack, createFastTrack, FastTrackError, fastTrackHeld, listFastTrack, retryFastTrack } from './fast-track';

type OfferRow = typeof s.offers.$inferSelect;
const db = (env: Env) => drizzle(env.DB, { schema: s });
const membershipCatalogGuard=(r?:MembershipRequirement|null)=>r?sql`EXISTS(SELECT 1 FROM membership_catalog WHERE id=1 AND revision=${r.catalogRevision})`:undefined;

/** 4 位短码，方便在手机上回复（例如"通过 a3f9"）。 */
export function shortCode(id: string): string {
  let h = 2166136261;
  for (const ch of id) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36).padStart(4, '0').slice(-4);
}

const TYPE_L: Record<string, string> = { new: '注册新人礼', trial: '应用尝鲜', free: '限时免费开放', perk: '会员福利', topup: '充值赠送', gift: '会员免费送', standing: '常驻免费额度', apply: '申请制' };
const md = (d: string) => `${Number(d.slice(5, 7))}月${Number(d.slice(8, 10))}日`;
const endText = (o: OfferRow) => (o.endKind === 'date' && o.claimEnd ? `${md(o.claimEnd)}截止` : o.endKind === 'unknown' ? '截止未知' : '常驻');

function view(o: OfferRow, platformName: string, now = new Date()) {
  return {
    preparation: reviewPreparation(o), reviewVersion: o.updatedAt, visibilityVersion:o.updatedAt, code: shortCode(o.id), id: o.id, platformId: o.platformId, platform: platformName, title: o.title, type: TYPE_L[o.type] ?? o.type,
    value: o.valueText, usd: o.usdEstimate, end: endText(o), status: liveStatus(o, now), reviewState: o.reviewState,
    membershipRequirement:o.membershipRequirement??null, requirements: o.requirements, audience: o.audience, claimMethod: o.claimMethod, creditValidity: o.creditValidity,
    sourceTz: o.sourceTz, claimStart: o.claimStart, claimEnd: o.claimEnd, endKind: o.endKind,
    evidenceUrl: o.evidence.url, evidenceTier: o.evidence.tier, excerpts: o.evidence.excerpts, missingEvidence: missingEvidence(o.evidence.excerpts),verifyResult:o.verifyResult??null,
    steps: o.steps, models: o.models ?? [], tags: o.tags ?? [], publishedAt: o.publishedAt ?? null, lastVerifiedAt:o.lastVerifiedAt??null, modalities: o.modalities, usdEstimate: o.usdEstimate, usdMax: o.usdMax ?? null, valuation: parseValuation(o.valuation), adminNote: o.adminNote ?? null, reviewMemo: o.reviewMemo ?? null, officialReview: o.officialReview ?? null, suggestion: o.reviewSuggestion ?? null,
    // 上架前检查：缺了哪些字段、影响哪些栏目（规格见 src/shared/spec.ts）
    checks: checkOffer(o, now).map(i => ({ ...i, sections: i.sections.map(k => SECTIONS[k]) })),
    link: `https://ai-yangmao.com/#${o.reviewState === 'pending' ? 'admin-offer-' : 'offer-'}${encodeURIComponent(o.id)}`,
  };
}

export const admin = new Hono<{ Bindings: Env; Variables: { role: 'admin' | 'reviewer'; who: string } }>();

/** 审核员能用的接口：看待审、通过、拒绝、修改、核验记录、线索、补录、补信源、送交平台准入。 */
const REVIEWER_ALLOWED: [string, RegExp][] = [
  ['GET', /^\/memberships(?:\/[^/]+\/impact)?$/], ['POST', /^\/memberships$/],
  ['GET', /^\/identity\/tasks$/], ['GET', /^\/identity\/tasks\/[^/]+\/comparisons$/], ['POST', /^\/identity\/tasks\/[^/]+\/(hint|prepare|resolve)$/],
  ['GET', /^\/(whoami|queue|leads)$/], ['GET', /^\/offers\/[^/]+$/],
  ['POST', /^\/offers\/[^/]+\/(approve|reject|edit|memo|note|retested|suggest|official-retry)$/],
  ['POST', /^\/leads\/\d+\/(dismiss|reviewing|retry|resolve)$/], ['POST', /^\/(manual|sources|platforms)$/],
];
export function reviewerFor(env: Env, token: string | undefined): string | null {
  if (!token || token.length < 16) return null;
  for (const pair of (env.REVIEWER_TOKENS ?? '').split(',')) {
    const i = pair.indexOf(':');
    if (i > 0 && pair.slice(i + 1).trim().length >= 16 && pair.slice(i + 1).trim() === token) return pair.slice(0, i).trim();
  }
  return null;
}

admin.use('*', async (c, next) => {
  const token = c.req.header('Authorization')?.replace(/^Bearer\s+/i, '');
  c.header('Cache-Control', 'no-store');
  if (c.env.ADMIN_TOKEN && c.env.ADMIN_TOKEN.length >= 16 && token === c.env.ADMIN_TOKEN) { c.set('role', 'admin'); c.set('who', 'admin'); return next(); }
  const who = reviewerFor(c.env, token);
  if (!who) return c.json({ error: '管理员密钥不正确' }, 401);
  const path = c.req.path.replace(/^.*\/api\/admin/, '');
  if (!REVIEWER_ALLOWED.some(([m, re]) => m === c.req.method && re.test(path))) return c.json({ error: '审核员没有这个权限' }, 403);
  c.set('role', 'reviewer'); c.set('who', who);
  await next();
});

admin.route('/identity',identityAdminRoutes);
admin.route('/screening', screeningAdminRoutes);
admin.get('/review-stats', async c => c.json(await reviewStats(c.env.DB, Math.min(30, Math.max(1, Number(c.req.query('days') ?? 7) || 7)))));
admin.route('/memberships',membershipAdminRoutes);

admin.get('/whoami', c => c.json({ role: c.get('role'), who: c.get('who') }));
admin.post('/offers/:ref/comments', commentMutationGuard, commentBodyLimit, c => createComment(c, c.req.param('ref'), true));
admin.post('/comments/:id/delete', commentMutationGuard, commentBodyLimit, c => removeComment(c, c.req.param('id')));

/** 补信源：给已登记平台加一个官方信源，下一轮采集开始抓取；不会打开自动上架。 */
admin.get('/discord/unmapped', async c => c.json({ origins: await unmappedDiscordOrigins(c.env.DB) }));
admin.post('/discord/publishers', async c => {
  const body = z.object({ platformId: z.string().min(1), name: z.string().min(1).max(80), guildId: z.string().optional(), channelId: z.string().optional(), link: z.string().optional() }).safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: 'Discord 频道资料不正确' }, 400);
  const ids = body.data.link ? parseDiscordChannelLink(body.data.link) : body.data.guildId && body.data.channelId ? { guildId: body.data.guildId, channelId: body.data.channelId } : null;
  if (!ids) return c.json({ error: '请粘贴 https://discord.com/channels/服务器/频道 链接' }, 400);
  const r = await registerDiscordPublisher(c.env.DB, { platformId: body.data.platformId, name: body.data.name, ...ids });
  return r.status === 200 ? c.json({ ok: true, ...ids }) : c.json({ error: r.error }, r.status);
});
/** ⚡ 快速上架：管理员担保的官方链接或实测权益，跳过筛查与审核闸门；仅管理员。 */
const fastTrackError = (c: Context<{ Bindings: Env; Variables: { role: 'admin' | 'reviewer'; who: string } }>, error: unknown) => {
  if (error instanceof FastTrackError) return c.json({ error: error.message }, error.status);
  if (error instanceof z.ZodError) return c.json({ error: '快速上架资料不正确', issues: error.issues }, 400);
  throw error;
};
admin.use('/fast-track/*', async (c, next) => c.get('role') === 'admin' ? next() : c.json({ error: '只有管理员可以快速上架' }, 403));
admin.use('/fast-track', async (c, next) => c.get('role') === 'admin' ? next() : c.json({ error: '只有管理员可以快速上架' }, 403));
admin.get('/fast-track', async c => c.json({ jobs: await listFastTrack(c.env.DB) }));
admin.post('/fast-track', async c => {
  try { return c.json(await createFastTrack(c.env, await c.req.json().catch(() => null), c.get('who') || 'admin')); } catch (error) { return fastTrackError(c, error); }
});
admin.post('/fast-track/:id/complete', async c => {
  try { return c.json(await completeFastTrack(c.env, c.req.param('id'), await c.req.json().catch(() => null))); } catch (error) { return fastTrackError(c, error); }
});
admin.post('/fast-track/:id/advance', async c => {
  try { return c.json(await advanceFastTrack(c.env, c.req.param('id'))); } catch (error) { return fastTrackError(c, error); }
});
admin.post('/fast-track/:id/retry', async c => {
  try { return c.json(await retryFastTrack(c.env, c.req.param('id'))); } catch (error) { return fastTrackError(c, error); }
});
admin.post('/sources', async c => {
  const body = z.object({ platformId: z.string().min(1), url: z.url().refine(u => /^https:\/\//.test(u), '只收 https 链接'),
    kind: z.enum(['web_list', 'rss', 'json']), tier: z.enum(['site', 'docs', 'official', 'staff']) }).safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: '信源资料不正确', issues: body.error.issues }, 400);
  const d = db(c.env);
  const [platform] = await d.select({ id: s.platforms.id }).from(s.platforms).where(eq(s.platforms.id, body.data.platformId));
  if (!platform) return c.json({ error: '没有这个平台，先送交平台准入' }, 404);
  const [dup] = await d.select({ id: s.sources.id }).from(s.sources).where(eq(s.sources.url, body.data.url));
  if (dup) return c.json({ error: `这个链接已经是信源 ${dup.id}` }, 409);
  const id = `${body.data.platformId}-${c.get('who') === 'admin' ? 'add' : 'rv'}-${Date.now().toString(36)}`;
  await d.insert(s.sources).values({ id, ...body.data, config: { addedBy: c.get('who') }, enabled: true, autoPublish: false });
  return c.json({ id }, 201);
});

async function platformNames(env: Env) {
  const rows = await db(env).select({ id: s.platforms.id, name: s.platforms.name }).from(s.platforms);
  return Object.fromEntries(rows.map(r => [r.id, r.name]));
}

/** 按短码或完整 id 找羊毛。 */
async function findOffer(env: Env, ref: string): Promise<OfferRow | null> {
  const d = db(env);
  const [byId] = await d.select().from(s.offers).where(eq(s.offers.id, ref));
  if (byId) {const route=await resolveCanonicalOffer(env.DB,byId.id);return route.offerId===byId.id?byId:(await d.select().from(s.offers).where(eq(s.offers.id,route.offerId)))[0]??null;}
  const all = await d.select().from(s.offers);
  const matches = all.filter(o => shortCode(o.id) === ref.toLowerCase());
  if (matches.length > 1) throw new AmbiguousShortCode(matches.map(o => o.id));
  if(!matches[0])return null;const route=await resolveCanonicalOffer(env.DB,matches[0].id);return (await d.select().from(s.offers).where(eq(s.offers.id,route.offerId)))[0]??null;
}

class AmbiguousShortCode extends Error {
  constructor(readonly ids: string[]) { super('短码不唯一，请改用完整活动 ID'); }
}
admin.onError((error, c) => {
  if (error instanceof z.ZodError) return c.json({error:'身份请求格式不正确'},400);
  if (error instanceof IdentityError || error instanceof MembershipError) return c.json({error:error.message},error.status);
  if (error instanceof AmbiguousShortCode) return c.json({ error: error.message, ids: error.ids }, 409);
  throw error;
});

admin.get('/queue', async c => {
  const d = db(c.env), names = await platformNames(c.env), now = new Date();
  // 先抓到的在前，新抓取的排在最后（管理员按顺序审，新来的不打乱已预审的条目，2026-10-03）
  const pending = await d.select().from(s.offers).where(and(eq(s.offers.reviewState, 'pending'),canonicalOffers)).orderBy(s.offers.discoveredAt, s.offers.id);
  const proposals = await d.select().from(s.offerProposals).orderBy(desc(s.offerProposals.updatedAt));
  const originals = proposals.length ? await d.select().from(s.offers).where(inArray(s.offers.id, d.select({ id: s.offerProposals.offerId }).from(s.offerProposals))) : [];
  const codeCounts = new Map<string, number>();
  for (const { id } of await d.select({ id: s.offers.id }).from(s.offers)) codeCounts.set(shortCode(id), (codeCounts.get(shortCode(id)) ?? 0) + 1);
  const entityRows=(await c.env.DB.prepare("SELECT e.id,e.canonical_offer_id,e.business_revision,e.state,EXISTS(SELECT 1 FROM review_tasks t WHERE t.entity_id=e.id AND t.state IN ('open','checking','manual')) active_task FROM benefit_entities e WHERE e.canonical_offer_id IS NOT NULL").all<{id:string;canonical_offer_id:string;business_revision:number;state:string;active_task:number}>()).results;
  const managed=new Set(entityRows.filter(e=>e.state==='merged'||e.active_task).map(e=>e.canonical_offer_id));
  const entityByOffer=new Map(entityRows.map(e=>[e.canonical_offer_id,e]));
  const queueView = (o: OfferRow) => ({ ...view(o, names[o.platformId] ?? o.platformId, now),...(entityByOffer.has(o.id)?{reviewVersion:entityOfferVersion(entityByOffer.get(o.id)!,o.updatedAt),visibilityVersion:entityOfferVersion(entityByOffer.get(o.id)!,o.updatedAt)}:{}), code: codeCounts.get(shortCode(o.id))! > 1 ? o.id : shortCode(o.id) });
  const [{ n: newLeads }] = await d.select({ n: sql<number>`count(*)` }).from(s.leads).where(eq(s.leads.status, 'new'));
  const pendingPlatforms = await d.select().from(s.platforms).where(eq(s.platforms.status, 'pending'));
  const suggest = (await d.select().from(s.sources).where(and(gte(s.sources.cleanStreak, 5), eq(s.sources.autoPublish, false))))
    .filter(source => source.enabled && ['site', 'docs', 'official'].includes(source.tier));
  const approvedRows = await d.select().from(s.offers).where(and(eq(s.offers.reviewState, 'approved'),canonicalOffers));
  // An approved offer can lose current-evidence status without losing its approval.
  // Keep this separate from new-activity approval and render it lazily in the admin UI.
  const needsVerification = approvedRows.filter(o=>!o.withdrawnAt&&liveStatus(o,now)==='stale').sort((a,b)=>Number(b.verifyResult==='evidence_missing')-Number(a.verifyResult==='evidence_missing')||(claimEndAt(a)?.getTime()??Infinity)-(claimEndAt(b)?.getTime()??Infinity)||String(a.id).localeCompare(String(b.id)));
  const incomplete = approvedRows.filter(o => !o.withdrawnAt&&liveStatus(o,now)!=='stale'&&checkOffer(o, now).some(i => i.level !== 'info'));
  const identityTasks=(await c.env.DB.prepare("SELECT t.id,t.kind,t.revision,t.entity_id,t.suggestion_json,d.basis_json,e.canonical_offer_id,v.display_candidate_json FROM review_tasks t LEFT JOIN benefit_entities e ON e.id=t.entity_id LEFT JOIN benefit_versions v ON v.id=t.version_id AND v.entity_id=e.id LEFT JOIN review_decisions d ON d.id=t.decision_id WHERE t.state IN ('open','checking','manual') AND (e.id IS NULL OR e.state='active') ORDER BY t.created_at,t.id").all<{id:string;kind:string;revision:number;entity_id:string|null;suggestion_json:string|null;basis_json:string|null;canonical_offer_id:string|null;display_candidate_json:string|null}>()).results;
  const taskOfferIds=identityTasks.flatMap(t=>t.canonical_offer_id?[t.canonical_offer_id]:[]);
  const allOffers=taskOfferIds.length?await d.select().from(s.offers).where(sql`${s.offers.id} IN (SELECT value FROM json_each(${JSON.stringify(taskOfferIds)}))`):[];
  const managedCards=identityTasks.flatMap(t=>{const original=allOffers.find(o=>o.id===t.canonical_offer_id),restoration=!!t.basis_json&&JSON.parse(t.basis_json).visibilityReopen===true;if(!original||!t.display_candidate_json||!['initial','terms_change','evidence_reopen'].includes(t.kind)||(original.withdrawnAt&&!restoration))return [];const suggestion=t.suggestion_json?JSON.parse(t.suggestion_json):null;const target={...proposalOffer(original,JSON.parse(t.display_candidate_json)),...(suggestion?.kind==='official_evidence'?{verifyResult:null}:{})};return [{...queueView(target),...(suggestion?.kind==='official_evidence'?{suggestion:original.reviewSuggestion??{verdict:suggestion.verdict??'judge',reason:suggestion.reason,by:'系统补证建议'}}:{}),restoration,identityTaskId:t.id,reviewVersion:`identity:${t.id}:${t.revision}`,pendingUpdate:!restoration&&original.reviewState==='approved',updateDiff:original.reviewState==='approved'?proposalComparison(original,JSON.parse(t.display_candidate_json)):[]}];});
  const legacyCards = [
      ...pending.filter(o=>!managed.has(o.id)).map(queueView),
      ...proposals.filter(p=>!managed.has(p.offerId)).flatMap(p => {
        const original = originals.find(o => o.id === p.offerId);
        if (!original) return [];
        const updateDiff = proposalComparison(original, p.candidate);
        if (!updateDiff.some(change => isReviewField(change.field))) return [];
        return [{ ...queueView(proposalOffer(original, p.candidate)), link:`https://ai-yangmao.com/#admin-offer-${encodeURIComponent(p.offerId)}`, reviewVersion: p.updatedAt, pendingUpdate: original.reviewState==='approved', changedFields: updateDiff.map(x => x.field), updateDiff }];
      }),
    ];
  const pendingCards=[...new Map(legacyCards.map(c=>[c.id,c])).values()];
  const leadTasks=(await canonicalLeadProjection(c.env.DB,await d.select().from(s.leads).where(eq(s.leads.status,'reviewing')))).filter(l=>!l.resolution?.identityTaskIds?.length).sort((a,b)=>Number(b.resolution?.status==='manual')-Number(a.resolution?.status==='manual')||leadPriority(a)-leadPriority(b)||b.id-a.id).map(leadTask); // 同组内新线索在前：只追最新福利（2026-10-16）
  const cards=[...pendingCards,...managedCards];
  // 已下架或已标历史的活动留在各自的审核决定里，不再作为队列里的「暂停发布」堆积。
  const counts={activities:pendingCards.length+identityTasks.length,leadReview:leadTasks.length,newLeads};
  return c.json({pending:cards,counts,managedTaskIds:managedCards.map(c=>c.identityTaskId),leadTasks,
    priorityLeads: (await d.select().from(s.leads).where(inArray(s.leads.status,['new','reviewing'])))
      .filter(l=>leadPriority(l)<=1).sort((a,b)=>leadPriority(a)-leadPriority(b)||b.id-a.id).slice(0,10)
      .map(l=>({ id:l.id,title:l.title,url:l.url,status:l.status,note:l.status==='reviewing'?l.raw?.split('[研判]').at(-1)?.slice(0,500):null })),
    newLeads, needsVerification: needsVerification.filter(o=>!cards.some(card=>card.id===o.id)).map(queueView), incomplete: incomplete.map(queueView), pendingPlatforms: pendingPlatforms.map(p => ({ id: p.id, name: p.name, type: p.type, site: p.site })),
    suggestAutoPublish: suggest.map(x => ({ id: x.id, platformId: x.platformId, url: x.url, cleanStreak: x.cleanStreak })),
  });
});

/** 人工确认停止领取：官方撤回，或管理员明确实测；记录确认时刻，不推断实际截止日。 */
admin.post('/offers/:ref/withdraw', async c => {
  const o = await findOffer(c.env, c.req.param('ref'));
  if (!o) return c.json({ error: '找不到这条羊毛' }, 404);
  const body = z.object({ reason: z.string().min(4).max(500), evidenceUrl: z.url().refine(url => /^https?:\/\//.test(url)), basis: z.enum(['official', 'tested']).default('official'),expectedReviewVersion:z.string().optional() })
    .safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: '需要证据入口链接和具体理由', issues: body.error.issues }, 400);
  if(await c.env.DB.prepare('SELECT id FROM benefit_entities WHERE canonical_offer_id=?').bind(o.id).first()){
    const version=c.req.header('If-Match')??body.data.expectedReviewVersion;if(!version)return c.json({error:'请携带当前活动版本 If-Match'},409);
    const reason=(body.data.basis==='tested'?'管理员实测停止领取：':'')+body.data.reason;
    const requestId=await sha256(stableJson({offerId:o.id,action:'withdraw',version,body:body.data,actor:c.get('who')}));
    return c.json({ok:true,status:'ended',...await new IdentityService(c.env.DB).setVisibility(o.id,{requestId,expectedOfferVersion:version,action:'withdraw',reason,evidenceUrl:body.data.evidenceUrl,basis:body.data.basis,actor:c.get('who')})});
  }
  const nowIso = new Date().toISOString();
  const previousEvidence = o.evidence;
  // 实测确认不能冒充官方撤回公告；原权益的官方历史证据及抓取日期保留。
  const tested = body.data.basis === 'tested';
  const reason = tested ? `管理员实测停止领取：${body.data.reason}` : body.data.reason;
  const evidence = tested ? previousEvidence : { ...previousEvidence, url: body.data.evidenceUrl, capturedAt: nowIso };
  const reviewMemo = tested ? `${o.reviewMemo ?? ''}\n\n${nowIso} ${reason}；实测入口：${body.data.evidenceUrl}。withdrawnAt仅为确认时刻，未修改未知claimEnd。`.trim() : o.reviewMemo;
  await db(c.env).update(s.offers).set({ withdrawnAt: nowIso, withdrawnReason: reason, evidence, reviewMemo, updatedAt: nowIso }).where(eq(s.offers.id, o.id));
  await db(c.env).insert(s.offerRevisions).values({ offerId: o.id, author: 'admin',
    diff: [{ field: 'withdrawnAt', from: o.withdrawnAt, to: nowIso }, { field: 'withdrawnReason', from: o.withdrawnReason, to: reason }],
    evidenceBefore: previousEvidence, evidenceAfter: evidence });
  await db(c.env).delete(s.offerProposals).where(eq(s.offerProposals.offerId, o.id));
  return c.json({ ok: true, code: shortCode(o.id), status: 'ended' });
});

admin.get('/offers/:ref', async c => {
  const o = await findOffer(c.env, c.req.param('ref'));
  if (!o) return c.json({ error: '找不到这条羊毛' }, 404);
  const names = await platformNames(c.env);
  const [proposal] = await db(c.env).select().from(s.offerProposals).where(eq(s.offerProposals.offerId, o.id));
  const revisions = await db(c.env).select().from(s.offerRevisions).where(sql`${s.offerRevisions.offerId}=${o.id} OR ${s.offerRevisions.offerId} IN (SELECT member.canonical_offer_id FROM benefit_entities member JOIN benefit_entities root ON root.id=member.merged_into WHERE root.canonical_offer_id=${o.id} AND member.state='merged')`).orderBy(desc(s.offerRevisions.at));
  let target = proposal ? proposalOffer(o, proposal.candidate) : o;
  const tasks=await c.env.DB.prepare("SELECT t.id,t.revision,t.suggestion_json,v.display_candidate_json FROM review_tasks t JOIN benefit_entities e ON e.id=t.entity_id LEFT JOIN benefit_versions v ON v.id=t.version_id AND v.entity_id=e.id WHERE e.canonical_offer_id=? AND t.state IN ('open','checking','manual') AND t.kind IN ('initial','terms_change','evidence_reopen') ORDER BY t.id LIMIT 2").bind(o.id).all<{id:string;revision:number;suggestion_json:string|null;display_candidate_json:string|null}>();
  const task=tasks.results.length===1?tasks.results[0]:null;
  if(task?.display_candidate_json){const suggestion=task.suggestion_json?JSON.parse(task.suggestion_json):null;target={...proposalOffer(o,JSON.parse(task.display_candidate_json)),...(suggestion?.kind==='official_evidence'?{verifyResult:null,reviewSuggestion:o.reviewSuggestion??{verdict:suggestion.verdict??'judge',reason:suggestion.reason,by:'系统补证建议'}}:{})};}
  const entity=await c.env.DB.prepare('SELECT id,business_revision FROM benefit_entities WHERE canonical_offer_id=?').bind(o.id).first<{id:string;business_revision:number}>();
  const hold=entity?visibilityView(await visibilityState(c.env.DB,entity.id)):null;
  return c.json({ offer: { visibilityHold:hold,...view(target, names[target.platformId] ?? target.platformId), visibilityVersion:entity?entityOfferVersion(entity,o.updatedAt):o.updatedAt,reviewVersion:task?`identity:${task.id}:${task.revision}`:entity?entityOfferVersion(entity,o.updatedAt):proposal?.updatedAt ?? o.updatedAt, ...(proposal ? {link:`https://ai-yangmao.com/#admin-offer-${encodeURIComponent(o.id)}`, pendingUpdate: true, updateDiff: proposalComparison(o, proposal.candidate)} : {}) }, pendingUpdate: !!proposal, revisions });
});

/** 审核：通过 / 拒绝。原样通过会给信源的"连续原样通过"加一；拒绝清零。 */
admin.post('/offers/:ref/:action{approve|reject}', async c => {
  const o = await findOffer(c.env, c.req.param('ref'));
  if (!o) return c.json({ error: '找不到这条羊毛' }, 404);
  const action = c.req.param('action') as 'approve' | 'reject';
  const body = await c.req.json().catch(() => ({})) as { reason?: string; reasonCode?: string; reasonCategory?: string; reviewer?: string; expectedReviewVersion?: string };
  const ownerLabel = action === 'reject' ? ownerRejectInput(body) : null;
  if (action === 'reject' && !ownerLabel) return c.json({ error: '请选择拒绝类别' }, 400);
  if (ownerLabel) body.reasonCode = ownerLabel.code;
  const entity=await c.env.DB.prepare('SELECT id FROM benefit_entities WHERE canonical_offer_id=?').bind(o.id).first<{id:string}>();
  if(entity){
    const transport=body as typeof body & {identityTaskId?:string;expectedIdentityRevision?:number;requestId?:string};
    const encoded=transport.expectedReviewVersion?.match(/^identity:([^:]+):(\d+)$/);
    const taskId=transport.identityTaskId??encoded?.[1],revision=transport.expectedIdentityRevision??(encoded?Number(encoded[2]):undefined);
    if(!taskId||revision===undefined)return c.json({error:'请刷新身份审核任务，提交其当前版本'},409);
    const belongs=await c.env.DB.prepare('SELECT id FROM review_tasks WHERE id=? AND entity_id=?').bind(taskId,entity.id).first();
    if(!belongs)return c.json({error:'审核任务不属于这条活动'},409);
    const requestId=transport.requestId??await sha256(stableJson({taskId,revision,action,actor:c.get('who'),reason:body.reason??null,reasonCode:body.reasonCode??'other'}));
    const receipt=await new IdentityService(c.env.DB).decideTask(taskId,{requestId,expectedRevision:revision,action,actor:c.get('who'),role:c.get('role'),reason:body.reason,reasonCode:body.reasonCode as never});
    if (ownerLabel) await recordOwnerLabel(c.env.DB, { subjectKind: 'offer', subjectId: o.id, category: ownerLabel.category, actor: c.get('who'), justification: body.reason });
    if(action==='approve')await learnWechatAccount(c.env.DB,o.platformId,o.evidence?.url);
    return c.json({ok:true,code:shortCode(o.id),reviewState:action==='approve'?'approved':'rejected',identityDecision:receipt});
  }
  const d = db(c.env);
  const [proposal] = await d.select().from(s.offerProposals).where(eq(s.offerProposals.offerId, o.id));
  if (body.expectedReviewVersion && body.expectedReviewVersion !== (proposal?.updatedAt ?? o.updatedAt)) return c.json({ error: '内容已更新，请刷新这条活动后再审核' }, 409);
  if (o.reviewState !== 'pending' && !proposal) return c.json({ error: '这条活动目前没有待审核内容' }, 409);
  if (action === 'approve') {
    const candidate = proposal ? proposalOffer(o, proposal.candidate) : o;
    const issue = await publicationError(c.env, candidate);
    if (issue) return c.json({ error: issue }, 400);
  }
  const membershipGuard=action==='approve'?membershipCatalogGuard((proposal?proposalOffer(o,proposal.candidate):o).membershipRequirement):undefined;
  const nowIso = new Date().toISOString();
  if (proposal && o.reviewState === 'approved') {
    if (action === 'approve') {
      const candidate = proposalOffer(o, proposal.candidate);
      const parsed = validateStoredOffer(candidate);
      if (!parsed.success) return c.json({ error: '提案字段不正确', issues: parsed.error.issues }, 400);
      const accepted = await d.update(s.offers).set({ ...parsed.data, lastVerifiedAt: nowIso, verifyResult: '审核员确认官方证据', updatedAt: nowIso }).where(and(eq(s.offers.id,o.id),eq(s.offers.updatedAt,o.updatedAt),sql`EXISTS (SELECT 1 FROM offer_proposals WHERE offer_id=${o.id} AND updated_at=${proposal.updatedAt})`,membershipGuard)).returning({id:s.offers.id});
      if (!accepted.length) return c.json({error:'条目或提案已更新，请刷新后重试'},409);
      await d.insert(s.offerRevisions).values({ offerId: o.id, diff: proposal.diff, evidenceBefore: o.evidence, evidenceAfter: candidate.evidence });
    }
    if (action === 'reject') {
      // D1 batch is transactional. A zero-row version guard must also make audit/delete no-ops.
      // A fresh decision key ties subsequent writes to THIS successful insertion, not an older rejection.
      const decisionKey = crypto.randomUUID();
      const rejected = await c.env.DB.batch<{ id: number | string }>([
        c.env.DB.prepare(`INSERT INTO rejected_offer_updates(offer_id,evidence,diff,at,decision_key)
          SELECT offer_id,?,diff,?,? FROM offer_proposals WHERE offer_id=? AND updated_at=?
          AND EXISTS(SELECT 1 FROM offers WHERE id=? AND updated_at=? AND review_state='approved')
          RETURNING id`)
          .bind(JSON.stringify(proposal.candidate.evidence ?? o.evidence),nowIso,decisionKey,o.id,proposal.updatedAt,o.id,o.updatedAt),
        c.env.DB.prepare(`INSERT INTO reviews(offer_id,action,reviewer,reason,reason_code,at)
          SELECT ?,'reject',?,?,?,? WHERE EXISTS(SELECT 1 FROM rejected_offer_updates WHERE decision_key=?) RETURNING id`)
          .bind(o.id,c.get('who'),body.reason ?? null,body.reasonCode ?? null,nowIso,decisionKey),
        c.env.DB.prepare(`DELETE FROM offer_proposals WHERE offer_id=? AND updated_at=?
          AND EXISTS(SELECT 1 FROM rejected_offer_updates WHERE decision_key=?) RETURNING offer_id AS id`)
          .bind(o.id,proposal.updatedAt,decisionKey),
      ]);
      if (!rejected[0].results.length || !rejected[2].results.length) return c.json({error:'条目或提案已更新，请刷新后重试'},409);
    } else {
      await d.delete(s.offerProposals).where(and(eq(s.offerProposals.offerId,o.id),eq(s.offerProposals.updatedAt,proposal.updatedAt)));
    }
  } else {
    const changed = await d.update(s.offers).set({ reviewState: action === 'approve' ? 'approved' : 'rejected', ...(action === 'approve' ? { lastVerifiedAt: nowIso, verifyResult: '审核员确认官方证据' } : {}), updatedAt: nowIso }).where(and(eq(s.offers.id, o.id), eq(s.offers.reviewState, 'pending'), eq(s.offers.updatedAt,o.updatedAt),membershipGuard)).returning({id:s.offers.id});
    if (!changed.length) return c.json({error:'这条活动已被更新或处理，请刷新后重试'},409);
  }
  // Proposal rejection already wrote its audit in the same transaction as memory and deletion.
  if (!(proposal && o.reviewState === 'approved' && action === 'reject')) {
    await d.insert(s.reviews).values({ offerId: o.id, action, reviewer: c.get('who'), reason: body.reason ?? null, reasonCode: body.reasonCode ?? null });
  }
  let streak: number | null = null;
  if (o.sourceId) {
    const [src] = await d.select().from(s.sources).where(eq(s.sources.id, o.sourceId));
    if (src) {
      streak = action === 'approve' ? src.cleanStreak + 1 : 0;
      await d.update(s.sources).set({ cleanStreak: streak }).where(eq(s.sources.id, src.id));
    }
  }
  const end = claimEndAt(proposal ? proposalOffer(o, proposal.candidate) : o);
  const urgent = action === 'approve' && !!end && end.getTime() - Date.now() <= 48 * 3600_000 && end.getTime() > Date.now();
  if (ownerLabel) await recordOwnerLabel(c.env.DB, { subjectKind: 'offer', subjectId: o.id, category: ownerLabel.category, actor: c.get('who'), justification: body.reason });
  if (action === 'approve') await learnWechatAccount(c.env.DB, o.platformId, o.evidence?.url);
  return c.json({ ok: true, code: shortCode(o.id), title: o.title, reviewState: action === 'approve' ? 'approved' : 'rejected', sourceCleanStreak: streak, urgent });
});

/** 补丁只允许编辑业务字段；补丁合并后仍由 offerIn 校验完整活动。 */
const EDITABLE_FIELDS = new Set(['title', 'type', 'valueText', 'usdEstimate', 'usdMax', 'valuation', 'models', 'tags', 'claimStart', 'claimEnd', 'endKind', 'creditValidity',
  'audience', 'requirements', 'membershipRequirement', 'modalities', 'platformId', 'sourceTz', 'claimMethod', 'steps', 'evidence', 'publishedAt', 'sourceId']);
/** 旧提案可能含整行快照；只覆盖业务字段，审核建议、核验记录及当前状态始终读原条目。 */
function proposalOffer(original: OfferRow, candidate: Record<string, unknown>): OfferRow {
  return { ...original, ...Object.fromEntries(Object.entries(candidate).filter(([field]) => EDITABLE_FIELDS.has(field))) } as OfferRow;
}
/** Compare against the current public row, even if a legacy proposal has an empty or stale stored diff. */
function proposalComparison(original: OfferRow, candidate: Record<string, unknown>) {
  const parsed = validateStoredOffer(proposalOffer(original, candidate));
  const normalized = parsed.success ? { ...candidate, ...parsed.data } : candidate;
  return Object.entries(normalized)
    .filter(([field, value]) => EDITABLE_FIELDS.has(field) && JSON.stringify((original as Record<string, unknown>)[field] ?? null) !== JSON.stringify(value ?? null))
    .map(([field, value]) => ({ field, from: (original as Record<string, unknown>)[field] ?? null, to: value ?? null }));
}
admin.post('/offers/:ref/edit', async c => {
  const o = await findOffer(c.env, c.req.param('ref'));
  if (!o) return c.json({ error: '找不到这条羊毛' }, 404);
  const body = await c.req.json().catch(() => null) as { fields?: Record<string, unknown>; approve?: boolean; reason?: string; reasonCode?: string; expectedReviewVersion?: string } | null;
  if(c.get('role')!=='admin'&&(body?.fields?.evidence as {tier?:string}|undefined)?.tier==='tested')return c.json({error:'管理员亲测需要管理员确认'},403);
  const identity=await c.env.DB.prepare('SELECT id FROM benefit_entities WHERE canonical_offer_id=?').bind(o.id).first();
  if(identity){
    if(body?.approve)return c.json({error:'请先保存身份草稿，再按其当前版本批准'},409);
    const transport=body as typeof body & {requestId?:string;identityTaskId?:string;expectedIdentityRevision?:number;identityFacts?:unknown};
    const encoded=transport?.expectedReviewVersion?.match(/^identity:([^:]+):(\d+)$/);
    const requestId=transport?.requestId??await sha256(stableJson({offerId:o.id,...body,actor:c.get('who')}));
    const result=await new IdentityService(c.env.DB).editManagedOffer(o.id,{requestId,taskId:transport?.identityTaskId??encoded?.[1],expectedTaskRevision:transport?.expectedIdentityRevision??(encoded?Number(encoded[2]):undefined),expectedOfferVersion:body?.expectedReviewVersion,fields:body?.fields??{},actor:c.get('who'),...(transport?.identityFacts?{identityFacts:transport.identityFacts as never}:{})});
    return c.json({ok:true,approved:false,code:shortCode(o.id),title:o.title,changed:Object.keys(body?.fields??{}),...result,reviewVersion:result.taskId?`identity:${result.taskId}:${result.revision}`:undefined});
  }
  if(body?.fields){
    const proposal=await c.env.DB.prepare('SELECT candidate FROM offer_proposals WHERE offer_id=?').bind(o.id).first<{candidate:string}>();
    const base=proposal?proposalOffer(o,JSON.parse(proposal.candidate)):o;
    try{body.fields=await prepareMembershipFields(c.env.DB,base,body.fields);}catch(e){return c.json({error:e instanceof Error?e.message:'会员资格不正确'},e instanceof MembershipError?e.status:400);}
  }
  const patch = z.record(z.string(), z.unknown()).safeParse(body?.fields);
  if (!patch.success || Object.keys(patch.data).some(key => !EDITABLE_FIELDS.has(key))) return c.json({ error: '包含不可编辑的字段' }, 400);
  const d = db(c.env), nowIso = new Date().toISOString();
  const [proposal] = await d.select().from(s.offerProposals).where(eq(s.offerProposals.offerId, o.id));
  if (body?.expectedReviewVersion && body.expectedReviewVersion !== (proposal?.updatedAt ?? o.updatedAt)) return c.json({ error: '内容已更新，请刷新这条活动后再审核' }, 409);
  const base = proposal ? proposalOffer(o, proposal.candidate) : o;
  const candidate = { ...base, ...patch.data } as OfferRow;
  const membershipGuard=(Object.hasOwn(patch.data,'membershipRequirement')||body?.approve)?membershipCatalogGuard(candidate.membershipRequirement):undefined;
  const valid = validateStoredOffer(candidate);
  if (!valid.success) return c.json({ error: '活动字段不正确', issues: valid.error.issues }, 400);
  const diff = Object.keys(patch.data)
    .filter(key => JSON.stringify((base as Record<string, unknown>)[key] ?? null) !== JSON.stringify((candidate as Record<string, unknown>)[key] ?? null))
    .map(field => ({ field, from: (base as Record<string, unknown>)[field], to: (candidate as Record<string, unknown>)[field] }));
  if (!diff.length && !body?.approve) return c.json({ error: '没有要改的字段' }, 400);
  if (!diff.length && body?.approve && o.reviewState !== 'pending' && !proposal) return c.json({ error: '这条活动没有待审核内容' }, 409);
  // Eligibility changes on legacy published rows also require a separately reviewed proposal.
  if(!proposal&&o.reviewState==='approved'&&!body?.approve&&diff.some(d=>d.field==='membershipRequirement')){
    const selected=candidate.membershipRequirement;
    const inserted=await c.env.DB.prepare(`INSERT INTO offer_proposals(offer_id,candidate,diff,manual_fields,detected_at,updated_at)
      SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM offers WHERE id=? AND updated_at=? AND review_state='approved')
      AND (? IS NULL OR EXISTS(SELECT 1 FROM membership_catalog WHERE id=1 AND revision=?))
      ON CONFLICT(offer_id) DO NOTHING RETURNING offer_id`).bind(o.id,JSON.stringify(candidate),JSON.stringify(diff),JSON.stringify(diff.map(d=>d.field)),nowIso,nowIso,o.id,o.updatedAt,selected?.catalogRevision??null,selected?.catalogRevision??null).all();
    if(!inserted.results.length)return c.json({error:'条目或会员目录已更新，请刷新后重试'},409);
    await d.insert(s.reviews).values({offerId:o.id,action:'edit',editedFields:diff.map(x=>x.field),reviewer:c.get('who'),reason:body?.reason??'会员资格已保存为待审更新',reasonCode:'wrong_field'});
    return c.json({ok:true,code:shortCode(o.id),changed:diff.map(x=>x.field),approved:false,pendingUpdate:true,reviewVersion:nowIso});
  }
  if (body?.approve || (!proposal && o.reviewState === 'approved')) {
    const issue = await publicationError(c.env, candidate,{preserveExistingMembership:!body?.approve&&!proposal&&o.reviewState==='approved'&&diff.every(d=>!['requirements','membershipRequirement'].includes(d.field))});
    if (issue) return c.json({ error: issue }, 400);
  }

  if (proposal) {
    const manualFields = [...new Set([...proposal.manualFields, ...diff.map(x => x.field)])];
    const proposedDiff = [...new Set([...Object.keys(proposal.candidate), ...Object.keys(patch.data)])]
      .filter(field => JSON.stringify((o as Record<string, unknown>)[field] ?? null) !== JSON.stringify((candidate as Record<string, unknown>)[field] ?? null))
      .map(field => ({ field, from: (o as Record<string, unknown>)[field], to: (candidate as Record<string, unknown>)[field] }));
    if (body?.approve) {
      const accepted = await d.update(s.offers).set({ ...valid.data, lastVerifiedAt: nowIso, verifyResult: '审核员确认官方证据', updatedAt: nowIso }).where(and(eq(s.offers.id,o.id),eq(s.offers.updatedAt,o.updatedAt),sql`EXISTS (SELECT 1 FROM offer_proposals WHERE offer_id=${o.id} AND updated_at=${proposal.updatedAt})`,membershipGuard)).returning({id:s.offers.id});
      if (!accepted.length) return c.json({error:'条目或提案已更新，请刷新后重试'},409);
      const pipelineDiff = proposedDiff.filter(x => !manualFields.includes(x.field));
      const manualDiff = proposedDiff.filter(x => manualFields.includes(x.field));
      if (pipelineDiff.length) await d.insert(s.offerRevisions).values({ offerId: o.id, diff: pipelineDiff, evidenceBefore: o.evidence, evidenceAfter: candidate.evidence });
      if (manualDiff.length) await d.insert(s.offerRevisions).values({ offerId: o.id, diff: manualDiff, author: 'admin', evidenceBefore: o.evidence, evidenceAfter: candidate.evidence });
      await d.delete(s.offerProposals).where(and(eq(s.offerProposals.offerId,o.id),eq(s.offerProposals.updatedAt,proposal.updatedAt)));
    } else {
      const changed = await d.update(s.offerProposals).set({ candidate, diff: proposedDiff, manualFields, updatedAt: nowIso }).where(and(eq(s.offerProposals.offerId,o.id),eq(s.offerProposals.updatedAt,proposal.updatedAt),membershipGuard)).returning({id:s.offerProposals.offerId});
      if (!changed.length) return c.json({error:'提案已更新，请刷新后重试'},409);
    }
  } else {
    const changed = await d.update(s.offers).set({ ...valid.data, ...(body?.approve ? { reviewState: 'approved' as const, lastVerifiedAt: nowIso, verifyResult: '审核员确认官方证据' } : {}), updatedAt: nowIso }).where(and(eq(s.offers.id, o.id),eq(s.offers.updatedAt,o.updatedAt),membershipGuard)).returning({id:s.offers.id});
    if (!changed.length) return c.json({error:'这条活动已更新，请刷新后重试'},409);
    if (diff.length) await d.insert(s.offerRevisions).values({ offerId: o.id, diff, author: 'admin', evidenceBefore: o.evidence, evidenceAfter: candidate.evidence });
  }
  await d.insert(s.reviews).values({ offerId: o.id, action: 'edit', editedFields: diff.map(x => x.field), reviewer: c.get('who'), reason: body?.reason ?? null, reasonCode: body?.reasonCode ?? 'wrong_field' });
  if (o.sourceId && diff.length) await d.update(s.sources).set({ cleanStreak: 0 }).where(eq(s.sources.id, o.sourceId));
  return c.json({ ok: true, code: shortCode(o.id), changed: diff.map(x => x.field), approved: !!body?.approve });
});

/** 管理员复测仍有效：更新最近核验时间（管理员实测的条目没有可自动复核的页面，靠这个保持有效）。 */
admin.post('/offers/:ref/retested', async c => {
  const o = await findOffer(c.env, c.req.param('ref'));
  if (!o) return c.json({ error: '找不到这条羊毛' }, 404);
  const at = new Date().toISOString();
  await db(c.env).update(s.offers).set({ lastVerifiedAt: at, verifyResult: '管理员复测仍有效', updatedAt: at }).where(eq(s.offers.id, o.id));
  return c.json({ ok: true, code: shortCode(o.id), lastVerifiedAt: at, status: liveStatus({ ...o, lastVerifiedAt: at, verifyResult: '管理员复测仍有效' }) });
});

/** 内部核验记录：只给管理员看，不公开、不触发审核。 */
admin.post('/offers/:ref/memo', async c => {
  const o = await findOffer(c.env, c.req.param('ref'));
  if (!o) return c.json({ error: '找不到这条羊毛' }, 404);
  const body = z.object({ memo: z.string().max(4000) }).safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: '核验记录最多 4000 字' }, 400);
  const memo = body.data.memo.trim() || null;
  await db(c.env).update(s.offers).set({ reviewMemo: memo }).where(eq(s.offers.id, o.id));
  return c.json({ ok: true, code: shortCode(o.id), reviewMemo: memo });
});

/** 下架：把已上架但不该收的条目撤下（按新标准不收、错收等），不同于“官方撤回”（withdraw，算活动结束、进墓场）。只给管理员。 */
admin.post('/offers/:ref/reopen-visibility',async c=>{
 const o=await findOffer(c.env,c.req.param('ref'));if(!o)return c.json({error:'找不到这条羊毛'},404);
 const body=z.object({expectedReviewVersion:z.string().min(1),reason:z.string().min(8).max(2000),requestId:z.string().min(1).max(180).optional()}).safeParse(await c.req.json().catch(()=>null));if(!body.success)return c.json({error:'需要当前上下架版本和明确重开依据'},400);
 const requestId=body.data.requestId??await sha256(stableJson({offerId:o.id,...body.data,actor:c.get('who')}));return c.json({ok:true,...await new IdentityService(c.env.DB).reopenVisibility(o.id,{requestId,expectedOfferVersion:body.data.expectedReviewVersion,reason:body.data.reason,actor:c.get('who')})});
});
admin.post('/offers/:ref/unpublish', async c => {
  const o = await findOffer(c.env, c.req.param('ref'));
  if (!o) return c.json({ error: '找不到这条羊毛' }, 404);
  const body = z.object({ reasonCategory: z.string().max(40).optional(), reasonCode: z.string().max(40).default('other'), reason: z.string().min(2).max(500),expectedReviewVersion:z.string().optional() }).safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: '请写明下架理由' }, 400);
  const ownerLabel = ownerRejectInput(body.data);
  if (ownerLabel) body.data.reasonCode = ownerLabel.code;
  if(await c.env.DB.prepare('SELECT id FROM benefit_entities WHERE canonical_offer_id=?').bind(o.id).first()){
    const version=c.req.header('If-Match')??body.data.expectedReviewVersion;if(!version)return c.json({error:'请携带当前活动版本 If-Match'},409);
    const requestId=await sha256(stableJson({offerId:o.id,action:'unpublish',version,body:body.data,actor:c.get('who')}));
    return c.json({ok:true,title:o.title,code:shortCode(o.id),...await new IdentityService(c.env.DB).setVisibility(o.id,{requestId,expectedOfferVersion:version,action:'unpublish',reason:body.data.reason,reasonCode:body.data.reasonCode,actor:c.get('who')})});
  }
  if (o.reviewState !== 'approved') return c.json({ error: '这条目前没有上架' }, 409);
  const d = db(c.env);
  await d.delete(s.offerProposals).where(eq(s.offerProposals.offerId, o.id));
  await d.update(s.offers).set({ reviewState: 'rejected', updatedAt: new Date().toISOString() }).where(eq(s.offers.id, o.id));
  await d.insert(s.reviews).values({ offerId: o.id, action: 'reject', reviewer: c.get('who'), reason: `下架：${body.data.reason}`, reasonCode: body.data.reasonCode });
  if (ownerLabel) await recordOwnerLabel(c.env.DB, { subjectKind: 'offer', subjectId: o.id, category: ownerLabel.category, actor: c.get('who'), justification: body.data.reason });
  return c.json({ ok: true, code: shortCode(o.id), title: o.title, reviewState: 'rejected' });
});

/** 审核建议：给审批卡片标“建议通过 / 作为历史 / 建议拒绝 / 需要你判断”和理由；不改条款、不改审核状态。 */
admin.post('/offers/:ref/suggest', async c => {
  const o = await findOffer(c.env, c.req.param('ref'));
  if (!o) return c.json({ error: '找不到这条羊毛' }, 404);
  const body = z.object({ verdict: z.enum(['approve', 'history', 'reject', 'judge']).nullable(), code: z.string().max(40).nullish(), reason: z.string().max(500).default('') })
    .safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: '建议格式不正确', issues: body.error.issues }, 400);
  const suggestion = body.data.verdict ? { verdict: body.data.verdict, code: body.data.code ?? null, reason: body.data.reason.trim(), by: c.get('who'), at: new Date().toISOString() } : null;
  await db(c.env).update(s.offers).set({ reviewSuggestion: suggestion }).where(eq(s.offers.id, o.id));
  return c.json({ ok: true, code: shortCode(o.id), suggestion });
});

/** 明确重试官方检索：仅操作复核队列，不修改业务字段或审批结果。 */
admin.post('/offers/:ref/official-retry',async c=>{
  const o=await findOffer(c.env,c.req.param('ref'));if(!o)return c.json({error:'找不到条目'},404);
  const [proposal]=await db(c.env).select().from(s.offerProposals).where(eq(s.offerProposals.offerId,o.id));
  let target=proposal?proposalOffer(o,proposal.candidate):o;
  const drafts=(await c.env.DB.prepare("SELECT v.display_candidate_json,t.suggestion_json FROM review_tasks t JOIN benefit_entities e ON e.id=t.entity_id JOIN benefit_versions v ON v.id=t.version_id AND v.entity_id=e.id WHERE e.canonical_offer_id=? AND e.state='active' AND t.kind='initial' AND t.state IN ('open','manual') LIMIT 2").bind(o.id).all<{display_candidate_json:string;suggestion_json:string|null}>()).results;
  if(drafts.length===1){const suggestion=drafts[0].suggestion_json?JSON.parse(drafts[0].suggestion_json):null;target={...proposalOffer(o,JSON.parse(drafts[0].display_candidate_json)),...(suggestion?.kind==='official_evidence'?{verifyResult:null}:{})};}
  if(o.withdrawnAt||!needsEvidence(target)||(o.reviewState!=='pending'&&!proposal))return c.json({error:'当前条目无需补证，或已暂停发布'},409);
  if(o.officialReview?.status==='checking'&&Date.now()-Date.parse(o.officialReview.checkedAt)<20*60_000)return c.json({error:'官方复核正在进行，请稍后查看'},409);
  await db(c.env).update(s.offers).set({officialReview:null}).where(eq(s.offers.id,o.id));
  return c.json({ok:true});
});

/** 管理员使用心得：不改条款、不影响审核状态，写了立即公开；空字符串表示删除。 */
admin.post('/offers/:ref/note', async c => {
  const o = await findOffer(c.env, c.req.param('ref'));
  if (!o) return c.json({ error: '找不到这条羊毛' }, 404);
  const body = z.object({ note: z.string().max(500) }).safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: '心得最多 500 字' }, 400);
  const note = body.data.note.trim() || null;
  const updatedAt = new Date().toISOString();
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE offers SET admin_note=?,updated_at=? WHERE id=?').bind(note, updatedAt, o.id),
    legacyNoteStatement(c.env.DB, o.id, note, updatedAt),
  ]);
  return c.json({ ok: true, code: shortCode(o.id), adminNote: note, reviewVersion: updatedAt });
});

admin.get('/leads', async c => {
  const params = z.object({limit:z.coerce.number().int().min(1).max(100).default(30),
    before:z.coerce.number().int().positive().optional(), status:z.enum(['all','new','reviewing','linked','rejected']).default('all')})
    .safeParse(c.req.query());
  if (!params.success) return c.json({error:'线索分页参数不正确'},400);
  const {limit,before,status}=params.data, d=db(c.env);
  const state = status==='all' ? inArray(s.leads.status,['new','reviewing']) : eq(s.leads.status,status);
  const [{total}] = await d.select({total:sql<number>`count(*)`}).from(s.leads).where(state);
  const rows=await d.select().from(s.leads).where(and(state,before ? lt(s.leads.id,before):undefined)).orderBy(desc(s.leads.id)).limit(limit+1);
  const page=await canonicalLeadProjection(c.env.DB,rows.slice(0,limit));
  return c.json({total,nextCursor:rows.length>limit ? page.at(-1)!.id:null,leads:page.map(l=>({...leadTask(l),origin:l.origin,
    note:l.resolution?.reason??(l.status==='reviewing'?l.raw?.split('[研判]').at(-1)?.slice(0,500):null),createdAt:l.createdAt}))});
});

admin.post('/leads/:id/resolve',async c=>{
  const body=z.object({expectedVersion:z.string(),outcome:z.enum(['linked','closed','retry']),offerId:z.string().optional(),reason:z.string().min(2).max(1000)}).safeParse(await c.req.json().catch(()=>null));
  if(!body.success)return c.json({error:'请填写处理依据并使用当前线索版本'},400);
  const d=db(c.env),[l]=await d.select().from(s.leads).where(eq(s.leads.id,Number(c.req.param('id'))));
  if(!l||!['new','reviewing'].includes(l.status)||leadReviewVersion(l)!==body.data.expectedVersion)return c.json({error:'线索状态已更新，请刷新'},409);
  if(l.resolution?.identityTaskIds?.length)return c.json({error:'请逐项处理身份审核任务，不能用整条线索覆盖候选决定'},409);
  const b=body.data;
  // 关联目标可以粘贴条目网址、4 位短码或完整 ID（2026-10-15 管理员粘贴条目链接被拒）。
  if(b.offerId){
    const ref=offerRefFromInput(b.offerId),[exact]=await d.select({id:s.offers.id}).from(s.offers).where(eq(s.offers.id,ref));
    let id=exact?.id;
    if(!id){const matches=(await d.select({id:s.offers.id}).from(s.offers)).filter(o=>shortCode(o.id)===ref.toLowerCase());if(matches.length>1)throw new AmbiguousShortCode(matches.map(o=>o.id));id=matches[0]?.id;}
    if(!id)return c.json({error:'找不到这个条目：请粘贴条目网址、4 位短码或完整 ID'},400);
    b.offerId=id;
  }
  const originOfferId=b.offerId;
  if(b.offerId)b.offerId=(await resolveCanonicalOffer(c.env.DB,b.offerId)).offerId;
  if(b.outcome==='linked'&&(!b.offerId||!(await d.select().from(s.offers).where(eq(s.offers.id,b.offerId))).length))return c.json({error:'请填写要关联的条目：网址、4 位短码或完整 ID'},400);
  const resolution:LeadResolution={status:b.outcome==='retry'?'retry':b.outcome,jobId:crypto.randomUUID(),attempts:0,inconclusive:0,checkedAt:new Date().toISOString(),nextAttemptAt:b.outcome==='retry'?new Date().toISOString():null,reason:b.reason,queries:l.resolution?.queries??[],candidates:l.resolution?.candidates??[],evidenceUrl:l.resolution?.evidenceUrl,quote:l.resolution?.quote,offerIds:b.offerId?[b.offerId]:(l.resolution?.offerIds??[]),originOfferIds:originOfferId?[originOfferId]:(l.resolution?.originOfferIds??l.resolution?.offerIds??[])};
  if(c.env.IDENTITY_MODE==='enforce'&&b.outcome==='closed'){await closeIdentityLead(c.env.DB,l,resolution,l.raw??l.title??resolution.reason??'管理员关闭线索',{actor:c.get('who')});return c.json({ok:true,identityHandled:true});}
  const changed=await d.update(s.leads).set({status:b.outcome==='linked'?'linked':b.outcome==='closed'?'rejected':'reviewing',resolution,offerId:b.offerId??l.offerId})
    .where(and(eq(s.leads.id,l.id),eq(s.leads.status,l.status),sql`COALESCE(${s.leads.resolution},'')=COALESCE(${l.resolution?JSON.stringify(l.resolution):null},'')`)).returning({id:s.leads.id});
  const linked=b.outcome==='linked'&&b.offerId?(await d.select({id:s.offers.id,title:s.offers.title}).from(s.offers).where(eq(s.offers.id,b.offerId)))[0]:undefined;
  return changed.length?c.json({ok:true,...(linked?{offer:{id:linked.id,code:shortCode(linked.id),title:linked.title}}:{})}):c.json({error:'线索已更新，请刷新'},409);
});
admin.post('/leads/:id/:action{dismiss|reviewing|retry}', async c => {
  const action=c.req.param('action'),d=db(c.env),[l]=await d.select().from(s.leads).where(eq(s.leads.id,Number(c.req.param('id'))));
  if(!l)return c.json({error:'没有这条线索'},404);
  const body=await c.req.json().catch(()=>({}));
  if(!['new','reviewing'].includes(l.status)||body.expectedVersion!==leadReviewVersion(l))return c.json({error:'线索版本已变化或缺少版本，请刷新后处理'},409);
  if(l.resolution?.identityTaskIds?.length)return c.json({error:'请使用身份任务或拒绝决定的显式重开接口'},409);
  const resolution:LeadResolution={status:action==='dismiss'?'closed':'retry',jobId:crypto.randomUUID(),attempts:0,inconclusive:0,checkedAt:new Date().toISOString(),nextAttemptAt:action==='dismiss'?null:new Date().toISOString(),reason:String(body.reason??(action==='dismiss'?'管理员忽略线索':ADMIN_RETRY_REASON)).slice(0,1000),queries:[],candidates:[]};
  if(action==='dismiss'){
    const ownerLabel=ownerRejectInput(body as {reasonCategory?:unknown;reasonCode?:unknown});
    if(!ownerLabel)return c.json({error:'请选择拒绝类别'},400);
    await recordOwnerLabel(c.env.DB,{subjectKind:'lead',subjectId:String(l.id),category:ownerLabel.category,actor:c.get('who'),justification:resolution.reason});
    if(c.env.IDENTITY_MODE==='enforce'){
      await closeIdentityLead(c.env.DB,l,resolution,l.raw??l.title??resolution.reason??'管理员关闭线索',{actor:c.get('who'),reasonCode:ownerLabel.code});
      return c.json({ok:true,identityHandled:true});
    }
  }
  const changed=await d.update(s.leads).set({status:action==='dismiss'?'rejected':'reviewing',resolution}).where(and(eq(s.leads.id,l.id),eq(s.leads.status,l.status),sql`COALESCE(${s.leads.resolution},'')=COALESCE(${l.resolution?JSON.stringify(l.resolution):null},'')`)).returning({id:s.leads.id});
  return changed.length?c.json({ok:true}):c.json({error:'线索已更新，请刷新'},409);
});

admin.post('/platforms', async c => {
  const body = z.object({ id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,60}$/), name: z.string().min(2).max(100),
    type: z.enum(['lab', 'cloud', 'infra', 'tool', 'new']), site: z.url().refine(url => /^https?:\/\//.test(url)) }).safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: '平台资料不正确', issues: body.error.issues }, 400);
  const [created] = await db(c.env).insert(s.platforms).values({ ...body.data, status: 'pending' }).onConflictDoNothing().returning({ id: s.platforms.id });
  if (!created) return c.json({ error: '该平台 ID 已存在' }, 409);
  return c.json({ id: created.id, status: 'pending' }, 201);
});

/** 补录：记为线索，下一轮采集会抓取这个链接并抽取（进待审）。 */
admin.post('/manual', async c => {
  const body = z.object({ url: z.url(), note: z.string().max(500).optional(), platformId: z.string().optional() }).safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: '链接不正确', issues: body.error.issues }, 400);
  const raw = JSON.stringify({ note: body.data.note ?? null, platformId: body.data.platformId ?? null });
  const res = await db(c.env).insert(s.leads).values({ origin: 'telegram', url: body.data.url, title: body.data.note ?? '补录链接', raw })
    .onConflictDoUpdate({ target: s.leads.url, set: { raw: sql`COALESCE(${s.leads.raw}, '') || '\n[补充链接备注] ' || ${raw}` } }).returning({ id: s.leads.id });
  return c.json({ ok: true, leadId: res[0]?.id });
});

admin.post('/platforms/:id/:action{approve|reject}', async c => {
  await db(c.env).update(s.platforms).set({ status: c.req.param('action') === 'approve' ? 'approved' : 'rejected', updatedAt: new Date().toISOString() }).where(eq(s.platforms.id, c.req.param('id')));
  return c.json({ ok: true });
});

admin.post('/sources/:id/auto-publish', async c => {
  const { on } = await c.req.json().catch(() => ({ on: true })) as { on: boolean };
  const [source] = await db(c.env).select().from(s.sources).where(eq(s.sources.id, c.req.param('id')));
  if (!source) return c.json({ error: '没有这个信源' }, 404);
  if (on) {
    const [platform] = source.platformId ? await db(c.env).select().from(s.platforms).where(eq(s.platforms.id, source.platformId)) : [];
    const aiHotResetPolicy=source.id===AIHOT_RESET_SOURCE&&source.kind==='aihot'&&source.url===AIHOT_RESET_URL&&source.enabled;
    if (!aiHotResetPolicy && (!source.enabled || source.cleanStreak < 5 || !['site', 'docs', 'official'].includes(source.tier) || platform?.status !== 'approved'))
      return c.json({ error: '信源尚未满足五条原样通过、平台准入和官方等级门槛' }, 400);
  }
  await db(c.env).update(s.sources).set({ autoPublish: !!on }).where(eq(s.sources.id, c.req.param('id')));
  return c.json({ ok: true, autoPublish: !!on });
});

type NoticeKind = 'digest' | 'urgent';
const TOP = { standing: 5, rising: 3, lastcall: 3 }; // 飞书日报三个榜各推几条
export const IDENTITY_BACKLOG_MAX = 20, IDENTITY_BACKLOG_MAX_HOURS = 48; // 查重卡积压提醒阈值

/**
 * 飞书日报「今日专题」（2026-10-16）：原常驻榜每天取同样的前 5 条常驻额度，内容天天一样。改为按日轮换类型；
 * 当天可领不足 3 条的专题跳过；同一专题再次轮到时从下一批条目开始，避免重复。榜单键仍为 standing。
 */
type ThemeOffer = { type: string; audience: string; requirements: string[]; modalities: string[] };
export const DAILY_THEMES: { key: string; title: string; short: string; match: (o: ThemeOffer) => boolean }[] = [
  { key: 'newuser', title: '🎁 今日专题 · 新人注册礼', short: '新人礼', match: o => o.type === 'new' },
  { key: 'member', title: '👑 今日专题 · 会员与老用户福利', short: '会员福利', match: o => o.type === 'perk' || o.type === 'gift' || o.audience === 'old' },
  { key: 'standing', title: '🏆 今日专题 · 常驻额度（一直能薅）', short: '常驻额度', match: o => o.type === 'standing' },
  { key: 'limited', title: '⏳ 今日专题 · 限时免费开放', short: '限时免费', match: o => o.type === 'free' || o.type === 'trial' },
  { key: 'student', title: '🎓 今日专题 · 学生与教师专享', short: '学生专享', match: o => o.requirements.includes('student') },
  { key: 'media', title: '🎨 今日专题 · 图像、视频与语音', short: '多模态', match: o => o.modalities.some(m => m !== 'text') },
  { key: 'nobarrier', title: '🆓 今日专题 · 零门槛直接领', short: '零门槛', match: o => o.requirements.length === 1 && o.requirements[0] === 'none' },
  { key: 'apply', title: '📝 今日专题 · 申请制资助', short: '申请制', match: o => o.type === 'apply' },
];
const THEME_MIN = 3;
/** Pick the day's theme and its window of items; `pool` is already sorted best-first. */
export function dailyTheme<T extends { o: ThemeOffer }>(pool: T[], now: Date, size: number): { theme: (typeof DAILY_THEMES)[number]; items: T[] } {
  const day = Math.floor(Date.parse(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now) + 'T00:00:00Z') / 86400_000);
  // Rotate over the themes that have enough claimable perks today, so a thin theme never makes its neighbour repeat.
  const viable = DAILY_THEMES.map(theme => ({ theme, list: pool.filter(x => theme.match(x.o)) })).filter(t => t.list.length >= THEME_MIN);
  if (viable.length) {
    const { theme, list } = viable[day % viable.length];
    const start = (Math.floor(day / viable.length) * size) % list.length; // the theme's next turn shows the next batch
    return { theme, items: [...list.slice(start), ...list.slice(0, start)].slice(0, size) };
  }
  const fallback = DAILY_THEMES.find(t => t.key === 'standing')!;
  return { theme: fallback, items: pool.filter(x => fallback.match(x.o)).slice(0, size) };
}
type NoticeChannel = 'telegram' | 'feishu';
type NoticeStage = 'new' | 'changed' | 'ending' | 'ended' | 'urgent';
type NoticeMark = { offerId: string; stage: NoticeStage; messageId?: string;eventId?:string;eventKey?:string;entityId?:string;versionId?:string|null;publicationRevision?:number;generation?:number };
const FIELD_NAME: Record<string, string> = { title: '标题', type: '类型', modalities: '模态', claimMethod: '领取方式', requirements: '门槛', audience: '适用对象', valueText: '额度', usdEstimate: '价值估算', usdMax: '价值上限', models: '免费模型', tags: '标签', publishedAt: '发布时间', claimStart: '领取开始', claimEnd: '领取截止', endKind: '截止方式', creditValidity: '额度有效期', sourceTz: '官方时区', steps: '领取步骤', evidence: '官方证据' };
const showValue = (value: unknown) => value == null ? '未写明' : Array.isArray(value) ? value.join('、') : typeof value === 'object' ? '已更新' : String(value);

export async function buildNotice(env: Env, kind: NoticeKind, channel: NoticeChannel, now = new Date()) {
  const d = db(env), names = await platformNames(env);
  const approvedPlatforms = new Set((await d.select({ id: s.platforms.id }).from(s.platforms).where(eq(s.platforms.status, 'approved'))).map(p => p.id));
  const approved = (await d.select().from(s.offers).where(and(eq(s.offers.reviewState, 'approved'),canonicalOffers))).filter(o => approvedPlatforms.has(o.platformId));
  const inherited=await notificationInheritance(env.DB,approved.map(o=>o.id),channel);
  const inFlight = (await d.select({ payload: s.deliveries.payload, channel: s.deliveries.channel, status: s.deliveries.status }).from(s.deliveries).where(and(eq(s.deliveries.channel,channel),inArray(s.deliveries.status, ['pending', 'unknown']))));
  const blockedItems = new Set(inFlight.flatMap(delivery => Object.values((delivery.payload as {items?:Record<string,{id:string}[]>}).items ?? {}).flat().map(item=>item.id)));
  for(const id of inherited.blocked)blockedItems.add(id);
  const identities=await noticeIdentities(env.DB,approved.map(o=>o.id)),identityEvents=await pendingIdentityNotices(env.DB,channel,approved.filter(o=>isClaimable(liveStatus(o,now))&&!blockedItems.has(o.id)).map(o=>o.id),[...inherited.sent.entries()].filter(([,stages])=>stages.has('new')||stages.has('urgent')).map(([id])=>id),[...inherited.sent.entries()].filter(([,stages])=>stages.has('changed')).map(([id])=>id));
  const sent = await d.select().from(s.notifications).where(eq(s.notifications.channel, channel));
  const has = (id: string, stage: string) => sent.find(n => n.offerId === id && n.stage === stage)??(inherited.sent.get(id)?.has(stage)?{sentAt:null,messageId:null}:undefined);
  const out: Record<string, (ReturnType<typeof view> & { score?: number })[]> = { new: [], changed: [], ending: [], ended: [], urgent: [], standing: [], rising: [], lastcall: [] };
  let marks: NoticeMark[] = [];
  const revs = approved.length ? await d.select().from(s.offerRevisions).where(and(inArray(s.offerRevisions.offerId, d.select({ id: s.offers.id }).from(s.offers).where(eq(s.offers.reviewState, 'approved'))), eq(s.offerRevisions.author, 'pipeline'))) : [];
  for (const o of approved) {
    const st = liveStatus(o, now), v = view(o, names[o.platformId] ?? o.platformId, now), end = claimEndAt(o);
    if (kind === 'urgent') {
      // 快速上架的权益等次日飞书日报，不走即时推送
      if (st === 'ending' && end && end > now && end.getTime() - now.getTime() <= 48 * 3600_000 && !has(o.id, 'urgent') && !has(o.id, 'new') && !fastTrackHeld(o.fastTrackedAt, now)) { out.urgent.push(v); marks.push({ offerId: o.id, stage: 'urgent' }); }
      continue;
    }
    if(identities.has(o.id)&&channel==='telegram'){
      const event=identityEvents.find(e=>e.entity_id===identities.get(o.id)!.id);
      if(event&&!inherited.sent.get(o.id)?.has(event.kind)&&isClaimable(st)&&(event.kind==='changed'||(!has(o.id,'new')&&!has(o.id,'urgent')))){out[event.kind].push(v);marks.push({offerId:o.id,stage:event.kind,eventId:event.id,eventKey:event.event_key});}
      if(st==='ending'&&!has(o.id,'ending')&&!has(o.id,'urgent')){out.ending.push(v);marks.push({offerId:o.id,stage:'ending'});}
      if(st==='ended'&&!has(o.id,'ended')&&(has(o.id,'new')||has(o.id,'urgent'))){out.ended.push(v);marks.push({offerId:o.id,stage:'ended'});}
      continue;
    }
    if (!has(o.id, 'new') && !has(o.id, 'urgent') && isClaimable(st)) {
      out.new.push(v); marks.push({ offerId: o.id, stage: 'new' });
      // 新上架时已经临期的，这次就算"临期"也通知过了，避免同一天再以"3 天内结束"重复推送
      if (st === 'ending' && !has(o.id, 'ending')) marks.push({ offerId: o.id, stage: 'ending' });
      continue;
    }
    const lastRev = revs.filter(r => r.offerId === o.id).sort((a, b) => b.id - a.id)[0];
    const ch = has(o.id, 'changed');
    const firstAnnouncedAt = has(o.id, 'new')?.sentAt ?? has(o.id, 'urgent')?.sentAt;
    if (lastRev && firstAnnouncedAt && Date.parse(lastRev.at) > Date.parse(firstAnnouncedAt) && (!ch || Number(ch.messageId ?? 0) < lastRev.id)) {
      out.changed.push({ ...v, value: lastRev.diff.map(x => `${FIELD_NAME[x.field] ?? x.field}：${showValue(x.from)} → ${showValue(x.to)}`).join('；') });
      marks.push({ offerId: o.id, stage: 'changed', messageId: String(lastRev.id) });
    }
    if (st === 'ending' && !has(o.id, 'ending') && !has(o.id, 'urgent')) { out.ending.push(v); marks.push({ offerId: o.id, stage: 'ending' }); }
    // 只通知推送过“上架”的条目；作为历史数据补录的已结束活动不推送
    if (st === 'ended' && !has(o.id, 'ended') && (has(o.id, 'new') || has(o.id, 'urgent')) && (!end || now.getTime() - end.getTime() < 7 * 86400_000)) { out.ended.push(v); marks.push({ offerId: o.id, stage: 'ended' }); }
  }
  const key = (mark: NoticeMark) => `${mark.offerId}\u0000${mark.stage}\u0000${mark.messageId ?? ''}`;
  const blocked = new Set(inFlight.flatMap(delivery => ((delivery.payload as { marks?: NoticeMark[] }).marks ?? []).map(key)));
  marks = marks.filter(mark => !blocked.has(key(mark)) && !blockedItems.has(mark.offerId)).sort((a, b) => key(a).localeCompare(key(b)));
  for (const stage of Object.keys(out) as NoticeStage[]) out[stage] = out[stage].filter(item => marks.some(mark => mark.offerId === item.id && mark.stage === stage));
  // 飞书日报：三个榜，都按薅度分排。
  //   今日专题（原常驻榜）：按日轮换类型（新人礼、会员福利、常驻额度、限时免费…），每个专题取 5 条（每天都排，不记推送）
  //   新星榜：最近 14 天新上架、还没推送过的取前 3（没选上的之后还有机会）
  //   末班车榜：3 天内结束的限时活动取前 3
  // 条款变化和已结束不进飞书日报（Telegram 照旧）。
  let moreCount = 0, theme: { key: string; title: string; short: string } | null = null;
  if (kind === 'digest' && String(channel).startsWith('feishu')) {
    const scored = approved.filter(o=>!blockedItems.has(o.id)).map(o => ({ o, st: liveStatus(o, now), score: haoScore(o, now) })).sort((a, b) => b.score - a.score);
    const item = (x: typeof scored[number]) => ({ ...view(x.o, names[x.o.platformId] ?? x.o.platformId, now), score: x.score });
    const used = new Set<string>();
    const pick = (list: typeof scored, n: number) => { const got = list.filter(x => !used.has(x.o.id)).slice(0, n); got.forEach(x => used.add(x.o.id)); return got; };
    const today = dailyTheme(scored.filter(x => isClaimable(x.st)), now, TOP.standing);
    theme = { key: today.theme.key, title: today.theme.title, short: today.theme.short };
    const standing = pick(today.items, TOP.standing);
    const freshPool = scored.filter(x => isClaimable(x.st) && !has(x.o.id, 'new') && !has(x.o.id, 'urgent') && now.getTime() - Date.parse(x.o.discoveredAt) <= 14 * 86400_000);
    const rising = pick(freshPool, TOP.rising);
    const lastcall = pick(scored.filter(x => x.st === 'ending' && !has(x.o.id, 'ending') && !has(x.o.id, 'urgent')), TOP.lastcall);
    moreCount = freshPool.filter(x => !used.has(x.o.id)).length;
    for (const k of Object.keys(out)) out[k] = [];
    out.standing = standing.map(item); out.rising = rising.map(item); out.lastcall = lastcall.map(item);
    marks = [
      ...[...standing, ...rising].filter(x => !has(x.o.id, 'new') && !has(x.o.id, 'urgent')).map(x => ({ offerId: x.o.id, stage: 'new' as const })),
      ...[...rising, ...lastcall].filter(x => x.st === 'ending' && !has(x.o.id, 'ending')).map(x => ({ offerId: x.o.id, stage: 'ending' as const })),
    ].filter(mark => !blocked.has(key(mark)));
  }
  const pendingOffers = (await d.select({ n: sql<number>`count(*)` }).from(s.offers).where(and(eq(s.offers.reviewState, 'pending'),sql`NOT EXISTS(SELECT 1 FROM benefit_entities e WHERE e.canonical_offer_id=offers.id)`)))[0].n;
  const pendingProposals = (await d.select({ diff: s.offerProposals.diff }).from(s.offerProposals).where(sql`NOT EXISTS(SELECT 1 FROM benefit_entities e WHERE e.canonical_offer_id=offer_proposals.offer_id)`))
    .filter(proposal => proposal.diff.some(change => isReviewField(change.field))).length;
  let pendingCount = pendingOffers + pendingProposals;
  let needsVerificationCount = 0; // 自动核验故障由健康监控处理，不要求管理员每天确认。
  let suggestAutoPublish = kind === 'digest' && channel === 'telegram'
    ? (await d.select().from(s.sources).where(and(gte(s.sources.cleanStreak, 5), eq(s.sources.autoPublish, false))))
      .filter(source => source.enabled && ['site', 'docs', 'official'].includes(source.tier) && !!source.platformId && approvedPlatforms.has(source.platformId)).map(x => x.id) : [];
  if (kind === 'digest' && channel === 'telegram') {
    const tokyoDay = (date: Date) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
    const sentToday = (await d.select({ payload: s.deliveries.payload, createdAt: s.deliveries.createdAt }).from(s.deliveries)
      .where(and(eq(s.deliveries.kind, 'digest'), eq(s.deliveries.channel, 'telegram'), eq(s.deliveries.status, 'sent')))
      .orderBy(desc(s.deliveries.createdAt)).limit(40)).filter(delivery => tokyoDay(new Date(delivery.createdAt)) === tokyoDay(now));
    const summaries = sentToday.map(delivery => delivery.payload as { pendingCount?: number; needsVerificationCount?: number; suggestAutoPublish?: string[] });
    if (pendingCount <= Math.max(0, ...summaries.map(summary => summary.pendingCount ?? 0))) pendingCount = 0;
    if (needsVerificationCount <= Math.max(0, ...summaries.map(summary => summary.needsVerificationCount ?? 0))) needsVerificationCount = 0;
    const alreadySuggested = new Set(summaries.flatMap(summary => summary.suggestAutoPublish ?? []));
    suggestAutoPublish = suggestAutoPublish.filter(id => !alreadySuggested.has(id));
  }
  const [lastCollect] = kind === 'digest' && channel === 'telegram'
    ? await d.select({ stats: s.runs.stats }).from(s.runs).where(eq(s.runs.kind, 'collect')).orderBy(desc(s.runs.startedAt)).limit(1) : [];
  const coverageDegraded = !!lastCollect?.stats?.coverageDegraded || (Array.isArray(lastCollect?.stats?.errors) && lastCollect.stats.errors.length > 0);
  // D1 读取超过免费额度 70%：推给 Telegram（每小时检查，UTC 同一天只推一次）
  let d1Alert: { rowsRead: number; limit: number } | null = null;
  if (channel === 'telegram') {
    const u = await d1Usage(env);
    if (u.rowsRead != null && u.rowsRead > u.limits.rowsRead * 0.7) {
      const today = now.toISOString().slice(0, 10);
      const sentToday = (await d.select({ payload: s.deliveries.payload, createdAt: s.deliveries.createdAt }).from(s.deliveries)
        .where(and(eq(s.deliveries.channel, 'telegram'), inArray(s.deliveries.status, ['sent', 'pending', 'unknown']))).orderBy(desc(s.deliveries.createdAt)).limit(60))
        .filter(x => x.createdAt.slice(0, 10) === today && (x.payload as { d1Alert?: unknown }).d1Alert);
      if (!sentToday.length) d1Alert = { rowsRead: u.rowsRead, limit: u.limits.rowsRead };
    }
  }
  // 审核提醒按对象身份去重，不能用“待审总数没增加”吞掉替换进来的新条目。
  type ReviewAlert = { key: string; title: string; state: string; url: string; priority?: number;eventId?:string;taskId?:string;materialRevision?:number };
  let reviewAlerts: ReviewAlert[] = [];
  let leadBacklog = 0;
  if (channel === 'telegram') {
    const receipts = await d.select({ payload: s.deliveries.payload }).from(s.deliveries)
      .where(and(eq(s.deliveries.channel, 'telegram'), inArray(s.deliveries.status, ['sent', 'pending', 'unknown'])));
    const announced = new Set(receipts.flatMap(r => ((r.payload as { reviewAlerts?: ReviewAlert[] }).reviewAlerts ?? []).map(a=>a.key)));
    const awaiting = await d.select().from(s.offers).where(and(eq(s.offers.reviewState, 'pending'),sql`NOT EXISTS(SELECT 1 FROM benefit_entities e WHERE e.canonical_offer_id=offers.id)`)).orderBy(s.offers.discoveredAt);
    const reviewRank = (o: OfferRow) => {
      const end = claimEndAt(o);
      if (end && end > now && end.getTime()-now.getTime() <= 48*3600_000) return 0;
      return leadPriority({id:0,origin:'aihot',title:o.title,raw:o.valueText}) <= 1 ? 1 : 2;
    };
    awaiting.sort((a,b)=>reviewRank(a)-reviewRank(b));
    const proposals = await d.select().from(s.offerProposals).where(sql`NOT EXISTS(SELECT 1 FROM benefit_entities e WHERE e.canonical_offer_id=offer_proposals.offer_id)`);
    const unresolved = await d.select().from(s.leads).where(inArray(s.leads.status,['new','reviewing']));
    leadBacklog = unresolved.length;
    // Identity backlog (2026-10-16): warn on day one of a pile-up, not at 90 open cards. Once a day at most.
    const identityBacklog = await env.DB.prepare("SELECT count(*) n, min(created_at) oldest FROM review_tasks WHERE state IN ('open','checking','manual')").first<{ n: number; oldest: string | null }>();
    const oldestHours = identityBacklog?.oldest ? Math.floor((now.getTime() - Date.parse(identityBacklog.oldest)) / 3600_000) : 0;
    const backlogAlert: ReviewAlert[] = identityBacklog && (identityBacklog.n > IDENTITY_BACKLOG_MAX || oldestHours > IDENTITY_BACKLOG_MAX_HOURS)
      ? [{ key: `backlog:identity:${now.toISOString().slice(0, 10)}`, priority: 0, title: `🚨 查重积压：${identityBacklog.n} 张卡待处理，最久已等 ${oldestHours} 小时`, state: '积压提醒：先处理有截止日期的卡', url: 'https://ai-yangmao.com/#admin' }] : [];
    reviewAlerts = [
      ...backlogAlert,
      ...await identityReviewAlerts(env.DB,[...announced,...inherited.announcedReviewKeys]),
      ...awaiting.map(o=>({ key: o.officialReview && (o.officialReview.status === 'matched' || (o.officialReview.status!=='checking'&&!o.officialReview.nextAttemptAt)) ? `offer:${o.id}:official:${o.officialReview.jobId}` : `offer:${o.id}`, priority: reviewRank(o), title: `[${shortCode(o.id)}] ${o.title}`, state: o.officialReview?.status==='unresolved'&&!o.officialReview.nextAttemptAt?'官方复核待人工核对':'待审', url: `https://ai-yangmao.com/#admin-offer-${encodeURIComponent(o.id)}` })),
      ...proposals.filter(p=>p.diff.some(x=>isReviewField(x.field))).map(p=>({ key: `proposal:${p.offerId}:${JSON.stringify(p.diff)}`, priority: 2, title: String(p.candidate.title ?? p.offerId), state: '条款更新待审', url: `https://ai-yangmao.com/#admin-offer-${encodeURIComponent(p.offerId)}` })),
      ...unresolved.filter(l=>!l.resolution?.identityTaskIds?.length&&(leadPriority(l)<=1||l.resolution?.status==='manual')).sort((a,b)=>leadPriority(a)-leadPriority(b)||b.id-a.id).map(l=>({ key: `lead:${l.id}:${l.resolution?.status==='manual'?'manual:'+l.resolution.jobId:l.status}`, priority: wechatHandoff(l) ? 0 : 1, title: `#${l.id} ${l.title ?? ''}`, state: wechatHandoff(l) ? '⚡ 公众号福利：点开一键快速上架' : l.status==='reviewing' ? (l.resolution?.status==='manual'?'线索待你判断':'线索正在自动复核') : '重要线索，尚未研判', url: 'https://ai-yangmao.com/#admin' })),
    ].filter(a=>!announced.has(a.key));
    // 重要线索先提醒，余下待审分批发完；单条失败不堵住其他审核提醒。
    reviewAlerts.sort((a,b)=>(a.priority ?? 2)-(b.priority ?? 2));
    const alertPool = reviewAlerts;
    const primary = reviewAlerts.slice(0,8);
    const selected = new Set(primary.map(a=>a.key));
    const backlog = reviewAlerts.filter(a=>!selected.has(a.key) && !a.key.startsWith('lead:')).slice(0,2);
    reviewAlerts = [...primary,...backlog];
    const chosen = new Set(reviewAlerts.map(a=>a.key));
    reviewAlerts.push(...alertPool.filter(a=>!chosen.has(a.key)).slice(0,10-reviewAlerts.length));
  }
  marks=marks.map(mark=>{const e=identities.get(mark.offerId);return e?{...mark,...identityGuard(e),eventKey:mark.eventKey??`offer:${e.id}:${e.publication_revision}:${mark.stage}:${channel}`}:mark;});
  const itemIds=new Set(Object.values(out).flat().map(o=>o.id));const identityGuards=[...identities.values()].filter(e=>itemIds.has(e.canonical_offer_id)).map(identityGuard);
  const empty = !reviewAlerts.length && !d1Alert && !marks.length && !out.standing.length && !out.rising.length && !out.lastcall.length && (kind === 'urgent' || channel !== 'telegram' || (!pendingCount && !suggestAutoPublish.length && !needsVerificationCount && !coverageDegraded));
  return { kind, channel, identityGuards, items: out, marks, moreCount, theme, d1Alert, pendingCount, reviewAlerts, leadBacklog, suggestAutoPublish, needsVerificationCount, coverageDegraded, empty, blockedCount: blocked.size+inherited.blocked.size,identityDeliveryConflicts:inherited.conflicts };
}

const wechatHandoff=(l:{resolution?:{status?:string;reason?:string}|null})=>l.resolution?.status==='manual'&&!!l.resolution.reason?.startsWith(WECHAT_FAST_TRACK_REASON);
/** 预览是纯读取，不能仅凭获取消息就把内容记为已发送。 */
admin.get('/notify', async c => {
  const channel = c.req.query('channel') === 'feishu' ? 'feishu' : 'telegram';
  const kind = c.req.query('kind') === 'urgent' ? 'urgent' : 'digest';
  return c.json(await buildNotice(c.env, kind, channel));
});

/** 原子占位避免并发重复；失败或结果不明时不会自动重发。Telegram（经 Hermes）与飞书（Worker 定时任务）共用。 */
export type ClaimedNotice = Awaited<ReturnType<typeof buildNotice>> & { deliveryId?: string; alreadyClaimed?: boolean; staleContent?:boolean; editionChanged?:boolean };
export async function claimNotice(env: Env, kind: NoticeKind, channel: NoticeChannel, frozen?: Awaited<ReturnType<typeof buildNotice>>): Promise<ClaimedNotice> {
  const notice = frozen ?? await buildNotice(env, kind, channel);
  if (notice.empty) return { ...notice, alreadyClaimed: notice.blockedCount > 0 };
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const content = JSON.stringify({ kind: notice.kind, channel: notice.channel,
    ...(frozen?{digestDay:(frozen as {digestDay?:string}).digestDay,digestRevision:(frozen as {digestRevision?:number}).digestRevision}:{}),
    marks: notice.marks, reviewKeys: notice.reviewAlerts.map(a=>a.key),
    ...(!notice.marks.length && !notice.reviewAlerts.length ? { day, pendingCount: notice.pendingCount,
      suggestAutoPublish: notice.suggestAutoPublish, needsVerificationCount: notice.needsVerificationCount, coverageDegraded: notice.coverageDegraded } : {}) });
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content));
  const fingerprint = [...new Uint8Array(hash)].map(x => x.toString(16).padStart(2, '0')).join('');
  const id = crypto.randomUUID();
  const editionGuard=frozen?"(json_extract(?5,'$.digestRevision') IS NULL OR EXISTS(SELECT 1 FROM daily_digest WHERE id=1 AND day=json_extract(?5,'$.digestDay') AND json_extract(payload,'$.public.revision')=json_extract(?5,'$.digestRevision')))":'1';
  const created = await env.DB.prepare(`
    INSERT INTO deliveries(id,fingerprint,channel,kind,payload)
    SELECT ?1,?2,?3,?4,?5 WHERE ${deliveryIdentityGuard} AND ${editionGuard} AND NOT EXISTS (
      SELECT 1 FROM deliveries prior WHERE prior.channel=?3 AND prior.status IN ('pending','unknown') AND (
        EXISTS (SELECT 1 FROM json_tree(prior.payload,'$.items') old_item, json_tree(?5,'$.items') new_item
          WHERE old_item.key='id' AND new_item.key='id' AND coalesce((SELECT root.canonical_offer_id FROM benefit_entities old JOIN benefit_entities root ON root.id=old.merged_into WHERE old.canonical_offer_id=old_item.value AND old.state='merged'),old_item.value)=new_item.value)
        OR EXISTS (SELECT 1 FROM json_each(prior.payload,'$.marks') old_mark,json_tree(?5,'$.items') new_item WHERE new_item.key='id' AND coalesce((SELECT root.canonical_offer_id FROM benefit_entities old JOIN benefit_entities root ON root.id=old.merged_into WHERE old.canonical_offer_id=json_extract(old_mark.value,'$.offerId') AND old.state='merged'),json_extract(old_mark.value,'$.offerId'))=new_item.value)
        OR EXISTS (SELECT 1 FROM json_each(prior.payload,'$.reviewAlerts') old_alert, json_each(?5,'$.reviewAlerts') new_alert
          WHERE (json_extract(old_alert.value,'$.key')=json_extract(new_alert.value,'$.key') OR EXISTS(SELECT 1 FROM merge_task_sources m WHERE m.status='active' AND m.source_task_id=json_extract(old_alert.value,'$.taskId') AND m.canonical_task_id=json_extract(new_alert.value,'$.taskId')) OR ${reviewAlertOverlap('old_alert.value',"json_extract(new_alert.value,'$.taskId')")}))
      )) ON CONFLICT(fingerprint) DO NOTHING RETURNING id`)
    .bind(id,fingerprint,channel,kind,JSON.stringify(notice)).all<{id:string}>();
  if(created.results.length)return {...notice,deliveryId:id};
  if(frozen){const edition=await env.DB.prepare(`SELECT (${editionGuard.replaceAll('?5','?1')}) AS valid`).bind(JSON.stringify(notice)).first<{valid:number}>();if(!edition?.valid)return {...notice,empty:true,editionChanged:true};}
  if(frozen){const validity=await env.DB.prepare(`SELECT (${deliveryIdentityGuard.replaceAll('?5','?1')}) AS valid`).bind(JSON.stringify(notice)).first<{valid:number}>();
    if(!validity?.valid)return {...notice,empty:true,staleContent:true};}
  return { ...notice, empty: true, alreadyClaimed: true };
}
admin.post('/notify/claim', async c => {
  const parsed = z.object({ kind: z.enum(['digest', 'urgent']), channel: z.enum(['telegram', 'feishu']) }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: '发送参数不正确' }, 400);
  return c.json(await claimNotice(c.env, parsed.data.kind, parsed.data.channel));
});

async function recordDeliveryResult(env:Env,delivery:typeof s.deliveries.$inferSelect,status:'sent'|'unknown',error?:string,manual=false) {
 const notice=delivery.payload as unknown as Awaited<ReturnType<typeof buildNotice>>,now=new Date().toISOString();
 const eligible=manual?"status IN ('pending','unknown')":"status='pending'";
 const gate=`EXISTS(SELECT 1 FROM deliveries WHERE id=? AND ${eligible})`,statements:D1PreparedStatement[]=[];
 if(status==='sent'){
  for(const mark of notice.marks??[])statements.push(env.DB.prepare(`INSERT INTO notifications(offer_id,stage,channel,status,sent_at,message_id) SELECT ?,?,?,'sent',?,? WHERE ${gate} ON CONFLICT(offer_id,stage,channel) DO UPDATE SET status='sent',sent_at=excluded.sent_at,message_id=excluded.message_id`).bind(mark.offerId,mark.stage,delivery.channel,now,mark.messageId??null,delivery.id));
  const ids=[...(notice.marks??[]).flatMap(m=>m.eventId?[m.eventId]:[]),...(notice.reviewAlerts??[]).flatMap(a=>a.eventId?[a.eventId]:[])];
  if(ids.length)statements.push(env.DB.prepare(`UPDATE identity_events SET status='delivered' WHERE id IN (SELECT value FROM json_each(?)) AND ${gate}`).bind(JSON.stringify(ids),delivery.id));
 }
 statements.push(env.DB.prepare(`UPDATE deliveries SET status=?,error=?,updated_at=? WHERE id=? AND ${eligible}`).bind(status,error??null,now,delivery.id));
 await env.DB.batch(statements);
}
/** Unknown delivery stays blocked until an explicit administrator resolution. */
export async function ackDelivery(env: Env, id: string, status: 'sent' | 'unknown', error?: string): Promise<{ ok: boolean; code?: number; error?: string; alreadyAcknowledged?: boolean; status?: string }> {
 const [delivery]=await db(env).select().from(s.deliveries).where(eq(s.deliveries.id,id));
 if(!delivery)return {ok:false,code:404,error:'没有这次发送'};
 if(delivery.status==='sent')return {ok:true,alreadyAcknowledged:true};
 if(delivery.status==='unknown'&&status==='unknown')return {ok:true,alreadyAcknowledged:true,status:'unknown'};
 if(delivery.status!=='pending')return {ok:false,code:409,error:'结果不明或已释放的消息需要先人工核对'};
 await recordDeliveryResult(env,delivery,status,error);
 const current=await env.DB.prepare('SELECT status FROM deliveries WHERE id=?').bind(id).first<{status:string}>();
 return current?.status===status?{ok:true,status}:{ok:false,code:409,error:'发送状态已改变'};
}
admin.post('/notify/:id/ack', async c => {
  const body = z.object({ status: z.enum(['sent', 'unknown']), error: z.string().max(500).optional() }).safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: '发送结果不正确' }, 400);
  const r = await ackDelivery(c.env, c.req.param('id'), body.data.status, body.data.error);
  return r.ok ? c.json(r) : c.json({ error: r.error }, (r.code ?? 400) as 404 | 409);
});

/** 结果不明的通知必须由管理员核对收件端后才能结案或释放重发。 */
admin.post('/notify/:id/resolve', async c => {
  const body = z.object({ outcome: z.enum(['delivered', 'not_delivered']), reason: z.string().min(4).max(500) })
    .safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: '需要人工核对结论及理由' }, 400);
  const d = db(c.env);
  const [delivery] = await d.select().from(s.deliveries).where(eq(s.deliveries.id, c.req.param('id')));
  if (!delivery || !['unknown', 'pending'].includes(delivery.status)) return c.json({ error: '没有需要核对的发送记录' }, 404);
  if (delivery.status === 'pending' && Date.now() - Date.parse(delivery.createdAt) < 10 * 60_000) return c.json({ error: '发送仍可能进行中，十分钟后再人工核对' }, 409);
  if (body.data.outcome === 'delivered') {
    await recordDeliveryResult(c.env,delivery,'sent',`人工确认已送达：${body.data.reason}`,true);
  } else {
    await d.update(s.deliveries).set({ status: 'released', fingerprint: `${delivery.fingerprint}:released:${delivery.id}`, error: `人工确认未送达：${body.data.reason}`, updatedAt: new Date().toISOString() }).where(eq(s.deliveries.id, delivery.id));
  }
  return c.json({ ok: true, outcome: body.data.outcome });
});

/** 抽取准确率：每个字段被人工修改的比例、拒绝理由分布、各信源原样通过率。 */
admin.get('/quality', async c => {
  const since = new Date(Date.now() - Number(c.req.query('days') ?? 30) * 86400_000).toISOString();
  const rv = await c.env.DB.prepare(`SELECT r.action, r.edited_fields, r.reason_code, o.source_id, o.first_channel FROM reviews r JOIN offers o ON o.id = r.offer_id WHERE r.at >= ?1 AND COALESCE(r.reviewer,'') <> 'system'`).bind(since).all<{ action: string; edited_fields: string; reason_code: string | null; source_id: string | null; first_channel: string | null }>();
  const rows = rv.results;
  const reviewed = rows.length;
  const fields: Record<string, number> = {}, reasons: Record<string, number> = {}, bySource: Record<string, { total: number; clean: number }> = {};
  for (const r of rows) {
    if (r.action === 'edit') for (const f of JSON.parse(r.edited_fields || '[]') as string[]) fields[f] = (fields[f] ?? 0) + 1;
    if (r.reason_code) reasons[r.reason_code] = (reasons[r.reason_code] ?? 0) + 1;
    const k = r.source_id ?? `线索:${r.first_channel ?? '?'}`;
    const b = (bySource[k] ??= { total: 0, clean: 0 }); b.total++; if (r.action === 'approve') b.clean++;
  }
  return c.json({ reviewed, approvedClean: rows.filter(r => r.action === 'approve').length, edits: rows.filter(r => r.action === 'edit').length, rejects: rows.filter(r => r.action === 'reject').length, fields, reasons, bySource });
});

/** 健康检查：最近一次成功采集距今多久、连续失败的信源、预算。 */
/** 今天（UTC）整个账号的 D1 读写行数；D1 免费版每天读 500 万行、写 10 万行，超了全站查询都会失败。需要 CF_ANALYTICS_TOKEN（账户分析只读）。 */
export const D1_LIMITS = { rowsRead: 5_000_000, rowsWritten: 100_000 };
async function d1Usage(env: Env): Promise<{ configured: boolean; rowsRead?: number; rowsWritten?: number; limits: typeof D1_LIMITS; error?: string }> {
  if (!env.CF_ANALYTICS_TOKEN) return { configured: false, limits: D1_LIMITS };
  const day = new Date().toISOString().slice(0, 10);
  try {
    const r = await fetch('https://api.cloudflare.com/client/v4/graphql', { method: 'POST', headers: { Authorization: `Bearer ${env.CF_ANALYTICS_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'query($a:String!,$d:Date!){viewer{accounts(filter:{accountTag:$a}){d1AnalyticsAdaptiveGroups(limit:10000,filter:{date_geq:$d,date_leq:$d}){sum{rowsRead rowsWritten}}}}}', variables: { a: env.CF_ACCOUNT_ID ?? '25c6294320af71adb8ec4b3a90427ce9', d: day } }) });
    const j = await r.json() as { data?: { viewer: { accounts: { d1AnalyticsAdaptiveGroups: { sum: { rowsRead: number; rowsWritten: number } }[] }[] } }; errors?: { message: string }[] };
    if (!j.data) return { configured: true, limits: D1_LIMITS, error: j.errors?.[0]?.message ?? `HTTP ${r.status}` };
    const groups = j.data.viewer.accounts[0]?.d1AnalyticsAdaptiveGroups ?? [];
    return { configured: true, limits: D1_LIMITS, rowsRead: groups.reduce((a, g) => a + g.sum.rowsRead, 0), rowsWritten: groups.reduce((a, g) => a + g.sum.rowsWritten, 0) };
  } catch (e) { return { configured: true, limits: D1_LIMITS, error: String(e) }; }
}

admin.get('/health', async c => {
  const d = db(c.env);
  const [lastOk] = await d.select().from(s.runs).where(and(eq(s.runs.kind, 'collect'), eq(s.runs.ok, true))).orderBy(desc(s.runs.finishedAt)).limit(1);
  const [lastAttempt] = await d.select().from(s.runs).where(eq(s.runs.kind, 'collect')).orderBy(desc(s.runs.startedAt)).limit(1);
  const allSources = await d.select({ id: s.sources.id, failStreak: s.sources.failStreak, lastError: s.sources.lastError, lastOkAt: s.sources.lastOkAt,
    kind: s.sources.kind, url: s.sources.url, autoPublish: s.sources.autoPublish, cleanStreak: s.sources.cleanStreak, enabled: s.sources.enabled, createdAt: s.sources.createdAt }).from(s.sources);
  const failing = allSources.filter(source => source.enabled && sourceUnhealthy(source)).map(source => ({ ...source, reason: sourceHealthReason(source) }));
  const hours = lastOk?.finishedAt ? (Date.now() - Date.parse(lastOk.finishedAt)) / 3600_000 : null;
  const today = new Date().toISOString().slice(0, 10);
  const b = await c.env.DB.prepare("SELECT COALESCE(SUM(CASE WHEN substr(started_at,1,10)=?1 THEN tokens END),0) AS t, COALESCE(SUM(CASE WHEN substr(started_at,1,7)=?2 THEN cost_cny END),0) AS c FROM runs").bind(today, today.slice(0, 7)).first<{ t: number; c: number }>();
  const uncertainDeliveries = await d.select({ id: s.deliveries.id, kind: s.deliveries.kind, channel: s.deliveries.channel, status: s.deliveries.status, createdAt: s.deliveries.createdAt, error: s.deliveries.error })
    .from(s.deliveries).where(inArray(s.deliveries.status, ['unknown', 'pending']));
  const needsVerification = (await d.select().from(s.offers).where(eq(s.offers.reviewState, 'approved')))
    .filter(offer => liveStatus(offer) === 'stale').map(offer => ({ id: offer.id, title: offer.title, evidenceUrl: offer.evidence.url }));
  const dispatchFailures = (await c.env.DB.prepare("SELECT started_at AS at, stats FROM runs WHERE kind='collect' AND ok=0 AND started_at >= ?1 ORDER BY started_at DESC LIMIT 5")
    .bind(new Date(Date.now() - 48 * 3600_000).toISOString()).all<{ at: string; stats: string }>()).results
    .map(r => ({ at: r.at, ...(JSON.parse(r.stats || '{}') as { stage?: string; error?: string }) })).filter(r => r.stage === 'dispatch');
  const [lastLeadRun] = await d.select().from(s.runs).where(eq(s.runs.kind,'sweep')).orderBy(desc(s.runs.startedAt)).limit(1);
  const backlog = await d.select().from(s.leads).where(inArray(s.leads.status,['new','reviewing']));
  const important = backlog.filter(l=>leadPriority(l)<=1);
  const leadWorkflow = { rescueQueued:backlog.filter(l=>leadReviewDue(l)).length, rescueChecking:backlog.filter(l=>l.resolution?.status==='checking').length, rescueManual:backlog.filter(l=>l.resolution?.status==='manual').length, rescueRetrying:backlog.filter(l=>l.resolution?.status==='retry'&&!leadReviewDue(l)).length, new: backlog.filter(l=>l.status==='new').length, reviewing: backlog.filter(l=>l.status==='reviewing').length,
    important: important.length, oldestImportantNewAt: important.filter(l=>l.status==='new').map(l=>l.createdAt).sort()[0] ?? null, oldestAt: backlog.map(l=>l.createdAt).sort()[0] ?? null,
    lastRun: lastLeadRun ? { startedAt:lastLeadRun.startedAt,finishedAt:lastLeadRun.finishedAt,ok:lastLeadRun.ok,stats:lastLeadRun.stats } : null };
  const officialReviewRows = await d.select().from(s.offers).where(inArray(s.offers.reviewState,['pending','approved']));
  const officialProposals=new Map((await d.select().from(s.offerProposals)).map(p=>[p.offerId,p]));
  const officialReviewCounts = {checking:0,matched:0,unresolved:0,failed:0,waiting:0,retrying:0,exhausted:0,stalled:0};
  for(const row of officialReviewRows){
    const r=row.officialReview,p=officialProposals.get(row.id),target=p?proposalOffer(row,p.candidate):row;
    if(r)officialReviewCounts[r.status]++;
    if(r?.status==='checking'&&Date.now()-Date.parse(r.checkedAt)>=20*60_000)officialReviewCounts.stalled++;
    if((row.reviewState==='pending'||p)&&target.evidence.tier==='media'){
      if(officialReviewDue(r,Date.now(),`${row.updatedAt}|${p?.updatedAt??''}`))officialReviewCounts.waiting++;
      else if(r?.nextAttemptAt)officialReviewCounts.retrying++;
      else if(r&&r.status!=='checking')officialReviewCounts.exhausted++;
    }
  }
  return c.json({ officialReviewCounts, leadWorkflow, tokensToday: b?.t ?? 0, tokenCap: Number(c.env.DAILY_TOKEN_CAP ?? 0), costMonthCny: b?.c ?? 0, coverageDegraded: !!lastAttempt?.stats?.coverageDegraded || (Array.isArray(lastAttempt?.stats?.errors) && lastAttempt.stats.errors.length > 0), lastCollectAttempt: lastAttempt ? {startedAt:lastAttempt.startedAt,ok:lastAttempt.ok,stats:lastAttempt.stats}:null, sources: allSources, lastSuccessfulCollect: lastOk?.finishedAt ?? null,
    hoursSince: hours, collectStale: hours === null || hours > 8, failingSources: failing, uncertainDeliveries, needsVerification, dispatchFailures, d1Usage: await d1Usage(c.env) });
});

export const offerIsClaimable = (o: OfferRow) => isClaimable(liveStatus(o));
