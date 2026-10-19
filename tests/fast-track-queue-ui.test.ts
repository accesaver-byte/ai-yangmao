import {it,expect} from 'vitest';
import {fixture} from './fixtures/frontend';
const queue={pending:[],newLeads:0,pendingPlatforms:[],suggestAutoPublish:[],incomplete:[],leadTasks:[],counts:{activities:0,leadReview:0,newLeads:0}};
const job={id:'stuck-minimax',platformName:'MiniMax',benefit:'MiniMax Code M3.1 Flash 限免',url:'https://agent.minimax.io/',state:'needs_owner',missing:['membershipCatalog'],error:'会员目录待核实：MiniMax',requirements:['member:MiniMax 付费订阅']};
const tick=()=>new Promise(r=>setTimeout(r,0));
function page(){return fixture((url,init)=>{
 if(url.endsWith('/fast-track'))return {jobs:[job]};
 if(url.endsWith('/reconcile'))return {state:'needs_owner'};
 if(url.includes('/identity/tasks'))return {tasks:[]};
 if(url.endsWith('/platforms'))return {platforms:[{id:'minimax',name:'MiniMax',type:'lab'}]};
 if(url.includes('/discord/unmapped'))return {channels:[]};
 return queue;
});}
it('shows paused fast-track jobs at the top of the review tab with the blocker and retry action',async()=>{
 const f=page();f.run("ADM.tab='queue'");await f.run('admQueue()');await tick();await tick();
 const panel=f.document.querySelector('[data-fast-track-review]');
 expect(panel).not.toBeNull();expect(panel!.textContent).toContain('MiniMax Code');expect(panel!.textContent).toContain('会员目录待核实');
 expect(panel!.querySelector('[data-ft-retry]')).not.toBeNull();
 expect(f.document.querySelector('[data-ft-count]')!.textContent).toBe('1');
});
it('keeps the manual intake form but does not hide fast-track failures in the intake tab',async()=>{
 const f=page();f.run("ADM.tab='manual'");await f.run('admManual()');
 expect(f.document.querySelector('[data-fast-track]')).not.toBeNull();
 expect(f.document.querySelector('[data-ft-jobs]')).toBeNull();
 expect(f.document.querySelector('#admBody')!.textContent).toContain('待审');
});
