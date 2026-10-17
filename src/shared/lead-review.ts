export interface LeadResolution {
  status: 'checking'|'retry'|'manual'|'linked'|'closed';
  jobId: string;
  attempts: number;
  inconclusive: number;
  checkedAt: string;
  nextAttemptAt: string|null;
  reason: string;
  queries: string[];
  candidates: string[];
  offerIds?: string[];
  originOfferIds?: string[];
  identityTaskIds?: string[];
  identityCandidateIds?: string[];
  evidenceUrl?: string;
  quote?: string;
}
export interface ReviewableLead {id:number;status:string;url:string;title:string|null;raw:string|null;createdAt:string;resolution:LeadResolution|null;offerId?:string|null;originOfferId?:string|null;identityReadVersion?:string}
export const LEAD_LEASE_MS=20*60_000;
/** 自动复核只追最近 3 天的线索：更早的福利多已过期或已收录，反复重试只消耗模型与搜索额度（2026-10-15 管理员要求只追最新）。
 * 管理员补录和管理员手动“重新核验”的线索不受限；过期线索仍留在后台列表，不删除。 */
export const LEAD_REVIEW_MAX_AGE_MS=3*86400_000;
export const ADMIN_RETRY_REASON='管理员要求重新官方核验';
/** 公众号文章无法自动核验、交管理员一键快速上架的线索复核结论前缀（后台与 Telegram 提醒据此置顶）。 */
export const WECHAT_FAST_TRACK_REASON='原文是微信公众号文章';
export function leadReviewStale(l:{origin?:string;createdAt:string;resolution:LeadResolution|null},now=Date.now()):boolean {
  // 管理员“重新核验/重试”会把 attempts 归零；自动重试至少为 1。
  if(l.origin==='manual'||(l.resolution?.status==='retry'&&l.resolution.attempts===0)||l.resolution?.reason?.startsWith(ADMIN_RETRY_REASON))return false;
  const created=Date.parse(l.createdAt);return Number.isFinite(created)&&now-created>LEAD_REVIEW_MAX_AGE_MS;
}
export function leadReviewDue(l:ReviewableLead,now=Date.now()):boolean {
  if(l.status!=='reviewing')return false;
  const r=l.resolution;
  if(!r)return true;
  if(r.status==='checking')return now-Date.parse(r.checkedAt)>=LEAD_LEASE_MS;
  return r.status==='retry'&&!!r.nextAttemptAt&&Date.parse(r.nextAttemptAt)<=now;
}
export const leadReviewVersion=(l:ReviewableLead)=>{
  let hash=2166136261;
  for(const ch of JSON.stringify([l.status,l.title,l.url,l.raw,l.resolution])){hash^=ch.charCodeAt(0);hash=Math.imul(hash,16777619);}
  return `${l.id}-${(hash>>>0).toString(36)}`;
};
export function leadTask(l:ReviewableLead){
  return {id:l.id,title:l.title,url:l.url,status:l.status,createdAt:l.createdAt,offerId:l.offerId??null,originOfferId:l.originOfferId??l.offerId??null,
    note:l.resolution?.reason??l.raw?.split('[研判]').at(-1)?.slice(0,500)??null,
    resolution:l.resolution,reviewVersion:l.identityReadVersion??leadReviewVersion(l)};
}
