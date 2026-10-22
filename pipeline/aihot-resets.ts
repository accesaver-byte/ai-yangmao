import {api,fetchPage} from './lib';
import {fetchedSource} from './fetch-evidence';
import type {AiHotLead,Source} from './collectors';
import {AIHOT_RESET_SOURCE,AIHOT_RESET_URL,aiHotEventSchema,buildAiHotReset,AiHotResetReviewRequired,type AiHotResetInput} from '../src/shared/aihot-reset';
interface ResetReceipt {outcome:string;candidateId?:string;offerId?:string;reason?:string}
/** Run immediately after discoveries persist; independent of model budgets and ordinary lead queue size. */
export async function publishAiHotResets(source:Source,leads:AiHotLead[],options:{dry:boolean;log:(...args:unknown[])=>void;canContinue?:()=>boolean;resume?:boolean}){
 const stats={published:0,manual:0,failed:0,manualReasons:[] as {subject:string;reason:string}[],errors:[] as string[]};
 if(source.id!==AIHOT_RESET_SOURCE||source.kind!=='aihot'||source.url!==AIHOT_RESET_URL||!source.autoPublish)return stats;
 if(options.dry){options.log('AIHOT Codex reset 自动发布演练：不写入',leads.length);return stats;}
 const manual=(subject:string,reason:string)=>{stats.manual++;stats.manualReasons.push({subject,reason});options.log('重置保留常规审核',subject,reason);};
 const finish=async(initial:ResetReceipt,input?:AiHotResetInput)=>{
  let result=initial;const saved=initial.candidateId;
  for(let step=0;step<12;step++){
   const candidate=result.candidateId??saved;
   result=candidate?await api<ResetReceipt>(`/aihot-resets/${encodeURIComponent(candidate)}/advance`,{}):await api<ResetReceipt>('/aihot-resets',input);
   if(result.outcome==='published'){stats.published++;options.log('AIHOT Codex reset 已上架',result.offerId);return;}
   if(result.outcome==='manual'){manual(input?.url??candidate??'续传候选',result.reason??'自动通道需要人工核对');return;}
   if(options.canContinue&&!options.canContinue())break;
  }
  throw Error('自动发布已保存进度，等待下轮续传');
 };
 // Durable candidates resume even if AIHOT removes the event or its seven-day discovery window expires.
 if(options.resume!==false)try{
  const pending=await api<{candidates:{candidateId:string}[]}>('/aihot-resets/pending');
  for(const candidate of pending.candidates){
   if(options.canContinue&&!options.canContinue())break;
   try{await finish({outcome:'resume',candidateId:candidate.candidateId});}catch(error){stats.failed++;stats.errors.push(`${candidate.candidateId}: ${(error as Error).message}`);}
  }
 }catch(error){stats.failed++;stats.errors.push('重置续传队列：'+(error as Error).message);}
 // One post anchoring several AIHOT events is a multi-round schedule; the round cannot be told from the post.
 const events=new Map<string,number>();for(const lead of leads)events.set(lead.url,(events.get(lead.url)??0)+1);
 const seen=new Set<string>();
 for(const lead of leads){
  if(options.canContinue&&!options.canContinue()){stats.failed++;stats.errors.push('运行窗口已结束，重置线索保留待续传');break;}
  if(seen.has(lead.url))continue;seen.add(lead.url);
  if(events.get(lead.url)!>1){manual(lead.url,'AIHOT 同一原帖对应多次重置，保留常规审核');continue;}
  try{
   const page=await fetchPage(lead.url),proof=fetchedSource(page);
   if(!proof.sourceText||!proof.sourceFetch)throw Error('员工原帖未读到完整正文');
   const event=lead.aihotEvent===undefined?null:aiHotEventSchema.safeParse(lead.aihotEvent);
   if(event&&!event.success)options.log('AIHOT 重置事件格式无法识别，改读员工原帖',lead.url);
   const input:AiHotResetInput={url:lead.url,sourceText:proof.sourceText,sourceFetch:proof.sourceFetch,capturedAt:new Date().toISOString(),...(event?.success?{aihotEvent:event.data}:{})};
   try{buildAiHotReset(input);}catch(error){
    if(!(error instanceof AiHotResetReviewRequired))throw error;
    manual(lead.url,error.message);continue;
   }
   await finish({outcome:'retry'},input);
  }catch(error){stats.failed++;stats.errors.push(`${lead.url}: ${(error as Error).message}`);options.log('Codex reset 自动发布未完成，线索仍保留',stats.errors.at(-1));}
 }
 return stats;
}
