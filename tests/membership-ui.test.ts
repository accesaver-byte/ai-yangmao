import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const source = () => readFileSync('web/src/membership.js', 'utf8');
function context() {
 const c = vm.createContext({ structuredClone, esc:(s:unknown)=>String(s), C:{subscriptions:[]}, YMMembership: { migrateLegacyMembership: (r: string[]) => ({status:r.some(x=>x.startsWith('member:'))?'needs_review':'not_required'}), matchMembership: (r: any) => r.status==='confirmed'?'yes':r.status==='not_required'?'yes':'unknown', migrateMemberSelections: () => ({subscriptions:[],unresolved:['Pro']}), formatMembership:()=> 'New Vendor Pro' }, MEMBERSHIP_CATALOG:{revision:1,products:[],plans:[]}, MEMBERSHIP_CATALOG_OK:true });
 vm.runInContext(source(), c); return c;
}
describe('membership browser contract', () => {
 it('shows pending directory entries disabled instead of treating them as selectable memberships', () => {
  const c=context();
  vm.runInContext(`MEMBERSHIP_CATALOG={revision:2,products:[{id:'new-vendor',name:'New Vendor',status:'pending'}],plans:[{id:'new-vendor-pro',productId:'new-vendor',name:'Pro',status:'pending'}]}`,c);
  const html=vm.runInContext(`subscriptionControls()`,c);
  expect(html).toContain('New Vendor');expect(html).toContain('data-owned-plan="new-vendor-pro"');expect(html).toContain('disabled');expect(html).toContain('待核实');
 });
 it('treats unstructured member text as unknown without exact-string matching', () => {
  expect(vm.runInContext(`membershipResult({r:['member:Pro']},[])`, context())).toBe('unknown');
 });
 it('does not erase multiple legacy requirements during unrelated edits', () => {
  expect(vm.runInContext(`JSON.stringify(membershipEditFields({requirements:['member:A','member:B','net']}, {touched:false}, ['net'], false, ''))`, context())).toBe('{}');
 });
 it('preserves all legacy member entries when a nonmember condition changes', () => {
  expect(JSON.parse(vm.runInContext(`JSON.stringify(membershipEditFields({requirements:['member:A','member:B','net']}, {touched:false}, ['card'], true, ''))`, context()))).toEqual({requirements:['card','member:A','member:B']});
 });
 it('keeps local nonmember preferences and unresolved old memberships during migration', () => {
  const result=JSON.parse(vm.runInContext(`JSON.stringify(migrateMembershipPreferences({phone:true,members:['Pro']}))`, context()));
  expect(result).toMatchObject({phone:true,membershipStorageVersion:2,subscriptions:[],unresolvedMembers:['Pro']});
 });
 it('refuses a confirmed edit if the catalog was unavailable', () => {
  const c=context();vm.runInContext('MEMBERSHIP_CATALOG_OK=false',c);
  expect(()=>vm.runInContext(`membershipEditFields({}, {touched:true, requirement:{status:'confirmed'}}, [], false, '')`,c)).toThrow(/目录/);
 });
});

import { parseHTML } from 'linkedom';
import * as core from '../src/shared/membership';
const catalog = {revision:3, products:[{id:'cursor',name:'Cursor',aliases:[],status:'verified',sourceUrl:'https://cursor.com',verifiedAt:'2026-10-11',revision:1},{id:'claude',name:'Claude',aliases:[],status:'verified',sourceUrl:'https://claude.ai',verifiedAt:'2026-10-11',revision:1}],plans:[{id:'cursor-pro',productId:'cursor',name:'Pro',aliases:[],status:'verified',billing:'paid',sourceUrl:'https://cursor.com',verifiedAt:'2026-10-11',revision:1},{id:'claude-pro',productId:'claude',name:'Pro',aliases:[],status:'verified',billing:'paid',sourceUrl:'https://claude.ai',verifiedAt:'2026-10-11',revision:1}]};
function editorFixture() {
 const {document,window}=parseHTML('<form><div data-membership-editor></div></form>');
 const c=vm.createContext({document,window,structuredClone,YMMembership:core,initialCatalog:catalog,adm:async()=>catalog,esc:(s:unknown)=>String(s).replace(/[<>&"']/g,''),C:{subscriptions:[]}});
 vm.runInContext(readFileSync('web/src/data.js','utf8'),c);
 vm.runInContext('MEMBERSHIP_CATALOG=initialCatalog;MEMBERSHIP_CATALOG_OK=true;',c);
 vm.runInContext(source(),c);
 const change=(selector:string,value:string)=>{const input=document.querySelector(selector)!;Object.defineProperty(input,'value',{configurable:true,value});input.dispatchEvent(new window.Event('change',{bubbles:true}));};
 return {document,window,c,change};
}
describe('membership editor controls',()=>{
 it('saves checked plans across vendors without logical-group controls',async()=>{
  const {c,document,window,change}=editorFixture();
  await vm.runInContext(`mountMembershipEditor(document.querySelector('form'),{requirements:['none']})`,c);
  const check=(id:string)=>{const p=document.querySelector(`[data-member-plan="${id}"]`)!;Object.defineProperty(p,'checked',{configurable:true,value:true});p.dispatchEvent(new window.Event('change',{bubbles:true}));};
  check('cursor-pro');change('[data-member-vendor]','claude');check('claude-pro');
  const result=vm.runInContext(`membershipEditFields({},document.querySelector('form').membershipEditor,[],false,'https://example.com/eligibility')`,c);
  expect(result.membershipRequirement.anyOf).toMatchObject([{allOf:[{productId:'cursor',planIds:['cursor-pro']}]},{allOf:[{productId:'claude',scope:'plans',planIds:['claude-pro']}]}]);
  expect(core.matchMembership(result.membershipRequirement,[{planId:'claude-pro'}],catalog as core.MembershipCatalog)).toBe('yes');
  expect(core.matchMembership(result.membershipRequirement,[],catalog as core.MembershipCatalog)).toBe('no');
  expect(document.querySelector('[data-membership-add-group], [data-limit], [data-clause]')).toBeNull();
 });
 it('shows missing details as unknown and does not turn bare Pro into either platform',()=>{
  const {c}=editorFixture();
  expect(vm.runInContext(`migrateMembershipPreferences({members:['Pro'],phone:true}).unresolvedMembers`,c)).toEqual(['Pro']);
  const req={schemaVersion:'membership-v1',status:'confirmed',catalogRevision:3,evidenceUrls:['https://example.com'],anyOf:[{allOf:[{productId:'cursor',scope:'plans',planIds:['cursor-pro'],excludePlanIds:[],limits:{trial:'exclude'}}]}]};
  c.offer={membershipRequirement:req};
  expect(vm.runInContext(`membershipResult(offer,[{planId:'cursor-pro'}])`,c)).toBe('unknown');
  expect(vm.runInContext(`membershipResult(offer,[{planId:'cursor-pro',trial:false}])`,c)).toBe('yes');
 });
 it('does not silently rebase an editor when a newer catalog becomes available',async()=>{
  const {c}=editorFixture();await vm.runInContext(`mountMembershipEditor(document.querySelector('form'),{requirements:['none']})`,c);
  const req={schemaVersion:'membership-v1',status:'confirmed',catalogRevision:3,evidenceUrls:['https://example.com'],anyOf:[{allOf:[{productId:'cursor',scope:'plans',planIds:['cursor-pro'],excludePlanIds:[]}]}]};
  c.req=req;
  vm.runInContext(`document.querySelector('form').membershipEditor.requirement=req;document.querySelector('form').membershipEditor.touched=true;MEMBERSHIP_CATALOG={...MEMBERSHIP_CATALOG,revision:4}`,c);
  expect(()=>vm.runInContext(`membershipEditFields({},document.querySelector('form').membershipEditor,[],false,'')`,c)).toThrow(/版本/);
 });
});

describe('membership editor catalog refresh',()=>{
 it('does not duplicate product names in already qualified standard plans',()=>{
  const {c}=editorFixture();
  vm.runInContext(`MEMBERSHIP_CATALOG={...MEMBERSHIP_CATALOG,plans:MEMBERSHIP_CATALOG.plans.map(p=>({...p,name:p.id==='cursor-pro'?'Cursor Pro':p.name}))}`,c);
  expect(vm.runInContext(`membershipPlanLabel(MEMBERSHIP_CATALOG.plans[0])`,c)).toBe('Cursor Pro');
  expect(vm.runInContext(`subscriptionControls()`,c)).not.toContain('Cursor Cursor Pro');
 });
 it('adopts a newer revision on refresh and preserves existing eligibility facts without exposing logic controls',async()=>{
  const {c,document,window}=editorFixture();
  const req={schemaVersion:'membership-v1',status:'confirmed',catalogRevision:3,evidenceUrls:['https://example.com'],anyOf:[{allOf:[{productId:'cursor',scope:'plans',planIds:['cursor-pro'],excludePlanIds:[],limits:{trial:'exclude'}}]}]};
  c.original={membershipRequirement:req};
  await vm.runInContext(`mountMembershipEditor(document.querySelector('form'),original)`,c);
  expect(document.querySelector('[data-limit]')).toBeNull();
  vm.runInContext(`adm=async()=>({...MEMBERSHIP_CATALOG,revision:4})`,c);
  document.querySelector('[data-membership-refresh]')!.dispatchEvent(new window.Event('click',{bubbles:true}));
  await new Promise(resolve=>setTimeout(resolve,0));
  const saved=vm.runInContext(`membershipEditFields({},document.querySelector('form').membershipEditor,[],false,'https://example.com')`,c);
  expect(saved.membershipRequirement.catalogRevision).toBe(4);
  expect(saved.membershipRequirement.anyOf[0].allOf[0]).toMatchObject({productId:'cursor',planIds:['cursor-pro'],limits:{trial:'exclude'}});
 });
});
