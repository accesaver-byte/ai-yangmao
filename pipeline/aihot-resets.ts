import {api,fetchPage} from './lib';
import {fetchedSource} from './fetch-evidence';
import type {Source} from './collectors';
import type {LeadIn} from '../src/shared/ingest';
import {AIHOT_RESET_SOURCE,AIHOT_RESET_URL,buildAiHotReset} from '../src/shared/aihot-reset';
interface ResetReceipt {outcome:string;candidateId?:string;offerId?:string;reason?:string}
/** Run immediately after discoveries persist; independent of model budgets and ordinary lead queue size. */
export async function publishAiHotResets(source:Source,leads:LeadIn[],options:{dry:boolean;log:(...args:unknown[])=>void;canContinue?:()=>boolean;resume?:boolean}){
 const stats={published:0,manual:0,failed:0,errors:[] as string[]};
 if(source.id!==AIHOT_RESET_SOURCE||source.kind!=='aihot'||source.url!==AIHOT_RESET_URL||!source.autoPublish)return stats;
 if(options.dry){options.log('AIHOT Codex reset 自动发布演练：不写入',leads.length);return stats;}
 const finish=async(initial:ResetReceipt,input?:unknown)=>{
  let result=initial;const saved=initial.candidateId;
  for(let step=0;step<12;step++){
   const candidate=result.candidateId??saved;
   result=candidate?await api<ResetReceipt>(`/aihot-resets/${encodeURIComponent(candidate)}/advance`,{}):await api<ResetReceipt>('/aihot-resets',input);
   if(result.outcome==='published'){stats.published++;options.log('AIHOT Codex reset 已上架',result.offerId);return;}
   if(result.outcome==='manual'){stats.manual++;options.log('重置保留原审核决定',result.reason);return;}
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
 for(const lead of leads){
  if(options.canContinue&&!options.canContinue()){stats.failed++;stats.errors.push('运行窗口已结束，重置线索保留待续传');break;}
  try{
   const page=await fetchPage(lead.url),proof=fetchedSource(page);
   if(!proof.sourceText||!proof.sourceFetch)throw Error('员工原帖未读到完整正文');
   const input={url:lead.url,sourceText:proof.sourceText,sourceFetch:proof.sourceFetch,capturedAt:new Date().toISOString()};
   try{buildAiHotReset(input);}catch{stats.manual++;options.log('重置保留常规审核（非独立公告）',lead.url);continue;}
   await finish({outcome:'retry'},input);
  }catch(error){stats.failed++;stats.errors.push(`${lead.url}: ${(error as Error).message}`);options.log('Codex reset 自动发布未完成，线索仍保留',stats.errors.at(-1));}
 }
 return stats;
}
