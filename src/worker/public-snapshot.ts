import {liveStatus,isClaimable,activeOnDate,missingEvidence} from '../shared/lifecycle';
import {z} from 'zod';
import {normalizeModelNames} from '../shared/model-names';
import type {offers} from '../db/schema';
type PublicOffer=typeof offers.$inferSelect;
type Snapshot={capturedAt:string;coverage?:Record<string,unknown>;offers:PublicOffer[];platforms:Array<{id:string;status:string;[k:string]:unknown}>};
export const snapshotActive=(until:string|undefined,now=Date.now())=>!!until&&Number.isFinite(Date.parse(until))&&now<Date.parse(until);
export function quotaFailure(error:unknown):boolean {
 for(let i=0;i<6&&error;i++){const e=error as {message?:string;cause?:unknown};if(/(?:exceeded|exhausted).*(?:D1|row read|read limit)|D1.*(?:daily|quota|limit)/i.test(e.message??String(error)))return true;error=e.cause;}return false;
}
/** Public data comes only from a pre-sanitized approved snapshot, never a raw DB dump. */
export async function snapshotResponse(request:Request,assets:Fetcher):Promise<Response|null>{
 const u=new URL(request.url),path=u.pathname;
 if(/^\/api\/offers\/[^/]+\/comments$/.test(path))return null;
 if(!['/api/offers','/api/platforms','/api/meta','/api/coverage'].includes(path)&&!path.startsWith('/api/offers/'))return null;
 const source=await assets.fetch(new Request(new URL('/public-snapshot.json',u.origin)));
 if(!source.ok)return Response.json({error:'只读快照暂不可用，请稍后重试',degraded:true},{status:503});
 let s:Snapshot;try{s=await source.json() as Snapshot;}catch{return Response.json({error:'只读快照读取失败',degraded:true},{status:503});}
 if(!s.capturedAt||!Array.isArray(s.offers)||!Array.isArray(s.platforms))return Response.json({error:'只读快照尚未准备',degraded:true},{status:503});
 const meta={degraded:true,snapshotAt:s.capturedAt,readOnly:true,reason:'d1_read_quota',coverageDegraded:true};
 const headers={'Cache-Control':'public, max-age=30','X-Data-Mode':'approved-snapshot'};
 const response=(body:unknown,status=200)=>Response.json(body,{status,headers});
 const platforms=s.platforms.filter(p=>p.status==='approved');
 if(path==='/api/platforms')return response({...meta,platforms});
 if(path==='/api/meta')return response({...meta,lastSuccessfulCollect:null});
 if(path==='/api/coverage')return response({...meta,platforms:platforms.length,...(s.coverage??{sources:null,byKind:{},officialPages:[]}),lastSuccessfulCollect:null});
 const now=new Date();
 let rows=s.offers.filter(o=>o.reviewState==='approved'&&platforms.some(p=>p.id===o.platformId)).map(o=>{const {withdrawnReason:_reason,reviewMemo:_memo,reviewSuggestion:_suggestion,officialReview:_review,...pub}=o;return {...pub,models:normalizeModelNames(o.models),status:liveStatus(o,now),missingEvidence:missingEvidence(o.evidence.excerpts)}});
 if(path.startsWith('/api/offers/')){const id=decodeURIComponent(path.slice('/api/offers/'.length));const offer=rows.find(o=>o.id===id);return offer?response({...meta,offer}):response({...meta,error:'快照中没有这条公开羊毛'},404);}
 const parsed=z.object({view:z.enum(['all','claimable']).default('claimable'),type:z.string().optional(),platform:z.string().optional(),modality:z.string().optional(),on:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),tz:z.string().default('Asia/Shanghai').refine(v=>{try{new Intl.DateTimeFormat('en',{timeZone:v});return true;}catch{return false;}})}).safeParse(Object.fromEntries(u.searchParams));
 if(!parsed.success)return response({...meta,error:'查询参数不正确'},400);
 const q=parsed.data;
 if(q.platform)rows=rows.filter(o=>o.platformId===q.platform);if(q.type)rows=rows.filter(o=>o.type===q.type);if(q.modality)rows=rows.filter(o=>o.modalities.includes(q.modality!));
 if(q.on)rows=rows.filter(o=>activeOnDate(o,q.on!,q.tz));else if(q.view==='claimable')rows=rows.filter(o=>isClaimable(o.status));
 return response({...meta,count:rows.length,offers:rows});
}
