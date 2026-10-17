import * as YMMembership from '../src/shared/membership';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { parseHTML } from 'linkedom';
import { describe, expect, it } from 'vitest';

async function pageFixture() {
  const { window, document } = parseHTML(`<html><body>${readFileSync('web/src/body.html','utf8')}</body></html>`);
  document.querySelector('#main')!.innerHTML='<div id="admBody"></div>';
  const makeOffer=(code:string)=>({code,id:code,platformId:'vendor',platform:'Vendor',title:'免费额度',type:'注册新人礼',value:'100 credits',end:'截止未知',status:'active',reviewState:'pending',requirements:['none'],audience:'all',claimMethod:'signup',sourceTz:'UTC',evidenceUrl:'https://vendor.example',evidenceTier:'docs',excerpts:{},models:[],tags:[],modalities:['text'],checks:[],steps:[]});
  const queue={pending:[makeOffer('first'),makeOffer('second')],incomplete:Array.from({length:8},(_,i)=>makeOffer(`live-${i}`)),newLeads:0,needsVerification:[],pendingPlatforms:[],suggestAutoPublish:[]};
  const writes:unknown[]=[]; const requests:string[]=[];
  const timers:Function[]=[];
  const context=createContext({YMMembership, structuredClone,document,window,console,Intl,Date,Map,Set,URL,Response,FormData,
    location:{hash:'#admin'},navigator:{},getComputedStyle:()=>({getPropertyValue:()=> '#123456'}),
    matchMedia:()=>({matches:false,addEventListener(){}}),MutationObserver:class{observe(){}},
    localStorage:{getItem(){return null},setItem(){},removeItem(){}},sessionStorage:{getItem(){return null},setItem(){},removeItem(){}},
    setTimeout,clearTimeout,setInterval:(fn:Function)=>timers.push(fn),fetch:async(_url:string,init?:RequestInit)=>{
      if(_url.endsWith('/memberships')) return new Response(JSON.stringify({revision:0,products:[],plans:[]}));
      if(init?.body){requests.push(_url);writes.push(JSON.parse(String(init.body)));return new Response(JSON.stringify({adminNote:JSON.parse(String(init.body)).note}));}
      return new Response(JSON.stringify(queue));
    }});
  // Run the real frontend and handlers, without the network-driven boot screen.
  const app=readFileSync('web/src/app.js','utf8');
  runInContext(readFileSync('web/src/urgent-review.js','utf8'),context);
  runInContext(readFileSync('web/src/data.js','utf8')+'\n'+readFileSync('web/src/membership.js','utf8')+'\n'+app.slice(0,app.indexOf('(async function boot()')),context);
  await runInContext("ADM.token='fixture'; ADM.role='admin'; PLATFORMS=[{id:'vendor',name:'Vendor',type:'lab'}]; admQueue()",context);
  return {document,window,context,writes,timers,requests};
}

describe('admin text input lifecycle',()=>{
  it('keeps closed forms and the incomplete backlog out of the live DOM, mounts each only once, and preserves drafts',async()=>{
    const {document,window}=await pageFixture();
    expect(document.querySelectorAll('[data-code]')).toHaveLength(2);
    expect(document.querySelectorAll('[data-editform]')).toHaveLength(0);
    const card=document.querySelector('[data-code="first"]')!;
    const edit=card.querySelector('[data-act="edit"]')!;
    edit.dispatchEvent(new window.Event('click'));
    const form=card.querySelector('[data-editform]')!;
    const title=form.querySelector('[name="title"]') as HTMLInputElement;
    title.value='中文草稿';
    edit.dispatchEvent(new window.Event('click'));edit.dispatchEvent(new window.Event('click'));
    expect(card.querySelector('[data-editform]')).toBe(form);
    expect(title.value).toBe('中文草稿');
    const incomplete=document.querySelector('[data-incomplete]') as HTMLDetailsElement;
    incomplete.open=true;incomplete.dispatchEvent(new window.Event('toggle'));
    expect(document.querySelectorAll('[data-code]')).toHaveLength(10);
    incomplete.dispatchEvent(new window.Event('toggle'));
    expect(document.querySelectorAll('[data-code]')).toHaveLength(10);
    expect(document.querySelectorAll('[data-editform]')).toHaveLength(1);
  });
  it('treats the string live flag 0 as pending when binding review actions',async()=>{
    const {document,window,requests}=await pageFixture();
    const card=document.querySelector('[data-code="first"]')!;
    const reason=card.querySelector('[data-reason]') as HTMLInputElement;
    reason.value='fixture rejection';
    card.querySelector('[data-act="rejectopen"]')!.dispatchEvent(new window.Event('click'));
    card.querySelector('[data-rc="other"]')!.dispatchEvent(new window.Event('click'));
    card.querySelector('[data-act="reject"]')!.dispatchEvent(new window.Event('click'));
    await new Promise(resolve=>setTimeout(resolve,0));
    expect(requests).toEqual(['/api/admin/offers/first/reject']);
  });
  it('discards a late background refresh when typing started during the request',async()=>{
    const {document,context}=await pageFixture();
    const input=document.querySelector('[data-note]')!;
    const refresh=runInContext(`location.hash='#today'; OFFERS=[{id:'original'}];
      loadData=()=>new Promise(resolve=>{releaseRefresh=()=>{OFFERS=[{id:'replacement'}];resolve();};});
      refreshPage()`,context);
    Object.defineProperty(document,'activeElement',{value:input,configurable:true});
    runInContext('releaseRefresh()',context); await refresh;
    expect(runInContext('OFFERS[0].id',context)).toBe('original');
    expect(document.querySelector('[data-note]')).toBe(input);
  });
  it('keeps typing local and immediately dirty, saves exact Chinese text, and reports success without rebuilding the field',async()=>{
    const {document,window,writes,timers}=await pageFixture();
    const input=document.querySelector('[data-note]') as HTMLTextAreaElement;
    input.value='实测大部分模型速度正常。';input.dispatchEvent(new window.Event('input'));
    const status=document.querySelector('[data-note-status]')!;
    expect(status.textContent).toBe('未保存');expect(writes).toHaveLength(0);
    timers.forEach(fn=>fn());
    expect(document.querySelector('[data-note]')).toBe(input);
    document.querySelector('[data-act="note"]')!.dispatchEvent(new window.Event('click'));
    expect(status.textContent).toBe('保存中…');
    await new Promise(resolve=>setTimeout(resolve,0));
    expect(writes).toEqual([{note:'实测大部分模型速度正常。'}]);
    expect(status.textContent).toBe('已保存');
    expect(document.querySelector('[data-note]')).toBe(input);
  });
});
