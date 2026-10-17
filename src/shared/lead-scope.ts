import {officialTier,type OfficialPlatform,type OfficialSource} from './official-review';
import {normUrl} from './dedupe';
import {zonedTime} from './lifecycle';

// Product nouns are not brands. Latin aliases need token boundaries (e.g. xAI != AI).
const generic=new Set(['ai','api','app','code','cloud','studio','portal','pro','free','model','models','cn','international','中国','国内','国际版']);
// Product aliases (platforms.aliases) count too: a lead that only says “ZCode” or “海螺AI” names its platform (2026-10-15).
export function platformMentioned(text:string,platform:Pick<OfficialPlatform,'id'|'name'|'aliases'>):boolean {
 text=text.replace(/https?:\/\/[^\s<>"）)]+/gi,' ');
 const aliases=[platform.id,platform.name,...platform.name.split(/[（）()\/·、\s]+/),...(platform.aliases??[])];
 return aliases.some(raw=>{
  const name=raw.normalize('NFKC').trim().toLowerCase();
  if(name.length<2||generic.has(name))return false;
  const escaped=name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  const pattern=/^[a-z0-9 _-]+$/.test(name)?`(?<![a-z0-9])${escaped}(?![a-z0-9])`:escaped;
  return new RegExp(pattern,'iu').test(text.normalize('NFKC'));
 });
}
type Lead={url:string;title:string|null;raw:string|null};
type Candidate={title:string;valueText:string;type:string;requirements?:string[];evidence:{url:string;excerpts?:Record<string,string|undefined>}};
const signals:Record<string,RegExp>={
 student:/学生|教师|在校|教育认证|student|teacher|education/i,
 reset:/重置|reset/i,referral:/邀请|推荐奖励|referral|invite/i,
 daily:/签到|每日|每天|daily|check.?in|per day/i,
 startup:/创业|初创|startups?|founders?/i,
 oss:/开源|open.source|\boss\b/i,
 cashback:/返现|消费返利|cashback/i,
};
/** Fail closed on a candidate that cannot be tied to the original lead. Search hits are not identity evidence. */
export function leadScopeMismatch(lead:Lead,platform:OfficialPlatform,sources:OfficialSource[],candidate:Candidate):string|null {
 const original=`${lead.title??''}\n${(lead.raw??'').split('[研判]')[0]}`;
 const direct=!!officialTier(lead.url,platform,sources);
 const urls=original.match(/https?:\/\/[^\s<>"）)]+/g)??[];
 const linked=urls.some(url=>!!officialTier(url,platform,sources));
 if(!direct&&!linked&&!platformMentioned(original,platform))return '原线索未指向该发放平台，不能用搜索到的其他福利替代';
 if(!direct&&/号池|账号池|账号买卖|账号转售|API\s*转售|中转站|account\s*pool/i.test(original))return '原线索涉及中转或账号转售，不能改抽模型厂商的无关活动';
 const targetKinds=Object.entries(signals).filter(([,pattern])=>pattern.test(original)).map(([kind])=>kind);
 const candidateText=`${candidate.title}\n${candidate.valueText}\n${candidate.requirements?.join(' ')??''}\n${Object.values(candidate.evidence.excerpts??{}).join(' ')}`;
 const nextKinds=Object.entries(signals).filter(([,pattern])=>pattern.test(candidateText)).map(([kind])=>kind);
 // An exact official landing page may legitimately reveal previously unstated conditions.
 const exactOfficial=direct&&normUrl(lead.url)===normUrl(candidate.evidence.url);
 if(nextKinds.some(kind=>!targetKinds.includes(kind))&&!exactOfficial)return '候选活动的资格或领取机制未出现在原线索中，需人工核对活动身份';
 if(targetKinds.length&&!targetKinds.some(kind=>nextKinds.includes(kind)))return '候选与原线索的活动机制不同';
 return null;
}

const HOUR=3600_000;
/** X 帖子 ID 是 snowflake，高位即发帖毫秒时间；非 X 帖子地址返回 null。 */
export function xPostTime(url:string):number|null {
 const id=/^https?:\/\/(?:www\.)?(?:x|twitter)\.com\/[^/]+\/status\/(\d{15,20})/.exec(url)?.[1];
 return id?Number((BigInt(id)>>22n)+1288834974657n):null;
}
/** 线索指向的事件时间：X 原帖用发帖时间，其余用入库时间。 */
export function leadEventTime(lead:{url:string;createdAt?:string|null}):number|null {
 const own=xPostTime(lead.url);if(own!=null)return own;
 const at=lead.createdAt?Date.parse(lead.createdAt):NaN;return Number.isFinite(at)?at:null;
}
type Occurrence={title:string;valueText:string;tags?:string[]|null;claimStart?:string|null;claimEnd?:string|null;publishedAt?:string|null;sourceTz?:string|null};
/**
 * 不同日期的额度重置是独立活动（通用规则第 82 条）。把线索关联到已有重置条目前，线索事件必须落在该轮次附近：
 * 开始前 36 小时（预告）到截止日结束后 24 小时（到账确认）。2026-10-15 Day 10 重置的两条回复被模型并入 10 月 10 日、12 日旧轮次。
 * 不知道时区时（只有去重索引）按 UTC 并多放宽 14 小时；没有任何日期时不判断。
 */
export function leadOccurrenceMismatch(lead:{url:string;createdAt?:string|null},offer:Occurrence):string|null {
 if(!(offer.tags?.includes('reset')||/重置|reset/i.test(`${offer.title} ${offer.valueText}`)))return null;
 const at=leadEventTime(lead);if(at==null)return null;
 const tz=offer.sourceTz||'UTC',slack=offer.sourceTz?0:14*HOUR,published=offer.publishedAt?Date.parse(offer.publishedAt):NaN;
 const lastDay=offer.claimEnd??offer.claimStart;
 const starts=[offer.claimStart?zonedTime(offer.claimStart,'00:00:00',tz).getTime()-slack:NaN,published].filter(Number.isFinite);
 const ends=[lastDay?zonedTime(lastDay,'23:59:59',tz).getTime()+slack:NaN,published].filter(Number.isFinite);
 if(!starts.length||!ends.length)return null;
 if(at>=Math.min(...starts)-36*HOUR&&at<=Math.max(...ends)+24*HOUR)return null;
 return `线索事件时间 ${new Date(at).toISOString()} 不在已有重置活动（${offer.claimStart??'?'}至${lastDay??'?'}）的同一轮次范围内，不同日期的重置不能并入旧条目`;
}
