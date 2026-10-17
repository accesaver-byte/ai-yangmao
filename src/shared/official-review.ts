/** 自动复核只修改待审草稿/更新提案，不替代管理员批准。 */
export interface OfficialReview {
  status: 'checking' | 'matched' | 'unresolved' | 'failed';
  identityRevision?: number;
  jobId: string;
  inputVersion: string;
  originUrl: string;
  attempts: number;
  unresolvedAttempts?: number;
  checkedAt: string;
  nextAttemptAt: string | null;
  reason: string;
  queries: string[];
  candidates: string[];
  chosenUrl?: string;
  changedFields?: string[];
}
export interface OfficialPlatform {
  id: string; name: string; site: string | null;
  /** WeChat official-account __biz IDs, comma separated; other text in the field is ignored. */
  wechat?: string | null;
  xHandles: string[]; staffHandles: string[];
  /** Product names that also identify the platform (0043). */
  aliases?: string[] | null;
}
export interface OfficialSource { url: string; tier: string; platformId?: string | null }
type Activity = {title:string;valueText:string;type:string;tags?:string[]};
/** 搜到同一厂商不等于同一活动。金额/日期可以校正，但不能用月度套餐替换一次发放。 */
export function officialActivityMismatch(target:Activity,candidate:Activity): string|null {
  const family=(o:Activity)=>{
    const text=o.title+' '+o.valueText;
    if(o.tags?.includes('reset')||/重置卡|额度重置|banked reset|reset card/i.test(text))return 'reset';
    if(o.tags?.includes('referral')||/邀请奖励|推荐奖励|referral reward/i.test(text))return 'referral';
    if(o.type==='apply')return 'grant';
    if(o.type==='topup')return 'topup';
    if(o.type==='gift')return 'membership-gift';
    if(o.tags?.includes('daily')||/每日|每天|daily|per day|each day/i.test(text))return 'daily';
    if(/每月|monthly|per month|each month/i.test(text))return 'monthly';
    if(/每周|weekly|per week|each week/i.test(text))return 'weekly';
    if(o.type==='standing')return 'ongoing';
    return 'one-off';
  };
  const before=family(target),after=family(candidate);
  const labels:Record<string,string>={reset:'额度重置',referral:'邀请奖励',grant:'申请资助',topup:'充值赠额','membership-gift':'会员赠送',daily:'每日额度',monthly:'每月额度',weekly:'每周额度',ongoing:'常驻额度','one-off':'单次活动'};
  return before===after?null:`官方页面属于另一类活动（${labels[before]} → ${labels[after]}），不能替代原线索；需核对同一次发放或领取机制`;
}
export const OFFICIAL_REVIEW_LEASE_MS = 20 * 60_000;
export function officialReviewDue(review: OfficialReview | null, now: number, version: string): boolean {
  if (!review) return true;
  if (review.status === 'checking') return now - Date.parse(review.checkedAt) >= OFFICIAL_REVIEW_LEASE_MS;
  // 修改发生在任务执行期间也必须重新排队，不能拿完成时间掩盖新的输入。
  if (review.inputVersion !== version) return true;
  return !!review.nextAttemptAt && Date.parse(review.nextAttemptAt) <= now;
}
const hosted = new Set(['github.com','gitee.com','huggingface.co','medium.com','substack.com','mp.weixin.qq.com']);
/** The __biz account ID of a WeChat article URL, or null for short links and other hosts. */
export function wechatBiz(value: string | null | undefined): string | null {
  try { const url = new URL(value ?? ''); return url.hostname.toLowerCase() === 'mp.weixin.qq.com' ? url.searchParams.get('__biz') || null : null; } catch { return null; }
}
export const wechatAccounts = (field: string | null | undefined): string[] => (field ?? '').split(/[\s,，]+/).filter(token => /^[A-Za-z0-9+/]{10,}==$/.test(token));
export function officialTier(value: string, platform: OfficialPlatform, sources: OfficialSource[]): 'site'|'docs'|'official'|'staff'|null {
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  if (!['http:','https:'].includes(url.protocol) || url.username || url.password || (url.port && !['80','443'].includes(url.port))) return null;
  const host=url.hostname.toLowerCase().replace(/^www\./,'');
  if (['x.com','twitter.com'].includes(host)) {
    const m=url.pathname.match(/^\/([^/]+)\/status\/\d+\/?$/);
    if (!m) return null;
    const handle='@'+m[1].toLowerCase();
    if(platform.xHandles.some(h=>h.toLowerCase()===handle))return 'official';
    if(platform.staffHandles.some(h=>h.toLowerCase()===handle))return 'staff';
    return null;
  }
  if (host === 'mp.weixin.qq.com') { const biz = wechatBiz(url.href); if (biz && wechatAccounts(platform.wechat).includes(biz)) return 'official'; }
  const entries=[...sources.filter(s=>['site','docs','official'].includes(s.tier)),...(platform.site?[{url:platform.site,tier:'site'}]:[])];
  for(const entry of entries) {
    let base:URL;try{base=new URL(entry.url);}catch{continue;}
    const baseHost=base.hostname.toLowerCase().replace(/^www\./,'');
    if(host!==baseHost && !host.endsWith('.'+baseHost))continue;
    if(hosted.has(baseHost)) {
      if(baseHost==='mp.weixin.qq.com') { if(url.href!==base.href)continue; }
      else {
        const parts=base.pathname.split('/').filter(Boolean);
        // 共享托管不信任整站；GitHub/Gitee限已登记仓库，其他站限已登记路径。
        const prefix=parts.slice(0,['github.com','gitee.com'].includes(baseHost)?2:1).join('/');
        if(!prefix || !(url.pathname==='/'+prefix || url.pathname.startsWith('/'+prefix+'/')))continue;
        // 官方仓库内的 issue / PR / discussion 正文和评论可由任何用户提交。
        if (['github.com','gitee.com'].includes(baseHost) && (/^\/(issues|pull|pulls|discussions|wiki)(\/|$)/.test(url.pathname.slice(prefix.length+1)) || /(?:issue|discussion|pullrequest|commit)comment/i.test(url.hash))) continue;
        if (baseHost === 'huggingface.co' && /\/(discussions|community)(\/|$)/.test(url.pathname)) continue;
      }
    }
    return entry.tier==='docs' || /\b(docs|help|support)\b/.test(host) ? 'docs':'site';
  }
  return null;
}
