/** 信源健康判断（后台健康页、公开覆盖统计共用）。 */
export const SOURCE_STALE_MS = 12 * 3600_000;
export interface SourceHealthInput { failStreak: number; lastOkAt: string | null; lastError?: string | null; createdAt?: string | null }
/**
 * 失效：连续失败 3 次；成功过但超过 12 小时没有再成功；从未成功且已经失败过，或登记超过 12 小时仍未成功。
 * 刚登记、还没轮到采集的信源不算失效（2026-10-16：新登记的 38 个信源在首轮采集前就被报成“超过 12 小时未成功”）。
 */
export function sourceUnhealthy(x: SourceHealthInput, now = Date.now()): boolean {
  if (x.failStreak >= 3) return true;
  if (x.lastOkAt) return now - Date.parse(x.lastOkAt) > SOURCE_STALE_MS;
  if (x.failStreak >= 1) return true;
  const created = x.createdAt ? Date.parse(x.createdAt) : NaN;
  return !Number.isFinite(created) || now - created > SOURCE_STALE_MS;
}
/** 告警里给人看的原因。 */
export function sourceHealthReason(x: SourceHealthInput, now = Date.now()): string {
  if (x.failStreak >= 3) return `连续失败 ${x.failStreak} 次：${x.lastError ?? '原因未记录'}`;
  if (x.lastOkAt) return `${Math.round((now - Date.parse(x.lastOkAt)) / 3600_000)} 小时未成功${x.lastError ? '：' + x.lastError : ''}`;
  if (x.failStreak >= 1) return `登记后从未成功：${x.lastError ?? '原因未记录'}`;
  return '登记超过 12 小时仍未采集到';
}
