import {z} from 'zod';
import {sourceFetchSchema} from './identity/fetch-evidence';
import {officialStatusKey} from './dedupe';
import {xPostTime} from './lead-scope';
import {offerIn,type OfferIn} from './ingest';
import type {CanonicalTermsV1} from './identity/types';
export type AiHotResetProduct='codex'|'antigravity'|'claude';
/** One AIHOT reset feed the admin authorized for auto-publish: Codex 2026-10-18; Antigravity and Claude 2026-11-22. */
export interface AiHotResetProfile {product:AiHotResetProduct;label:string;source:string;url:string;actor:string;extractionVersion:string;platformId:string;handles:readonly string[];authorizedOn:string}
export const AIHOT_RESET_PROFILES:Record<AiHotResetProduct,AiHotResetProfile>={
 codex:{product:'codex',label:'Codex',source:'aihot-resets',url:'https://aihot.news/api/v1/codex-resets',actor:'policy:aihot-codex-reset-v1',extractionVersion:'aihot-codex-reset-v1',platformId:'openai',handles:['thsottiaux'],authorizedOn:'2026-10-18'},
 antigravity:{product:'antigravity',label:'Antigravity',source:'aihot-antigravity-resets',url:'https://aihot.news/api/v1/antigravity-resets',actor:'policy:aihot-antigravity-reset-v1',extractionVersion:'aihot-antigravity-reset-v1',platformId:'google',handles:['_mohansolo'],authorizedOn:'2026-11-22'},
 claude:{product:'claude',label:'Claude',source:'aihot-claude-resets',url:'https://aihot.news/api/v1/claude-resets',actor:'policy:aihot-claude-reset-v1',extractionVersion:'aihot-claude-reset-v1',platformId:'anthropic',handles:['claudedevs','lydiahallie'],authorizedOn:'2026-11-22'},
};
export const AIHOT_RESET_SOURCE=AIHOT_RESET_PROFILES.codex.source;
export const AIHOT_RESET_URL=AIHOT_RESET_PROFILES.codex.url;
export const AIHOT_RESET_ACTOR=AIHOT_RESET_PROFILES.codex.actor;
const profiles=Object.values(AIHOT_RESET_PROFILES);
/** The source row must match a profile exactly (id, kind and URL); a lookalike source never inherits the authorization. */
export const aiHotResetProfileForSource=(source:{id:string;kind:string;url:string})=>source.kind==='aihot'?profiles.find(p=>p.source===source.id&&p.url===source.url)??null:null;
export const aiHotResetProfileForVersion=(version:string)=>profiles.find(p=>p.extractionVersion===version)??null;
/** An expected policy handoff, distinct from malformed evidence or a broken template. */
export class AiHotResetReviewRequired extends Error {}
const iso=z.iso.datetime({offset:true}),note=z.string().max(4000).nullish();
/** The part of an AIHOT reset event (all three feeds share the format) the policy reads. Other upstream fields are dropped. */
export const aiHotEventSchema=z.object({
 id:z.string().min(1).max(200),type:z.string().max(40),status:z.string().max(40),title:z.string().max(300).nullish(),createdAt:iso,confirmedAt:iso.nullish(),scope:z.string().max(200).nullish(),
 schedule:z.object({precision:z.string().max(40).nullish(),from:iso.nullish(),through:iso.nullish()}).nullish(),
 posts:z.array(z.object({id:z.string().max(40),url:z.string().max(300),stage:z.string().max(40).nullish(),text:note,fullText:note,originalText:note,fullOriginalText:note,
  context:z.array(z.object({id:z.string().max(40).nullish(),author:z.string().max(80).nullish(),relation:z.string().max(20).nullish(),text:note,originalText:note})).max(10).nullish()})).min(1).max(30),
});
export type AiHotEvent=z.infer<typeof aiHotEventSchema>;
export const aiHotResetInput=z.object({url:z.url(),sourceText:z.string().min(1).max(20000),sourceFetch:sourceFetchSchema,capturedAt:z.iso.datetime({offset:true}),aihotEvent:aiHotEventSchema.optional(),product:z.enum(['codex','antigravity','claude']).optional()}).strict();
export type AiHotResetInput=z.infer<typeof aiHotResetInput>;
const day=(date:Date)=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/Los_Angeles',year:'numeric',month:'2-digit',day:'2-digit'}).format(date);
// X 的 syndication 接口返回 HTML 实体（Day 23：「iCloud Main &amp; Calendar」），AIHOT 记录的是解码后的「&」；比较前先解码，否则实体里的字母会让原文比对失败。
const entities:Record<string,string>={amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' '};
const decodeEntities=(text:string)=>text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi,(m,e:string)=>e[0]==='#'?String.fromCodePoint(parseInt(e[1]==='x'||e[1]==='X'?e.slice(2):e.slice(1),e[1]==='x'||e[1]==='X'?16:10)):entities[e.toLowerCase()]??m);
const fold=(text:string)=>decodeEntities(text).normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu,'');
interface ResetReading {banked:boolean;number:string|null;eventDay:string;landsBy?:string;scope?:string}
/**
 * AIHOT's own reading of the event decides (admin rule 2026-10-22): employee English is too loose and figurative for
 * patterns ("but no, it's reset day" read as a denial on Day 17). The type, status and time come from AIHOT, the
 * Chinese note must state a reset, and the fetched post must be the one AIHOT describes. Anything else is reviewed.
 */
function readAiHotEvent(event:AiHotEvent,postId:string,body:string,profile:AiHotResetProfile):ResetReading {
 const banked=event.type==='reset_credit';
 if(event.type!=='direct_reset'&&!banked)throw new AiHotResetReviewRequired(`AIHOT 事件类型 ${event.type} 不在自动范围，保留常规审核`);
 if(!['announced','confirmed'].includes(event.status))throw new AiHotResetReviewRequired(`AIHOT 事件状态 ${event.status} 不在自动范围，保留常规审核`);
 const handle=(url:string)=>officialStatusKey(url)?.split('/')[1]??'',registered=(name:string)=>profile.handles.includes(name.replace(/^@/,'').toLowerCase());
 if(event.posts.some(p=>!registered(handle(p.url))))throw new AiHotResetReviewRequired('AIHOT 事件含非登记员工的帖子，保留常规审核');
 // Same-author reply parents are the announcement itself (Day 13); quoted posts may be an older round and stay out.
 const parents=event.posts.flatMap(p=>(p.context??[]).filter(c=>c.relation==='reply'&&!!c.author&&registered(c.author)));
 const own=event.posts.find(p=>p.id===postId),parent=parents.find(c=>c.id===postId);
 const original=own?own.fullOriginalText||own.originalText:parent?.originalText;
 if(!own&&!parent)throw new AiHotResetReviewRequired('AIHOT 事件不包含这条原帖，保留常规审核');
 if(!original||!fold(body).includes(fold(original))&&!fold(original).includes(fold(body)))throw new AiHotResetReviewRequired('AIHOT 记录的原文与原帖不一致，保留常规审核');
 const mention=/^@(\w+)/.exec(body)?.[1];
 if(mention&&!registered(mention))throw new AiHotResetReviewRequired('员工回复他人的帖子，不是独立公告，保留常规审核');
 // AIHOT's Chinese title and notes together are its reading; a figurative post ("piggy bank") still says 重置 there.
 const notes=[event.title??'',...event.posts.map(p=>p.fullText||p.text||''),...parents.map(c=>c.text??'')].filter(Boolean).join('\n');
 if(!/重置/.test(notes))throw new AiHotResetReviewRequired('AIHOT 中文备注未写明重置，保留常规审核');
 if(/取消|推迟|延期|延后|暂停|改期|撤回|搁置|不确定|尚未确定|还没定|可能会|也许|或许/.test(notes))throw new AiHotResetReviewRequired('AIHOT 中文备注含取消、推迟或不确定，保留常规审核');
 if(/(?:不会|不再|没有|没|未|无法|不)(?:进行|再)?(?:重置|发卡)/.test(notes))throw new AiHotResetReviewRequired('AIHOT 中文备注否定了重置，保留常规审核');
 if(/下周|下次|下一次|以后|将来|改天|过几天/.test(notes))throw new AiHotResetReviewRequired('AIHOT 中文备注指向以后的重置，保留常规审核');
 // Claude names its quotas "5 小时和每周的用量限额"; for the feeds added 2026-11-22 that limit name is not a schedule.
 const schedule=profile.product==='codex'?notes:notes.replace(/每周(?:的)?(?:用量|速率|使用)?(?:限额|限制|额度)/g,'限额');
 if(/(?:每天|每日|每周|每月|每隔)[^。！？\n]{0,12}重置|重置[^。！？\n]{0,12}(?:每天|每日|每周|每月)/.test(schedule))throw new AiHotResetReviewRequired('AIHOT 中文备注是周期安排，保留常规审核');
 if(/(?:昨天|(?<![送加附带])上次|之前|此前|前几天)[^。！？\n]{0,12}重置/.test(notes))throw new AiHotResetReviewRequired('AIHOT 中文备注提及既往重置，需核对是否为同轮次进度');
 // Confirmation time when AIHOT has one; a deadline ("before 10am") counts for the day it closes; otherwise the start.
 const s=event.schedule,at=event.confirmedAt?Date.parse(event.confirmedAt):s?.precision==='deadline'&&s.through?Date.parse(s.through)-1000:Date.parse(s?.from??s?.through??event.createdAt);
 // Tibo numbers his rounds ("Day 15 /"); the other feeds have no such series.
 const number=profile.product!=='codex'?null:/\bday\s*(\d+)\s*\//i.exec(body)?.[1]??/第\s*(\d+)\s*天/.exec(notes)?.[1]??null;
 // Announced but not yet confirmed, with a landing deadline: coming soon until it lands (2026-10-23).
 const landsBy=event.status==='announced'&&!event.confirmedAt&&s?.precision==='deadline'&&s.through?new Date(Date.parse(s.through)).toISOString():undefined;
 const scope=event.scope?.trim();
 return {banked,number,eventDay:day(new Date(at)),...(landsBy?{landsBy}:{}),...(scope?{scope}:{})};
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
const months=['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
/** "Use it anytime before December 10 at 2:00PM PT" → the last day a banked reset can be used, on or after the issue day. */
function useByDay(body:string,eventDay:string):string|null {
 const m=/\b(?:before|by|until|through)\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b/i.exec(body);
 if(!m)return null;
 const date=(year:number)=>`${year}-${String(months.indexOf(m[1].toLowerCase())+1).padStart(2,'0')}-${m[2].padStart(2,'0')}`,year=Number(eventDay.slice(0,4));
 const value=date(year)<eventDay?date(year+1):date(year);
 return new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value?value:null;
}
const monthDay=(value:string)=>`${Number(value.slice(5,7))} 月 ${Number(value.slice(8,10))} 日`;
/** A deterministic template for independent announcements, never model-generated fields or progress replies. */
export function readAiHotReset(input:AiHotResetInput):{offer:OfferIn;scope?:string} {
 const profile=AIHOT_RESET_PROFILES[input.product??'codex'],codex=profile.product==='codex';
 const key=officialStatusKey(input.url),id=key?.split('/').at(-1),author=key?.split('/')[1]??'',at=xPostTime(input.url);
 if(!id||!profile.handles.includes(author)||at==null)throw Error(codex?'不是登记的 Tibo 重置原帖':`不是登记的 ${profile.label} 重置原帖`);
 const lines=input.sourceText.split('\n');
 if(lines[0].toLowerCase()!=='@'+author)throw Error('原帖作者不符');
 const timestamp=Date.parse(lines[1]);
 if(!Number.isFinite(timestamp)||Math.abs(timestamp-at)>60000)throw Error('发布时间与原帖 ID 不符');
 // The fetched post binds author, ID and time; AIHOT's event, when supplied, decides what it announces and when.
 const body=lines.slice(2).join('\n').trim(),quote=body;
 // Reading the English post alone is kept only for Codex candidates saved before AIHOT events (2026-10-22).
 if(!input.aihotEvent&&!codex)throw new AiHotResetReviewRequired('没有 AIHOT 事件判定，保留常规审核');
 const {banked,number,eventDay,landsBy,scope}=input.aihotEvent?readAiHotEvent(input.aihotEvent,id,body,profile):readStaffText(body,timestamp);
 if(banked&&profile.product==='antigravity')throw new AiHotResetReviewRequired('Antigravity 重置卡没有自动模板，保留常规审核');
 // A Claude reset card stays usable until the date the post gives; without one the listing would never end.
 const useBy=banked&&profile.product==='claude'?useByDay(body,eventDay):null;
 if(banked&&profile.product==='claude'&&!useBy)throw new AiHotResetReviewRequired('Claude 重置卡未写明使用期限，保留常规审核');
 const claimEnd=useBy??eventDay;
 const known=<T>(value:T)=>({state:'known' as const,value,evidenceRefs:['benefit']});
 const unknown={state:'unknown'} as const;
 const facts:CanonicalTermsV1={schemaVersion:'terms-v1',issuerProductId:known(profile.platformId),mechanism:known('extra_reset'),benefitPools:[],eligibility:unknown,geography:unknown,claimChannels:unknown,costs:unknown,
  claimWindow:known({startsAt:eventDay,endsAt:claimEnd,timezone:'America/Los_Angeles'}),occurrenceAnchor:{state:'known',value:lines[1],evidenceRefs:['publication']}};
 const common={platformId:profile.platformId,sourceId:profile.source,firstChannel:'aihot',identityFacts:facts,sourceText:input.sourceText,sourceFetch:input.sourceFetch,
  type:'perk',modalities:['text'],models:[],tags:['reset'],claimMethod:'auto',requirements:['net'],claimStart:eventDay,claimEnd,endKind:'date',sourceTz:'America/Los_Angeles',publishedAt:new Date(timestamp).toISOString(),creditValidity:null,usdEstimate:null,usdMax:null};
 const evidence=(tier:'staff'|'official')=>({url:input.url,tier,capturedAt:input.capturedAt,...(landsBy?{landsBy}:{}),excerpts:{benefit:quote}});
 if(codex){
  // The policy establishes a dated event. The primary quote remains the actual original text.
  const suffix=number?`Day ${number} `:'';
  return {offer:offerIn.parse({id:`openai-aihot-reset-${id}`,...common,
   title:`Tibo ${suffix}Codex ${banked?'重置卡发放':'使用额度重置'}`,audience:'unclear',
   valueText:`Tibo 宣布${suffix}${banked?'发放一次可储存的额度重置卡':'一次 Codex 使用额度重置'}；具体适用账号与恢复后可用量以账号用量页面为准。`,
   steps:['登录 Codex，查看账号用量页面中的本轮重置结果。'],evidence:evidence('staff'),
   valuationFactors:{kind:'plan',price:{catalogId:'chatgpt-plus.amount'},billingPeriod:'month',benchmark:'plan_fraction',referencePlan:'ChatGPT Plus',denominator:{ruleId:'plan_fraction_quarter'},sources:[{id:'benefit',url:input.url,checkedAt:input.capturedAt,excerpt:quote,priceBasis:'管理员授权的单次重置套餐四分之一参照，非官方赠金面额'}]},
  }),...(scope?{scope}:{})};
 }
 // Only Codex has an authorized valuation rule; the other feeds publish without an estimate.
 const audience=/\b(?:everyone|everybody|all (?:users|accounts|plans))\b/i.test(body)?'all':'unclear',offerId=`${profile.platformId}-aihot-${profile.product}-reset-${id}`;
 if(profile.product==='antigravity')return {offer:offerIn.parse({id:offerId,...common,audience,
  title:`Antigravity 使用额度重置（${monthDay(eventDay)}）`,
  valueText:'Varun Mohan 宣布一次 Antigravity 使用额度重置；具体适用账号与恢复后可用量以账号用量页面为准。',
  steps:['打开 Antigravity，在用量页面查看本轮重置后的额度。'],evidence:evidence('staff')}),...(scope?{scope}:{})};
 const who=author==='claudedevs'?'Claude 官方':'Anthropic 员工 Lydia Hallie';
 return {offer:offerIn.parse({id:offerId,...common,audience,
  title:useBy?`Claude 免费重置卡发放（${monthDay(useBy)}前使用）`:`Claude 用量限额重置（${monthDay(eventDay)}）`,
  valueText:useBy?`${who}宣布发放一次可自选时间使用的用量重置，须在太平洋时间 ${monthDay(useBy)}截止前使用；适用套餐见资格要求，具体以 Claude 用量页面为准。`:`${who}宣布一次 Claude 用量限额重置；适用账号与恢复后可用量以 Claude 用量页面为准。`,
  steps:useBy?['登录 Claude，在 Settings → Usage 查看可用的重置。',`在太平洋时间 ${monthDay(useBy)}截止前选择使用重置。`]:['登录 Claude，在 Settings → Usage 查看重置后的用量限额。'],
  evidence:evidence(author==='claudedevs'?'official':'staff')}),...(scope?{scope}:{})};
}
export const buildAiHotReset=(input:AiHotResetInput):OfferIn=>readAiHotReset(input).offer;
