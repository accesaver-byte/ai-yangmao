import * as YMModels from '../src/shared/model-names';
import * as YMMembership from '../src/shared/membership';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { parseHTML } from 'linkedom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/worker/index';
import { leadReviewVersion } from '../src/shared/lead-review';
import { validateVerdict, type VerdictContext } from '../src/shared/screening/validate';
import type { ScreeningVerdict } from '../src/shared/screening/types';
import { identityDb } from './fixtures/identity/db';
import { snapshot } from './fixtures/screening';

afterEach(() => {
  vi.doUnmock('../pipeline/screening/model');
  vi.doUnmock('../pipeline/screening/memory');
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

const none = { tier: 'P3' as const, deadline: null, signals: [] as const, quote: null };
const verdict = (over: Partial<ScreeningVerdict>): ScreeningVerdict => ({
  verdict: 'new_candidate', matchId: null, ruleId: null, reasonCategory: null, occurrenceCheck: null, confidence: 0.5,
  evidenceQuote: 'hello', explanation: 'x', urgency: none, ...over,
});
const ctx = (over: Partial<VerdictContext> = {}): VerdictContext => ({
  subjectText: 'hello world', supplied: new Map(), crossPlatformRefs: new Set(), subjectPlatformIds: [], activeRuleIds: new Set(), subjectDates: {}, deterministicUrgency: none, ...over,
});

function ingest(f: ReturnType<typeof identityDb>, body: unknown, env: Record<string, string> = {}) {
  return worker.fetch(new Request('https://local.test/api/ingest/leads', { method: 'POST', headers: { Authorization: 'Bearer ingest-test-token-123', 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), { DB: f.db, INGEST_TOKEN: 'ingest-test-token-123', ADMIN_TOKEN: 'admin-test-token-123456', ...env } as never, {} as ExecutionContext);
}
function admin(f: ReturnType<typeof identityDb>, path: string, body: unknown, env: Record<string, string> = {}) {
  return worker.fetch(new Request(`https://local.test/api/admin/${path}`, { method: 'POST', headers: { Authorization: 'Bearer admin-test-token-123456', 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), { DB: f.db, ADMIN_TOKEN: 'admin-test-token-123456', INGEST_TOKEN: 'ingest-test-token-123', ...env } as never, {} as ExecutionContext);
}

describe('screening review corrections', () => {
  it('closes an auto-mode non-AI rule with reason code not_ai', async () => {
    const f = identityDb();
    f.sqlite.prepare(`INSERT INTO screening_rules(id, kind, scope_kind, scope_value, category, description, pattern, status, created_at) VALUES ('r-non-ai', 'title_pattern', 'global', NULL, 'non_ai', '不是 AI 额度', '打车券', 'active', '2026-10-12T00:00:00.000Z')`).run();
    const response = await ingest(f, [{ origin: 'linuxdo', url: 'https://linux.do/t/taxi/1', title: '打车券免费领' }], { SCREENING_MODE: 'auto' });
    expect(response.status).toBe(200);
    expect(JSON.parse((f.sqlite.prepare(`SELECT resolution FROM leads WHERE url='https://linux.do/t/taxi/1'`).get() as any).resolution)).toMatchObject({ status: 'closed', reasonCode: 'not_ai', ruleId: 'r-non-ai' });
  });

  it('keeps a verdict when the urgency quote is missing and does not ask the model again', async () => {
    vi.resetModules();
    vi.stubEnv('SCREENING_PACE_MS', '0');
    vi.stubEnv('LLM_MIN_GAP_MS', '0');
    const model = vi.fn(async () => ({ text: JSON.stringify(verdict({ evidenceQuote: 'body', urgency: { tier: 'P0', deadline: null, signals: ['same_day_one_time'], quote: null } })), model: 'm', calibrated: false, paid: false, tokens: 1, costCny: 0 }));
    vi.doMock('../pipeline/screening/model', () => ({ callScreeningModel: model }));
    const { screenSubject } = await import('../pipeline/screening/screener');
    const result = await screenSubject({
      itemId: 'lead:1', kind: 'lead', origin: 'linuxdo', url: 'https://linux.do/t/x/1', title: 'title', text: 'body', truncated: false,
      platformIds: [], discoveredAt: '2026-10-12T00:00:00.000Z', deterministicUrgency: none,
    }, snapshot([]), { purpose: 'urgent', deadlineAt: Date.now() + 60_000 });
    expect(model).toHaveBeenCalledTimes(1);
    expect(result.verdict.verdict).toBe('new_candidate');
    expect(result.verdict.urgency.tier).toBe('P3');
    expect(result.downgradeReasons).toEqual(['urgency_quote_missing']);
  });

  it('rejects an empty evidence quote', () => {
    expect(validateVerdict(verdict({ evidenceQuote: '' }), ctx()).downgradeReasons).toContain('quote_not_verbatim');
  });

  it('dismisses a lead outside enforce mode without an identity closure', async () => {
    const f = identityDb();
    f.sqlite.prepare(`INSERT INTO leads(id, origin, url, status, title) VALUES (4, 'linuxdo', 'https://linux.do/t/x/4', 'reviewing', '待忽略')`).run();
    const row = f.sqlite.prepare('SELECT id, status, title, url, raw, resolution, offer_id AS offerId FROM leads WHERE id=4').get() as { id: number; status: string; title: string | null; url: string; raw: string | null; resolution: string | null; offerId: string | null };
    const response = await admin(f, 'leads/4/dismiss', { expectedVersion: leadReviewVersion({ ...row, createdAt: '', resolution: null }), reasonCategory: 'relay_station', reason: '中转站' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(f.sqlite.prepare('SELECT status FROM leads WHERE id=4').get()).toEqual({ status: 'rejected' });
    expect(f.sqlite.prepare('SELECT count(*) n FROM review_decisions').get()).toEqual({ n: 0 });
    expect(f.sqlite.prepare(`SELECT category, actor_kind, label_source FROM decision_labels WHERE subject_kind='lead' AND subject_id='4'`).get()).toEqual({ category: 'relay_station', actor_kind: 'owner', label_source: 'owner' });
  });

  it('accepts every reject-picker option', async () => {
    const { window, document } = parseHTML(`<html><body>${readFileSync('web/src/body.html', 'utf8')}</body></html>`);
    document.querySelector('#main')!.innerHTML = '<div id="admBody"></div><div id="identity"></div>';
    window.scrollTo = () => {};
    const context = createContext({
      YMModels, YMMembership, structuredClone, crypto, window, document, console, Intl, Date, Map, Set, URL, URLSearchParams, Response, FormData,
      location: { hash: '#admin' }, navigator: {}, getComputedStyle: () => ({ getPropertyValue: () => '' }),
      matchMedia: () => ({ matches: false, addEventListener() {} }), MutationObserver: class { observe() {} },
      localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
      setTimeout, clearTimeout, setInterval() {},
      fetch: async (url: string) => Response.json(String(url).includes('/leads') ? { leads: [{ id: 9, origin: 'linuxdo', url: 'https://linux.do/t/x/9', title: '线索', status: 'new', reviewVersion: 'v' }], total: 1, nextCursor: null } : String(url).includes('/platforms') ? { platforms: [] } : { pending: [{ id: 'offer-1', code: 'offer-1', platformId: 'vendor', platform: 'Vendor', title: '免费额度', type: '限时免费开放', value: '免费', end: '截止未知', status: 'active', reviewState: 'pending', requirements: ['none'], audience: 'all', claimMethod: 'auto', sourceTz: 'UTC', evidenceUrl: 'https://vendor.example', evidenceTier: 'docs', excerpts: {}, models: [], tags: [], modalities: ['text'], checks: [], steps: [] }], tasks: [], holds: [], counts: {} }),
    });
    const app = readFileSync('web/src/app.js', 'utf8');
    runInContext(readFileSync('web/src/data.js', 'utf8') + '\n' + readFileSync('web/src/membership.js', 'utf8') + '\n' + app.slice(0, app.indexOf('(async function boot()')), context);
    const run = (code: string) => runInContext(code, context);
    run(`PLATFORMS=[{id:'vendor',name:'Vendor',type:'lab'}];ADM.token='t';ADM.role='admin';ADM.tab='leads';`);
    run(`renderIdentityTasks(document.querySelector('#identity'), {tasks:[{id:'t1', kind:'initial', sources:[]}]})`);
    await run('admLeads()');
    const chips = run('RC.map(([code]) => code)') as string[];
    const offered = [...chips, ...[...document.querySelectorAll('[data-identity-category] option,[data-lead-category] option')].map(node => (node as HTMLOptionElement).value)]
      .filter((value): value is string => !!value);
    expect(offered.length).toBeGreaterThan(0);
    const f = identityDb();
    f.sqlite.prepare(`INSERT INTO offers(id, platform_id, title, type, modalities, claim_method, requirements, audience, value_text, end_kind, review_state, evidence, steps, tags) VALUES ('picker-offer', 'vendor', 'Visible offer', 'standing', '["text"]', 'signup', '["none"]', 'all', 'free', 'standing', 'pending', ?, '[]', '[]')`).run(JSON.stringify({ url: 'https://vendor.example/perk', tier: 'official', capturedAt: '2026-10-01T00:00:00.000Z', excerpts: {} }));
    for (const [index, category] of [...new Set(offered)].entries()) {
      const id = 20 + index;
      f.sqlite.prepare(`INSERT INTO leads(id, origin, url, status, title) VALUES (?, 'linuxdo', ?, 'new', '待分类')`).run(id, `https://linux.do/t/picker/${id}`);
      const row = f.sqlite.prepare('SELECT id, status, title, url, raw, resolution, offer_id AS offerId FROM leads WHERE id=?').get(id) as { id: number; status: string; title: string | null; url: string; raw: string | null; resolution: string | null; offerId: string | null };
      const dismissed = await admin(f, `leads/${id}/dismiss`, { expectedVersion: leadReviewVersion({ ...row, createdAt: '', resolution: null }), reasonCategory: category });
      expect(dismissed.status, category).toBe(200);
    }
  });

  it('treats a mistyped screening mode as off', async () => {
    vi.resetModules();
    vi.stubEnv('SCREENING_MODE', 'shadw');
    vi.stubEnv('API_BASE', 'https://screening.test');
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: unknown) => { urls.push(String(url)); return Response.json({ items: [] }); }));
    const { runScreening } = await import('../pipeline/screening/run');
    const stats = await runScreening({ deadlineAt: Date.now() + 60_000, dry: false });
    expect(stats.screened).toBe(0);
    expect(urls).toEqual([]);
    for (const file of ['pipeline/run.ts', 'pipeline/screening/run.ts']) {
      expect(readFileSync(file, 'utf8')).not.toMatch(/SCREENING_MODE\s*(?:\?\?|!==|&&)/);
    }
  });

  it('refuses to screen without an explicit API base', async () => {
    vi.resetModules();
    vi.stubEnv('SCREENING_MODE', 'shadow');
    vi.stubEnv('API_BASE', '');
    const urls: string[] = [];
    vi.doMock('../pipeline/screening/memory', () => ({ loadMemory: async () => snapshot([]) }));
    vi.stubGlobal('fetch', vi.fn(async (url: unknown) => { urls.push(String(url)); return Response.json({ items: [] }); }));
    const { runScreening } = await import('../pipeline/screening/run');
    await expect(runScreening({ deadlineAt: Date.now() + 60_000, dry: false })).rejects.toThrow(/explicit API_BASE required/);
    expect(urls).toEqual([]);
  });

  it('keeps the screening item id helper out of the worker', () => {
    expect(readFileSync('pipeline/screening/run.ts', 'utf8')).not.toMatch(/src\/worker/);
  });
});
