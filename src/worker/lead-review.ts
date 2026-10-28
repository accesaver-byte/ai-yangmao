import {closeIdentityLead} from './identity/lead-closure';
import { aggregateIdentityLead } from './identity/leads';
import {leadScopeMismatch,leadOccurrenceMismatch} from '../shared/lead-scope';
import {normUrl} from '../shared/dedupe';
import {Hono} from 'hono';
import {drizzle} from 'drizzle-orm/d1';
import {and,eq,sql} from 'drizzle-orm';
import {z} from 'zod';
import * as s from '../db/schema';
import {leadPriority} from '../shared/leads';
import {LEAD_TECHNICAL_RETRY_LIMIT,leadReviewDue,leadReviewStale,type LeadResolution} from '../shared/lead-review';
import {officialTier} from '../shared/official-review';
import type {Env} from './index';
import { readUrgentReview, readUrgentReviews, urgentFirst } from './screening/urgent-review';
import { verificationRetryDelayMs, verificationWindowEndsAt } from '../shared/screening/urgency';
const db=(env:Env)=>drizzle(env.DB,{schema:s});
export const leadReviewRoutes=new Hono<{Bindings:Env}>();
leadReviewRoutes.get('/queue',async c=>{
  const limit=Math.max(1,Math.min(10,Number(c.req.query('limit'))||4));
  const ids=(c.req.query('ids')??'').split(',').filter(Boolean).map(Number);
  const urgency = new Map((await readUrgentReviews(c.env.DB)).filter(r=>r.kind==='lead').map(r=>[Number(r.id),r]));
  const rows=(await db(c.env).select().from(s.leads).where(eq(s.leads.status,'reviewing')))
    .filter(l=>(!ids.length||ids.includes(l.id))&&leadReviewDue(l)&&(ids.length>0||!leadReviewStale(l)))
    .sort((a,b)=>{const ua=urgency.get(a.id),ub=urgency.get(b.id);return (ua&&ub?urgentFirst(ua,ub):0)||leadPriority(a)-leadPriority(b)||(a.resolution?.attempts??0)-(b.resolution?.attempts??0)||a.id-b.id;});
  const selected=rows.slice(0,limit);
  if(limit>=4&&rows.length>limit){const oldest=[...rows].sort((a,b)=>a.id-b.id)[0];if(!selected.includes(oldest))selected[limit-1]=oldest;}
  return c.json({jobs:selected.map(l=>({id:l.id,title:l.title})),remaining:rows.length});
});
leadReviewRoutes.post('/:id/claim',async c=>{
  const d=db(c.env),[l]=await d.select().from(s.leads).where(eq(s.leads.id,Number(c.req.param('id'))));
  if(!l||!leadReviewDue(l))return c.json({claimed:false});
  const resolution:LeadResolution={status:'checking',jobId:crypto.randomUUID(),attempts:(l.resolution?.attempts??0)+1,inconclusive:l.resolution?.inconclusive??0,
    checkedAt:new Date().toISOString(),nextAttemptAt:null,reason:'正在读取原文并搜索官方出处',queries:[],candidates:[],offerIds:l.resolution?.offerIds??[]};
  const changed=await d.update(s.leads).set({resolution}).where(and(eq(s.leads.id,l.id),eq(s.leads.status,'reviewing'),
    sql`COALESCE(${s.leads.resolution},'')=COALESCE(${l.resolution?JSON.stringify(l.resolution):null},'')`)).returning({id:s.leads.id});
  if(!changed.length)return c.json({claimed:false});
  const platforms=await d.select().from(s.platforms).where(eq(s.platforms.status,'approved'));
  const sources=await d.select({platformId:s.sources.platformId,url:s.sources.url,tier:s.sources.tier}).from(s.sources);
  const existing=await d.select({id:s.offers.id,platformId:s.offers.platformId,title:s.offers.title,valueText:s.offers.valueText,claimStart:s.offers.claimStart,claimEnd:s.offers.claimEnd,sourceTz:s.offers.sourceTz,tags:s.offers.tags,publishedAt:s.offers.publishedAt,reviewState:s.offers.reviewState,evidenceUrl:sql<string>`json_extract(${s.offers.evidence},'$.url')`}).from(s.offers);
  return c.json({claimed:true,jobId:resolution.jobId,lead:l,platforms,sources,existing,previousCandidates:l.resolution?.candidates??[]});
});
leadReviewRoutes.post('/:id/result',async c=>{
  const body=z.object({jobId:z.string().uuid(),outcome:z.enum(['linked','closed','retry','manual']),manualNow:z.boolean().optional(),deferred:z.boolean().optional(),reason:z.string().min(2).max(1000),
    offerIds:z.array(z.string()).max(50).default([]),queries:z.array(z.string().max(350)).max(4),candidates:z.array(z.url()).max(12),
    evidenceUrl:z.url().optional(),quote:z.string().max(2000).optional(),sourceText:z.string().max(250000).optional()}).safeParse(await c.req.json().catch(()=>null));
  if(!body.success)return c.json({error:'线索复核结果不完整'},400);
  const b=body.data,d=db(c.env),[l]=await d.select().from(s.leads).where(eq(s.leads.id,Number(c.req.param('id'))));
  if(!l||l.resolution?.jobId!==b.jobId||l.status!=='reviewing')return c.json({error:'线索已由其他操作处理，请刷新'},409);
  if(l.resolution.status!=='checking')return c.json({ok:true,status:l.resolution.status,nextAttemptAt:l.resolution.nextAttemptAt});
  // 关联到线索之前就存在的重置条目时，线索必须属于同一轮次；否则降为人工处理，不能把新一轮重置并入旧条目（2026-10-15）。
  const staleRounds:string[]=[];
  for(const id of [...b.offerIds]){
    const [offer]=await d.select().from(s.offers).where(eq(s.offers.id,id));
    if(!offer)return c.json({error:'关联条目尚未入库'},400);
    const stale=offer.createdAt<l.createdAt?leadOccurrenceMismatch(l,offer):null;
    if(stale){staleRounds.push(stale);b.offerIds=b.offerIds.filter(x=>x!==id);continue;}
    const [platform]=await d.select().from(s.platforms).where(eq(s.platforms.id,offer.platformId));
    const sources=await d.select().from(s.sources).where(eq(s.sources.platformId,offer.platformId));
    const mismatch=platform?leadScopeMismatch(l,platform,sources,offer):'发放平台不存在';
    if(mismatch)return c.json({error:mismatch},400);
  }
  if(staleRounds.length&&b.outcome==='linked'&&!b.offerIds.length){b.outcome='manual';b.reason=`${staleRounds[0]}；${b.reason}`.slice(0,1000);}
  if(b.outcome==='linked'&&!b.offerIds.length)return c.json({error:'缺少关联条目'},400);
  if(b.outcome==='closed'){
    const platforms=await d.select().from(s.platforms).where(eq(s.platforms.status,'approved'));
    const sources=await d.select({platformId:s.sources.platformId,url:s.sources.url,tier:s.sources.tier}).from(s.sources);
    const norm=(v:string)=>v.replace(/\s+/g,' ').trim().toLowerCase();
    if(!b.evidenceUrl||normUrl(b.evidenceUrl)!==normUrl(l.url)||!b.quote||b.quote.trim().length<12||!b.sourceText||!norm(b.sourceText).includes(norm(b.quote))
      ||!platforms.some(p=>officialTier(b.evidenceUrl!,p,sources.filter(x=>x.platformId===p.id))))return c.json({error:'结束线索需要可信官方原文与具体依据'},400);
  }
  const identity=await aggregateIdentityLead(c.env.DB,l.id);
  if(identity)return c.json({ok:true,identityHandled:true,...identity,status:identity.status==='linked'?'linked':identity.status==='rejected'?'closed':identity.deferredIds.length?'retry':'manual'});
  const old=l.resolution,now=Date.now();
  const inconclusive=old.inconclusive+(b.outcome==='manual'?1:0);
  // manualNow：自动核验不可能成功（如微信公众号文章），不再等三次无结论，立即交管理员。
  let status=b.outcome==='manual'&&inconclusive<3&&!b.manualNow?'retry':b.outcome;
  const urgent=status==='retry'?await readUrgentReview(c.env.DB,`lead:${l.id}`,new Date(now)):undefined;
  const tier=urgent&&!urgent.suppressed&&!urgent.expired?urgent.tier:'P3';
  const verifyUntil=(tier==='P0'||tier==='P1')?Date.parse(verificationWindowEndsAt({tier,discoveredAt:l.createdAt,deadline:urgent?.deadline??null,now:new Date(l.createdAt)})):null;
  if(status==='retry'&&(urgent?.expired||(verifyUntil!=null&&verifyUntil<=now))) status='manual';
  // 抓取失败、模型输出无效等技术性受阻不计入 inconclusive；连续受阻达到上限就交人工，不再空耗模型与搜索额度（2026-10-28 管理员确认）。
  // 模型额度耗尽而推迟（deferred）不是这条线索的问题，不计次。
  const blocked=status==='retry'&&b.outcome==='retry'&&!b.deferred&&old.attempts>=LEAD_TECHNICAL_RETRY_LIMIT;
  if(blocked){status='manual';b.reason=`自动复核连续 ${old.attempts} 次受阻，请人工判断：${b.reason}`.slice(0,1000);}
  const delayHours=leadPriority(l)<=1?1:Math.min(24,2**Math.min(5,old.attempts-1));
  const resolution:LeadResolution={status,jobId:b.jobId,attempts:old.attempts,inconclusive,checkedAt:new Date(now).toISOString(),
    nextAttemptAt:status==='retry'?new Date(Math.min(verifyUntil??Infinity,now+((tier==='P0'||tier==='P1')?verificationRetryDelayMs(tier,old.attempts):delayHours*3600_000))).toISOString():null,
    reason:status==='manual'?'已转为线索审核任务：'+b.reason:b.reason,queries:b.queries,candidates:b.candidates,
    offerIds:[...new Set([...(old.offerIds??[]),...b.offerIds])],evidenceUrl:b.evidenceUrl,quote:b.quote};
  if(c.env.IDENTITY_MODE==='enforce'&&status==='closed'){await closeIdentityLead(c.env.DB,l,resolution,b.sourceText!);return c.json({ok:true,status:'closed',nextAttemptAt:null,identityHandled:true});}
  const changed=await d.update(s.leads).set({resolution,status:status==='linked'?'linked':status==='closed'?'rejected':'reviewing',offerId:resolution.offerIds?.[0]??l.offerId})
    .where(and(eq(s.leads.id,l.id),eq(s.leads.status,'reviewing'),sql`json_extract(${s.leads.resolution},'$.jobId')=${b.jobId}`,sql`json_extract(${s.leads.resolution},'$.status')='checking'`)).returning({id:s.leads.id});
  return changed.length?c.json({ok:true,status,nextAttemptAt:resolution.nextAttemptAt}):c.json({error:'线索已被其他操作处理'},409);
});
