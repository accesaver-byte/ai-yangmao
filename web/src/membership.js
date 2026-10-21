/* Shared membership semantics are bundled as YMMembership; this file only owns controls. */
function membershipRequirementOf(o) {
  return o.membershipRequirement || YMMembership.migrateLegacyMembership(o.r || o.requirements || [], MEMBERSHIP_CATALOG);
}
function membershipResult(o, subscriptions) {
  const requirement = membershipRequirementOf(o);
  if (requirement.status === 'not_required') return 'yes';
  if (!MEMBERSHIP_CATALOG_OK) return 'unknown';
  const result=YMMembership.matchMembership(requirement,subscriptions,MEMBERSHIP_CATALOG);
  return result==='no'&&C.unresolvedMembers?.length?'unknown':result;
}
function migrateMembershipPreferences(previous) {
  if (!MEMBERSHIP_CATALOG_OK) return previous;
  if (previous.membershipStorageVersion === 2 && previous.membershipCatalogRevision === MEMBERSHIP_CATALOG.revision) return previous;
  const legacy=previous.membershipStorageVersion ? {subscriptions:previous.subscriptions||[],unresolved:previous.unresolvedMembers||[]} : YMMembership.migrateMemberSelections(previous.members||[],MEMBERSHIP_CATALOG);
  const subscriptions=[],unresolved=[...legacy.unresolved];
  for(const old of legacy.subscriptions){
    const planId=MEMBERSHIP_CATALOG.planIdAliases?.[old.planId]||old.planId;
    if(!MEMBERSHIP_CATALOG.plans.some(p=>p.id===planId&&p.status==='verified')){const previousPlan=MEMBERSHIP_CATALOG.plans.find(p=>p.id===old.planId);unresolved.push(previousPlan?membershipPlanLabel(previousPlan):old.planId);continue;}
    if(!subscriptions.some(p=>p.planId===planId))subscriptions.push({...old,planId});
  }
  return {...previous,subscriptions,unresolvedMembers:[...new Set(unresolved)],membershipStorageVersion:2,membershipCatalogRevision:MEMBERSHIP_CATALOG.revision};
}
function membershipEditFields(original, editor, nonmember, otherTouched, evidenceUrl) {
  if (!editor?.touched) return otherTouched ? { requirements: [...nonmember, ...(original.requirements || []).filter(r => r.startsWith('member:'))] } : {};
  const requirement = editor.selectionOnly && editor.requirement.status !== 'not_required'
    ? {...membershipSelectionRequirement(editor.selectedPlanIds,{schemaVersion:'membership-v1',status:'not_required',catalogRevision:editor.catalogRevision,anyOf:[],evidenceUrls:[]},editor.catalogRevision,true),status:'needs_review',evidenceUrls:[]}
    : structuredClone(editor.requirement);
  if (requirement.status === 'confirmed' && (!MEMBERSHIP_CATALOG_OK || editor.catalogAvailable === false)) throw new Error('会员目录未加载，不能保存已确认资格');
  requirement.catalogRevision = editor.catalogRevision ?? requirement.catalogRevision;
  if (requirement.status === 'not_required') requirement.anyOf = [];
  if (requirement.status === 'confirmed' && !requirement.evidenceUrls.length && evidenceUrl) requirement.evidenceUrls = [evidenceUrl];
  const errors = YMMembership.validateMembership(requirement, MEMBERSHIP_CATALOG);
  if (errors.length) throw new Error(errors.join('；'));
  // The API generates member: projections from the structured requirement.
  return { membershipRequirement: requirement, requirements: nonmember.filter(r => r !== 'none') };
}
const membershipOption = (value, label, selected) => `<option value="${esc(value)}" ${selected ? 'selected' : ''}>${esc(label)}</option>`;
function membershipPlanLabel(plan, catalog = MEMBERSHIP_CATALOG) {
  return YMMembership.formatMembership({schemaVersion:'membership-v1',status:'confirmed',catalogRevision:catalog.revision,anyOf:[{allOf:[{productId:plan.productId,scope:'plans',planIds:[plan.id],excludePlanIds:[]}]}],evidenceUrls:[]},catalog);
}
let ownedMembershipVendor = '';
function membershipVendors() {
  const known = MEMBERSHIP_CATALOG.vendors || (typeof PLATFORMS === 'undefined' ? [] : PLATFORMS);
  const vendors = known.map(p => ({...p, status:p.status === 'none' ? 'none' : p.status === 'available' ? 'available' : 'unverified'}));
  // Platform admission can precede the next membership-directory revision.
  for(const p of typeof PLATFORMS==='undefined'?[]:PLATFORMS){
    if(!vendors.some(v=>v.id===p.id))vendors.push({...p,status:'unverified'});
  }
  // Compatibility for existing catalogs; new directory products have explicit platformIds.
  for (const p of MEMBERSHIP_CATALOG.products) {
    if (p.status !== 'retired' && !p.platformIds?.length && !vendors.some(v => v.id === p.id)) vendors.push({id:p.id,name:p.name,status:'unverified'});
  }
  return vendors;
}
function membershipVendorPlans(vendorId) {
  const products = MEMBERSHIP_CATALOG.products.filter(p => p.platformIds?.includes(vendorId) || (!p.platformIds?.length && p.id === vendorId));
  return MEMBERSHIP_CATALOG.plans.filter(p => products.some(x => x.id === p.productId) && p.status !== 'retired');
}
function membershipEmptyVendor(vendor) {
  return vendor?.status === 'none' ? '已核对官方资料，暂无公开会员套餐。' : '该厂商的会员目录尚待补齐。';
}
function subscriptionControls() {
  if (!MEMBERSHIP_CATALOG_OK) return `<div data-owned-subscriptions>${typeof DATA_LOADING !== 'undefined' && DATA_LOADING
    ? '<p class="small muted" role="status">正在加载会员目录…</p>'
    : '<p class="warn-note">会员目录暂时不可用，会员资格显示为还需确认；其他条件仍可使用。</p>'}</div>`;
  const vendors=membershipVendors(), subscriptions=C.subscriptions||[];
  if(!vendors.some(v=>v.id===ownedMembershipVendor))ownedMembershipVendor=vendors[0]?.id||'';
  const vendor=vendors.find(v=>v.id===ownedMembershipVendor),plans=membershipVendorPlans(ownedMembershipVendor);
  return `<div data-owned-subscriptions><p class="small muted">选择厂商，勾选你持有的会员套餐。可选择多个厂商，选择会保存在这台设备。</p>
    ${C.unresolvedMembers?.length?`<p class="warn-note">请重新确认这些旧会员名称：${C.unresolvedMembers.map((name,i)=>`<button type="button" class="btn sm" data-remove-unresolved-member="${i}" title="移除此旧记录">${esc(name)} ×</button>`).join(' ')}</p>`:''}
    <label class="field">厂商<select data-owned-vendor>${vendors.map(v=>membershipOption(v.id,v.name,v.id===ownedMembershipVendor)).join('')}</select></label>
    <div class="chips">${plans.map(p=>`<label class="chip"><input type="checkbox" data-owned-plan="${esc(p.id)}" ${subscriptions.some(s=>s.planId===p.id)?'checked':''} ${p.status!=='verified'?'disabled':''}>${esc(membershipPlanLabel(p))}${p.legacy?'（历史套餐）':''}${p.status!=='verified'?'（待核实）':''}</label>`).join('')||`<p class="small muted">${esc(membershipEmptyVendor(vendor))}</p>`}</div>
    ${subscriptions.length?`<p class="small">已选 ${subscriptions.length} 项</p><div class="chips">${subscriptions.map(s=>{const p=MEMBERSHIP_CATALOG.plans.find(p=>p.id===s.planId);return `<button type="button" class="btn sm" data-remove-owned-plan="${esc(s.planId)}">${esc(p?membershipPlanLabel(p):s.planId)} ×</button>`;}).join('')}</div>`:''}</div>`;
}
function refreshSubscriptionControls() {
  const holder=document.querySelector('[data-owned-subscriptions]');
  if(holder)holder.outerHTML=subscriptionControls();
}
function persistSubscriptionChange() {
  LS.set('ym-cond',C);RACE=computeRace();TREND=computeTrend();drawCondBtn();
  refreshSubscriptionControls();render(true);
}
function bindSubscriptionEvents() {
  document.addEventListener('click',e=>{
    const unresolved=e.target.closest('[data-remove-unresolved-member]');if(unresolved){C.unresolvedMembers=(C.unresolvedMembers||[]).filter((_,i)=>i!==Number(unresolved.dataset.removeUnresolvedMember));persistSubscriptionChange();return;}
    const remove=e.target.closest('[data-remove-owned-plan]');if(!remove)return;
    C.subscriptions=(C.subscriptions||[]).filter(s=>s.planId!==remove.dataset.removeOwnedPlan);persistSubscriptionChange();
  });
  document.addEventListener('change',e=>{
    const input=e.target;
    if(input.matches('[data-owned-vendor]')){ownedMembershipVendor=input.value;refreshSubscriptionControls();return;}
    if(!input.matches('[data-owned-plan]'))return;
    const id=input.dataset.ownedPlan,plan=MEMBERSHIP_CATALOG.plans.find(p=>p.id===id&&p.status==='verified');if(!plan)return;
    C.subscriptions||=[];
    if(input.checked){if(!C.subscriptions.some(s=>s.planId===id))C.subscriptions.push({planId:id});}
    else C.subscriptions=C.subscriptions.filter(s=>s.planId!==id);
    persistSubscriptionChange();
  });
}
function membershipSelectedPlans(requirement) {
  return [...new Set(requirement.anyOf.flatMap(g=>g.allOf.flatMap(c=>{
    const selected=c.planIds.flatMap(id=>YMMembership.membershipPlanAlternatives(id,MEMBERSHIP_CATALOG)||[]),excluded=c.excludePlanIds.flatMap(id=>YMMembership.membershipPlanAlternatives(id,MEMBERSHIP_CATALOG)||[]);
    return MEMBERSHIP_CATALOG.plans.filter(p=>p.productId===c.productId&&p.status==='verified'&&!excluded.includes(p.id)&&(c.scope==='plans'?selected.includes(p.id):c.scope==='any_paid'?p.billing==='paid':true)).map(p=>p.id);
  })))];
}
function membershipSelectionRequirement(ids, original, revision, selectionOnly = false) {
  const selected=[...new Set(ids)].filter(id=>MEMBERSHIP_CATALOG.plans.some(p=>p.id===id&&p.status==='verified'));
  if(!selected.length){
    if(original.anyOf.some(g=>g.allOf.length>1))throw new Error('联合资格不能移除全部必需套餐，请按官方条款重新核对。');
    return {...original,status:'not_required',catalogRevision:revision,anyOf:[]};
  }
  const priorIds=membershipSelectedPlans(original),added=selected.filter(id=>!priorIds.includes(id));
  // Keep the original OR branches and every AND clause. A flat checkbox list
  // cannot determine a new clause's restrictions or its place in a joint rule.
  const anyOf=original.anyOf.map(group=>({ ...structuredClone(group),allOf:group.allOf.map(clause=>{
    const applicable=membershipSelectedPlans({anyOf:[{allOf:[clause]}]});
    const planIds=selected.filter(id=>applicable.includes(id));
    if(group.allOf.length===1){
      for(const id of added){
        const plan=MEMBERSHIP_CATALOG.plans.find(p=>p.id===id);
        const peers=original.anyOf.flatMap(g=>g.allOf).filter(c=>c.productId===plan.productId);
        if(plan.productId===clause.productId&&peers.length===1&&!clause.excludePlanIds.some(old=>(YMMembership.membershipPlanAlternatives(old,MEMBERSHIP_CATALOG)||[]).includes(id)))planIds.push(id);
      }
    }
    const excludePlanIds=[...new Set(clause.excludePlanIds.flatMap(id=>{
      const alternatives=YMMembership.membershipPlanAlternatives(id,MEMBERSHIP_CATALOG);
      if(!alternatives||alternatives.some(current=>!MEMBERSHIP_CATALOG.plans.some(p=>p.id===current&&p.productId===clause.productId&&p.status==='verified')))throw new Error('原排除套餐尚未完成目录映射，不能移除其限制。');
      return alternatives;
    }))];
    return {...structuredClone(clause),scope:'plans',planIds,excludePlanIds};
  })}));
  if(anyOf.some(g=>g.allOf.length>1&&g.allOf.some(c=>!c.planIds.length)))throw new Error('联合资格中的必需产品不能取消全部套餐，请按官方条款重新核对。');
  const retained=anyOf.filter(g=>g.allOf.every(c=>c.planIds.length));
  for(const id of added){
    if(retained.some(g=>g.allOf.some(c=>c.planIds.includes(id))))continue;
    const plan=MEMBERSHIP_CATALOG.plans.find(p=>p.id===id);
    if(original.anyOf.some(g=>g.allOf.length>1)||original.anyOf.some(g=>g.allOf.some(c=>c.productId===plan.productId)))throw new Error('此套餐的联合资格或限制尚不明确，请按官方条款重新核对。');
    let group=retained.find(g=>g.allOf.length===1&&g.allOf[0].productId===plan.productId);
    if(!group){group={allOf:[{productId:plan.productId,scope:'plans',planIds:[],excludePlanIds:[]}]};retained.push(group);}
    group.allOf[0].planIds.push(id);
  }
  return {...original,status:selectionOnly?'needs_review':'confirmed',catalogRevision:revision,anyOf:retained};
}
function membershipEditorMarkup(state) {
  const vendors=membershipVendors();if(!vendors.some(v=>v.id===state.vendorId))state.vendorId=vendors[0]?.id||'';
  const vendor=vendors.find(v=>v.id===state.vendorId),plans=membershipVendorPlans(state.vendorId);
  return `<p class="small">选择厂商，再勾选适用的会员套餐；${state.selectionOnly?'未勾选由模型补齐。':'未选择套餐表示无需会员。'}</p>
    ${state.error?`<p class="warn-note">${esc(state.error)}</p>`:''}
    ${state.requirement.legacyText?.length?`<p class="small muted">原会员条件：${state.requirement.legacyText.map(esc).join('；')}</p>`:''}
    ${state.catalogRevision!==MEMBERSHIP_CATALOG.revision?'<p class="warn-note">目录已更新，请刷新后核对选择。</p>':''}
    <label class="field">厂商<select data-member-vendor>${vendors.map(v=>membershipOption(v.id,v.name,v.id===state.vendorId)).join('')}</select></label>
    <div class="chips">${plans.map(p=>`<label class="chip"><input type="checkbox" data-member-plan="${esc(p.id)}" ${state.selectedPlanIds.includes(p.id)?'checked':''} ${p.status!=='verified'?'disabled':''}>${esc(membershipPlanLabel(p))}${p.legacy?'（历史套餐）':''}${p.status!=='verified'?'（待核实）':''}</label>`).join('')||`<p class="small muted">${esc(membershipEmptyVendor(vendor))}</p>`}</div>
    <p data-membership-preview class="small" aria-live="polite">${esc(YMMembership.formatMembership(state.requirement,MEMBERSHIP_CATALOG))}</p>
    <button type="button" class="btn sm" data-membership-clear>清除会员选择</button> <button type="button" class="btn sm" data-membership-refresh>刷新目录</button>
    <details data-membership-detail="catalog"><summary>管理会员目录</summary><div data-membership-catalog></div></details>`;
}
async function mountMembershipEditor(form, original, options = {}) {
  const host=form.querySelector('[data-membership-editor]');
  const requirement=structuredClone(membershipRequirementOf(original));
  const state={selectionOnly:options.selectionOnly===true,touched:false,requirement,original:structuredClone(requirement),selectedPlanIds:[],vendorId:original.platformId||form.querySelector('[name="platformId"]')?.value||'',catalogRevision:MEMBERSHIP_CATALOG.revision,catalogAvailable:false,error:''};
  form.membershipEditor=state;
  form.addEventListener('change',e=>{if(e.target.matches('[name="req"],[name="reqPay"]'))form.nonmemberTouched=true;});
  try{const catalog=await loadMembershipCatalog(adm);state.catalogAvailable=true;state.catalogRevision=catalog.revision;}
  catch{state.error='会员目录加载失败：可编辑其他字段，不能确认会员资格';}
  state.selectedPlanIds=membershipSelectedPlans(requirement);
  if(state.selectedPlanIds.length&&!membershipVendorPlans(state.vendorId).some(p=>state.selectedPlanIds.includes(p.id))){
    const selected=MEMBERSHIP_CATALOG.plans.find(p=>p.id===state.selectedPlanIds[0]);
    const product=MEMBERSHIP_CATALOG.products.find(p=>p.id===selected?.productId);
    state.vendorId=product?.platformIds?.[0]||product?.id||state.vendorId;
  }
  const redraw=()=>{const open=host.querySelector('[data-membership-detail="catalog"]')?.open;host.innerHTML=membershipEditorMarkup(state);host.querySelector('[data-membership-detail="catalog"]').open=!!open;renderMembershipCatalog(host.querySelector('[data-membership-catalog]'),redraw);};
  const update=()=>{
    try{state.requirement=membershipSelectionRequirement(state.selectedPlanIds,state.original,state.catalogRevision,state.selectionOnly);state.touched=true;state.error='';}
    catch(error){state.error=error.message;state.selectedPlanIds=membershipSelectedPlans(state.requirement);}
    redraw();
  };
  redraw();
  host.addEventListener('change',e=>{
    const input=e.target;if(input.closest('[data-membership-catalog]'))return;
    if(input.matches('[data-member-vendor]')){state.vendorId=input.value;redraw();return;}
    if(!input.matches('[data-member-plan]'))return;
    const id=input.dataset.memberPlan;
    if(input.checked)state.selectedPlanIds=[...new Set([...state.selectedPlanIds,id])];
    else state.selectedPlanIds=state.selectedPlanIds.filter(x=>x!==id);
    update();
  });
  host.addEventListener('click',async e=>{
    const button=e.target.closest('button');if(!button||button.closest('[data-membership-catalog]'))return;
    if(button.hasAttribute('data-membership-clear')){state.selectedPlanIds=[];update();return;}
    if(!button.hasAttribute('data-membership-refresh'))return;
    button.disabled=true;
    try{const catalog=await loadMembershipCatalog(adm);state.catalogRevision=catalog.revision;state.catalogAvailable=true;state.error='';state.touched=true;}
    catch(error){state.error='目录刷新失败：'+error.message;state.catalogAvailable=false;}
    redraw();
  });
}
function renderMembershipCatalog(host, redraw) {
  host.innerHTML=`<p class="small">目录只记录产品、套餐、收费属性和来源；确认这些资料不会重新审批已上架福利。新资格的适用组合与限制另按条款决定。</p><div class="filters"><label class="field">类别<select data-catalog="kind"><option value="plan">套餐</option><option value="product">产品</option></select></label><label class="field">厂商（新增产品时）<select data-catalog="platformId">${membershipVendors().map(p=>membershipOption(p.id,p.name,false)).join('')}</select></label><label class="field">所属产品<select data-catalog="productId">${MEMBERSHIP_CATALOG.products.map(p=>membershipOption(p.id,p.name,false)).join('')}</select></label><label class="field">正式名称<input data-catalog="name" type="text"></label><label class="field">官方来源<input data-catalog="sourceUrl" type="url"></label><label class="field">收费属性<select data-catalog="billing"><option value="unknown">未知</option><option value="paid">付费</option><option value="free">免费</option></select></label></div><button type="button" class="btn sm" data-catalog-create>保存目录项</button><div data-catalog-msg role="status"></div>${['products','plans'].flatMap(key=>MEMBERSHIP_CATALOG[key].filter(p=>p.status==='pending').map(p=>`<p>${esc(p.name)} · 目录资料未确认 <a href="${esc(p.sourceUrl)}" target="_blank" rel="noopener">已登记来源 ↗</a> <button class="btn sm" type="button" data-catalog-verify="${esc(p.id)}" data-kind="${key==='plans'?'plan':'product'}">查看引用并确认资料</button></p>`)).join('')}`;
  host.onclick=async e=>{
    const button=e.target.closest('button');if(!button)return;
    const message=host.querySelector('[data-catalog-msg]');button.disabled=true;
    try{
      if(button.hasAttribute('data-catalog-create')){
        const values=Object.fromEntries([...host.querySelectorAll('[data-catalog]')].map(x=>[x.dataset.catalog,x.value.trim()]));
        if(!values.name||!/^https?:\/\//.test(values.sourceUrl))throw new Error('请填写正式名称和官方来源链接');
        if(values.kind==='product'){delete values.productId;delete values.billing;values.platformIds=[values.platformId];}delete values.platformId;
        await adm('/memberships',{...values,expectedCatalogRevision:MEMBERSHIP_CATALOG.revision});
      }else if(button.dataset.catalogVerify){
        const kind=button.dataset.kind,id=button.dataset.catalogVerify;
        const impact=await adm(`/memberships/${encodeURIComponent(id)}/impact?kind=${kind}`);
        const entry=MEMBERSHIP_CATALOG[kind==='plan'?'plans':'products'].find(p=>p.id===id);
        message.innerHTML=`<p>引用该目录项的福利：${impact.affectedOffers.map(x=>esc(x.title)).join('、')||'无'}。这里只确认名称、所属产品、收费属性和来源，不改这些福利的批准决定。</p><button type="button" class="btn sm" data-confirm-catalog>资料已确认</button>`;
        message.querySelector('button').onclick=async event=>{event.stopPropagation();try{await adm(`/memberships/${encodeURIComponent(id)}/verify`,{kind,expectedCatalogRevision:impact.catalogRevision,expectedRevision:entry.revision,acknowledgeAffectedOffers:true});await loadMembershipCatalog(adm);redraw();}catch(error){message.textContent=error.message;}};
        return;
      }else return;
      await loadMembershipCatalog(adm);redraw();
    }catch(error){message.textContent=error.message;button.disabled=false;}
  };
}
