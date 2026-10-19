import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { MODEL_NAMES_VERSION, normalizeModelNames } from '../src/shared/model-names';
export interface ModelRow { id:string; models:string; updated_at:string; review_state:string; evidence:string }
export interface ModelVersion { id:string; entity_id:string; offer_id:string; revision:number; display_candidate_json:string; current_approved?:number|boolean }
export interface ModelTask { id:string; version_id:string; revision:number; state:string }
export interface ModelProposal { offer_id:string; candidate:string; diff:string; manual_fields:string; updated_at:string }
export interface ModelDisplays { versions?:ModelVersion[]; tasks?:ModelTask[]; proposals?:ModelProposal[] }
export function modelCleanup(rows:ModelRow[],at:string,corrections:Record<string,string[]>={},displays:ModelDisplays={}):{sql:string;changes:Array<{id:string;from:string[];to:string[]}>;displayChanges:string[]} {
  if (!Number.isFinite(Date.parse(at))) throw new Error('Invalid cleanup timestamp');
  const quote=(value:string)=>`'${value.replace(/'/g,"''")}'`;
  const activeTasks=(displays.tasks??[]).filter(t=>['open','checking','manual'].includes(t.state));
  const changes:Array<{id:string;from:string[];to:string[]}>=[],sql:string[]=[],displayChanges:string[]=[];
  for(const row of rows) {
    if(!['approved','pending'].includes(row.review_state))continue;
    const from=JSON.parse(row.models) as string[],to=normalizeModelNames(corrections[row.id]??from);
    const changed=JSON.stringify(from)!==JSON.stringify(to);
    const versions=(displays.versions??[]).filter(v=>v.offer_id===row.id&&(v.current_approved||activeTasks.some(t=>t.version_id===v.id))).flatMap(v=>{
      const display=JSON.parse(v.display_candidate_json),models=normalizeModelNames(corrections[row.id]??display.models??[]);
      return JSON.stringify(display.models??[])===JSON.stringify(models)?[]:[{...v,after:JSON.stringify({...display,models})}];
    });
    const proposals=(displays.proposals??[]).filter(p=>p.offer_id===row.id).flatMap(p=>{
      const candidate=JSON.parse(p.candidate),models=normalizeModelNames(corrections[row.id]??candidate.models??[]);
      if(JSON.stringify(candidate.models??[])===JSON.stringify(models))return [];
      const diff=(JSON.parse(p.diff) as Array<{field:string}>).filter(d=>d.field!=='models');
      if(JSON.stringify(to)!==JSON.stringify(models))diff.push({field:'models',from:to,to:models} as never);
      const manual=JSON.parse(p.manual_fields) as string[];
      if(Object.hasOwn(corrections,row.id)&&!manual.includes('models'))manual.push('models');
      return [{...p,after:JSON.stringify({...candidate,models}),afterDiff:JSON.stringify(diff),afterManual:JSON.stringify(manual)}];
    });
    if(!changed&&!versions.length&&!proposals.length)continue;
    if(changed)changes.push({id:row.id,from,to});
    const id=quote(row.id),after=quote(JSON.stringify(to)),stamp=quote(at),state=quote(row.review_state);
    const applied=`id=${id} AND models=${after} AND updated_at=${stamp} AND review_state=${state}`;
    const tasks=activeTasks.filter(t=>versions.some(v=>v.id===t.version_id));
    const guards=[...versions.map(v=>`EXISTS(SELECT 1 FROM benefit_versions WHERE id=${quote(v.id)} AND revision=${v.revision} AND display_candidate_json=${quote(v.display_candidate_json)})`),
      ...tasks.map(t=>`EXISTS(SELECT 1 FROM review_tasks WHERE id=${quote(t.id)} AND revision=${t.revision} AND state=${quote(t.state)})`),
      ...proposals.map(p=>`EXISTS(SELECT 1 FROM offer_proposals WHERE offer_id=${id} AND candidate=${quote(p.candidate)} AND updated_at=${quote(p.updated_at)})`)];
    sql.push(`UPDATE offers SET models=${after},updated_at=${stamp} WHERE id=${id} AND models=${quote(row.models)} AND updated_at=${quote(row.updated_at)} AND review_state=${state}${guards.length?' AND '+guards.join(' AND '):''};`,
      'UPDATE identity_public_state SET generation=generation+changes() WHERE id=1;');
    for(const v of versions){
      displayChanges.push('version:'+v.id);
      sql.push(`UPDATE benefit_versions SET display_candidate_json=${quote(v.after)},revision=revision+1 WHERE id=${quote(v.id)} AND revision=${v.revision} AND display_candidate_json=${quote(v.display_candidate_json)} AND EXISTS(SELECT 1 FROM offers WHERE ${applied});`,
        `UPDATE benefit_entities SET business_revision=business_revision+changes() WHERE id=${quote(v.entity_id)};`);
      for(const t of tasks.filter(t=>t.version_id===v.id))sql.push(`UPDATE review_tasks SET revision=revision+1,material_revision=material_revision+1,state='manual',lease_token=NULL,lease_until=NULL WHERE id=${quote(t.id)} AND revision=${t.revision} AND state=${quote(t.state)} AND EXISTS(SELECT 1 FROM benefit_versions WHERE id=${quote(v.id)} AND revision=${v.revision+1} AND display_candidate_json=${quote(v.after)}) AND EXISTS(SELECT 1 FROM offers WHERE ${applied});`);
    }
    for(const p of proposals){displayChanges.push('proposal:'+p.offer_id);sql.push(`UPDATE offer_proposals SET candidate=${quote(p.after)},diff=${quote(p.afterDiff)},manual_fields=${quote(p.afterManual)},updated_at=${stamp} WHERE offer_id=${id} AND candidate=${quote(p.candidate)} AND updated_at=${quote(p.updated_at)} AND EXISTS(SELECT 1 FROM offers WHERE ${applied});`);}
    const diff=quote(JSON.stringify([{field:'models',from,to}]));
    sql.push(`INSERT INTO offer_revisions(offer_id,at,diff,author,evidence_before,evidence_after) SELECT id,${stamp},${diff},'admin',evidence,evidence FROM offers WHERE ${applied} AND NOT EXISTS(SELECT 1 FROM offer_revisions WHERE offer_id=${id} AND at=${stamp} AND author='admin');`,
      `INSERT INTO reviews(offer_id,action,edited_fields,reviewer,at,reason,reason_code) SELECT id,'edit','["models"]','admin:model-normalization',${stamp},${quote('管理员授权模型名称统一与错误关联清理；'+MODEL_NAMES_VERSION+'；同步当前显示草稿并使旧审核版本失效；审核状态、权益、官方证据及核验时间不变。')},'wrong_field' FROM offers WHERE ${applied} AND NOT EXISTS(SELECT 1 FROM reviews WHERE offer_id=${id} AND at=${stamp} AND reviewer='admin:model-normalization');`);
  }
  return {sql:sql.join('\n'),changes,displayChanges};
}

// Generates a reviewable CAS-protected SQL artifact; execution remains an explicit operator action.
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const [input,output,correctionFile]=process.argv.slice(2);
 if(!input||!output)throw new Error('Usage: tsx scripts/normalize-offer-models.ts snapshot.json cleanup.sql [corrections.json]');
 const raw=JSON.parse(readFileSync(input,'utf8')),rows=(Array.isArray(raw)&&raw[0]?.results?raw[0].results:raw) as ModelRow[];
 const at=new Date().toISOString(),corrections=correctionFile?JSON.parse(readFileSync(correctionFile,'utf8')):{};
 const displays:ModelDisplays=Array.isArray(raw)&&raw[0]?.results?{proposals:raw[1]?.results??[],versions:raw[3]?.results?.filter((v:ModelVersion)=>v.display_candidate_json)??[],tasks:raw[4]?.results??[]}:{};
 const result=modelCleanup(rows,at,corrections,displays);
 writeFileSync(output,result.sql,{mode:0o600});writeFileSync(output+'.json',JSON.stringify({at,version:MODEL_NAMES_VERSION,changes:result.changes,displayChanges:result.displayChanges},null,2),{mode:0o600});
 console.log(JSON.stringify({at,offers:rows.length,changed:result.changes.length,displays:result.displayChanges.length,sql:output,manifest:output+'.json'}));
}
