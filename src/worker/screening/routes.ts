import { Hono } from 'hono';
import { z } from 'zod';
import { platformMentioned } from '../../shared/lead-scope';
import { SCREENING_PROMPT_VERSION } from '../../shared/screening/version';
import { platformProfileSchema, screeningMode, screeningVerdictSchema } from '../../shared/screening/types';
import { putProfile } from './profiles';
import { compareQueueOrder, latestUsefulReviewAt, systemDueAt } from '../../shared/screening/urgency';
import { buildMemoryPage, reviewerNames } from './memory';
import { ScreeningStore } from './store';
import { confirmAutoClosed, listAutoClosed, markWronglyClosed } from './spot-check';
import { activeTitleRules, applyRuleToOpenLeads, createIntakeRule, listIntakeRules, retireIntakeRule, RuleError, suggestIntakeRules } from './intake-rules';
import type { Env } from '../index';
import { readUrgentReviews, urgentReviewQueue } from './urgent-review';

export const screeningIngestRoutes = new Hono<{ Bindings: Env }>();

screeningIngestRoutes.get('/memory', async c => {
  const limit = Math.min(500, Math.max(1, Number(c.req.query('limit') ?? 500) || 500));
  const cursor = c.req.query('cursor') || null;
  const page = await buildMemoryPage(c.env.DB, cursor, limit, reviewerNames(c.env));
  const first = !cursor;
  const rules = first ? (await c.env.DB.prepare(`SELECT id, kind, scope_kind scopeKind, scope_value scopeValue, category, description, pattern, status FROM screening_rules`).all()).results : [];
  const profiles = first ? (await c.env.DB.prepare(`SELECT profile_json FROM platform_profiles ORDER BY platform_id`).all<{ profile_json: string }>()).results.map(row => JSON.parse(row.profile_json)) : [];
  const calibrations = first ? (await c.env.DB.prepare(`SELECT model, close_threshold closeThreshold, new_threshold newThreshold, sample_size sampleSize, close_precision closePrecision, wrong_new_rate wrongNewRate, recurring_false_closes recurringFalseCloses, status FROM screening_calibrations`).all()).results : [];
  return c.json({ records: page.records, rules, profiles, calibrations, nextCursor: page.nextCursor });
});

const verdictBody = z.object({
  requestId: z.string().min(1),
  itemId: z.string().min(1),
  subject: z.object({
    kind: z.enum(['lead', 'task']), leadId: z.number().optional(), taskId: z.string().optional(), candidateId: z.string().optional(),
    platformId: z.string().nullable().optional(), origin: z.string().nullable().optional(), discoveredAt: z.string(),
  }),
  verdict: screeningVerdictSchema,
  model: z.string(), calibrated: z.boolean(), promptVersion: z.string(), contextHash: z.string(), downgradeReasons: z.array(z.string()).default([]),
});

screeningIngestRoutes.post('/verdicts', async c => {
  const body = verdictBody.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: 'invalid verdict' }, 400);
  const verdict = body.data.verdict;
  if (verdict.matchId) {
    const [kind, id] = verdict.matchId.split(':');
    const row = kind === 'offer'
      ? await c.env.DB.prepare('SELECT id FROM offers WHERE id=?').bind(id).first()
      : kind === 'lead' ? await c.env.DB.prepare('SELECT id FROM leads WHERE id=?').bind(Number(id)).first() : null;
    if (!row) return c.json({ error: 'unknown match' }, 400);
  }
  if (verdict.ruleId && !await c.env.DB.prepare(`SELECT id FROM screening_rules WHERE id=? AND status='active'`).bind(verdict.ruleId).first()) return c.json({ error: 'inactive rule' }, 400);
  const mode = screeningMode(c.env);
  const store = new ScreeningStore(c.env.DB);
  const existing = await store.getItem(body.data.itemId);
  const ownerTier = existing?.tierBy === 'owner';
  const tier = ownerTier ? existing!.tier : verdict.urgency.tier;
  const discoveredAt = existing?.discoveredAt ?? body.data.subject.discoveredAt;
  await store.upsertItem({
    subjectKind: body.data.subject.kind, subjectId: body.data.subject.kind === 'lead' ? String(body.data.subject.leadId ?? body.data.itemId.slice(5)) : String(body.data.subject.taskId ?? body.data.itemId.slice(5)),
    platformId: body.data.subject.platformId ?? null, origin: body.data.subject.origin ?? null,
    state: existing?.state ?? 'awaiting_screen', tier, deadline: ownerTier ? existing!.deadline : verdict.urgency.deadline,
    signals: verdict.urgency.signals, urgencyQuote: verdict.urgency.quote, tierBy: ownerTier ? 'owner' : 'screener',
    discoveredAt, dueAt: systemDueAt(tier, discoveredAt),
  });
  const decision = await store.recordDecision({
    requestId: body.data.requestId, itemId: body.data.itemId, verdict: verdict.verdict, matchRef: verdict.matchId, ruleId: verdict.ruleId,
    reasonCategory: verdict.reasonCategory, occurrenceCheck: verdict.occurrenceCheck, confidence: verdict.confidence, evidenceQuote: verdict.evidenceQuote,
    explanation: verdict.explanation, urgency: verdict.urgency, model: body.data.model, calibrated: body.data.calibrated, promptVersion: body.data.promptVersion,
    contextHash: body.data.contextHash, downgrade: body.data.downgradeReasons, mode: mode === 'off' ? 'shadow' : mode,
  });
  return c.json({ decisionId: decision.id, mode, applied: false });
});

screeningIngestRoutes.get('/queue', async c => {
  const limit = Math.min(50, Math.max(1, Number(c.req.query('limit') ?? 50) || 50));
  const ids = (c.req.query('ids') ?? '').split(',').map(id => id.trim()).filter(Boolean);
  const rows = await c.env.DB.prepare(`SELECT i.id, i.subject_kind, i.subject_id, i.tier, i.discovered_at, i.deadline, i.origin, i.platform_id,
      l.title AS lead_title, l.url AS lead_url, l.raw AS lead_raw, l.origin AS lead_origin,
      c.id AS candidate_id, c.raw_candidate_json, o.text AS source_text
    FROM screening_items i
    LEFT JOIN leads l ON i.subject_kind='lead' AND l.id=CAST(i.subject_id AS INTEGER)
    LEFT JOIN task_candidates tc ON i.subject_kind='task' AND tc.task_id=i.subject_id
    LEFT JOIN intake_candidates c ON c.id=tc.candidate_id
    LEFT JOIN source_observations o ON o.id=c.observation_id
    WHERE i.state='awaiting_screen' AND i.latest_decision_id IS NULL`).all<QueueRow>();
  const chosen = new Map<string, QueueRow>();
  for (const row of rows.results) {
    const prev = chosen.get(row.id);
    if (!prev || (row.candidate_id ?? '\uffff') < (prev.candidate_id ?? '\uffff')) chosen.set(row.id, row);
  }
  const platforms = (await c.env.DB.prepare(`SELECT id, name, aliases FROM platforms WHERE status='approved'`).all<{ id: string; name: string; aliases: string }>()).results
    .map(p => ({ id: p.id, name: p.name, aliases: JSON.parse(p.aliases || '[]') as string[] }));
  const items = [...chosen.values()].filter(row => !ids.length || ids.includes(row.id)).map(row => ({
    itemId: row.id, subject: row.subject_kind === 'lead' ? leadSubject(row, platforms) : taskSubject(row), tier: row.tier, discoveredAt: row.discovered_at,
    latestUsefulReviewAt: latestUsefulReviewAt(row.deadline, row.tier),
  })).sort(compareQueueOrder).slice(0, limit).map(({ latestUsefulReviewAt: _review, ...item }) => item);
  return c.json({ items });
});

screeningIngestRoutes.get('/items/:id', async c => {
  const row = await c.env.DB.prepare(`SELECT verdict, urgency_json FROM screening_decisions WHERE item_id=? ORDER BY created_at DESC LIMIT 1`).bind(c.req.param('id')).first<{ verdict: string; urgency_json: string }>();
  return c.json({ decision: row ?? null });
});

screeningIngestRoutes.post('/items/:id/escalate', async c => {
  const body = z.object({ requestId: z.string().min(1), suggestion: z.enum(['screening_unavailable', 'unverified', 'new_platform']), note: z.string().default('') }).safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: 'invalid escalation' }, 400);
  const prior = await c.env.DB.prepare('SELECT id FROM screening_decisions WHERE request_id=?').bind(body.data.requestId).first();
  if (prior) return c.json({ ok: true, duplicate: true });
  const store = new ScreeningStore(c.env.DB);
  const item = await store.getItem(c.req.param('id'));
  if (!item) return c.json({ error: 'missing item' }, 404);
  const moved = await store.setItemState(item.id, item.revision, { state: 'owner', suggestion: body.data.suggestion });
  if (!moved) return c.json({ error: 'stale item' }, 409);
  await store.recordDecision({
    requestId: body.data.requestId, itemId: item.id, verdict: 'unsure', confidence: 0, evidenceQuote: item.urgencyQuote ?? '', explanation: body.data.note || body.data.suggestion,
    urgency: { tier: item.tier, deadline: item.deadline, signals: item.signals, quote: item.urgencyQuote }, model: 'escalate', calibrated: false, promptVersion: SCREENING_PROMPT_VERSION, contextHash: 'escalate', mode: 'shadow',
  });
  return c.json({ ok: true, duplicate: false });
});

const TEXT_LIMIT = 12000;

type QueueRow = {
  id: string; subject_kind: 'lead' | 'task'; subject_id: string; tier: 'P0' | 'P1' | 'P2' | 'P3'; discovered_at: string; deadline: string | null;
  origin: string | null; platform_id: string | null; lead_title: string | null; lead_url: string | null; lead_raw: string | null; lead_origin: string | null;
  candidate_id: string | null; raw_candidate_json: string | null; source_text: string | null;
};

function clipText(value: string, stripReview: boolean): { text: string; truncated: boolean } {
  const body = (stripReview ? value.split('[研判]')[0] : value).trim();
  return { text: body.slice(0, TEXT_LIMIT), truncated: body.length > TEXT_LIMIT };
}

function leadSubject(row: QueueRow, platforms: { id: string; name: string; aliases?: string[] }[]) {
  const clipped = clipText(row.lead_raw ?? '', true);
  const title = row.lead_title ?? '';
  const platformIds = platforms.filter(platform => platformMentioned(`${title}\n${clipped.text}`, platform)).map(platform => platform.id);
  return { kind: 'lead' as const, id: row.subject_id, leadId: Number(row.subject_id), title, url: row.lead_url ?? '', origin: row.lead_origin ?? row.origin, platformIds, ...clipped };
}

function taskSubject(row: QueueRow) {
  let title = '', url = '', platformId = row.platform_id;
  try {
    const parsed = JSON.parse(row.raw_candidate_json ?? '{}') as { title?: unknown; platformId?: unknown; evidence?: { url?: unknown } };
    if (typeof parsed.title === 'string') title = parsed.title;
    if (typeof parsed.evidence?.url === 'string') url = parsed.evidence.url;
    if (typeof parsed.platformId === 'string') platformId = parsed.platformId;
  } catch { /* a broken candidate payload still leaves the queue; the screener sees empty fields */ }
  return {
    kind: 'task' as const, id: row.subject_id, taskId: row.subject_id, candidateId: row.candidate_id, title, url, platformId,
    platformIds: platformId ? [platformId] : [], ...clipText(row.source_text ?? '', false),
  };
}

export const screeningAdminRoutes = new Hono<{ Bindings: Env; Variables: { role: 'admin' | 'reviewer'; who: string } }>();

screeningAdminRoutes.get('/urgent', async c => c.json(await urgentReviewQueue(c.env.DB)));
screeningAdminRoutes.post('/urgency', async c => {
  const input = z.object({ key: z.string().max(300), expectedVersion: z.string().length(64), suppressed: z.boolean() }).safeParse(await c.req.json().catch(() => null));
  if (!input.success) return c.json({ error: '需要当前卡片版本和排序选择' }, 400);
  const row = (await readUrgentReviews(c.env.DB)).find(row => row.key === input.data.key);
  if (!row || row.expired || row.version !== input.data.expectedVersion) return c.json({ error: '任务已处理、截止或内容变化，请刷新后重试' }, 409);
  // 偏好绑定此版本；并发产生的新版本不受旧请求影响。
  await c.env.DB.prepare(`INSERT INTO review_urgency_preferences(subject_key,subject_version,suppressed,actor,updated_at)
    VALUES(?,?,?,?,?) ON CONFLICT(subject_key) DO UPDATE SET subject_version=excluded.subject_version,
    suppressed=excluded.suppressed,actor=excluded.actor,updated_at=excluded.updated_at`).bind(row.key, row.version, Number(input.data.suppressed), c.get('who'), new Date().toISOString()).run();
  return c.json({ ok: true });
});

screeningAdminRoutes.get('/profiles/:platformId', async c => {
  const row = await c.env.DB.prepare('SELECT profile_json FROM platform_profiles WHERE platform_id=?').bind(c.req.param('platformId')).first<{ profile_json: string }>();
  if (!row) return c.json({ error: '没有这个平台画像' }, 404);
  return c.json({ profile: platformProfileSchema.parse(JSON.parse(row.profile_json)) });
});

screeningAdminRoutes.put('/profiles/:platformId', async c => {
  const body = z.object({ profile: platformProfileSchema, expectedRevision: z.number().int().nonnegative() }).safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: '平台画像格式不正确' }, 400);
  const saved = await putProfile(c.env.DB, c.req.param('platformId'), { ...body.data.profile, platformId: c.req.param('platformId') }, body.data.expectedRevision, c.get('who'));
  if (!saved) return c.json({ error: '平台画像已更新，请刷新后再保存' }, 409);
  return c.json({ ok: true, revision: body.data.expectedRevision + 1 });
});

/** Intake filter: owner-approved title rules that close junk leads on arrival (admin only; reviewers are not allow-listed). */
screeningAdminRoutes.get('/rules', async c => c.json({ rules: await listIntakeRules(c.env.DB), suggestions: await suggestIntakeRules(c.env.DB) }));
screeningAdminRoutes.post('/rules', async c => {
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  try {
    const rule = await createIntakeRule(c.env.DB, body, c.get('who'));
    const swept = rule.status === 'active' && body.applyToOpen === true ? await applyRuleToOpenLeads(c.env.DB, rule) : { closed: 0, more: false };
    return c.json({ rule, ...swept });
  } catch (error) {
    if (error instanceof RuleError) return c.json({ error: error.message, conflicts: error.conflicts }, error.status);
    throw error;
  }
});
screeningAdminRoutes.post('/rules/:id/apply', async c => {
  const rule = (await activeTitleRules(c.env.DB)).find(r => r.id === c.req.param('id'));
  if (!rule) return c.json({ error: '没有这条启用中的规则' }, 404);
  return c.json(await applyRuleToOpenLeads(c.env.DB, rule));
});
screeningAdminRoutes.post('/rules/:id/retire', async c => {
  const body = await c.req.json().catch(() => ({})) as { reason?: string };
  try { await retireIntakeRule(c.env.DB, c.req.param('id'), body.reason || '管理员停用', c.get('who')); return c.json({ ok: true }); }
  catch (error) { if (error instanceof RuleError) return c.json({ error: error.message }, error.status); throw error; }
});

/** Spot-check of leads the system closed by itself (admin only). */
screeningAdminRoutes.get('/spot-check', async c => c.json(await listAutoClosed(c.env.DB, Math.min(30, Math.max(1, Number(c.req.query('days') ?? 7) || 7)))));
screeningAdminRoutes.post('/spot-check/confirm', async c => {
  try { return c.json(await confirmAutoClosed(c.env.DB, await c.req.json().catch(() => null), c.get('who'))); }
  catch (error) { if (error instanceof z.ZodError) return c.json({ error: '抽查确认格式不正确（每次最多 15 条）' }, 400); throw error; }
});
screeningAdminRoutes.post('/spot-check/:id/wrong', async c => {
  const result = await markWronglyClosed(c.env.DB, Number(c.req.param('id')), c.get('who'));
  return result.ok ? c.json(result) : c.json({ error: '没有这条已关闭的线索' }, 404);
});
