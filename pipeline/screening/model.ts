import { BudgetExhaustedError, reserveModel, settleModel, type ModelPrice } from '../budget';
import { DeferError, pace, providerCall } from '../llm';
import type { Calibration } from '../../src/shared/screening/types';

let nextScreeningCall = 0;
async function screeningPace() {
  const gap = Number(process.env.SCREENING_PACE_MS ?? 4000);
  const start = Math.max(Date.now(), nextScreeningCall);
  nextScreeningCall = start + Math.max(0, gap);
  const wait = start - Date.now();
  if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
  await pace();
}

function retryable(error: unknown): boolean {
  const status = (error as { httpStatus?: number }).httpStatus;
  // 404/400 from one model is that model's provider (e.g. 2026-10-21 Nvidia "Function not found"): try the next model
  // instead of aborting the whole fallback chain. Auth (401/403) still stops.
  return status === 429 || status === 404 || status === 400 || status === 408 || (status != null && status >= 500);
}

function reserveOptions(model: string, purpose: 'urgent' | 'normal' | 'backfill') {
  if (model === 'openrouter/free' || model.endsWith(':free')) return { line: 'screening' as const, pool: 'openrouter-free' as const, purpose };
  return { line: 'screening' as const, purpose };
}

type Attempt = { text: string; model: string; tokens: number; prompt: number; completion: number; usageKnown: boolean; costCny: number };

async function openRouter(model: string, system: string, user: string, timeoutMs: number): Promise<Attempt> {
  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENROUTER_API_KEY ?? ''}` },
    body: JSON.stringify({ model, temperature: 0.1, max_tokens: 1024, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw Object.assign(new Error(`openrouter ${response.status}`), { httpStatus: response.status });
  const body = await response.json() as { model?: string; choices?: { message?: { content?: string } }[]; usage?: { total_tokens?: number; prompt_tokens?: number; completion_tokens?: number } };
  const usage = body.usage;
  return {
    text: body.choices?.[0]?.message?.content ?? '', model: body.model || model, tokens: usage?.total_tokens ?? 0, prompt: usage?.prompt_tokens ?? 0, completion: usage?.completion_tokens ?? 0, costCny: 0,
    usageKnown: Number.isFinite(usage?.total_tokens) && Number.isFinite(usage?.prompt_tokens) && Number.isFinite(usage?.completion_tokens),
  };
}

async function attempt(provider: string, model: string, system: string, user: string, purpose: 'urgent' | 'normal' | 'backfill', price: ModelPrice | undefined, call: () => Promise<Attempt>): Promise<Attempt | null> {
  let reservation;
  try {
    reservation = await reserveModel(provider, system, user, price, reserveOptions(model, purpose));
  } catch (error) {
    if (error instanceof BudgetExhaustedError && error.message.includes('pool_exhausted')) {
      if (purpose !== 'urgent') throw new DeferError('screening model unavailable');
      return null;
    }
    throw error;
  }
  try {
    const result = await call();
    if (!result.usageKnown) return { ...result, tokens: reservation.tokens, costCny: reservation.costCny };
    const costCny = price ? (result.prompt * price.in + result.completion * price.out) / 1e6 : 0;
    await settleModel(reservation, provider, result.tokens, costCny);
    return { ...result, costCny };
  } catch (error) {
    const status = (error as { httpStatus?: number }).httpStatus;
    if (status) await settleModel(reservation, provider, 0, 0);
    if (!retryable(error)) throw error;
    return null;
  }
}

export async function callScreeningModel(i: { system: string; user: string; purpose: 'urgent' | 'normal' | 'backfill'; deadlineAt: number; calibrations: Calibration[] }): Promise<{ text: string; model: string; calibrated: boolean; paid: boolean; tokens: number; costCny: number }> {
  const active = i.calibrations.filter(item => item.status === 'active').sort((a, b) => b.closePrecision - a.closePrecision);
  const pinned = (process.env.SCREENING_MODELS ?? '').split(',').map(item => item.trim()).filter(Boolean);
  const models = [...new Set([...active.map(item => item.model), ...pinned, 'openrouter/free'])];
  const timeout = Math.max(1000, i.deadlineAt - Date.now());
  await screeningPace();
  for (const model of models) {
    const result = await attempt('openrouter', model, i.system, i.user, i.purpose, undefined, () => openRouter(model, i.system, i.user, timeout));
    if (result) return { text: result.text, model: result.model, calibrated: active.some(item => item.model === result.model), paid: false, tokens: result.tokens, costCny: result.costCny };
  }
  if (process.env.GEMINI_API_KEY) {
    const model = process.env.GEMINI_MODEL || 'gemini-flash-lite-latest';
    const result = await attempt('gemini', model, i.system, i.user, i.purpose, undefined, async () => {
      const called = await providerCall('gemini', i.system, i.user, timeout);
      return { text: called.text, model, tokens: called.tokens, prompt: 0, completion: 0, usageKnown: called.usageKnown, costCny: 0 };
    });
    if (result) return { text: result.text, model: result.model, calibrated: active.some(item => item.model === result.model), paid: false, tokens: result.tokens, costCny: result.costCny };
  }
  if (i.purpose === 'urgent' && process.env.SCREENING_PAID_MODEL) {
    const paidModel = process.env.SCREENING_PAID_MODEL;
    const price = { in: Number(process.env.SCREENING_PAID_PRICE_IN ?? 0), out: Number(process.env.SCREENING_PAID_PRICE_OUT ?? 0) };
    try {
      const result = await attempt('openrouter', paidModel, i.system, i.user, 'urgent', price, () => openRouter(paidModel, i.system, i.user, timeout));
      if (result) return { text: result.text, model: result.model, calibrated: active.some(item => item.model === result.model), paid: true, tokens: result.tokens, costCny: result.costCny };
    } catch (error) {
      if (error instanceof DeferError) throw error;
      throw new DeferError(`screening model unavailable: ${(error as Error).message}`);
    }
  }
  throw new DeferError('screening model unavailable');
}
