import { api } from './lib';

// 推理型模型（DeepSeek Flash、openrouter/free 路由到的思考模型）先消耗输出额度思考；4096 时常见 finish=length 且正文为空（2026-10-15）。
export const MODEL_OUTPUT_LIMIT = 8192;
export class BudgetExhaustedError extends Error {}
export class BudgetLedgerError extends Error {}

export interface ModelPrice { in: number; out: number }
export interface ModelReservation { id: number; tokens: number; costCny: number }

/** UTF-8 字节数是文本 token 的保守上界，再加最大输出和协议余量。 */
export async function reserveModel(provider: string, system: string, user: string, price?: ModelPrice, opts?: { line?: 'extraction' | 'screening'; pool?: 'openrouter-free'; purpose?: 'urgent' | 'normal' | 'backfill' }): Promise<ModelReservation> {
  const inputCeiling = Buffer.byteLength(system + user, 'utf8') + 1024;
  const tokens = inputCeiling + MODEL_OUTPUT_LIMIT;
  const costCny = price ? (inputCeiling * price.in + MODEL_OUTPUT_LIMIT * price.out) / 1e6 : 0;
  try {
    const result = await api<{ id: number }>('/model-budget/reserve', { provider, tokens, costCny, line: opts?.line, pool: opts?.pool, purpose: opts?.purpose });
    return { id: result.id, tokens, costCny };
  } catch (error) {
    throw new BudgetExhaustedError(`模型预算无法预留：${(error as Error).message}`);
  }
}

export async function settleModel(reservation: ModelReservation, provider: string, tokens: number, costCny: number): Promise<void> {
  try {
    await api(`/model-budget/${reservation.id}/settle`, { provider, tokens, costCny });
  } catch (error) {
    throw new BudgetLedgerError(`模型用量未能入账，预留余额仍被占用：${(error as Error).message}`);
  }
}

/** 按固定费用预留（如联网搜索插件按次计费），与模型调用共用月度付费上限。 */
export async function reserveFixed(provider: string, costCny: number): Promise<ModelReservation> {
  try {
    const result = await api<{ id: number }>('/model-budget/reserve', { provider, tokens: 0, costCny });
    return { id: result.id, tokens: 0, costCny };
  } catch (error) {
    throw new BudgetExhaustedError(`搜索预算无法预留：${(error as Error).message}`);
  }
}

export const modelBudget = { reserve: reserveModel, settle: settleModel };
