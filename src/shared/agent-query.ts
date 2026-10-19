import { z } from 'zod';
import { modelMatches, normalizeModelNames } from './model-names';
import { claimEndAt, isClaimable, liveStatus, OFFER_TYPES } from './lifecycle';
import { matchMembership, migrateLegacyMembership, type MembershipCatalog, type MembershipRequirement } from './membership';
import { haoScore, type ScoreInput } from './score';
import { parseValuation, valuationMatchesAmounts } from './valuation';

const string = () => z.string().trim().min(1).max(200);
const requirementKeys = () => z.array(z.enum(['none','unknown','phone','card','net','student','biz','invite','realname','pay','member','targeted'])).max(20);
const subscription = z.object({
  planId: string(), billingCycle:z.enum(['monthly','annual']).optional(), seatType:string().optional(), region:string().optional(),
  startedOn:z.iso.date().optional(), trial:z.boolean().optional(), legacy:z.boolean().optional(),
}).strict();
export const agentProfileSchema = z.object({
  phone:z.boolean().describe('是否有海外手机号；省略为未知').optional(), card:z.boolean().describe('是否有可用的海外信用卡 / PayPal；省略为未知').optional(), net:z.boolean().describe('是否能使用海外网络').optional(), student:z.boolean().describe('是否具备学生认证资格').optional(),
  biz:z.boolean().optional(), invite:z.boolean().optional(), realname:z.boolean().optional(), pay:z.boolean().optional(),
  targeted:z.boolean().optional(), newUser:z.boolean().optional(), subscriptions:z.array(subscription).max(20).optional(),
  subscriptionsComplete:z.boolean().describe('只有用户明确这是完整会员清单时才传 true；未提及的会员默认未知').optional(),
}).strict();
export const agentSearchSchema = z.object({
  q:string().optional(), platform:string().optional(), model:string().optional(),
  modality:z.enum(['text','code','image','video','audio']).optional(), type:z.enum(OFFER_TYPES).optional(),
  claimMethod:z.enum(['auto','signup','app','form','topup','member','code']).optional(),
  status:z.enum(['claimable','all','active','ending','standing','open','upcoming','ended','stale']).default('claimable'),
  endsWithinDays:z.number().int().min(0).max(365).optional(),
  requirement:z.enum(['zero','nooversea','nopay','special']).optional(), requires:requirementKeys().optional(), excludes:requirementKeys().optional(),
  valuationMethod:z.enum(['official','scenario','unknown']).optional(),
  sort:z.enum(['score','new','end','value']).default('score'), limit:z.number().int().min(1).max(50).default(10),
  offset:z.number().int().min(0).max(10000).default(0), profile:agentProfileSchema.optional(),
  eligibility:z.enum(['all','eligible','ineligible','unknown']).default('all'),
}).strict();
export type AgentSearch = z.infer<typeof agentSearchSchema>;
export type AgentOffer = ScoreInput & {
  id:string; platformId:string; platform:string; title:string; valueText:string; models:string[]; tags:string[]; modalities:string[];
  audience:string; steps:string[]; creditValidity:string|null; membershipRequirement?:MembershipRequirement|null;
  evidence:ScoreInput['evidence'] & {url:string; excerpts:Record<string,string|undefined>};
  discoveredAt:string; lastVerifiedAt:string|null; link?:string;
  sourceDegraded?:boolean;
};
export type Eligibility = 'eligible'|'ineligible'|'unknown';

export function qualifyOffer(o:AgentOffer, profile:AgentSearch['profile'], catalog:MembershipCatalog,now=new Date()) {
  const failed:string[]=[], unknown:string[]=[];
  for (const requirement of o.requirements) {
    const key=requirement.split(':')[0];
    if(key==='none'||key==='member')continue;
    if(key==='unknown'){unknown.push('官方未明确领取条件');continue;}
    const value=profile?.[key as keyof z.infer<typeof agentProfileSchema>];
    if(value===false)failed.push(requirement);
    else if(value!==true)unknown.push(requirement);
  }
  if(!o.requirements.length)unknown.push('领取条件尚未明确');
  if(o.audience==='unclear')unknown.push('适用对象尚未明确');
  else if(o.audience==='new'||o.audience==='old') {
    if(profile?.newUser===undefined)unknown.push(o.audience==='new'?'仅新用户':'仅老用户');
    else if(profile.newUser!==(o.audience==='new'))failed.push(o.audience==='new'?'仅新用户':'仅老用户');
  }
  const membership=o.membershipRequirement??migrateLegacyMembership(o.requirements,catalog);
  if(membership.status!=='not_required') {
    let result=profile?.subscriptions===undefined?'unknown':matchMembership(membership,profile.subscriptions,catalog);
    if(result==='no'&&profile?.subscriptions?.length&&!profile.subscriptionsComplete)result='unknown';
    if(result==='no')failed.push('未满足会员资格');
    if(result==='unknown')unknown.push(membership.status==='needs_review'
      ? '活动已批准；旧会员条件尚未自动匹配，请按原条件核对'
      : '会员资格还需确认');
  }
  if(o.sourceDegraded)unknown.push('只读快照中的资格待重新确认');
  if(o.lastVerifiedAt&&Date.parse(o.lastVerifiedAt)>now.getTime()+300_000)unknown.push('核验时间晚于当前时间，需重新确认');
  return {status:(failed.length?'ineligible':unknown.length?'unknown':'eligible') as Eligibility, reasons:[...failed,...unknown]};
}
function valueOf(o:AgentOffer) {
  const value=parseValuation(o.valuation);
  return o.type!=='apply' && value && valuationMatchesAmounts(value,o) && ['priced','provisional'].includes(value.status)
    ? {amount:value.usdEstimate,group:value.method==='scenario'?'scenario':'official'} : {amount:null,group:'unknown'};
}

export function searchAgentOffers(offers:AgentOffer[],catalog:MembershipCatalog,q:AgentSearch,now=new Date()) {
  const lower=(v:string)=>v.toLocaleLowerCase('en');
  const has=(o:AgentOffer,keys:string[])=>o.requirements.some(r=>keys.includes(r.split(':')[0]))
    || (keys.includes('member')&&o.membershipRequirement?.status!=='not_required'&&!!o.membershipRequirement);
  const valueGroup=(o:AgentOffer)=>valueOf(o).group;
  let rows=offers.filter(o=> {
    const status=liveStatus(o,now), end=claimEndAt(o);
    if(q.status==='claimable'?!isClaimable(status):q.status!=='all'&&q.status!==status)return false;
    if(q.platform&&!([o.platformId,o.platform].some(v=>lower(v)===lower(q.platform!))))return false;
    if(q.type&&q.type!==o.type||q.claimMethod&&q.claimMethod!==o.claimMethod)return false;
    if(q.modality&&!o.modalities.some(m=>m===q.modality||['text','code'].includes(m)&&['text','code'].includes(q.modality!)))return false;
    if(q.model&&!o.models.some(m=>modelMatches(m,q.model!)))return false;
    if(q.q&&!lower([o.title,o.valueText,o.platform,...o.models,...o.tags].join(' ')).includes(lower(q.q))&&!o.models.some(m=>modelMatches(m,q.q!)))return false;
    if(q.endsWithinDays!==undefined&&(!end||end<now||end.getTime()-now.getTime()>q.endsWithinDays*86400_000))return false;
    if(q.valuationMethod&&valueGroup(o)!==q.valuationMethod)return false;
    if(q.requires&&!q.requires.every(k=>has(o,[k])))return false;
    if(q.excludes&&has(o,q.excludes))return false;
    if(q.requirement==='zero'&&(!o.requirements.length||!o.requirements.every(r=>r==='none')||has(o,['member'])||o.audience!=='all'))return false;
    if(q.requirement==='nooversea'&&has(o,['phone','card','net','unknown']))return false;
    if(q.requirement==='nopay'&&has(o,['pay','member','unknown']))return false;
    if(q.requirement==='special'&&!has(o,['student','biz','invite','targeted','member']))return false;
    return true;
  }).map(o=>({...o,models:normalizeModelNames(o.models),status:liveStatus(o,now),score:haoScore(o,now),eligibility:qualifyOffer(o,q.profile,catalog,now)}));
  if(q.eligibility!=='all')rows=rows.filter(o=>o.eligibility.status===q.eligibility);
  const counts={eligible:0,ineligible:0,unknown:0}; rows.forEach(o=>counts[o.eligibility.status]++);
  rows.sort((a,b)=> {
    let delta=0;
    if(q.sort==='score')delta=b.score-a.score;
    else if(q.sort==='new')delta=Date.parse(b.discoveredAt)-Date.parse(a.discoveredAt);
    else if(q.sort==='end')delta=(claimEndAt(a)?.getTime()??Infinity)-(claimEndAt(b)?.getTime()??Infinity);
    else {
      const va=valueOf(a),vb=valueOf(b);
      delta=(vb.amount??-Infinity)-(va.amount??-Infinity);
    }
    return (Number.isNaN(delta)?0:delta)||a.id.localeCompare(b.id,'en');
  });
  const page=rows.slice(q.offset,q.offset+q.limit);
  return {total:rows.length,offset:q.offset,limit:q.limit,nextOffset:q.offset+page.length<rows.length?q.offset+page.length:null,
    offers:page,counts,groups:{eligible:page.filter(o=>o.eligibility.status==='eligible'),ineligible:page.filter(o=>o.eligibility.status==='ineligible'),unknown:page.filter(o=>o.eligibility.status==='unknown')}};
}
