import {z} from 'zod';
import {sourceFetchSchema} from './identity/fetch-evidence';
import {officialStatusKey} from './dedupe';
import {xPostTime} from './lead-scope';
import {offerIn,type OfferIn} from './ingest';
import type {CanonicalTermsV1} from './identity/types';
export const AIHOT_RESET_SOURCE='aihot-resets';
export const AIHOT_RESET_URL='https://aihot.news/api/v1/codex-resets';
export const AIHOT_RESET_ACTOR='policy:aihot-codex-reset-v1';
/** An expected policy handoff, distinct from malformed evidence or a broken template. */
export class AiHotResetReviewRequired extends Error {}
const iso=z.iso.datetime({offset:true}),note=z.string().max(4000).nullish();
/** The part of an AIHOT codex-resets event the policy reads. Other upstream fields are dropped. */
export const aiHotEventSchema=z.object({
 id:z.string().min(1).max(200),type:z.string().max(40),status:z.string().max(40),title:z.string().max(300).nullish(),createdAt:iso,confirmedAt:iso.nullish(),
 schedule:z.object({precision:z.string().max(40).nullish(),from:iso.nullish(),through:iso.nullish()}).nullish(),
 posts:z.array(z.object({id:z.string().max(40),url:z.string().max(300),stage:z.string().max(40).nullish(),text:note,fullText:note,originalText:note,fullOriginalText:note,
  context:z.array(z.object({id:z.string().max(40).nullish(),author:z.string().max(80).nullish(),relation:z.string().max(20).nullish(),text:note,originalText:note})).max(10).nullish()})).min(1).max(30),
});
export type AiHotEvent=z.infer<typeof aiHotEventSchema>;
export const aiHotResetInput=z.object({url:z.url(),sourceText:z.string().min(1).max(20000),sourceFetch:sourceFetchSchema,capturedAt:z.iso.datetime({offset:true}),aihotEvent:aiHotEventSchema.optional()}).strict();
export type AiHotResetInput=z.infer<typeof aiHotResetInput>;
const day=(date:Date)=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/Los_Angeles',year:'numeric',month:'2-digit',day:'2-digit'}).format(date);
const fold=(text:string)=>text.normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu,'');
interface ResetReading {banked:boolean;number:string|null;eventDay:string;landsBy?:string}
/**
 * AIHOT's own reading of the event decides (admin rule 2026-10-22): employee English is too loose and figurative for
 * patterns ("but no, it's reset day" read as a denial on Day 17). The type, status and time come from AIHOT, the
 * Chinese note must state a reset, and the fetched post must be the one AIHOT describes. Anything else is reviewed.
 */
function readAiHotEvent(event:AiHotEvent,postId:string,body:string):ResetReading {
 const banked=event.type==='reset_credit';
 if(event.type!=='direct_reset'&&!banked)throw new AiHotResetReviewRequired(`AIHOT 事件类型 ${event.type} 不在自动范围，保留常规审核`);
 if(!['announced','confirmed'].includes(event.status))throw new AiHotResetReviewRequired(`AIHOT 事件状态 ${event.status} 不在自动范围，保留常规审核`);
 const handle=(url:string)=>officialStatusKey(url)?.split('/')[1];
 if(event.posts.some(p=>handle(p.url)!=='thsottiaux'))throw new AiHotResetReviewRequired('AIHOT 事件含非登记员工的帖子，保留常规审核');
 // Same-author reply parents are the announcement itself (Day 13); quoted posts may be an older round and stay out.
 const parents=event.posts.flatMap(p=>(p.context??[]).filter(c=>c.relation==='reply'&&c.author?.replace(/^@/,'').toLowerCase()==='thsottiaux'));
 const own=event.posts.find(p=>p.id===postId),parent=parents.find(c=>c.id===postId);
 const original=own?own.fullOriginalText||own.originalText:parent?.originalText;
 if(!own&&!parent)throw new AiHotResetReviewRequired('AIHOT 事件不包含这条原帖，保留常规审核');
 if(!original||!fold(body).includes(fold(original))&&!fold(original).includes(fold(body)))throw new AiHotResetReviewRequired('AIHOT 记录的原文与原帖不一致，保留常规审核');
 if(/^@(?!thsottiaux\b)\w+/i.test(body))throw new AiHotResetReviewRequired('员工回复他人的帖子，不是独立公告，保留常规审核');
 // AIHOT's Chinese title and notes together are its reading; a figurative post ("piggy bank") still says 重置 there.
 const notes=[event.title??'',...event.posts.map(p=>p.fullText||p.text||''),...parents.map(c=>c.text??'')].filter(Boolean).join('\n');
 if(!/重置/.test(notes))throw new AiHotResetReviewRequired('AIHOT 中文备注未写明重置，保留常规审核');
 if(/取消|推迟|延期|延后|暂停|改期|撤回|搁置|不确定|尚未确定|还没定|可能会|也许|或许/.test(notes))throw new AiHotResetReviewRequired('AIHOT 中文备注含取消、推迟或不确定，保留常规审核');
 if(/(?:不会|不再|没有|没|未|无法|不)(?:进行|再)?(?:重置|发卡)/.test(notes))throw new AiHotResetReviewRequired('AIHOT 中文备注否定了重置，保留常规审核');
 if(/下周|下次|下一次|以后|将来|改天|过几天/.test(notes))throw new AiHotResetReviewRequired('AIHOT 中文备注指向以后的重置，保留常规审核');
 if(/(?:每天|每日|每周|每月|每隔)[^。！？\n]{0,12}重置|重置[^。！？\n]{0,12}(?:每天|每日|每周|每月)/.test(notes))throw new AiHotResetReviewRequired('AIHOT 中文备注是周期安排，保留常规审核');
 if(/(?:昨天|(?<![送加附带])上次|之前|此前|前几天)[^。！？\n]{0,12}重置/.test(notes))throw new AiHotResetReviewRequired('AIHOT 中文备注提及既往重置，需核对是否为同轮次进度');
 // Confirmation time when AIHOT has one; a deadline ("before 10am") counts for the day it closes; otherwise the start.
 const s=event.schedule,at=event.confirmedAt?Date.parse(event.confirmedAt):s?.precision==='deadline'&&s.through?Date.parse(s.through)-1000:Date.parse(s?.from??s?.through??event.createdAt);
 const number=/\bday\s*(\d+)\s*\//i.exec(body)?.[1]??/第\s*(\d+)\s*天/.exec(notes)?.[1]??null;
 // Announced but not yet confirmed, with a landing deadline: coming soon until it lands (2026-10-23).
 const landsBy=event.status==='announced'&&!event.confirmedAt&&s?.precision==='deadline'&&s.through?new Date(Date.parse(s.through)).toISOString():undefined;
 return {banked,number,eventDay:day(new Date(at)),...(landsBy?{landsBy}:{})};
}
/** Older candidates carry no AIHOT event; their English post is read as before. */
function readStaffText(body:string,timestamp:number):ResetReading {
 // Employee announcements can include conversational text and line breaks before the reset.
 const numbered=/\bday\s*(\d+)\s*\/[\s\S]*?\breset\b/i.exec(body);
 const banked=/\b(?:loading|issuing|giving|granting|adding)\b[\s\S]{0,180}\bbanked reset\b/i.test(body);
 if(!numbered&&!banked&&!/\bglobal reset\b/i.test(body))throw new AiHotResetReviewRequired('只有进度、计划或未知重置形式，保留常规审核');
 // Check the whole sentence so admitting longer announcements cannot hide a distant denial.
 const statements=body.replace(/\.{2,}|…+/g,' ').replace(/\s+/g,' ');
 const nearbyUncertain=/\b(?:no|not|never|cancelled|canceled|won['’]t|might|may)\b.{0,40}\breset\b|\breset\b.{0,30}\b(?:every|daily|twice|two times|week|next week)\b|\b(?:every|daily|twice)\b.{0,30}\breset\b/i.test(body);
 if(nearbyUncertain||/\b(?:no|not|never|cancelled|canceled|won['’]t|might|may)\b[^.!?]*\breset\b|\breset\b[^.!?]*\b(?:every|daily|twice|two times|week|next week)\b|\b(?:every|daily|twice)\b[^.!?]*\breset\b/i.test(statements))throw new AiHotResetReviewRequired('非确定单次重置，保留常规审核');
 if(/\breset\b[^.!?]*\b(?:not|never|no|cannot|won['’]t|isn['’]t|cancel\w*|might|may)\b/i.test(statements))throw new AiHotResetReviewRequired('已取消或不确定重置，保留常规审核');
 if(/\b(?:yesterday|previous|last|earlier|prior)\b[^.!?]*\breset\b|\breset\b[^.!?]*\b(?:yesterday|previously|last night)\b/i.test(statements))throw new AiHotResetReviewRequired('提及既往重置，需核对是否为同轮次进度');
 const resetStatements=(statements.match(/[^.!?]+[.!?]?/g)??[]).filter(sentence=>/\breset\b/i.test(sentence));
 if(resetStatements.some(sentence=>sentence.endsWith('?')||/\b(?:any updates?|updates? on|status of|checking on|waiting for|awaiting|propagat\w*|rollout|rolling out|in progress)\b/i.test(sentence)))throw new AiHotResetReviewRequired('只有重置进度或提问，保留常规审核');
 const schedule=body.replace(/\bsee you(?: again)? tomorrow\b/gi,'');
 const tomorrow=/(?:reset|land(?:ing)?|arriv(?:e|ing)|be there|available)[^.!?\n]{0,60}\btomorrow\b|\btomorrow\b[^.!?\n]{0,60}(?:reset|land(?:ing)?|arriv(?:e|ing))/i.test(schedule);
 const date=new Date(timestamp);if(tomorrow)date.setUTCDate(date.getUTCDate()+1);
 return {banked,number:numbered?.[1]??null,eventDay:day(date)};
}
/** A deterministic template for independent announcements, never model-generated fields or progress replies. */
export function buildAiHotReset(input:AiHotResetInput):OfferIn {
 const key=officialStatusKey(input.url),id=key?.split('/').at(-1),at=xPostTime(input.url);
 if(!id||!key?.startsWith('x.com/thsottiaux/status/')||at==null)throw Error('不是登记的 Tibo 重置原帖');
 const lines=input.sourceText.split('\n');
 if(lines[0].toLowerCase()!=='@thsottiaux')throw Error('原帖作者不符');
 const timestamp=Date.parse(lines[1]);
 if(!Number.isFinite(timestamp)||Math.abs(timestamp-at)>60000)throw Error('发布时间与原帖 ID 不符');
 // The fetched post binds author, ID and time; AIHOT's event, when supplied, decides what it announces and when.
 const body=lines.slice(2).join('\n').trim(),quote=body;
 const {banked,number,eventDay,landsBy}=input.aihotEvent?readAiHotEvent(input.aihotEvent,id,body):readStaffText(body,timestamp);
 const known=<T>(value:T)=>({state:'known' as const,value,evidenceRefs:['benefit']});
 const unknown={state:'unknown'} as const;
 const facts:CanonicalTermsV1={schemaVersion:'terms-v1',issuerProductId:known('openai'),mechanism:known('extra_reset'),benefitPools:[],eligibility:unknown,geography:unknown,claimChannels:unknown,costs:unknown,
  claimWindow:known({startsAt:eventDay,endsAt:eventDay,timezone:'America/Los_Angeles'}),occurrenceAnchor:{state:'known',value:lines[1],evidenceRefs:['publication']}};
 // The policy establishes a dated event. The primary quote remains the actual original text.
 const suffix=number?`Day ${number} `:'';
 return offerIn.parse({id:`openai-aihot-reset-${id}`,platformId:'openai',sourceId:AIHOT_RESET_SOURCE,firstChannel:'aihot',identityFacts:facts,sourceText:input.sourceText,sourceFetch:input.sourceFetch,
  title:`Tibo ${suffix}Codex ${banked?'重置卡发放':'使用额度重置'}`,type:'perk',modalities:['text'],models:[],tags:['reset'],claimMethod:'auto',requirements:['net'],audience:'unclear',
  valueText:`Tibo 宣布${suffix}${banked?'发放一次可储存的额度重置卡':'一次 Codex 使用额度重置'}；具体适用账号与恢复后可用量以账号用量页面为准。`,
  claimStart:eventDay,claimEnd:eventDay,endKind:'date',sourceTz:'America/Los_Angeles',publishedAt:new Date(timestamp).toISOString(),creditValidity:null,steps:['登录 Codex，查看账号用量页面中的本轮重置结果。'],usdEstimate:null,usdMax:null,
  evidence:{url:input.url,tier:'staff',capturedAt:input.capturedAt,...(landsBy?{landsBy}:{}),excerpts:{benefit:quote}},
  valuationFactors:{kind:'plan',price:{catalogId:'chatgpt-plus.amount'},billingPeriod:'month',benchmark:'plan_fraction',referencePlan:'ChatGPT Plus',denominator:{ruleId:'plan_fraction_quarter'},sources:[{id:'benefit',url:input.url,checkedAt:input.capturedAt,excerpt:quote,priceBasis:'管理员授权的单次重置套餐四分之一参照，非官方赠金面额'}]},
 });
}
