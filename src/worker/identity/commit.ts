import type { MutationResult } from '../../shared/identity/types';
export type Binding = string | number | null;
export type ExpectedRevision = {kind:'entity'|'task'|'block';id:string;revision:number};
export interface Predicate {sql:string;args:Binding[]}
export interface MutationPlan<T> {
 requestId:string;payloadHash:string;executionToken:string;replayChecked?:boolean;expected:ExpectedRevision[];statements:D1PreparedStatement[];receipt:T;
 guards?:Predicate[];assertions?:Predicate[];
}
// D1 limits expression depth to 100. Keep wide guards logarithmic without
// weakening any predicate or changing the left-to-right binding order.
export function balancedAnd(parts:string[]):string {if(!parts.length)return '1';if(parts.length===1)return '('+parts[0]+')';const middle=Math.floor(parts.length/2);return '('+balancedAnd(parts.slice(0,middle))+' AND '+balancedAnd(parts.slice(middle))+')';}
export const commandGuard = "EXISTS(SELECT 1 FROM identity_commands WHERE request_id=? AND payload_hash=? AND state='staged' AND execution_token=?)";
const allowed=new Set(['auto_term_updates','source_documents','source_observations','source_observation_fetches','intake_candidates','intake_extractions','identity_extraction_leads','identity_refusal_applications','identity_backfill_progress','merge_plans','merge_operations','merge_members','identity_version_routes','merge_task_sources','identity_public_state','lead_candidate_links','benefit_entities','benefit_versions','entity_observations','identity_aliases','review_decisions','review_tasks','review_task_sources','task_candidates','identity_constraints','identity_blocks','identity_events','offers','offer_proposals','reviews','offer_revisions','rejected_offer_updates','leads']);
const identifier=(name:string)=>{if(!/^[a-z_]+$/.test(name))throw new Error('invalid internal SQL identifier');return '"'+name+'"';};
const ownsVersion=(table:string,column:string,entity='entity_id')=>`(${column} IS NULL OR EXISTS(SELECT 1 FROM benefit_versions v WHERE v.id=${table}.${column} AND v.entity_id=${table}.${entity}))`;
const ownership:Record<string,string>={
 benefit_entities:ownsVersion('benefit_entities','current_approved_version_id','id'),
 benefit_versions:ownsVersion('benefit_versions','base_version_id'),
 review_tasks:[ownsVersion('review_tasks','version_id'),ownsVersion('review_tasks','base_version_id'),"(decision_id IS NULL OR EXISTS(SELECT 1 FROM review_decisions d WHERE d.id=review_tasks.decision_id AND (d.entity_id=review_tasks.entity_id OR review_tasks.entity_id IS NULL)))"].join(' AND '),
 review_decisions:[...['version_id','base_version_id','target_version_id'].map(c=>ownsVersion('review_decisions',c)),"(entity_id IS NULL OR candidate_id IS NULL OR EXISTS(SELECT 1 FROM intake_candidates c WHERE c.id=review_decisions.candidate_id AND c.entity_id=review_decisions.entity_id))","(supersedes_id IS NULL OR EXISTS(SELECT 1 FROM review_decisions d WHERE d.id=review_decisions.supersedes_id AND (d.entity_id=review_decisions.entity_id OR d.candidate_id=review_decisions.candidate_id)))"].join(' AND '),
 intake_candidates:[ownsVersion('intake_candidates','version_id'),"(source_fetch_id IS NULL OR EXISTS(SELECT 1 FROM source_observation_fetches f WHERE f.id=intake_candidates.source_fetch_id AND f.observation_id=intake_candidates.observation_id))","(task_id IS NULL OR EXISTS(SELECT 1 FROM review_tasks t WHERE t.id=intake_candidates.task_id AND (t.entity_id IS NULL OR t.entity_id=intake_candidates.entity_id)))","(decision_id IS NULL OR EXISTS(SELECT 1 FROM review_decisions d WHERE d.id=intake_candidates.decision_id AND (d.candidate_id=intake_candidates.id OR d.entity_id=intake_candidates.entity_id OR EXISTS(SELECT 1 FROM identity_refusal_applications a WHERE a.candidate_id=intake_candidates.id AND a.decision_id=d.id AND a.facts_hash=intake_candidates.facts_hash))))"].join(' AND '),
 identity_events:[ownsVersion('identity_events','version_id'),"(task_id IS NULL OR EXISTS(SELECT 1 FROM review_tasks t WHERE t.id=identity_events.task_id AND (t.entity_id=identity_events.entity_id OR (t.entity_id IS NULL AND identity_events.entity_id IS NULL))))"].join(' AND '),
};
/** Server-internal builder. Client JSON never supplies a table name, column or SQL. */
export class MutationBuilder {
 private statements:D1PreparedStatement[]=[];
 private assertions:Predicate[]=[];
 private guards:Predicate[]=[];
 readonly executionToken=crypto.randomUUID();
 constructor(private db:D1Database,readonly requestId:string,readonly payloadHash:string){}
 private table(table:string) {if(!allowed.has(table))throw new Error('unsupported mutation table');return identifier(table);}
 insert(table:string,data:Record<string,Binding>,onConflict:'error'|'nothing'='error'):void {
  const keys=Object.keys(data);const name=this.table(table);
  this.statements.push(this.db.prepare(`INSERT INTO ${name}(${keys.map(identifier).join(',')}) SELECT ${keys.map(()=>'?').join(',')} WHERE ${commandGuard}${onConflict==='nothing'?' ON CONFLICT DO NOTHING':''}`).bind(...keys.map(k=>data[k]),this.requestId,this.payloadHash,this.executionToken));
  if(ownership[table]&&data.id!=null)this.assert(`NOT EXISTS(SELECT 1 FROM ${name} WHERE id=? AND NOT (${ownership[table]}))`,[data.id]);
 }
 update(table:string,data:Record<string,Binding>,where:string,args:Binding[]):void {
  const name=this.table(table),keys=Object.keys(data);
  this.statements.push(this.db.prepare(`UPDATE ${name} SET ${keys.map(k=>identifier(k)+'=?').join(',')} WHERE (${where}) AND ${commandGuard}`).bind(...keys.map(k=>data[k]),...args,this.requestId,this.payloadHash,this.executionToken));
 }
 advancePublicGeneration():void {
  this.statements.push(this.db.prepare(`UPDATE identity_public_state SET generation=generation+1 WHERE id=1 AND ${commandGuard}`).bind(this.requestId,this.payloadHash,this.executionToken));
  this.assert('EXISTS(SELECT 1 FROM identity_public_state WHERE id=1)');
 }
 cancelEntityReview(entityId:string,decisionId:string):void {
  this.statements.push(this.db.prepare(`UPDATE review_tasks SET state='cancelled',revision=revision+1,material_revision=material_revision+1,decision_id=?,lease_token=NULL,lease_until=NULL WHERE entity_id=? AND state IN ('open','checking','manual') AND ${commandGuard}`).bind(decisionId,entityId,this.requestId,this.payloadHash,this.executionToken));
  this.statements.push(this.db.prepare(`UPDATE intake_candidates SET lease_token=NULL,lease_until=NULL,revision=revision+1 WHERE entity_id=? AND lease_token IS NOT NULL AND ${commandGuard}`).bind(entityId,this.requestId,this.payloadHash,this.executionToken));
  this.statements.push(this.db.prepare(`UPDATE identity_events SET status='blocked' WHERE entity_id=? AND status='pending' AND ${commandGuard}`).bind(entityId,this.requestId,this.payloadHash,this.executionToken));
 }
 remove(table:string,where:string,args:Binding[]):void {
  this.statements.push(this.db.prepare(`DELETE FROM ${this.table(table)} WHERE (${where}) AND ${commandGuard}`).bind(...args,this.requestId,this.payloadHash,this.executionToken));
 }
 insertMany(table:string,rows:Record<string,Binding>[]):void {
  if(!rows.length)return;if(rows.length>1000||JSON.stringify(rows).length>750000)throw new Error('oversized mutation rows');
  const keys=Object.keys(rows[0]);if(rows.some(row=>Object.keys(row).join('|')!==keys.join('|')))throw new Error('inconsistent bulk columns');
  this.statements.push(this.db.prepare(`INSERT INTO ${this.table(table)}(${keys.map(identifier).join(',')}) SELECT ${keys.map(k=>`json_extract(value,'$.${k}')`).join(',')} FROM json_each(?) WHERE ${commandGuard}`).bind(JSON.stringify(rows),this.requestId,this.payloadHash,this.executionToken));
  for(const row of rows)if(ownership[table]&&row.id!=null)this.assertOwnership(table,String(row.id));
 }
 updateMany(table:string,rows:Record<string,Binding>[]):void {
  if(!rows.length)return;if(rows.length>1000||JSON.stringify(rows).length>750000)throw new Error('oversized mutation rows');const keys=Object.keys(rows[0]).filter(k=>k!=='id');const name=this.table(table);
  if(rows.some(row=>!row.id||keys.some(k=>!(k in row))))throw new Error('bulk update requires stable IDs');
  this.statements.push(this.db.prepare(`UPDATE ${name} SET ${keys.map(k=>`${identifier(k)}=(SELECT json_extract(r.value,'$.${k}') FROM json_each(?1) r WHERE json_extract(r.value,'$.id')=${name}.id)`).join(',')} WHERE id IN (SELECT json_extract(value,'$.id') FROM json_each(?1)) AND ${commandGuard}`).bind(JSON.stringify(rows),this.requestId,this.payloadHash,this.executionToken));
  for(const row of rows)if(ownership[table])this.assertOwnership(table,String(row.id));
 }
 insertLeadLinks(leadIds:number[],candidateId:string):void {
  if(leadIds.length>1000||leadIds.some(id=>!Number.isSafeInteger(id)||id<=0))throw new Error('oversized or invalid historical lead links');
  this.statements.push(this.db.prepare(`INSERT INTO lead_candidate_links(lead_id,candidate_id) SELECT value,? FROM json_each(?) WHERE ${commandGuard} ON CONFLICT DO NOTHING`).bind(candidateId,JSON.stringify(leadIds),this.requestId,this.payloadHash,this.executionToken));
  this.assert('NOT EXISTS(SELECT 1 FROM json_each(?) l WHERE NOT EXISTS(SELECT 1 FROM lead_candidate_links linked WHERE linked.lead_id=l.value AND linked.candidate_id=?))',[JSON.stringify(leadIds),candidateId]);
 }
 acknowledgeOfficialJob(offerId:string,originalJob:string,entityRevision:number):void {
  this.statements.push(this.db.prepare(`UPDATE offers SET official_review=json_set(official_review,'$.identityRevision',?,'$.inputVersion',updated_at||'|'||coalesce((SELECT updated_at FROM offer_proposals WHERE offer_id=offers.id),'')) WHERE id=? AND official_review=? AND ${commandGuard}`).bind(entityRevision,offerId,originalJob,this.requestId,this.payloadHash,this.executionToken));
 }
 assert(sql:string,args:Binding[]=[]):void {this.assertions.push({sql,args});}
 require(sql:string,args:Binding[]=[]):void {this.guards.push({sql,args});}
 assertOwnership(table:string,id:string):void {
  if(ownership[table])this.assert(`NOT EXISTS(SELECT 1 FROM ${this.table(table)} WHERE id=? AND NOT (${ownership[table]}))`,[id]);
 }
 plan<T>(expected:ExpectedRevision[],receipt:T):MutationPlan<T> {return {requestId:this.requestId,payloadHash:this.payloadHash,executionToken:this.executionToken,expected,statements:this.statements,receipt,guards:this.guards,assertions:this.assertions};}
}
export async function readIdentityReceipt<T>(db:D1Database,requestId:string,payloadHash:string):Promise<MutationResult<T>|null> {
 const row=await db.prepare('SELECT payload_hash,state,result_json FROM identity_commands WHERE request_id=?').bind(requestId).first<{payload_hash:string;state:string;result_json:string|null}>();
 if(!row)return null;
 if(row.payload_hash!==payloadHash||row.state!=='applied'||!row.result_json)return {status:'conflict',value:null};
 return {status:'replayed',value:JSON.parse(row.result_json) as T};
}
export async function commitIdentityMutation<T>(db:D1Database,plan:MutationPlan<T>):Promise<MutationResult<T>> {
 if(!plan.replayChecked){const prior=await readIdentityReceipt<T>(db,plan.requestId,plan.payloadHash);if(prior)return prior;}
 if(plan.expected.length>40||plan.statements.length>40)throw new Error('identity mutation exceeds bounded batch');
 const guards:Predicate[]=[...(plan.guards??[])];
 for(const item of [...plan.expected].sort((a,b)=>(a.kind+':'+a.id).localeCompare(b.kind+':'+b.id))) {
  if(!Number.isSafeInteger(item.revision)||item.revision<0)throw new Error('invalid revision');
  if(item.kind==='entity')guards.push({sql:'EXISTS(SELECT 1 FROM benefit_entities WHERE id=? AND business_revision=?)',args:[item.id,item.revision]});
  else if(item.kind==='task')guards.push({sql:'EXISTS(SELECT 1 FROM review_tasks WHERE id=? AND revision=?)',args:[item.id,item.revision]});
  else guards.push({sql:'coalesce((SELECT revision FROM identity_blocks WHERE block_key=?),0)=?',args:[item.id,item.revision]});
 }
 const assertions=plan.assertions??[];
 const firstArgs:Binding[]=[plan.requestId,plan.payloadHash,JSON.stringify(plan.expected),plan.executionToken,...guards.flatMap(g=>g.args)];
 const lastArgs:Binding[]=[...assertions.flatMap(g=>g.args),JSON.stringify(plan.receipt),plan.requestId,plan.payloadHash,plan.executionToken];
 if(firstArgs.length>100||lastArgs.length>100)throw new Error('identity mutation exceeds D1 binding limit');
 const results=await db.batch([
  db.prepare(`INSERT OR IGNORE INTO identity_commands(request_id,payload_hash,state,expected_json,execution_token) SELECT ?,?,'staged',?,? WHERE ${balancedAnd(guards.map(g=>g.sql))} RETURNING request_id`).bind(...firstArgs),
  ...plan.statements,
  db.prepare(`UPDATE identity_commands SET state=CASE WHEN ${balancedAnd(assertions.map(g=>g.sql))} THEN 'applied' ELSE 'invalid' END,result_json=? WHERE request_id=? AND payload_hash=? AND state='staged' AND execution_token=? RETURNING request_id,result_json`).bind(...lastArgs),
 ]);
 const final=results.at(-1)?.results[0] as {result_json?:string}|undefined;
 if(results[0].results.length&&final?.result_json)return {status:'applied',value:JSON.parse(final.result_json) as T};
 const applied=await readIdentityReceipt<T>(db,plan.requestId,plan.payloadHash);
 if(!applied)return {status:'conflict',value:null};
 return {...applied,status:applied.status==='replayed'&&results[0].results.length?'applied':applied.status};
}
