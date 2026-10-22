import {expect,it} from 'vitest';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {parseHTML} from 'linkedom';
import * as core from '../src/shared/membership';
const entry=(id:string,name:string)=>({id,name,aliases:[],status:'verified' as const,sourceUrl:'https://official.example/plans',verifiedAt:'2026-10-19',revision:1});
const catalog={revision:1,vendors:[{id:'alpha',name:'Alpha',status:'available'},{id:'beta',name:'Beta',status:'available'},{id:'api',name:'API Vendor',status:'none',sourceUrl:'https://official.example/pricing'}],products:[{...entry('a','Alpha'),platformIds:['alpha']},{...entry('b','Beta'),platformIds:['beta']}],plans:[{...entry('a-pro','Alpha Pro'),productId:'a',billing:'paid' as const},{...entry('a-max','Alpha Max'),productId:'a',billing:'paid' as const},{...entry('b-pro','Beta Pro'),productId:'b',billing:'paid' as const}]};
function fixture(){
 const {document,window}=parseHTML('<form><div data-membership-editor></div></form><div id="owned"></div>');
 const ctx=vm.createContext({document,window,structuredClone,YMMembership:core,initialCatalog:catalog,adm:async()=>catalog,esc:(s:unknown)=>String(s),C:{subscriptions:[]},LS:{set(){}},computeRace(){},computeTrend(){},RACE:null,TREND:null,drawCondBtn(){},render(){}});
 vm.runInContext(readFileSync('web/src/data.js','utf8'),ctx);
 vm.runInContext('MEMBERSHIP_CATALOG=initialCatalog;MEMBERSHIP_CATALOG_OK=true;',ctx);
 vm.runInContext(readFileSync('web/src/membership.js','utf8'),ctx);
 const change=(selector:string,value?:string,checked?:boolean)=>{const i=document.querySelector(selector)!;expect(i).not.toBeNull();if(value!==undefined)Object.defineProperty(i,'value',{configurable:true,value});if(checked!==undefined){Object.defineProperty(i,'checked',{configurable:true,value:checked});i.toggleAttribute('checked',checked);}i.dispatchEvent(new window.Event('change',{bubbles:true}));};
 return {document,ctx,change};
}
it('offers vendor-scoped multi-select without group, scope, exclusion, or limits controls',async()=>{
 const {ctx,document,change}=fixture();await vm.runInContext(`mountMembershipEditor(document.querySelector('form'),{platformId:'alpha',requirements:[]})`,ctx);
 expect(document.querySelector('[data-member-vendor]')).not.toBeNull();
 expect(document.querySelector('[data-clause], [data-limit], [data-membership-add-group]')).toBeNull();
 change('[data-member-plan="a-pro"]',undefined,true);change('[data-member-plan="a-max"]',undefined,true);
 const r=vm.runInContext(`membershipEditFields({},document.querySelector('form').membershipEditor,[],false,'https://official.example/perk')`,ctx);
 expect(r.membershipRequirement.anyOf).toEqual([{allOf:[{productId:'a',scope:'plans',planIds:['a-pro','a-max'],excludePlanIds:[]}]}]);
 expect(core.matchMembership(r.membershipRequirement,[{planId:'a-max'}],catalog)).toBe('yes');
 expect(core.matchMembership(r.membershipRequirement,[{planId:'b-pro'}],catalog)).toBe('no');
});
it('lets visitors select every vendor and toggles plans without duplicates while preserving other preferences',()=>{
 const {ctx,document,change}=fixture();vm.runInContext(`C.phone=true;document.querySelector('#owned').innerHTML=subscriptionControls();bindSubscriptionEvents()`,ctx);
 expect([...document.querySelectorAll('[data-owned-vendor] option')].map(o=>o.getAttribute('value'))).toEqual(['alpha','beta','api']);
 change('[data-owned-plan="a-pro"]',undefined,true);change('[data-owned-plan="a-pro"]',undefined,true);
 expect(vm.runInContext('C.subscriptions',ctx)).toEqual([{planId:'a-pro'}]);
 change('[data-owned-vendor]','beta');change('[data-owned-plan="b-pro"]',undefined,true);
 expect(vm.runInContext('C.subscriptions',ctx)).toEqual([{planId:'a-pro'},{planId:'b-pro'}]);
 change('[data-owned-vendor]','api');expect(document.querySelector('[data-owned-subscriptions]')!.textContent).toContain('暂无公开会员套餐');
 expect(vm.runInContext('C.phone',ctx)).toBe(true);
});
it('migrates saved exact plan IDs once, removes duplicate selections and preserves nonmembership settings',()=>{
 const {ctx}=fixture();vm.runInContext(`MEMBERSHIP_CATALOG={...MEMBERSHIP_CATALOG,revision:2,planIdAliases:{'old-alpha-pro':'a-pro'}}`,ctx);
 const result=vm.runInContext(`migrateMembershipPreferences({membershipStorageVersion:1,phone:true,subscriptions:[{planId:'old-alpha-pro'},{planId:'a-pro'},{planId:'unknown-old'}]})`,ctx);
 expect(result.subscriptions).toEqual([{planId:'a-pro'}]);expect(result.phone).toBe(true);expect(result.unresolvedMembers).toContain('unknown-old');expect(result.membershipStorageVersion).toBe(2);
});
it('does not recreate retired duplicate products as extra vendors',()=>{
 const {ctx}=fixture();vm.runInContext(`MEMBERSHIP_CATALOG={...MEMBERSHIP_CATALOG,products:[...MEMBERSHIP_CATALOG.products,{id:'old-app',name:'Old App',status:'retired',aliases:[]}],plans:[...MEMBERSHIP_CATALOG.plans,{id:'old-stub',name:'未知套餐',productId:'old-app',status:'retired'}]}`,ctx);
 expect(vm.runInContext('membershipVendors().map(v=>v.id)',ctx)).toEqual(['alpha','beta','api']);
});
it('opens a cross-vendor benefit at the vendor of its selected membership, rather than hiding the selection under the issuer',async()=>{
 const {ctx,document}=fixture();vm.runInContext(`offer={platformId:'alpha',membershipRequirement:{schemaVersion:'membership-v1',status:'confirmed',catalogRevision:1,evidenceUrls:['https://official.example/perk'],anyOf:[{allOf:[{productId:'b',scope:'plans',planIds:['b-pro'],excludePlanIds:[]}]}]}}`,ctx);
 await vm.runInContext(`mountMembershipEditor(document.querySelector('form'),offer)`,ctx);
 expect(document.querySelector('[data-member-plan="b-pro"]')).not.toBeNull();expect(document.querySelector('[data-member-plan="b-pro"]')!.hasAttribute('checked')).toBe(true);
});
it('lets users remove an ambiguous old membership notice without clearing valid memberships or other preferences',()=>{
 const {ctx,document,change}=fixture();vm.runInContext(`C={phone:true,subscriptions:[{planId:'a-pro'}],unresolvedMembers:['Pro']};document.querySelector('#owned').innerHTML=subscriptionControls();bindSubscriptionEvents()`,ctx);
 const remove=document.querySelector('[data-remove-unresolved-member]');expect(remove).not.toBeNull();remove!.dispatchEvent(new (ctx.window as any).Event('click',{bubbles:true}));
 expect(vm.runInContext('C.unresolvedMembers',ctx)).toEqual([]);expect(vm.runInContext('C.subscriptions',ctx)).toEqual([{planId:'a-pro'}]);expect(vm.runInContext('C.phone',ctx)).toBe(true);
});
it('does not turn an unresolved old membership into a definite negative qualification',()=>{
 const {ctx}=fixture();vm.runInContext(`C.unresolvedMembers=['旧版 Pro'];offer={membershipRequirement:{schemaVersion:'membership-v1',status:'confirmed',catalogRevision:1,evidenceUrls:['https://official.example/perk'],anyOf:[{allOf:[{productId:'a',scope:'plans',planIds:['a-pro'],excludePlanIds:[]}]}]}}`,ctx);
 expect(vm.runInContext('membershipResult(offer,[])',ctx)).toBe('unknown');
});
it('keeps existing limits when editing concrete seats expanded from a retired aggregate',async()=>{
 const {ctx,document,change}=fixture();vm.runInContext(`MEMBERSHIP_CATALOG={...MEMBERSHIP_CATALOG,planReplacements:{'a-pro':['a-standard','a-premium']},plans:[...MEMBERSHIP_CATALOG.plans.map(p=>p.id==='a-pro'?{...p,status:'retired'}:p),...['standard','premium'].map(n=>({...MEMBERSHIP_CATALOG.plans[0],id:'a-'+n,name:'Alpha Teams '+n,status:'verified'}))]};offer={platformId:'alpha',membershipRequirement:{schemaVersion:'membership-v1',status:'confirmed',catalogRevision:1,evidenceUrls:['https://official.example/perk'],anyOf:[{allOf:[{productId:'a',scope:'plans',planIds:['a-pro'],excludePlanIds:[],limits:{billingCycles:['annual']}}]}]}}`,ctx);
 const r=vm.runInContext(`membershipSelectionRequirement(['a-premium'],offer.membershipRequirement,1)`,ctx);
 expect(r.anyOf[0].allOf[0].limits).toEqual({billingCycles:['annual']});
});
const clause=(productId:string,planIds:string[],limits?:object)=>({productId,scope:'plans',planIds,excludePlanIds:[],...(limits?{limits}:{})});
const requirement=(anyOf:any[])=>({schemaVersion:'membership-v1',status:'confirmed',catalogRevision:1,evidenceUrls:['https://official.example/perk'],anyOf});
it('narrows a seat choice while retaining its required usage product and original restrictions',async()=>{
 const {ctx,document,change}=fixture();
 const seat=clause('a',['a-pro','a-max'],{billingCycles:['annual']});
 const original=requirement([{allOf:[seat,clause('b',['b-pro'])]}]);
 (ctx as any).offer={platformId:'alpha',membershipRequirement:original};
 await vm.runInContext(`mountMembershipEditor(document.querySelector('form'),offer)`,ctx);
 change('[data-member-plan="a-pro"]',undefined,false);
 const saved=vm.runInContext(`membershipEditFields(offer,document.querySelector('form').membershipEditor,[],false,'')`,ctx).membershipRequirement;
 expect(saved?.anyOf).toEqual([{allOf:[clause('a',['a-max'],{billingCycles:['annual']}),clause('b',['b-pro'])]}]);
 expect(core.matchMembership(saved,[{planId:'a-max',billingCycle:'annual'}],catalog)).toBe('no');
});
it('retains every restriction branch for a plan occurring more than once',()=>{
 const {ctx}=fixture();(ctx as any).original=requirement([{allOf:[clause('a',['a-pro','a-max'],{billingCycles:['annual']})]},{allOf:[clause('a',['a-pro'],{regions:['US']})]}]);
 const saved=vm.runInContext(`membershipSelectionRequirement(['a-pro'],original,1)`,ctx);
 expect(saved.anyOf).toEqual([{allOf:[clause('a',['a-pro'],{billingCycles:['annual']})]},{allOf:[clause('a',['a-pro'],{regions:['US']})]}]);
});
it('blocks removal of an entire required product rather than accepting the other product alone',async()=>{
 const {ctx,document,change}=fixture();const original=requirement([{allOf:[clause('a',['a-pro']),clause('b',['b-pro'])]}]);(ctx as any).offer={platformId:'alpha',membershipRequirement:original};
 expect(()=>vm.runInContext(`membershipSelectionRequirement(['b-pro'],offer.membershipRequirement,1)`,ctx)).toThrow();
 await vm.runInContext(`mountMembershipEditor(document.querySelector('form'),offer)`,ctx);
 change('[data-member-plan="a-pro"]',undefined,false);
 expect(vm.runInContext(`document.querySelector('form').membershipEditor.requirement`,ctx)).toEqual(original);
 expect(document.querySelector('[data-member-plan="a-pro"]')!.hasAttribute('checked')).toBe(true);
 expect(document.querySelector('.warn-note')).not.toBeNull();
});
it('preserves excluded plans when narrowing an existing clause',()=>{
 const {ctx}=fixture();(ctx as any).original=requirement([{allOf:[{...clause('a',['a-pro','a-max']),excludePlanIds:['a-pro']}]}]);
 expect(vm.runInContext(`membershipSelectionRequirement(['a-max'],original,1).anyOf[0].allOf[0].excludePlanIds`,ctx)).toEqual(['a-pro']);
});
it('blocks ambiguous additions to restriction branches rather than choosing the first restriction',()=>{
 const {ctx}=fixture();(ctx as any).original=requirement([{allOf:[clause('a',['a-pro'],{billingCycles:['annual']})]},{allOf:[clause('a',['a-pro'],{regions:['US']})]}]);
 expect(()=>vm.runInContext(`membershipSelectionRequirement(['a-pro','a-max'],original,1)`,ctx)).toThrow();
});
it('does not confirm an unresolved requirement just because a plan was selected',()=>{
 const {ctx}=fixture();(ctx as any).original={...requirement([{allOf:[clause('a',['a-pro','a-max'])]}]),status:'needs_review'};
 expect(vm.runInContext(`membershipSelectionRequirement(['a-pro'],original,1,true).status`,ctx)).toBe('needs_review');
});

it('lets the normal administrator editor confirm an unresolved rule with source evidence',async()=>{
 const {ctx,document,change}=fixture();(ctx as any).offer={membershipRequirement:{...requirement([{allOf:[clause('a',['a-pro','a-max'])]}]),status:'needs_review',evidenceUrls:[]}};
 await vm.runInContext(`mountMembershipEditor(document.querySelector('form'),offer)`,ctx);change('[data-member-plan="a-pro"]',undefined,false);
 expect(vm.runInContext(`membershipEditFields(offer,document.querySelector('form').membershipEditor,[],false,'https://official.example/perk').membershipRequirement`,ctx)).toMatchObject({status:'confirmed',evidenceUrls:['https://official.example/perk']});
});
it('expands a retired excluded alias without removing the exclusion',()=>{
 const {ctx}=fixture();vm.runInContext(`MEMBERSHIP_CATALOG={...MEMBERSHIP_CATALOG,planIdAliases:{'old-max':'a-max'},plans:[...MEMBERSHIP_CATALOG.plans,{...MEMBERSHIP_CATALOG.plans[1],id:'old-max',status:'retired'}]}`,ctx);
 (ctx as any).original=requirement([{allOf:[{...clause('a',['a-pro','a-max']),excludePlanIds:['old-max']}]}]);
 const saved=vm.runInContext(`membershipSelectionRequirement(['a-pro'],original,1)`,ctx);
 expect(saved.anyOf[0].allOf[0].excludePlanIds).toEqual(['a-max']);expect(core.validateMembership(saved,vm.runInContext('MEMBERSHIP_CATALOG',ctx))).toEqual([]);
});
it('keeps the fast-track editor full conjunction and restrictions but submits only unresolved concrete identities',async()=>{
 const {ctx,document,change}=fixture();const original=requirement([{allOf:[{...clause('a',['a-pro','a-max'],{billingCycles:['annual']}),excludePlanIds:['a-pro']},clause('b',['b-pro'])]}]);(ctx as any).offer={membershipRequirement:original};
 await vm.runInContext(`mountMembershipEditor(document.querySelector('form'),offer,{selectionOnly:true})`,ctx);
 // Change a selected plan off/on while the required usage product stays selected.
 change('[data-member-plan="a-max"]',undefined,false);
 expect(vm.runInContext(`document.querySelector('form').membershipEditor.requirement.anyOf[0].allOf.length`,ctx)).toBe(2);
 change('[data-member-plan="a-max"]',undefined,true);
 const saved=vm.runInContext(`membershipEditFields(offer,document.querySelector('form').membershipEditor,[],false,'https://official.example/perk').membershipRequirement`,ctx);
 expect(saved).toMatchObject({status:'needs_review',evidenceUrls:[]});
 expect(saved.anyOf.flatMap((g:any)=>g.allOf).map((c:any)=>({ids:c.planIds,excluded:c.excludePlanIds,limits:c.limits}))).toEqual([{ids:['a-max'],excluded:[],limits:undefined},{ids:['b-pro'],excluded:[],limits:undefined}]);
});
it('serializes an empty fast-track choice for the server to defer to the model',()=>{
 const {ctx}=fixture();(ctx as any).editor={touched:true,selectionOnly:true,selectedPlanIds:[],catalogAvailable:true,catalogRevision:1,requirement:{...requirement([]),status:'not_required'}};
 expect(vm.runInContext(`membershipEditFields({},editor,[],false,'https://official.example/perk').membershipRequirement.status`,ctx)).toBe('not_required');
});

it('saves the 39-product Microsoft vendor selection and matches only selected memberships',()=>{
 const {ctx}=fixture();
 // Concrete product/plan identities from the revision-59 catalog (105 verified plans).
 const microsoftPlans:Record<string,string[]>={
  "microsoft-copilot-personal":["microsoft-copilot-personal-personal","microsoft-copilot-personal-family","microsoft-copilot-personal-premium","microsoft-copilot-personal-pro"],
  "microsoft-copilot-free":["microsoft-copilot-free-free"],
  "microsoft-copilot-business":["microsoft-copilot-business-copilot-business-add-on","microsoft-copilot-business-business-standard-with-copilot","microsoft-copilot-business-business-premium-with-copilot","microsoft-copilot-business-business-standard-with-copilot-no-teams","microsoft-copilot-business-business-premium-with-copilot-no-teams"],
  "microsoft-copilot-enterprise":["microsoft-copilot-enterprise-add-on"],
  "microsoft-365-enterprise":["microsoft-365-enterprise-e7"],
  "microsoft-teams-premium":["microsoft-teams-premium-premium"],
  "microsoft-power-apps":["microsoft-power-apps-developer-plan","microsoft-power-apps-premium"],
  "microsoft-power-automate":["microsoft-power-automate-premium","microsoft-power-automate-process","microsoft-power-automate-hosted-process"],
  "microsoft-copilot-studio":["microsoft-copilot-studio-copilot-credit-pack-subscription"],
  "microsoft-dynamics-sales":["microsoft-dynamics-sales-sales-professional","microsoft-dynamics-sales-sales-enterprise-edition","microsoft-dynamics-sales-sales-premium"],
  "microsoft-relationship-sales":["microsoft-relationship-sales-relationship-sales"],
  "microsoft-dynamics-customer-service":["microsoft-dynamics-customer-service-customer-service-professional","microsoft-dynamics-customer-service-customer-service-enterprise","microsoft-dynamics-customer-service-customer-service-premium"],
  "microsoft-dynamics-contact-center":["microsoft-dynamics-contact-center-contact-center","microsoft-dynamics-contact-center-contact-center-digital","microsoft-dynamics-contact-center-contact-center-voice"],
  "microsoft-dynamics-field-service":["microsoft-dynamics-field-service-field-service","microsoft-dynamics-field-service-field-service-contractor"],
  "microsoft-dynamics-finance":["microsoft-dynamics-finance-finance","microsoft-dynamics-finance-finance-premium"],
  "microsoft-dynamics-supply-chain-management":["microsoft-dynamics-supply-chain-management-supply-chain-management","microsoft-dynamics-supply-chain-management-supply-chain-management-premium"],
  "microsoft-dynamics-intelligent-order-management":["microsoft-dynamics-intelligent-order-management-intelligent-order-management"],
  "microsoft-dynamics-customer-insights":["microsoft-dynamics-customer-insights-customer-insights","microsoft-dynamics-customer-insights-customer-insights-attach"],
  "microsoft-dynamics-customer-insights-legacy":["microsoft-dynamics-customer-insights-legacy-marketing-standalone","microsoft-dynamics-customer-insights-legacy-customer-insights-standalone"],
  "microsoft-dynamics-business-central":["microsoft-dynamics-business-central-business-central-essentials","microsoft-dynamics-business-central-business-central-premium","microsoft-dynamics-business-central-business-central-team-members"],
  "microsoft-dynamics-project-operations":["microsoft-dynamics-project-operations-project-operations"],
  "microsoft-dynamics-commerce":["microsoft-dynamics-commerce-commerce","microsoft-dynamics-commerce-commerce-e-commerce-add-on","microsoft-dynamics-commerce-commerce-headless-add-on"],
  "microsoft-dynamics-human-resources":["microsoft-dynamics-human-resources-human-resources","microsoft-dynamics-human-resources-human-resources-self-service"],
  "microsoft-dynamics-additional-software-licenses":["microsoft-dynamics-additional-software-licenses-sales-device","microsoft-dynamics-additional-software-licenses-sales-insights","microsoft-dynamics-additional-software-licenses-customer-service-device","microsoft-dynamics-additional-software-licenses-contact-center-digital-add-on","microsoft-dynamics-additional-software-licenses-contact-center-voice-add-on","microsoft-dynamics-additional-software-licenses-contact-center-add-on-digital-plus-voice","microsoft-dynamics-additional-software-licenses-field-service-device","microsoft-dynamics-additional-software-licenses-field-service-resource-scheduling-optimization","microsoft-dynamics-additional-software-licenses-team-members","microsoft-dynamics-additional-software-licenses-operations-activity","microsoft-dynamics-additional-software-licenses-operations-device"],
  "microsoft-power-bi":["microsoft-power-bi-free-account","microsoft-power-bi-pro","microsoft-power-bi-premium-per-user"],
  "microsoft-clipchamp-personal":["microsoft-clipchamp-personal-free","microsoft-clipchamp-personal-premium-standalone-existing-subscribers"],
  "microsoft-clipchamp-work":["microsoft-clipchamp-work-standard","microsoft-clipchamp-work-premium"],
  "microsoft-teams-rooms":["microsoft-teams-rooms-basic","microsoft-teams-rooms-pro"],
  "microsoft-365-education":["microsoft-365-education-a1","microsoft-365-education-a3","microsoft-365-education-a5"],
  "microsoft-office-365-education":["microsoft-office-365-education-a1","microsoft-office-365-education-a3","microsoft-office-365-education-a5"],
  "microsoft-power-apps-per-app":["microsoft-power-apps-per-app-per-app"],
  "microsoft-power-automate-per-flow-legacy":["microsoft-power-automate-per-flow-legacy-per-flow"],
  "microsoft-power-automate-user-legacy":["microsoft-power-automate-user-legacy-per-user-plan","microsoft-power-automate-user-legacy-p1","microsoft-power-automate-user-legacy-p2"],
  "microsoft-365-business-base":["microsoft-365-business-base-business-basic","microsoft-365-business-base-business-standard","microsoft-365-business-base-business-premium","microsoft-365-business-base-business-basic-no-teams","microsoft-365-business-base-business-standard-no-teams","microsoft-365-business-base-business-premium-no-teams","microsoft-365-business-base-apps-for-business"],
  "microsoft-365-enterprise-base":["microsoft-365-enterprise-base-e3","microsoft-365-enterprise-base-e5","microsoft-365-enterprise-base-e3-no-teams","microsoft-365-enterprise-base-e5-no-teams","microsoft-365-enterprise-base-e7-no-teams"],
  "microsoft-365-frontline-base":["microsoft-365-frontline-base-f1","microsoft-365-frontline-base-f3","microsoft-365-frontline-base-f1-no-teams","microsoft-365-frontline-base-f3-no-teams"],
  "microsoft-office-365-enterprise-base":["microsoft-office-365-enterprise-base-e1","microsoft-office-365-enterprise-base-e3","microsoft-office-365-enterprise-base-e5","microsoft-office-365-enterprise-base-e1-no-teams","microsoft-office-365-enterprise-base-e3-no-teams","microsoft-office-365-enterprise-base-e5-no-teams","microsoft-office-365-enterprise-base-f3"],
  "microsoft-365-apps-enterprise-base":["microsoft-365-apps-enterprise-base-apps-for-enterprise"],
  "microsoft-agent-365":["microsoft-agent-365-agent-365"]
 };
 const products=Object.keys(microsoftPlans).map(id=>({...entry(id,id),platformIds:['microsoft-ai']}));
 const plans=Object.entries(microsoftPlans).flatMap(([productId,ids])=>ids.map(id=>({...entry(id,id),productId,billing:'paid'})));
 (ctx as any).largeCatalog={...catalog,revision:59,products:[...catalog.products,...products],plans:[...catalog.plans,...plans]};
 vm.runInContext(`MEMBERSHIP_CATALOG=largeCatalog;const ids=MEMBERSHIP_CATALOG.plans.filter(p=>p.productId.startsWith('microsoft-')).map(p=>p.id);const r=membershipSelectionRequirement(ids,{schemaVersion:'membership-v1',status:'not_required',catalogRevision:59,evidenceUrls:[],anyOf:[]},59);editor={touched:true,requirement:r,catalogAvailable:true,catalogRevision:59}`,ctx);
 const saved=vm.runInContext(`membershipEditFields({},editor,[],false,'https://www.microsoft.com/en-us/copilot/pricing').membershipRequirement`,ctx);
 expect(saved.anyOf).toHaveLength(39);expect(saved.anyOf.flatMap((g:any)=>g.allOf).flatMap((c:any)=>c.planIds)).toHaveLength(105);
 expect(core.matchMembership(saved,[{planId:plans[0].id}],(ctx as any).largeCatalog)).toBe('yes');
 expect(core.matchMembership(saved,[{planId:'b-pro'}],(ctx as any).largeCatalog)).toBe('no');
});
it('includes newly admitted Command Code beside catalog vendors without changing saved subscriptions',async()=>{
 const {ctx,document,change}=fixture();vm.runInContext(`PLATFORMS=[{id:'alpha',name:'Live Alpha'},{id:'api',name:'Live API'},{id:'command-code',name:'Command Code'}];C.subscriptions=[{planId:'a-pro',billingCycle:'annual'}];document.querySelector('#owned').innerHTML=subscriptionControls();bindSubscriptionEvents()`,ctx);
 const vendors=vm.runInContext('membershipVendors()',ctx);
 expect(vendors.map((v:any)=>v.id)).toEqual(['alpha','beta','api','command-code']);expect(vendors.find((v:any)=>v.id==='alpha')).toMatchObject({name:'Alpha',status:'available'});expect(vendors.find((v:any)=>v.id==='api')).toMatchObject({name:'API Vendor',status:'none'});expect(vendors.find((v:any)=>v.id==='command-code')).toMatchObject({name:'Command Code',status:'unverified'});
 change('[data-owned-vendor]','command-code');expect(document.querySelector('[data-owned-subscriptions]')!.textContent).toContain('目录尚待补齐');expect(document.querySelector('[data-owned-plan]')).toBeNull();
 expect(vm.runInContext('C.subscriptions',ctx)).toEqual([{planId:'a-pro',billingCycle:'annual'}]);
 await vm.runInContext(`mountMembershipEditor(document.querySelector('form'),{requirements:[]})`,ctx);change('[data-member-vendor]','command-code');expect(document.querySelector('[data-membership-editor]')!.textContent).toContain('目录尚待补齐');expect(document.querySelector('[data-member-plan]')).toBeNull();
 expect(vm.runInContext('C.subscriptions',ctx)).toEqual([{planId:'a-pro',billingCycle:'annual'}]);
});
