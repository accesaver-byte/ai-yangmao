import {fetchPage} from './lib';
import {fetchedSource} from './fetch-evidence';
import { z } from 'zod';
import { api } from './lib';
import { intakeReceiptSchema } from '../src/shared/identity/types';
import { reviewIdentity,type IdentityReviewInput } from './identity-review';
export interface IdentityMaintenanceStats {resolved:number;deferred:number;modelTasks:number;handedToOwner?:number;errors?:Record<string,number>;status:'processed'|'disabled'|'not_evaluated';reason?:string}
export async function resumeIdentityIntake(deadlineAt:number):Promise<IdentityMaintenanceStats> {
 const stats:IdentityMaintenanceStats={resolved:0,deferred:0,modelTasks:0,handedToOwner:0,errors:{},status:'processed'};
 // Every deferral is counted by reason: the loop used to swallow errors, so a week of failures showed only "deferred".
 const fail=(where:string,error:unknown)=>{stats.deferred++;const key=where+': '+String(error instanceof Error?error.message:error).slice(0,120);stats.errors![key]=(stats.errors![key]??0)+1;};
 const skip=(status:IdentityMaintenanceStats['status'],reason:string)=>({...stats,status,reason});
 if(process.env.DRY_RUN==='1')return skip('disabled','dry_run');
 const mode=process.env.IDENTITY_MODE;
 if(!mode)return skip('not_evaluated','missing_identity_mode');
 if(!['off','shadow','enforce'].includes(mode))return skip('not_evaluated','invalid_identity_mode');
 if(mode!=='enforce')return skip('disabled','mode_'+mode);
 if(!['true','false'].includes(process.env.IDENTITY_MODEL_ASSIST??''))return skip('not_evaluated','invalid_or_missing_identity_model_assist');
 if(!process.env.API_BASE?.trim())return skip('not_evaluated','explicit_api_base_required');
 if(Date.now()>=deadlineAt)return skip('not_evaluated','deadline_reached');
 const queue=z.object({reason:z.string().optional(),candidates:z.array(z.object({id:z.string(),revision:z.number().int()})).max(4)}).parse(await api('/identity-retries'));
 if(queue.reason)return skip('not_evaluated',queue.reason);
 for(const candidate of queue.candidates){
  if(Date.now()>=deadlineAt){stats.deferred++;continue;}
  try {const receipt=intakeReceiptSchema.parse(await api('/identity-candidates/'+encodeURIComponent(candidate.id)+'/resolve',{requestId:crypto.randomUUID(),expectedRevision:candidate.revision}));if(receipt.retryable)stats.deferred++;else stats.resolved++;}
  catch(error){fail('retry',error);}
 }
 // Preparation is a bounded read of existing history. Failed official fetches remain deferred.
 try {
  const prepared=z.object({tasks:z.array(z.object({id:z.string(),revision:z.number().int()})).max(4)}).parse(await api('/identity-preparations'));
  for(const task of prepared.tasks){
   let revision=task.revision;
   for(let page=0;page<4&&Date.now()<deadlineAt;page++){
    try {
     let outcome=await api<{status:string;revision:number}>('/identity-preparations/'+encodeURIComponent(task.id)+'/scan',{requestId:crypto.randomUUID(),expectedRevision:revision});revision=outcome.revision;
     if(outcome.status==='needs_source'){
      const source=await api<{url:string;officialSource:boolean;issuerProductHint:string|null}>('/identity-preparations/'+encodeURIComponent(task.id)+'/source');
      if(source.officialSource&&source.issuerProductHint){
       try {const page=await fetchPage(source.url,{tries:1,timeoutMs:10000,minimumTextLength:120});const proof=fetchedSource(page);
        if(proof.sourceText&&proof.sourceFetch?.sourceVerified&&!proof.sourceFetch.truncated)outcome=await api('/identity-preparations/'+encodeURIComponent(task.id)+'/scan',{requestId:crypto.randomUUID(),expectedRevision:revision,freshSource:proof});
       }catch(error){fail('fetch',error);}
      }else fail('source','not an official source or no product hint');
     }
     if(outcome.status==='source_unverifiable'){stats.handedToOwner!++;break;}
     if(outcome.status==='ready')break;
     if(outcome.status!=='scanning')break;
     revision=outcome.revision;
    }catch(error){fail('prepare',error);break;}
   }
  }
 }catch(error){fail('preparation-queue',error);}
 if(process.env.IDENTITY_MODEL_ASSIST!=='true'||Date.now()>=deadlineAt)return stats;
 const tasks=z.object({tasks:z.array(z.object({id:z.string(),revision:z.number().int()})).max(4)}).parse(await api('/identity-tasks'));
 for(const task of tasks.tasks){
  if(Date.now()>=deadlineAt)break;
  try {
   const claimed=await api<{revision:number;leaseToken:string;context:IdentityReviewInput}>('/identity-tasks/'+encodeURIComponent(task.id)+'/claim',{requestId:crypto.randomUUID(),expectedRevision:task.revision});
   const result=await reviewIdentity(claimed.context,deadlineAt);
   await api('/identity-tasks/'+encodeURIComponent(task.id)+'/result',{requestId:crypto.randomUUID(),expectedRevision:claimed.revision,leaseToken:claimed.leaseToken,result});stats.modelTasks++;
  } catch(error){fail('model',error);}
 }
 return stats;
}
