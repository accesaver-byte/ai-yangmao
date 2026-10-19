import { z } from 'zod';
import {fastTrackCatalogBlock,type CatalogBlock} from '../shared/fast-track-membership';
import {semanticReviewSchema,semanticReviewIssues,type SemanticReview} from '../shared/fast-track-semantics';
import type { Env } from './index';
import { collectedOfferIn } from '../shared/ingest';
import { officialTier, wechatBiz, type OfficialPlatform } from '../shared/official-review';
import { canonicalTermsSchema, type CanonicalTermsV1, type IntakeReceipt } from '../shared/identity/types';
import { adaptLegacyOffer } from './identity/adapters';
import { entityOfferVersion } from './identity/canonical';
import { IdentityService } from './identity/service';
import { IdentityError } from './identity/store';
import { IdentityQueryBudgetError, withIdentityQueryBudget } from './identity/budget';
import { learnWechatAccount } from './wechat-accounts';
import { dispatchCollect } from './feishu';
import { mergeFastTrackFields, missingBasicFields, fastTrackFieldIssues, type FastTrackFields } from '../shared/fast-track-fields';
import { readMembershipCatalog, prepareMembershipFields, MembershipError } from './membership';
import { membershipSchema } from '../shared/membership';
import { sha256, stableJson } from '../shared/identity/normalize';

/**
 * Administrator fast-track. The owner vouches for an official URL (or an in-app test) and a one-line benefit;
 * the URL is registered as the vendor's official address, a free model fills the remaining fields, and the
 * offer goes live as soon as the basic fields are complete — no screening, verification or identity gate.
 */
export class FastTrackError extends Error { constructor(public status: 400 | 403 | 404 | 409, message: string) { super(message); } }

/** Vendor IDs are lowercase slugs; an admin typing "Replicas" or "My Vendor" means replicas / my-vendor. */
const slugId = (value: string) => value.normalize('NFKC').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

export const FAST_TRACK_LEASE_MS = 15 * 60_000;
export const FAST_TRACK_MAX_ATTEMPTS = 3;
export const FAST_TRACK_PUSH_HOLD_MS = 24 * 3600_000;
const SHARED_HOSTS = new Set(['mp.weixin.qq.com', 'x.com', 'twitter.com', 'github.com', 'gitee.com', 'huggingface.co', 'medium.com', 'substack.com']);
const MECHANISM: Record<string, CanonicalTermsV1['mechanism'] extends { value: infer V } ? V : string> = {
  new: 'signup_grant', trial: 'trial', free: 'temporary_free_access', standing: 'recurring_quota', apply: 'application_grant',
} as never;
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const fastTrackInput = z.object({
  platformId: z.string().min(1).optional(),
  newPlatform: z.object({ name: z.string().trim().min(2).max(100), id: z.string().transform(slugId).pipe(z.string().regex(/^[a-z0-9][a-z0-9-]{1,60}$/, '厂商 ID 只能用英文字母、数字和 -，如 replicas；不确定可留空')).optional(), type: z.enum(['lab', 'cloud', 'infra', 'tool', 'new']).default('new') }).optional(),
  url: z.url().refine(url => /^https:\/\//.test(url), '只收 https 链接'),
  benefit: z.string().trim().min(2).max(500),
  basis: z.enum(['official', 'tested']).default('official'),
  note: z.string().trim().max(1000).optional(),
  title: z.string().trim().min(2).max(120).optional(),
  claimStart: isoDate.optional(),
  claimEnd: isoDate.optional(),
  membershipRequirement: membershipSchema.optional(),
  leadId: z.number().int().positive().optional(),
  identityTaskId: z.string().min(1).max(200).optional(),
}).refine(v => !!v.platformId !== !!v.newPlatform, '选择已有厂商或填写新厂商，二选一');
export type FastTrackInput = z.input<typeof fastTrackInput>;

interface JobRow { id: string; platform_id: string; url: string; benefit: string; basis: 'official' | 'tested'; note: string | null; owner_fields_json: string; lead_id: number | null; identity_task_id?: string | null; state: string; lease_until: string | null; attempts: number; fields_json: string | null; progress_json: string | null; missing_json: string | null; error: string | null; offer_id: string | null; actor: string; created_at: string; updated_at: string; published_at: string | null; resolution_json?: string | null }
interface PlatformRow { id: string; name: string; status: string; site: string | null; x_handles: string; staff_handles: string; wechat: string | null }

const toOfficial = (p: PlatformRow): OfficialPlatform => ({ id: p.id, name: p.name, site: p.site, xHandles: JSON.parse(p.x_handles || '[]'), staffHandles: JSON.parse(p.staff_handles || '[]'), wechat: p.wechat });
const hostOf = (url: string) => new URL(url).hostname.toLowerCase().replace(/^www\./, '');
async function platformRow(db: D1Database, id: string) { return db.prepare('SELECT id,name,status,site,x_handles,staff_handles,wechat FROM platforms WHERE id=?').bind(id).first<PlatformRow>(); }
async function platformSources(db: D1Database, id: string) { return (await db.prepare('SELECT url,tier FROM sources WHERE platform_id=?').bind(id).all<{ url: string; tier: string }>()).results; }

/** 公众号文章页里的账号 __biz（var biz = "..."）；验证页、超时或格式不符时返回 null。 */
export async function wechatBizFromArticle(url: string): Promise<string | null> {
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36' }, signal: AbortSignal.timeout(5000) });
    if (!r.ok) return null;
    const biz = /var\s+biz\s*=\s*["']([A-Za-z0-9+/=]{8,40})["']/.exec(await r.text())?.[1];
    return biz ?? null;
  } catch { return null; }
}

/** Record `url` as the vendor's official address: WeChat account, X handle, site or official source. */
export async function registerOfficialAddress(db: D1Database, platformId: string, url: string, actor: string): Promise<{ kind: 'wechat' | 'x' | 'site' | 'source' | 'existing'; value: string }> {
  const host = hostOf(url);
  if (host === 'mp.weixin.qq.com') {
    // 管理员担保的公众号链接一律接受（2026-10-16）。微信的分享短链（/s/xxxx）不带 __biz，且微信对自动访问常返回验证页：
    // 先尝试从正文读出账号 __biz 并登记该公众号；读不到时只把这一篇文章登记为官方信源，不放行整个公众号域名。
    const biz = wechatBiz(url) ?? await wechatBizFromArticle(url);
    if (biz) {
      await learnWechatAccount(db, platformId, wechatBiz(url) ? url : `${url}${url.includes('?') ? '&' : '?'}__biz=${encodeURIComponent(biz)}`);
      return { kind: 'wechat', value: biz };
    }
    if (!await db.prepare('SELECT 1 FROM sources WHERE url=?').bind(url).first())
      await db.prepare("INSERT INTO sources(id,platform_id,kind,url,tier,config,enabled,auto_publish) VALUES(?,?,'web_list',?,'official',?,0,0)")
        .bind(`${platformId}-ft-wx-${Date.now().toString(36)}`.slice(0, 80), platformId, url, JSON.stringify({ addedBy: actor, fastTrack: true, wechatArticle: true })).run();
    return { kind: 'source', value: url };
  }
  const platform = await platformRow(db, platformId);
  if (!platform) throw new FastTrackError(404, '没有这个厂商');
  if (host === 'x.com' || host === 'twitter.com') {
    const handle = new URL(url).pathname.split('/').filter(Boolean)[0]?.toLowerCase();
    if (!handle || ['i', 'home', 'search', 'intent', 'explore'].includes(handle)) throw new FastTrackError(400, 'X 链接需要是厂商账号或其推文');
    // 已登记的员工账号保持员工级别：不能因快速上架升级成官方账号（2026-10-15 Tibo 帖子曾被加入 x_handles）。
    const staff: string[] = JSON.parse(platform.staff_handles || '[]');
    if (staff.some(h => h.toLowerCase() === '@' + handle)) return { kind: 'existing', value: '@' + handle };
    const handles: string[] = JSON.parse(platform.x_handles || '[]');
    if (!handles.some(h => h.toLowerCase() === '@' + handle)) await db.prepare('UPDATE platforms SET x_handles=?, updated_at=? WHERE id=?').bind(JSON.stringify([...handles, '@' + handle]), new Date().toISOString(), platformId).run();
    return { kind: 'x', value: '@' + handle };
  }
  if (officialTier(url, toOfficial(platform), await platformSources(db, platformId))) return { kind: 'existing', value: url };
  if (!platform.site && !SHARED_HOSTS.has(host)) {
    const site = new URL(url).origin;
    await db.prepare('UPDATE platforms SET site=?, updated_at=? WHERE id=? AND site IS NULL').bind(site, new Date().toISOString(), platformId).run();
    return { kind: 'site', value: site };
  }
  const existing = await db.prepare('SELECT id FROM sources WHERE url=?').bind(url).first<{ id: string }>();
  if (!existing) await db.prepare("INSERT INTO sources(id,platform_id,kind,url,tier,config,enabled,auto_publish) VALUES(?,?,'web_list',?,'site',?,1,0)")
    .bind(`${platformId}-ft-${Date.now().toString(36)}`.slice(0, 80), platformId, url, JSON.stringify({ addedBy: actor, fastTrack: true })).run();
  return { kind: 'source', value: url };
}

function newPlatformId(name: string, url: string): string | null {
  const ascii = slugId(name);
  if (/^[a-z0-9][a-z0-9-]{1,60}$/.test(ascii)) return ascii;
  const host = hostOf(url);
  if (SHARED_HOSTS.has(host)) return null;
  const label = host.split('.').slice(-2, -1)[0] ?? '';
  return /^[a-z0-9][a-z0-9-]{1,60}$/.test(label) ? label : null;
}

async function hashedPlatformId(name: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(name.normalize('NFKC'))));
  return 'v-' + [...digest.slice(0, 4)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Owner submission: admit/create the vendor, register the URL as official, queue extraction, start a run. */
export async function createFastTrack(env: Env, raw: unknown, actor: string): Promise<{ jobId: string; platformId: string; registered: { kind: string; value: string }; dispatched: boolean }> {
  const parsed = fastTrackInput.safeParse(raw);
  if (!parsed.success) throw new FastTrackError(400, parsed.error.issues.map(i => i.message).join('；'));
  const input = parsed.data, db = env.DB, now = new Date().toISOString();
  let platformId: string;
  if (input.newPlatform) {
    // The ID is internal: a Chinese-only name on a shared host (X, WeChat) gets a stable hash ID instead of asking the owner.
    const id = input.newPlatform.id ?? newPlatformId(input.newPlatform.name, input.url) ?? await hashedPlatformId(input.newPlatform.name);
    const site = SHARED_HOSTS.has(hostOf(input.url)) ? null : new URL(input.url).origin;
    await db.prepare("INSERT INTO platforms(id,name,type,status,site) VALUES(?,?,?,'approved',?) ON CONFLICT(id) DO UPDATE SET status='approved', updated_at=?")
      .bind(id, input.newPlatform.name, input.newPlatform.type, site, now).run();
    platformId = id;
  } else {
    const platform = await platformRow(db, input.platformId!);
    if (!platform) throw new FastTrackError(404, '没有这个厂商');
    if (platform.status !== 'approved') await db.prepare("UPDATE platforms SET status='approved', updated_at=? WHERE id=?").bind(now, platform.id).run();
    platformId = platform.id;
  }
  if (input.leadId && !await db.prepare('SELECT 1 FROM leads WHERE id=?').bind(input.leadId).first()) throw new FastTrackError(404, '没有这条线索');
  if (input.identityTaskId && !await db.prepare('SELECT 1 FROM review_tasks WHERE id=?').bind(input.identityTaskId).first()) throw new FastTrackError(404, '没有这个审核任务');
  const registered = await registerOfficialAddress(db, platformId, input.url, actor);
  const owner = Object.fromEntries(Object.entries({ title: input.title, claimStart: input.claimStart, claimEnd: input.claimEnd, membershipRequirement: input.membershipRequirement }).filter(([, v]) => v));
  const jobId = crypto.randomUUID();
  await db.prepare("INSERT INTO fast_track_jobs(id,platform_id,url,benefit,basis,note,owner_fields_json,lead_id,identity_task_id,state,actor,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,'queued',?,?,?)")
    .bind(jobId, platformId, input.url, input.benefit, input.basis, input.note ?? null, JSON.stringify(owner), input.leadId ?? null, input.identityTaskId ?? null, actor, now, now).run();
  const dispatched = await dispatchCollect(env, true).catch(() => ({ ok: false }));
  return { jobId, platformId, registered, dispatched: dispatched.ok };
}

export async function listFastTrack(db: D1Database) {
  const rows = await db.prepare("SELECT j.*, p.name platform_name FROM fast_track_jobs j JOIN platforms p ON p.id=j.platform_id ORDER BY CASE WHEN j.state IN ('published','rejected') THEN 1 ELSE 0 END,j.created_at DESC LIMIT 100").all<JobRow & { platform_name: string }>();
  return rows.results.map(r => ({ id: r.id, platformId: r.platform_id, platformName: r.platform_name, url: r.url, benefit: r.benefit, basis: r.basis, state: r.state, attempts: r.attempts, missing: r.missing_json ? JSON.parse(r.missing_json) as string[] : [], error: r.error, offerId: r.offer_id, leadId: r.lead_id, identityTaskId: r.identity_task_id ?? null, createdAt: r.created_at, publishedAt: r.published_at, updatedAt: r.updated_at, resolution: r.resolution_json ? JSON.parse(r.resolution_json) : null, catalogBlock:JSON.parse(r.fields_json??'{}').catalogBlock??null,
    // Current requirements let the membership picker show what the model read and keep the non-member ones.
    requirements: jobRequirements(r, r.platform_name) }));
}
function jobRequirements(r: JobRow, platformName: string): string[] {
  const stored = JSON.parse(r.fields_json ?? '{}') as { fields?: FastTrackFields }, owner = JSON.parse(r.owner_fields_json) as FastTrackFields;
  const value = mergeFastTrackFields(stored.fields ?? {}, owner, r.benefit, platformName).requirements;
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

export async function fastTrackQueue(db: D1Database, now = new Date()) {
  await resumeCatalogFastTracks(db,now);
  // Reconcile explicit terminal decisions before extracting: manual review can finish while a job is paused.
  const stale = await db.prepare(`SELECT j.* FROM fast_track_jobs j LEFT JOIN leads l ON l.id=j.lead_id
    LEFT JOIN offers o ON o.id=COALESCE(json_extract(j.progress_json,'$.offerId'),json_extract(j.progress_json,'$.receipt.canonicalOfferId'))
    WHERE j.state='needs_owner' AND (l.status IN ('linked','rejected') OR o.review_state='approved')
    ORDER BY j.updated_at LIMIT 3`).all<JobRow>();
  for (const job of stale.results) {
    if (!await reconcileFastTrack(db,job)) await db.prepare('UPDATE fast_track_jobs SET updated_at=? WHERE id=?').bind(now.toISOString(),job.id).run();
  }
  const rows = await db.prepare("SELECT id,state FROM fast_track_jobs WHERE state='publishing' OR ((state='queued' OR (state='extracting' AND lease_until<?)) AND attempts<?) ORDER BY created_at LIMIT 5").bind(now.toISOString(), FAST_TRACK_MAX_ATTEMPTS).all<{ id: string; state: string }>();
  return rows.results.map(r => ({ id: r.id, publishing: r.state === 'publishing' }));
}

export async function claimFastTrack(db: D1Database, id: string, now = new Date()) {
  const job = await db.prepare("UPDATE fast_track_jobs SET state='extracting', lease_until=?, attempts=attempts+1, updated_at=? WHERE id=? AND (state='queued' OR (state='extracting' AND lease_until<?)) AND attempts<? RETURNING *")
    .bind(new Date(now.getTime() + FAST_TRACK_LEASE_MS).toISOString(), now.toISOString(), id, now.toISOString(), FAST_TRACK_MAX_ATTEMPTS).first<JobRow>();
  if (!job) return null;
  const terminal = await reconcileFastTrack(db, job);
  if (terminal) return { ...terminal, id: job.id };
  const platform = await platformRow(db, job.platform_id);
  return { ownerFields: JSON.parse(job.owner_fields_json), previousFields: JSON.parse(job.fields_json ?? '{}').fields, repairFeedback: job.error ?? job.missing_json ?? undefined, membershipCatalog: await readMembershipCatalog(db), id: job.id, platformId: job.platform_id, platformName: platform?.name ?? job.platform_id, url: job.url, benefit: job.benefit, note: job.note };
}

export { mergeFastTrackFields, missingBasicFields, type FastTrackFields } from '../shared/fast-track-fields';

function terms(platformId: string, type: string): CanonicalTermsV1 {
  const unknown = { state: 'unknown' } as const;
  return canonicalTermsSchema.parse({ schemaVersion: 'terms-v1', issuerProductId: { state: 'known', value: platformId, evidenceRefs: ['benefit'] }, mechanism: { state: 'known', value: MECHANISM[type] ?? 'other', evidenceRefs: ['benefit'] }, benefitPools: [], eligibility: unknown, geography: unknown, claimChannels: unknown, costs: unknown, claimWindow: unknown, occurrenceAnchor: unknown });
}

interface Progress { pending?: { candidateId: string; requestId: string }; receipt?: IntakeReceipt; entityId?: string; offerId?: string; membership?: boolean | string; approved?: boolean; testedTask?: { id: string; revision: number } | null; testedTier?: boolean }
/** Identity work gets its own slice of the 50-query request budget; the rest is left for job bookkeeping. */
const IDENTITY_SLICE = 38;
class StepDeferred extends Error {}

/**
 * Create the entity and draft through the identity system, then approve it as the job's administrator.
 * One request rarely fits the whole chain, so each completed step is saved and the next request resumes.
 */
export async function publishFastTrack(env: Env, job: JobRow, fields: FastTrackFields, sourceText: string, progress: Progress, save: () => Promise<unknown>): Promise<{ offerId: string; alreadyLive: boolean }> {
  const db = env.DB, now = new Date().toISOString();
  const identityDb = withIdentityQueryBudget(env.AGENT_READ_KEY ?? db, IDENTITY_SLICE), service = new IdentityService(identityDb);
  const step = async <T>(work: () => Promise<T>): Promise<T> => {
    try { return await work(); } catch (error) {
      // Retrieval reports an exhausted budget as a 503; both mean “resume in the next request”.
      if (error instanceof IdentityQueryBudgetError || (error instanceof IdentityError && error.status === 503)) throw new StepDeferred();
      throw error;
    }
  };
  const facts = terms(job.platform_id, String(fields.type));
  if (!progress.receipt && progress.pending) {
    progress.receipt = await step(() => service.resolveCandidate(progress.pending!.candidateId, progress.pending!.requestId));
    await save();
  }
  if (!progress.receipt) {
    const platform = await platformRow(db, job.platform_id);
    if (!platform) throw new FastTrackError(404, '没有这个厂商');
    const ownerLine = `管理员提供的主要权益：${job.benefit}`;
    const text = [ownerLine, job.note ? `管理员备注：${job.note}` : '', sourceText].filter(Boolean).join('\n').slice(0, 250_000);
    const given = (fields.excerpts ?? {}) as Record<string, unknown>, excerpts: Record<string, string> = {};
    for (const key of ['benefit', 'eligibility', 'claim', 'validity']) { const value = given[key]; if (typeof value === 'string' && value.trim() && text.includes(value)) excerpts[key] = value; }
    if ((excerpts.benefit?.trim().length ?? 0) < 12) excerpts.benefit = ownerLine;
    const tier = officialTier(job.url, toOfficial(platform), await platformSources(db, job.platform_id)) ?? 'official';
    const parsed = collectedOfferIn.safeParse({
      id: `${job.platform_id}-ft-${job.id.slice(0, 8)}`.toLowerCase().slice(0, 80), platformId: job.platform_id,
      title: fields.title, type: fields.type, modalities: fields.modalities, tags: fields.tags ?? [], models: fields.models ?? [], claimMethod: fields.claimMethod,
      requirements: fields.requirements, audience: fields.audience ?? 'unclear', valueText: String(fields.valueText).slice(0, 200), usdEstimate: null, usdMax: null,
      claimStart: fields.claimStart ?? null, claimEnd: fields.claimEnd ?? null, endKind: fields.endKind, creditValidity: fields.creditValidity ?? null, sourceTz: fields.sourceTz,
      steps: Array.isArray(fields.steps) ? fields.steps.slice(0, 10) : [], firstChannel: 'manual', sourceText: text,
      evidence: { url: job.url, tier, capturedAt: job.created_at, excerpts },
    });
    if (!parsed.success) throw new FastTrackError(400, '字段不符合上架规则：' + parsed.error.issues.map(i => `${i.path.join('.')} ${i.message}`).join('；'));
    // A failed readiness check can already reserve the legacy request. Corrected owner fields
    // are a new payload revision; keep the old receipt and let activity identity dedupe it.
    const requestRevision=await sha256(stableJson({offer:{...parsed.data,usdEstimate:null,usdMax:null,valuation:null},identityFacts:facts,basis:job.basis}));
    const adapted = await step(() => adaptLegacyOffer({ ...env, DB: identityDb }, parsed.data, { ...parsed.data, identityFacts: facts, identityRequestId: `fast-track:${job.id}:${requestRevision}` }));
    if (!adapted) throw new FastTrackError(409, '身份系统未启用（IDENTITY_MODE 不是 enforce），不能快速上架');
    if (adapted.pendingResolution) { progress.pending = adapted.pendingResolution as Progress['pending']; await save(); throw new StepDeferred(); }
    if (adapted.error) throw new FastTrackError(409, String(adapted.error));
    progress.receipt = adapted.identityReceipt as IntakeReceipt;
    await save();
  }
  const receipt = progress.receipt!;
  if (receipt.outcome === 'duplicate_approved' && receipt.canonicalOfferId) return { offerId: receipt.canonicalOfferId, alreadyLive: true };
  if (receipt.outcome === 'duplicate_rejected') throw new FastTrackError(409, '这条权益此前被拒绝过：请在审核页显式重开该决定后再上架');
  if (!progress.offerId) {
    if (receipt.outcome === 'needs_identity_review') {
      const task = await db.prepare('SELECT id,revision FROM review_tasks WHERE id=?').bind(receipt.taskId).first<{ id: string; revision: number }>();
      if (!task) throw new FastTrackError(409, '身份任务不存在');
      const resolved = await step(() => service.resolveIdentityTask(task.id, { requestId: `fast-track-new:${job.id}`, expectedRevision: task.revision, action: 'new', candidateId: receipt.candidateId, facts, reason: '管理员快速上架：新活动', actor: job.actor }));
      if (resolved.outcome === 'duplicate_approved' && resolved.canonicalOfferId) return { offerId: resolved.canonicalOfferId, alreadyLive: true };
      progress.entityId = resolved.entityId ?? undefined; progress.offerId = resolved.canonicalOfferId ?? undefined;
    } else if (receipt.outcome === 'created_pending' || receipt.outcome === 'duplicate_pending') {
      progress.entityId = receipt.entityId ?? undefined; progress.offerId = receipt.canonicalOfferId ?? undefined;
    } else throw new FastTrackError(409, `身份系统返回 ${receipt.outcome}`);
    if (!progress.entityId || !progress.offerId) throw new FastTrackError(409, '身份系统没有建立活动');
    await save();
  }
  // The owner's catalog membership replaces the model's member: text on the draft, through the same guarded edit as the review page.
  // Without it every member perk stopped at approval: “会员资格尚未结构化确认” (2026-10-17 Higgsfield Wan 3.0).
  const membership = fields.membershipRequirement;
  const membershipKey = membership ? (await sha256(stableJson(membership))).slice(0, 16) : null;
  if (membership && progress.membership !== membershipKey) {
    const initial = await db.prepare("SELECT id,revision FROM review_tasks WHERE entity_id=? AND kind='initial' AND state IN ('open','checking','manual') ORDER BY created_at DESC LIMIT 1").bind(progress.entityId).first<{ id: string; revision: number }>();
    if (initial) {
      const requirements = (Array.isArray(fields.requirements) ? fields.requirements : []).filter(r => typeof r === 'string' && !r.startsWith('member:'));
      const key = membershipKey;
      await step(() => service.editManagedOffer(progress.offerId!, { requestId: `fast-track-membership:${job.id}:${key}`, taskId: initial.id, expectedTaskRevision: initial.revision, fields: { membershipRequirement: membership, requirements }, actor: job.actor }));
    }
    progress.membership = membershipKey!;
    await save();
  }
  if (!progress.approved) {
    const initial = await db.prepare("SELECT id,revision FROM review_tasks WHERE entity_id=? AND kind='initial' AND state IN ('open','checking','manual') ORDER BY created_at DESC LIMIT 1").bind(progress.entityId).first<{ id: string; revision: number }>();
    if (initial) await step(() => service.decideTask(initial.id, { requestId: `fast-track-approve:${job.id}`, expectedRevision: initial.revision, action: 'approve', actor: job.actor, role: 'admin', reason: `管理员快速上架（${job.basis === 'tested' ? '管理员实测' : '官方来源'}）` }));
    else if ((await db.prepare('SELECT review_state FROM offers WHERE id=?').bind(progress.offerId).first<{ review_state: string }>())?.review_state !== 'approved') throw new FastTrackError(409, '没有可通过的审核任务');
    progress.approved = true;
    await save();
  }
  // 管理员担保“我亲测可领”：身份入库不接受 tested 证据，先按链接级别上架，再像后台编辑一样把证据级别改为 tested 并批准，
  // 不让条目显示成链接页面的原文（2026-10-16 ZCode Weekend Build 曾被标成官网原文）。
  if (job.basis === 'tested' && !progress.testedTier) {
    // 两步分别保存进度：编辑出草稿、再批准草稿；单个请求的查询预算不够时下个请求接着做。
    if (progress.testedTask === undefined) {
      const row = await db.prepare("SELECT o.evidence,o.updated_at,e.id,e.business_revision FROM offers o JOIN benefit_entities e ON e.canonical_offer_id=o.id AND e.state='active' WHERE o.id=?").bind(progress.offerId)
        .first<{ evidence: string; updated_at: string; id: string; business_revision: number }>();
      const evidence = row ? JSON.parse(row.evidence) as Record<string, unknown> : null;
      if (!row || !evidence || evidence.tier === 'tested') progress.testedTask = null;
      else {
        const edit = await step(() => service.editManagedOffer(progress.offerId!, { requestId: `fast-track-tested:${job.id}`, expectedOfferVersion: entityOfferVersion(row, row.updated_at), fields: { evidence: { ...evidence, tier: 'tested' } }, actor: job.actor }));
        progress.testedTask = edit.taskId ? { id: edit.taskId, revision: edit.revision } : null;
      }
      await save();
    }
    const task = progress.testedTask;
    if (task) await step(() => service.decideTask(task.id, { requestId: `fast-track-tested-approve:${job.id}`, expectedRevision: task.revision, action: 'approve', actor: job.actor, role: 'admin', reason: '管理员快速上架（亲测）：证据级别为管理员实测' }));
    progress.testedTier = true;
    await save();
  }
  await db.prepare('UPDATE offers SET fast_tracked_at=? WHERE id=?').bind(now, progress.offerId).run();
  return { offerId: progress.offerId!, alreadyLive: false };
}

async function linkLead(db: D1Database, leadId: number, offerId: string) {
  const resolution = { status: 'linked', jobId: 'fast-track-' + crypto.randomUUID(), attempts: 0, inconclusive: 0, checkedAt: new Date().toISOString(), nextAttemptAt: null, reason: '管理员快速上架', queries: [], candidates: [], offerIds: [offerId] };
  // A wrongly auto-closed lead fast-tracked from the spot-check list links too (2026-10-16).
  await db.prepare("UPDATE leads SET status='linked', offer_id=?, resolution=? WHERE id=? AND status IN ('new','reviewing','rejected')").bind(offerId, JSON.stringify(resolution), leadId).run();
}

/**
 * The owner fast-tracked from an identity review card: close that task as a duplicate of the offer just published.
 * Best effort — a task already decided, or one whose shape needs an explicit identity decision, is left for the owner.
 */
async function closeIdentityTask(db: D1Database, job: JobRow, offerId: string) {
  const task = await db.prepare("SELECT id,revision FROM review_tasks WHERE id=? AND state IN ('open','checking','manual')").bind(job.identity_task_id).first<{ id: string; revision: number }>();
  if (!task) return;
  await new IdentityService(db).decideTask(task.id, { requestId: `fast-track-close:${job.id}`, expectedRevision: task.revision, action: 'reject', actor: job.actor, role: 'admin', reasonCode: 'duplicate',
    reason: `管理员已快速上架为 ${offerId}；本任务候选与之为同一活动` }).catch(error => { if (!(error instanceof IdentityError)) throw error; });
}

type PublishState = { state: 'published' | 'publishing' | 'needs_owner' | 'queued' | 'rejected'; offerId?: string | null; missing?: string[]; error?: string; alreadyLive?: boolean };
async function attemptPublish(env: Env, job: JobRow, requireReview=false): Promise<PublishState> {
  const db = env.DB, now = () => new Date().toISOString();
  const stored = JSON.parse(job.fields_json ?? '{}') as { fields?: FastTrackFields; sourceText?: string; semanticReview?: SemanticReview };
  const platform = await db.prepare('SELECT name FROM platforms WHERE id=?').bind(job.platform_id).first<{ name: string }>();
  const terminal = await reconcileFastTrack(db, job);
  if (terminal) return terminal;
  let fields = mergeFastTrackFields(stored.fields ?? {}, JSON.parse(job.owner_fields_json), job.benefit, platform?.name);
  const context={platformId:job.platform_id,url:job.url,benefit:job.benefit,note:job.note,sourceText:stored.sourceText??''};
  const catalog=await readMembershipCatalog(db);
  const catalogBlock=fastTrackCatalogBlock(fields,catalog,job.benefit);
  if(catalogBlock)return pauseForCatalog(db,job,catalogBlock);
  const missing = [...fastTrackFieldIssues(fields,context),...(stored.semanticReview?semanticReviewIssues(fields,stored.semanticReview,context,JSON.parse(job.owner_fields_json)):[])];
  if (missing.length) {
    return repairFastTrack(db, job, missing, '自动补全校验：' + missing.join('；'));
  }
  if(requireReview&&!stored.semanticReview)return repairFastTrack(db,job,['semanticReview'],'semanticReview: 模型结果必须先完成发布前字段语义核对');
  const progress: Progress = JSON.parse(job.progress_json ?? '{}');
  const save = () => db.prepare("UPDATE fast_track_jobs SET state='publishing', progress_json=?, lease_until=NULL, updated_at=? WHERE id=?").bind(JSON.stringify(progress), now(), job.id).run();
  try {
    if (fields.membershipRequirement) fields = await prepareMembershipFields(db, {requirements: []}, fields);
    const published = await publishFastTrack(env, job, fields, stored.sourceText ?? '', progress, save);
    await db.prepare("UPDATE fast_track_jobs SET state='published', offer_id=?, progress_json=?, missing_json=NULL, error=NULL, lease_until=NULL, published_at=?, updated_at=? WHERE id=?").bind(published.offerId, JSON.stringify(progress), now(), now(), job.id).run();
    if (job.lead_id) await linkLead(db, job.lead_id, published.offerId);
    if (job.identity_task_id) await closeIdentityTask(db, job, published.offerId);
    return { state: 'published', offerId: published.offerId, alreadyLive: published.alreadyLive };
  } catch (error) {
    // A step that cannot finish even with a fresh request budget would loop forever: hand it to the owner.
    const stalled = error instanceof StepDeferred && job.state === 'publishing' && job.progress_json === JSON.stringify(progress);
    if (error instanceof StepDeferred && !stalled) { await save(); return { state: 'publishing' }; }
    if (stalled) error = new FastTrackError(409, '上架步骤没有进展，请点“重新读取”或联系开发');
    if (!(error instanceof FastTrackError) && !(error instanceof IdentityError) && !(error instanceof MembershipError)) throw error;
    const repairable = error instanceof MembershipError || /字段不符合|会员资格|会员目录/.test(error.message);
    return repairFastTrack(db, repairable ? job : {...job, attempts: FAST_TRACK_MAX_ATTEMPTS}, [], error.message);
  }
}

/** Continue a publish that ran out of this request's query budget. */
export async function advanceFastTrack(env: Env, id: string) {
  const job = await env.DB.prepare('SELECT * FROM fast_track_jobs WHERE id=?').bind(id).first<JobRow>();
  if (!job) throw new FastTrackError(404, '没有这个快速上架任务');
  if (job.state === 'published') return { state: 'published', offerId: job.offer_id };
  if (job.state !== 'publishing') throw new FastTrackError(409, '任务不在上架中');
  return attemptPublish(env, job);
}

const resultInput = z.object({ catalogBlock:z.unknown().optional(), semanticReview:semanticReviewSchema.optional(), fields: z.record(z.string(), z.unknown()).optional(), sourceText: z.string().max(260_000).optional(), error: z.string().max(500).optional(), model: z.string().max(120).optional() });

/** The pipeline agent reports extracted fields (or a model failure) for a claimed job. */
export async function submitFastTrackResult(env: Env, id: string, raw: unknown) {
  const body = resultInput.parse(raw), db = env.DB, now = new Date().toISOString();
  const job = await db.prepare('SELECT * FROM fast_track_jobs WHERE id=?').bind(id).first<JobRow>();
  if (!job) throw new FastTrackError(404, '没有这个快速上架任务');
  if (job.state !== 'extracting') throw new FastTrackError(409, '任务不在读取中');
  if(body.fields){
    const fields=mergeFastTrackFields(body.fields,JSON.parse(job.owner_fields_json),job.benefit,(await platformRow(db,job.platform_id))?.name);
    const block=fastTrackCatalogBlock(fields,await readMembershipCatalog(db),job.benefit);
    if(block){const fieldsJson=JSON.stringify({fields:body.fields,sourceText:body.sourceText??'',model:body.model,catalogBlock:block});return pauseForCatalog(db,{...job,fields_json:fieldsJson},block);}
  }
  if (body.error || !body.fields) {
    if(body.fields)await db.prepare('UPDATE fast_track_jobs SET fields_json=? WHERE id=?').bind(JSON.stringify({fields:body.fields,sourceText:body.sourceText??'',model:body.model,semanticReview:body.semanticReview}),id).run();
    const exhausted = job.attempts >= FAST_TRACK_MAX_ATTEMPTS;
    await db.prepare('UPDATE fast_track_jobs SET state=?, error=?, lease_until=NULL, updated_at=? WHERE id=?').bind(exhausted ? 'needs_owner' : 'queued', body.error ?? '模型没有返回字段', now, id).run();
    return { state: exhausted ? 'needs_owner' : 'queued' };
  }
  const updated = { ...job, fields_json: JSON.stringify({ fields: body.fields, sourceText: body.sourceText ?? '', model: body.model, semanticReview:body.semanticReview }) };
  await db.prepare('UPDATE fast_track_jobs SET fields_json=?, updated_at=? WHERE id=?').bind(updated.fields_json, now, id).run();
  return attemptPublish(env, updated,true);
}

/** The owner fills the fields the model could not, then the job publishes immediately. */
export async function completeFastTrack(env: Env, id: string, raw: unknown) {
  const input = z.object({ fields: z.record(z.string(), z.unknown()), basis: z.enum(['official','tested']).optional() }).parse(raw), fields=input.fields, db = env.DB;
  const job = await db.prepare('SELECT * FROM fast_track_jobs WHERE id=?').bind(id).first<JobRow>();
  if (!job) throw new FastTrackError(404, '没有这个快速上架任务');
  if (job.state !== 'needs_owner') throw new FastTrackError(409, '只有“需要你补充”的任务可以补字段');
  const owner = { ...JSON.parse(job.owner_fields_json), ...fields };
  const basis=input.basis??job.basis;
  await db.prepare('UPDATE fast_track_jobs SET owner_fields_json=?, basis=?, updated_at=? WHERE id=?').bind(JSON.stringify(owner), basis, new Date().toISOString(), id).run();
  return attemptPublish(env, { ...job, basis, owner_fields_json: JSON.stringify(owner) });
}

/** Re-queue a job (e.g. after the free models were unavailable) and start a run. */
export async function retryFastTrack(env: Env, id: string) {
  const r = await env.DB.prepare("UPDATE fast_track_jobs SET state='queued', attempts=0, error=NULL, updated_at=? WHERE id=? AND state='needs_owner'").bind(new Date().toISOString(), id).run();
  if (!(r.meta?.changes ?? 0)) throw new FastTrackError(409, '只有“需要你补充”的任务可以重新读取');
  const dispatched = await dispatchCollect(env, true).catch(() => ({ ok: false }));
  return { state: 'queued', dispatched: dispatched.ok };
}

export const fastTrackHeld = (fastTrackedAt: string | null | undefined, now: Date) => !!fastTrackedAt && now.getTime() - Date.parse(fastTrackedAt) < FAST_TRACK_PUSH_HOLD_MS;

async function repairFastTrack(db: D1Database, job: JobRow, missing: string[], error: string): Promise<PublishState> {
  const state = job.attempts < FAST_TRACK_MAX_ATTEMPTS ? 'queued' : 'needs_owner';
  await db.prepare('UPDATE fast_track_jobs SET state=?,missing_json=?,error=?,lease_until=NULL,updated_at=? WHERE id=?')
    .bind(state, JSON.stringify(missing), error.slice(0, 500), new Date().toISOString(), job.id).run();
  return {state, missing, error};
}

/** Only explicit provenance can reconcile a stale job; never title similarity or another vendor's lead offer. */
async function reconcileFastTrack(db: D1Database, job: JobRow): Promise<PublishState | null> {
  if (job.state === 'published' || job.state === 'rejected') return {state:job.state,offerId:job.offer_id};
  const progress: Progress = JSON.parse(job.progress_json ?? '{}');
  if (job.state === 'publishing' || (job.basis === 'tested' && progress.approved && !progress.testedTier)) return null;
  let offerId = progress.offerId ?? progress.receipt?.canonicalOfferId;
  if (job.lead_id) {
    const lead = await db.prepare('SELECT status,offer_id,resolution FROM leads WHERE id=?').bind(job.lead_id).first<{status:string;offer_id:string|null;resolution:string|null}>();
    if (lead?.status === 'rejected') {
      const reason = JSON.parse(lead.resolution ?? '{}').reason ?? '关联线索已被管理员拒绝';
      await db.prepare("UPDATE fast_track_jobs SET state='rejected',error=NULL,missing_json=NULL,lease_until=NULL,resolution_json=?,updated_at=? WHERE id=?")
        .bind(JSON.stringify({action:'reject',reason,leadId:job.lead_id,origin:'existing-decision'}),new Date().toISOString(),job.id).run();
      return {state:'rejected',offerId:null};
    }
    if (!offerId && lead?.status === 'linked') offerId = lead.offer_id ?? undefined;
  }
  if (offerId) {
    const offer = await db.prepare("SELECT id FROM offers WHERE id=? AND platform_id=? AND review_state='approved'").bind(offerId,job.platform_id).first();
    if (offer) {
      if (job.identity_task_id) await closeIdentityTask(db,job,offerId);
      await db.prepare("UPDATE fast_track_jobs SET state='published',offer_id=?,error=NULL,missing_json=NULL,lease_until=NULL,published_at=COALESCE(published_at,?),updated_at=?,resolution_json=? WHERE id=?")
        .bind(offerId,new Date().toISOString(),new Date().toISOString(),JSON.stringify({action:'linked',reason:'已关联的同平台权益已批准，同步快速上架结果'}),job.id).run();
      return {state:'published',offerId};
    }
  }
  return null;
}
export async function reconcileFastTrackJob(env: Env, id: string) {
  const resumed=await resumeCatalogFastTracks(env.DB,new Date(),id);
  if(resumed.includes(id)){const dispatched=await dispatchCollect(env,true).catch(()=>({ok:false}));return {state:'queued',dispatched:dispatched.ok};}
  const job=await env.DB.prepare('SELECT * FROM fast_track_jobs WHERE id=?').bind(id).first<JobRow>();
  if(!job) throw new FastTrackError(404,'没有这个快速上架任务');
  return await reconcileFastTrack(env.DB,job) ?? {state:job.state,offerId:job.offer_id};
}

/** Read-only replay input: never reopens or republishes an already approved benefit. */
export async function fastTrackReviewInput(db:D1Database,id:string){
 const job=await db.prepare('SELECT * FROM fast_track_jobs WHERE id=?').bind(id).first<JobRow>();
 if(!job)throw new FastTrackError(404,'没有这个快速上架任务');
 const platform=await platformRow(db,job.platform_id),stored=JSON.parse(job.fields_json??'{}');
 if(!stored.fields)throw new FastTrackError(409,'任务没有可重放的模型初稿');
 return {job:{id:job.id,platformId:job.platform_id,platformName:platform?.name??job.platform_id,url:job.url,benefit:job.benefit,note:job.note,ownerFields:JSON.parse(job.owner_fields_json)},fields:stored.fields,sourceText:stored.sourceText??'',offerId:job.offer_id,membershipCatalog:await readMembershipCatalog(db)};
}

async function pauseForCatalog(db:D1Database,job:JobRow,block:CatalogBlock){
 const stored={...JSON.parse(job.fields_json??'{}'),catalogBlock:block};
 await db.prepare("UPDATE fast_track_jobs SET state='needs_owner',fields_json=?,missing_json='[\"membershipCatalog\"]',error=?,lease_until=NULL,updated_at=? WHERE id=?")
  .bind(JSON.stringify(stored),block.reason,new Date().toISOString(),job.id).run();
 return {state:'needs_owner' as const,missing:['membershipCatalog'],error:block.reason};
}
async function resumeCatalogFastTracks(db:D1Database,now:Date,onlyId?:string){
 const rows=await db.prepare("SELECT * FROM fast_track_jobs WHERE state='needs_owner' AND (missing_json LIKE '%membershipCatalog%' OR error LIKE '%会员产品未经核实%' OR error LIKE '%套餐未经核实%') AND (?1 IS NULL OR id=?1) ORDER BY updated_at LIMIT 5").bind(onlyId??null).all<JobRow>();
 if(!rows.results.length)return [] as string[];
 const resumed:string[]=[];
 const catalog=await readMembershipCatalog(db);
 for(const job of rows.results){
  const owner=JSON.parse(job.owner_fields_json),stored=JSON.parse(job.fields_json??'{}');
  // Never silently refresh an administrator's explicit membership selection.
  if(owner.membershipRequirement)continue;
  const seen=stored.catalogBlock?.catalogRevision??stored.fields?.membershipRequirement?.catalogRevision??0;
  if(catalog.revision<=seen)continue;
  const fields=mergeFastTrackFields(stored.fields??{},owner,job.benefit);
  if(fastTrackCatalogBlock(fields,catalog,job.benefit))continue;
  const next={...stored,catalogResume:{fromRevision:seen,revision:catalog.revision,at:now.toISOString()}};
  const result=await db.prepare("UPDATE fast_track_jobs SET state='queued',attempts=0,error=NULL,missing_json=NULL,fields_json=?,updated_at=? WHERE id=? AND state='needs_owner'")
   .bind(JSON.stringify(next),now.toISOString(),job.id).run();
  if(result.meta?.changes)resumed.push(job.id);
 }
 return resumed;
}
