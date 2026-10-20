import { describe, expect, it } from 'vitest';
import { fixture } from './fixtures/frontend';
const item={id:'one',code:'one',platformId:'vendor',platform:'Vendor',title:'免费额度',type:'限时免费开放',value:'免费 10 积分',end:'截止未知',status:'active',reviewState:'pending',requirements:['none'],audience:'all',claimMethod:'auto',sourceTz:'UTC',evidenceUrl:'https://vendor.example',evidenceTier:'docs',excerpts:{},models:[],tags:[],modalities:['text'],checks:[],steps:[]};
function setup(){return fixture(url=>url.includes('/identity/tasks')?{tasks:[]}:url.endsWith('/fast-track')?{jobs:[]}:{pending:[item],incomplete:[{...item,id:'live',code:'live'}],newLeads:0,needsVerification:[],pendingPlatforms:[],suggestAutoPublish:[],leadTasks:[]});}
describe('review workspace navigation',()=>{
 it('switches queues without rebuilding cards or losing an edit draft',async()=>{
  const f=setup();await f.run('admQueue()');
  const card=f.document.querySelector('[data-code="one"]')!;
  const opener=card.querySelector('[data-review-open]')!;
  expect(opener).not.toBeNull();opener.dispatchEvent(new f.window.Event('click'));
  card.querySelector('[data-act="edit"]')!.dispatchEvent(new f.window.Event('click'));
  const title=card.querySelector('[name="title"]') as HTMLInputElement;title.value='尚未保存的草稿';
  card.querySelector('[data-review-close]')!.dispatchEvent(new f.window.Event('click'));
  f.document.querySelector('[data-review-tab="leads"]')!.dispatchEvent(new f.window.Event('click'));
  expect(f.document.querySelector('[data-review-pane="activities"]')!.hasAttribute('hidden')).toBe(true);
  f.document.querySelector('[data-review-tab="activities"]')!.dispatchEvent(new f.window.Event('click'));
  expect(f.document.querySelector('[data-code="one"]')).toBe(card);
  expect(title.value).toBe('尚未保存的草稿');
  expect(f.document.querySelector('[data-review-pane="activities"]')!.hasAttribute('hidden')).toBe(false);
 });
 it('opens the live backlog on demand and routes deep links to its workspace',async()=>{
  const f=setup();f.context.location.hash='#admin-offer-live';await f.run('admQueue()');
  expect(f.document.querySelector('[data-review-tab="live"]')?.getAttribute('aria-selected')).toBe('true');
  expect(f.document.querySelector('[data-code="live"] [data-review-dialog]')?.hasAttribute('open')).toBe(true);
 });
 it('keeps the detail close control usable after an approval completes',async()=>{
  const f=setup();await f.run('admQueue()');
  const card=f.document.querySelector('[data-code="one"]')!;
  card.querySelector('[data-review-open]')!.dispatchEvent(new f.window.Event('click'));
  card.querySelector('[data-act="approve"]')!.dispatchEvent(new f.window.Event('click'));
  await new Promise(resolve=>setTimeout(resolve,0));
  expect((card.querySelector('[data-act="approve"]') as HTMLButtonElement).disabled).toBe(true);
  expect((card.querySelector('[data-review-close]') as HTMLButtonElement).disabled).toBe(false);
  card.querySelector('[data-review-close]')!.dispatchEvent(new f.window.Event('click'));
  expect(card.querySelector('[data-review-dialog]')!.hasAttribute('open')).toBe(false);
 });
 it('keeps the fast publishing workspace unavailable to reviewers',async()=>{
  const f=setup();f.run("ADM.role='reviewer'");await f.run('admQueue()');
  expect(f.document.querySelector('[data-review-tab="fast"]')).toBeNull();
  expect(f.document.querySelector('[data-review-pane="fast"]')).toBeNull();
 });

});
