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
  expect(f.document.querySelector('[data-fast-track]')).toBeNull();
 });

 it('keeps screening and fast publishing in the top navigation, with one publishing form',async()=>{
  const f=setup();f.run('pAdmin()');
  const tabs=[...f.document.querySelectorAll('[data-admtab]')].map(tab=>tab.getAttribute('data-admtab'));
  expect(tabs.slice(0,3)).toEqual(['screening','fast','queue']);
  f.run("ADM.tab='manual'");await f.run('admManual()');
  expect(f.document.querySelector('[data-fast-track]')).toBeNull();
  f.run("ADM.tab='fast'");await f.run('admFastTrack()');
  expect(f.document.querySelectorAll('[data-fast-track]')).toHaveLength(1);
  expect(f.document.querySelector('[data-review-pane="fast"]')).toBeNull();
 });

 it('places screening controls in the first top tab and removes auxiliary controls from review',async()=>{
  const f=setup();await f.run('admQueue()');
  expect(f.document.querySelector('.review-tools')).toBeNull();
  expect(f.document.querySelector('[data-intake-rules]')).toBeNull();
  f.run("ADM.tab='screening'");await f.run('admScreening()');
  expect(f.document.querySelector('[data-intake-rules]')).not.toBeNull();
  expect(f.document.querySelector('[data-spot-check]')).not.toBeNull();
 });

 it('passes a linked lead and identity task through the single publishing form',async()=>{
  const writes:unknown[]=[];
  const f=fixture((url,init)=>{
    if(url.endsWith('/fast-track')&&init?.method==='POST'){writes.push(JSON.parse(String(init.body)));return {registered:{kind:'existing'},dispatched:true};}
    if(url.endsWith('/fast-track'))return {jobs:[]};
    if(url.startsWith('/api/platforms'))return {platforms:[{id:'vendor',name:'Vendor',type:'lab'}]};
    return {};
  });
  f.run("openFastTrackForm({url:'https://official.example',benefit:'Free trial',platformId:'vendor'},17,{identityTaskId:'task-1'})");
  await new Promise(resolve=>setTimeout(resolve,0));
  const form=f.document.querySelector('[data-fast-track]') as HTMLFormElement;
  expect(form.querySelector<HTMLInputElement>('[name="url"]')?.value).toBe('https://official.example');
  f.context.FormData=class {constructor(){return new Map([['platformId','vendor'],['newName',''],['url','https://official.example'],['benefit','Free trial'],['basis','official']]);}};
  form.dispatchEvent(new f.window.Event('submit'));
  await new Promise(resolve=>setTimeout(resolve,0));
  expect(writes).toMatchObject([{leadId:17,identityTaskId:'task-1',url:'https://official.example'}]);
 });

 it('drops a contextual publishing link when the administrator changes top tabs',async()=>{
  const f=setup();f.run("openFastTrackForm({benefit:'Linked benefit'},17,{identityTaskId:'task-1'})");
  await new Promise(resolve=>setTimeout(resolve,0));
  f.document.querySelector('[data-admtab="queue"]')!.dispatchEvent(new f.window.Event('click'));
  expect(f.run('ADM.fastPrefill')).toBeNull();
 });

 it('keeps completed fast publishing cards in a three-column gallery',async()=>{
  const completed={id:'done',platformName:'Vendor',benefit:'Free credits',url:'https://vendor.example',state:'published',missing:[]};
  const f=fixture(url=>url.endsWith('/fast-track')?{jobs:[completed]}:url.endsWith('/platforms?fresh=0')?{platforms:[]}:{});
  f.run("ADM.tab='fast'");await f.run('admFastTrack()');
  const gallery=f.document.querySelector('[data-ft-completed] .review-completed-grid');
  expect(gallery).not.toBeNull();
  expect(gallery!.querySelectorAll('.review-tile')).toHaveLength(1);
 });

 it('explains uncertain notifications without exposing status codes as headings',async()=>{
  const health={hoursSince:1,failingSources:[],tokensToday:0,costMonthCny:0,sources:[],uncertainDeliveries:[
    {id:'internal-one',kind:'digest',channel:'feishu',status:'pending',createdAt:'2026-10-20T10:00:00Z'},
    {id:'internal-two',kind:'urgent',channel:'telegram',status:'unknown',createdAt:'2026-10-20T11:00:00Z'}]};
  const f=fixture(()=>health);await f.run('admHealth()');
  const cards=[...f.document.querySelectorAll('[data-delivery]')];
  expect(cards[0].querySelector('h3')?.textContent).toContain('飞书每日汇总');
  expect(cards[1].querySelector('h3')?.textContent).toContain('Telegram 临期提醒');
  expect(cards.map(card=>card.querySelector('h3')?.textContent).join(' ')).not.toMatch(/digest|urgent|pending|unknown/);
  expect(cards[0].querySelector('details')?.textContent).toContain('internal-one');
 });

});
