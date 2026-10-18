import {z} from 'zod';
import {sourceFetchSchema} from './identity/fetch-evidence';
import {officialStatusKey} from './dedupe';
import {xPostTime} from './lead-scope';
import {offerIn,type OfferIn} from './ingest';
import type {CanonicalTermsV1} from './identity/types';
export const AIHOT_RESET_SOURCE='aihot-resets';
export const AIHOT_RESET_URL='https://aihot.news/api/v1/codex-resets';
export const AIHOT_RESET_ACTOR='policy:aihot-codex-reset-v1';
export const aiHotResetInput=z.object({url:z.url(),sourceText:z.string().min(1).max(20000),sourceFetch:sourceFetchSchema,capturedAt:z.iso.datetime({offset:true})}).strict();
export type AiHotResetInput=z.infer<typeof aiHotResetInput>;
const day=(date:Date)=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/Los_Angeles',year:'numeric',month:'2-digit',day:'2-digit'}).format(date);
/** A deterministic template for independent announcements, never model-generated fields or progress replies. */
export function buildAiHotReset(input:AiHotResetInput):OfferIn {
 const key=officialStatusKey(input.url),id=key?.split('/').at(-1),at=xPostTime(input.url);
 if(!id||!key?.startsWith('x.com/thsottiaux/status/')||at==null)throw Error('不是登记的 Tibo 重置原帖');
 const lines=input.sourceText.split('\n');
 if(lines[0].toLowerCase()!=='@thsottiaux')throw Error('原帖作者不符');
 const timestamp=Date.parse(lines[1]);
 if(!Number.isFinite(timestamp)||Math.abs(timestamp-at)>60000)throw Error('发布时间与原帖 ID 不符');
 const body=lines.slice(2).join('\n').trim();
 const numbered=/\bday\s*(\d+)\s*\/[^\n]{0,30}\breset\b/i.exec(body);
 const banked=/\b(?:loading|issuing|giving|granting|adding)\b[\s\S]{0,180}\bbanked reset\b/i.test(body);
 if(!numbered&&!banked&&!/\bglobal reset\b/i.test(body))throw Error('只有进度、计划或未知重置形式，保留常规审核');
 if(/\b(?:no|not|never|cancelled|canceled|won't|might|may)\b.{0,40}\breset\b|\breset\b.{0,30}\b(?:every|daily|twice|two times|week|next week)\b|\b(?:every|daily|twice)\b.{0,30}\breset\b/i.test(body))throw Error('非确定单次重置，保留常规审核');
 if(/\breset\b[^.!?\n]{0,100}\b(?:not|never|no|cannot|won't|isn't|cancel\w*|might|may)\b/i.test(body))throw Error('已取消或不确定重置，保留常规审核');
 const schedule=body.replace(/\bsee you(?: again)? tomorrow\b/gi,'');
 const tomorrow=/(?:reset|land(?:ing)?|arriv(?:e|ing)|be there|available)[^.!?\n]{0,60}\btomorrow\b|\btomorrow\b[^.!?\n]{0,60}(?:reset|land(?:ing)?|arriv(?:e|ing))/i.test(schedule);
 const date=new Date(timestamp);if(tomorrow)date.setUTCDate(date.getUTCDate()+1);
 const eventDay=day(date),quote=body;
 const known=<T>(value:T)=>({state:'known' as const,value,evidenceRefs:['benefit']});
 const unknown={state:'unknown'} as const;
 const facts:CanonicalTermsV1={schemaVersion:'terms-v1',issuerProductId:known('openai'),mechanism:known('extra_reset'),benefitPools:[],eligibility:unknown,geography:unknown,claimChannels:unknown,costs:unknown,
  claimWindow:known({startsAt:eventDay,endsAt:eventDay,timezone:'America/Los_Angeles'}),occurrenceAnchor:{state:'known',value:lines[1],evidenceRefs:['publication']}};
 // The policy establishes a dated event. The primary quote remains the actual original text.
 const suffix=numbered?`Day ${numbered[1]} `:'';
 return offerIn.parse({id:`openai-aihot-reset-${id}`,platformId:'openai',sourceId:AIHOT_RESET_SOURCE,firstChannel:'aihot',identityFacts:facts,sourceText:input.sourceText,sourceFetch:input.sourceFetch,
  title:`Tibo ${suffix}Codex ${banked?'重置卡发放':'使用额度重置'}`,type:'perk',modalities:['text'],models:[],tags:['reset'],claimMethod:'auto',requirements:['net'],audience:'unclear',
  valueText:`Tibo 宣布${suffix}${banked?'发放一次可储存的额度重置卡':'一次 Codex 使用额度重置'}；具体适用账号与恢复后可用量以账号用量页面为准。`,
  claimStart:eventDay,claimEnd:eventDay,endKind:'date',sourceTz:'America/Los_Angeles',publishedAt:new Date(timestamp).toISOString(),creditValidity:null,steps:['登录 Codex，查看账号用量页面中的本轮重置结果。'],usdEstimate:null,usdMax:null,
  evidence:{url:input.url,tier:'staff',capturedAt:input.capturedAt,excerpts:{benefit:quote}},
  valuationFactors:{kind:'plan',price:{catalogId:'chatgpt-plus.amount'},billingPeriod:'month',benchmark:'plan_fraction',referencePlan:'ChatGPT Plus',denominator:{ruleId:'plan_fraction_quarter'},sources:[{id:'benefit',url:input.url,checkedAt:input.capturedAt,excerpt:quote,priceBasis:'管理员授权的单次重置套餐四分之一参照，非官方赠金面额'}]},
 });
}
