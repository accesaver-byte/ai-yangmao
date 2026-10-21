import { afterEach, expect, it, vi } from 'vitest';
import { validateVerdict } from '../src/shared/screening/validate';

const none = { tier: 'P3', deadline: null, signals: [], quote: null } as const;
const ctx = { subjectText: '美团外卖红包券天天领 满20减5', supplied: new Map(), crossPlatformRefs: new Set<string>(), subjectPlatformIds: [], activeRuleIds: new Set<string>(), subjectDates: {}, deterministicUrgency: none } as any;
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.resetModules(); });

// 2026-10-21: 509 of 535 shadow verdicts were schema_invalid — the prompt never named the fields — so every judgement became unsure.
it('a verdict that omits only optional fields is kept', () => {
  const r = validateVerdict({ verdict: 'not_a_perk', reasonCategory: 'non_ai', confidence: 0.9, evidenceQuote: '美团外卖红包券天天领' }, ctx);
  expect(r.downgradeReasons).toEqual([]);
  expect(r.verdict).toMatchObject({ verdict: 'not_a_perk', matchId: null, urgency: none });
});
it('a verdict without the judgement fields is still rejected', () => {
  expect(validateVerdict({ answer: 'unsure', reason: '外卖券' }, ctx).downgradeReasons).toEqual(['schema_invalid']);
});
it('a 404 from one model falls through to the next instead of aborting', async () => {
  vi.stubEnv('OPENROUTER_API_KEY', 'k'); vi.stubEnv('API_BASE', 'https://mock.local'); vi.stubEnv('SCREENING_MODELS', 'broken/model:free'); vi.stubEnv('SCREENING_PACE_MS', '0'); vi.stubEnv('LLM_MIN_GAP_MS', '0');
  const tried: string[] = [];
  vi.stubGlobal('fetch', async (url: string, init?: any) => {
    if (url.includes('/model-budget/reserve')) return Response.json({ reservationId: 'r', tokens: 1, costCny: 0 });
    if (url.includes('/model-budget/')) return Response.json({ ok: true });
    const model = JSON.parse(init.body).model; tried.push(model);
    if (model === 'broken/model:free') return new Response('{"error":{"code":404}}', { status: 404 });
    return Response.json({ model: 'fallback:free', choices: [{ message: { content: '{"verdict":"unsure"}' } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
  });
  const { callScreeningModel } = await import('../pipeline/screening/model');
  const r = await callScreeningModel({ system: 's', user: 'u', purpose: 'normal', deadlineAt: Date.now() + 30000, calibrations: [] });
  expect(tried).toEqual(['broken/model:free', 'openrouter/free']);
  expect(r.model).toBe('fallback:free');
});
