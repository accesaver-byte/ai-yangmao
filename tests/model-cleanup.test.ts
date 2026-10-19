import { expect,it } from 'vitest';
import { identityDb } from './fixtures/identity/db';
import { modelCleanup } from '../scripts/normalize-offer-models';

it('normalizes only current records, preserves review/evidence, audits changes and skips concurrent edits',()=>{
 const f=identityDb();try{
  for(const [id,state,models] of [['current','approved',['GLM 5.3 Flash','glm-5-3-flash','OpenAI']],['concurrent','approved',['Beam','beam']],['history','rejected',['GLM 5.3 Flash']]] as const){
   f.sqlite.prepare("INSERT INTO offers(id,platform_id,title,type,modalities,models,claim_method,requirements,audience,value_text,end_kind,evidence,steps,review_state,updated_at) VALUES(?,'vendor','免费额度','standing','[\"text\"]',?,'signup','[\"none\"]','all','免费','standing',?,'[]',?,'old')")
    .run(id,JSON.stringify(models),JSON.stringify({url:'https://vendor.example',tier:'site',capturedAt:'old',excerpts:{benefit:'Original language'}}),state);
  }
  const rows=f.sqlite.prepare('SELECT * FROM offers').all() as any;
  const before=f.sqlite.prepare("SELECT evidence,review_state FROM offers WHERE id='current'").get();
  const result=modelCleanup(rows,'2026-10-19T12:34:56.000Z');expect(result.changes).toHaveLength(2);
  f.sqlite.exec("UPDATE offers SET updated_at='newer',models='[\"New Model\"]' WHERE id='concurrent'");
  f.sqlite.exec(result.sql);
  expect(f.sqlite.prepare("SELECT models FROM offers WHERE id='current'").get()).toEqual({models:'["GLM-5.3-Flash"]'});
  expect(f.sqlite.prepare("SELECT evidence,review_state FROM offers WHERE id='current'").get()).toEqual(before);
  expect(f.sqlite.prepare("SELECT models FROM offers WHERE id='concurrent'").get()).toEqual({models:'["New Model"]'});
  expect(f.sqlite.prepare("SELECT models FROM offers WHERE id='history'").get()).toEqual({models:'["GLM 5.3 Flash"]'});
  expect(f.sqlite.prepare('SELECT count(*) n FROM offer_revisions').get()).toEqual({n:1});
  f.sqlite.exec(result.sql);expect(f.sqlite.prepare('SELECT count(*) n FROM offer_revisions').get()).toEqual({n:1});
 }finally{f.sqlite.close();}
});

it('reconciles current editable displays and invalidates stale task versions without changing fact history',()=>{
 const f=identityDb();try{
  f.sqlite.exec("INSERT INTO offers(id,platform_id,title,type,modalities,models,claim_method,requirements,audience,value_text,end_kind,evidence,steps,review_state,updated_at) VALUES('draft','vendor','免费额度','standing','[\"text\"]','[\"GLM-5.3-Flash\"]','signup','[\"none\"]','all','免费','standing','{}','[]','pending','old'); INSERT INTO benefit_entities(id,platform_id,canonical_offer_id) VALUES('e','vendor','draft')");
  const display=JSON.stringify({id:'draft',models:['GLM-5.3-Flash'],title:'Keep title'});
  f.sqlite.prepare("INSERT INTO benefit_versions(id,entity_id,terms_schema,terms_hash,facts_json,display_candidate_json) VALUES('v','e','terms-v1','original-hash','{}',?)").run(display);
  f.sqlite.prepare("INSERT INTO benefit_versions(id,entity_id,terms_schema,terms_hash,facts_json,display_candidate_json,state) VALUES('history-v','e','terms-v1','old-hash','{}',?,'superseded')").run(display);
  f.sqlite.exec("INSERT INTO review_tasks(id,task_key,kind,entity_id,version_id) VALUES('t','task','initial','e','v')");
  f.sqlite.exec("INSERT INTO review_tasks(id,task_key,kind,entity_id,version_id,state) VALUES('old-t','old-task','initial','e','history-v','resolved')");
  const rows=f.sqlite.prepare('SELECT * FROM offers').all() as any;
  const versions=f.sqlite.prepare("SELECT *, 'draft' AS offer_id FROM benefit_versions").all() as any;
  const tasks=f.sqlite.prepare('SELECT * FROM review_tasks').all() as any;
  const result=modelCleanup(rows,'2026-10-19T12:34:56.000Z',{draft:[]},{versions,tasks});f.sqlite.exec(result.sql);
  const version=f.sqlite.prepare("SELECT * FROM benefit_versions WHERE id='v'").get() as any;
  expect(JSON.parse(version.display_candidate_json)).toEqual({id:'draft',models:[],title:'Keep title'});
  expect(version.terms_hash).toBe('original-hash');expect(version.facts_json).toBe('{}');
  expect(f.sqlite.prepare("SELECT display_candidate_json FROM benefit_versions WHERE id='history-v'").get()).toEqual({display_candidate_json:display});
  expect(f.sqlite.prepare("SELECT state,revision FROM review_tasks WHERE id='old-t'").get()).toEqual({state:'resolved',revision:0});
  expect(f.sqlite.prepare("SELECT revision FROM review_tasks WHERE id='t'").get()).toEqual({revision:1});
  f.sqlite.exec(result.sql);expect(f.sqlite.prepare("SELECT revision FROM review_tasks WHERE id='t'").get()).toEqual({revision:1});
 }finally{f.sqlite.close();}
});
