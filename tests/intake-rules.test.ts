import { afterEach, beforeEach, expect, it } from 'vitest';
import worker from '../src/worker/index';
import { identityDb } from './fixtures/identity/db';
import { mineSuggestions, titleTerms } from '../src/worker/screening/intake-rules';

let f: ReturnType<typeof identityDb>;
beforeEach(() => { f = identityDb(); });
afterEach(() => f.sqlite.close());

const env = (mode = 'shadow') => ({ DB: f.db, ADMIN_TOKEN: 'intake-admin-token-001', INGEST_TOKEN: 'intake-ingest-token-01', REVIEWER_TOKENS: 'rev:intake-reviewer-token1', IDENTITY_MODE: 'enforce', SCREENING_MODE: mode }) as any;
async function call(path: string, body?: unknown, token = 'intake-admin-token-001', mode?: string) {
  const r = await worker.fetch(new Request('https://local.test/api/' + path, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }), env(mode), {} as any);
  return { status: r.status, body: await r.json() as any };
}
const ingest = (path: string, body?: unknown, mode?: string) => call('ingest/' + path, body, 'intake-ingest-token-01', mode);
const label = (id: number, category: string) => f.sqlite.prepare("INSERT INTO decision_labels(subject_kind,subject_id,category,actor_kind,label_source,justification,labeled_at) VALUES('lead',?,?,'owner','owner','管理员忽略线索',?)").run(String(id), category, new Date().toISOString());
const lead = (id: number, title: string, status = 'rejected', origin = 'linuxdo') => f.sqlite.prepare('INSERT INTO leads(id,origin,url,status,title) VALUES(?,?,?,?,?)').run(id, origin, `https://linux.do/t/topic/${id}`, status, title);

it('mines recurring title words from the owner\'s early rejections, never words seen in real perks', () => {
  expect([...titleTerms('外卖红包券 免费领')]).toEqual(expect.arrayContaining(['外卖', '红包券', '外卖红包券']));
  const labeled = [
    { id: 1, title: '美团外卖红包券每天领', origin: 'linuxdo', category: 'non_ai' as const },
    { id: 2, title: '饿了么外卖红包券合集', origin: 'linuxdo', category: 'non_ai' as const },
    { id: 3, title: '外卖红包券又来了 免费', origin: 'linuxdo', category: 'non_ai' as const },
    { id: 4, title: '免费 Claude 中转站 注册送额度', origin: 'linuxdo', category: 'relay_station' as const },
  ];
  const suggestions = mineSuggestions(labeled, ['Kimi 注册免费送额度', '免费领 Gemini 会员'], new Set());
  expect(suggestions[0]).toMatchObject({ category: 'non_ai', hits: 3, scopeKind: 'origin', scopeValue: 'linuxdo' });
  expect(suggestions[0].pattern).toMatch(/外卖|红包/);
  expect(suggestions.map(s => s.pattern)).not.toContain('免费');
  expect(suggestions.some(s => s.category === 'relay_station')).toBe(false); // one rejection is not a pattern
  const relays = ['【富可敌国】来试试 Haiku 5.5 回复 ID 送 $0.5', '【富可敌国】试试 Haiku 5.5 回复送 1 元', '【富可敌国】Haiku 5.5 回复 ID 送额度'].map((title, i) => ({ id: 10 + i, title, origin: 'linuxdo', category: 'relay_station' as const }));
  const named = mineSuggestions(relays, [], new Set(), ['Claude Haiku 5.5']).map(s => s.pattern);
  expect(named).toContain('富可敌国');
  expect(named.some(p => /haiku|回复/.test(p))).toBe(false);
});

it('an approved rule closes matching leads on arrival even in shadow mode, and can sweep the open backlog', async () => {
  for (const [i, t] of ['美团外卖红包券每天领', '饿了么外卖红包券合集', '外卖红包券又来了'].entries()) { lead(100 + i, t); label(100 + i, 'non_ai'); }
  lead(200, '外卖红包券 今日最新', 'new');
  lead(201, '智谱 GLM 免费额度', 'new');
  const listed = await call('admin/screening/rules');
  expect(listed.status).toBe(200);
  const sug = listed.body.suggestions.find((s: any) => s.category === 'non_ai');
  expect(sug).toBeTruthy();

  const created = await call('admin/screening/rules', { ...sug, applyToOpen: true });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  expect(created.body.closed).toBe(1);
  expect(f.sqlite.prepare('SELECT status FROM leads WHERE id=200').get()).toEqual({ status: 'rejected' });
  expect(f.sqlite.prepare('SELECT status FROM leads WHERE id=201').get()).toEqual({ status: 'new' });

  const arrived = await ingest('leads', [{ origin: 'linuxdo', url: 'https://linux.do/t/topic/300', title: '外卖红包券天天领' }, { origin: 'linuxdo', url: 'https://linux.do/t/topic/301', title: 'Kimi Code 免费试用' }]);
  expect(arrived.body).toMatchObject({ created: 2, filtered: 1 });
  expect(f.sqlite.prepare("SELECT status FROM leads WHERE url='https://linux.do/t/topic/300'").get()).toEqual({ status: 'rejected' });
  expect(f.sqlite.prepare("SELECT status FROM leads WHERE url='https://linux.do/t/topic/301'").get()).toEqual({ status: 'new' });
  expect(f.sqlite.prepare('SELECT hits FROM screening_rules WHERE id=?').get(created.body.rule.id)).toEqual({ hits: 2 });

  // Suggested once, decided: not suggested again.
  expect((await call('admin/screening/rules')).body.suggestions.some((s: any) => s.pattern === sug.pattern)).toBe(false);
  expect((await call(`admin/screening/rules/${created.body.rule.id}/retire`, { reason: '测试' })).status).toBe(200);
  const later = await ingest('leads', [{ origin: 'linuxdo', url: 'https://linux.do/t/topic/302', title: '外卖红包券又来' }]);
  expect(later.body.filtered).toBe(0);
});

it('refuses a rule that would hit a real perk, refuses non-content categories, and is admin only', async () => {
  lead(400, 'Kimi 免费额度活动', 'linked');
  const broad = await call('admin/screening/rules', { pattern: '免费额度', category: 'non_ai' });
  expect(broad.status).toBe(409);
  expect(broad.body.conflicts).toEqual(['Kimi 免费额度活动']);
  expect((await call('admin/screening/rules', { pattern: '重复帖', category: 'duplicate' })).status).toBe(400);
  expect((await call('admin/screening/rules', { pattern: '购物券', category: 'non_ai' }, 'intake-reviewer-token1')).status).toBe(403);
});

it('early content rejections reach the triage corrections; duplicates and unverifiable ones do not', async () => {
  lead(500, 'Claude 公益中转站 注册送 $50'); label(500, 'relay_station');
  lead(501, '豆包额度用完送重置'); label(501, 'unverifiable');
  const { body } = await ingest('corrections?limit=20');
  expect(body.corrections.some((l: string) => l.includes('Claude 公益中转站') && l.includes('中转站'))).toBe(true);
  expect(body.corrections.some((l: string) => l.includes('豆包额度用完送重置'))).toBe(false);
});

import { findNearDuplicate } from '../src/shared/screening/gate0';
it('gate0 never matches a lead against its own record (2026-10-21 #7675 self-match)', () => {
  const now = new Date();
  const record: any = { ref: 'lead:7675', kind: 'lead', platformId: null, origin: 'aihot', title: 'OpenAI 推出 Rosalind Academic Plan', valueText: null, type: null, claimStart: null, claimEnd: null, sourceTz: null, evidenceUrl: null, urlKey: 'aihot.example/rosalind', benefitExcerpt: null, decision: 'rejected', linkedOfferId: null, reasonCategory: 'non_ai', actorKind: 'owner', recurring: false, decidedAt: now.toISOString() };
  const memory: any = { generatedAt: now.toISOString(), records: [record], rules: [], profiles: [], calibrations: [] };
  const subject = { kind: 'lead' as const, url: 'https://aihot.example/rosalind', origin: 'aihot', platformId: null, title: 'OpenAI 推出 Rosalind Academic Plan', openingText: '' };
  expect(findNearDuplicate({ ...subject, ref: 'lead:7675' }, memory, now)).toBeNull();
  expect(findNearDuplicate({ ...subject, ref: 'lead:9999' }, memory, now)).not.toBeNull();
});
