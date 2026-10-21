function urgentReviewHtml(q) {
  const cards = (rows, suppressed) => rows.map(r => `<article class="card" data-urgent-key="${esc(r.key)}" ${r.deadline ? `data-urgent-end="${esc(r.deadline)}"` : ''}>
    <div class="row" style="justify-content:space-between"><b>${esc(r.title)}</b><span class="st warn" data-urgent-tier>${r.tier === 'P0' ? '马上处理' : '优先处理'}</span></div>
    <p class="small"><b data-urgent-clock>${r.deadline ? esc(new Date(r.deadline).toLocaleString()) + ' 截止' : '未确认截止时间，不代表还有固定领取时长'}</b></p>
    <p class="small">${esc(r.reason)}<br>${esc(r.stage)}</p>
    <div class="row"><button class="btn sm" data-urgent-open type="button">查看处理卡</button><button class="btn sm" data-urgent-suppress="${suppressed ? '0' : '1'}" type="button">${suppressed ? '恢复优先处理' : '不紧急'}</button></div>
    <p class="small" role="status" data-urgent-feedback></p><div data-urgent-detail></div></article>`).join('');
  return `<section data-urgent-section><div class="row" style="justify-content:space-between"><h3>紧急福利 · <span data-urgent-count>${(q.urgent || []).length}</span> 项</h3><button class="btn sm" data-urgent-refresh type="button">刷新紧急区</button></div>
    <p class="small muted">先核实快截止或限量的福利；加急不等于已核实或可直接上架。时间按当前设备时区显示。刷新会重新计算优先级，不改变审核决定。</p>
    <div class="grid g2" data-urgent-list>${cards(q.urgent || [], false)}</div><p class="small muted" data-urgent-empty ${(q.urgent || []).length ? 'hidden' : ''}>当前没有需要加急的待处理福利。</p>
    <details data-urgent-dismissed ${(q.urgencyDismissed || []).length ? '' : 'hidden'}><summary>已标记不紧急 · <span data-urgent-dismissed-count>${(q.urgencyDismissed || []).length}</span> 项</summary><div data-urgent-dismissed-list>${cards(q.urgencyDismissed || [], true)}</div></details></section>`;
}
function updateUrgentClocks() {
  $$('[data-urgent-end]').forEach(card => {
    const left = Date.parse(card.dataset.urgentEnd) - Date.now();
    card.querySelector('[data-urgent-clock]').textContent = left > 0 ? `还剩 ${cdText(left)} · ${new Date(card.dataset.urgentEnd).toLocaleString()} 截止` : '已截止，退出加急；原审核记录保留';
    if (left <= 0) {
      card.dataset.urgentExpired = '1';
      card.querySelector('[data-urgent-tier]').textContent = '已截止';
      card.querySelector('[data-urgent-suppress]').disabled = true;
      card.hidden = !card.querySelector('[data-urgent-detail]')?.children.length;
    } else if (left <= DAY) card.querySelector('[data-urgent-tier]').textContent = '马上处理';
  });
  const section = $('[data-urgent-section]');
  if (section) {
    const count = section.querySelectorAll('[data-urgent-list] [data-urgent-key]:not([data-urgent-expired])').length;
    section.querySelector('[data-urgent-count]').textContent = count;
    section.querySelector('[data-urgent-empty]').hidden = count > 0;
    const dismissed = section.querySelectorAll('[data-urgent-dismissed-list] [data-urgent-key]:not([data-urgent-expired])').length;
    section.querySelector('[data-urgent-dismissed-count]').textContent = dismissed;
    section.querySelector('[data-urgent-dismissed]').hidden = dismissed === 0 && !section.querySelector('[data-urgent-dismissed-list] [data-urgent-detail] input, [data-urgent-dismissed-list] [data-urgent-detail] textarea');
  }
}
function urgentDetailEditing(section) {
  return [...section.querySelectorAll('[data-urgent-detail] input, [data-urgent-detail] textarea, [data-urgent-detail] select, [data-urgent-detail] [data-submitting="1"]')]
    .some(control => !control.closest('[data-resolved="1"], [data-completed="1"]'));
}
function bindUrgentReview(box, q) {
  const section = box.querySelector('[data-urgent-section]');
  if (!section) return;
  let interactionVersion = 0;
  let pendingOperations = 0;
  const rows = [...(q.urgent || []), ...(q.urgencyDismissed || [])];
  const priority = [...rows].sort((a, b) => a.tier.localeCompare(b.tier)
    || (a.latestUsefulReviewAt || 'z').localeCompare(b.latestUsefulReviewAt || 'z')
    || (a.discoveredAt || '').localeCompare(b.discoveredAt || ''));
  section.querySelector('[data-urgent-refresh]').addEventListener('click', async e => {
    const button = e.currentTarget;
    if (pendingOperations) { toast('处理卡请求尚未完成，请稍后刷新'); return; }
    if (urgentDetailEditing(section)) { toast('请先完成处理卡中的编辑，再刷新紧急区'); return; }
    button.disabled = true;
    const startedVersion = interactionVersion;
    try {
      const data = await adm('/screening/urgent');
      if (!section.isConnected) return;
      if (pendingOperations || startedVersion !== interactionVersion || urgentDetailEditing(section)) {
        button.disabled = false; toast('刷新期间已操作处理卡，保留当前内容，请稍后再刷新'); return;
      }
      const wrapper = document.createElement('div'); wrapper.innerHTML = urgentReviewHtml(data);
      section.replaceWith(wrapper.firstElementChild); bindUrgentReview(box, data);
    } catch (error) { toast(error.message); button.disabled = false; }
  });
  section.querySelectorAll('[data-urgent-key]').forEach(card => {
    const row = rows.find(r => r.key === card.dataset.urgentKey);
    const feedback = card.querySelector('[data-urgent-feedback]');
    card.querySelector('[data-urgent-suppress]').addEventListener('click', async e => {
      const button = e.currentTarget; button.disabled = true;
      interactionVersion++;
      pendingOperations++;
      try {
        const suppressed = button.dataset.urgentSuppress === '1';
        await adm('/screening/urgency', { key: row.key, expectedVersion: row.version, suppressed });
        section.querySelector(suppressed ? '[data-urgent-dismissed-list]' : '[data-urgent-list]').append(card);
        const list = card.parentElement;
        for (const item of priority) {
          const child = [...list.children].find(el => el.dataset.urgentKey === item.key);
          if (child) list.append(child);
        }
        button.dataset.urgentSuppress = suppressed ? '0' : '1';
        button.textContent = suppressed ? '恢复优先处理' : '不紧急';
        button.disabled = false;
        if (suppressed) section.querySelector('[data-urgent-dismissed]').open = true;
        updateUrgentClocks(); toast(suppressed ? '已标记不紧急，可在下方直接恢复' : '已恢复优先处理');
      } catch (error) { feedback.textContent = error.message; button.disabled = false; updateUrgentClocks(); }
      finally { pendingOperations--; interactionVersion++; }
    });
    card.querySelector('[data-urgent-open]').addEventListener('click', async e => {
      interactionVersion++;
      const existing = [...box.querySelectorAll('[data-task-id],[data-identity-task],[data-lead-task],[data-offer-id]')].find(el =>
        row.kind === 'task' ? el.dataset.taskId === row.id || el.dataset.identityTask === row.id : row.kind === 'lead' ? el.dataset.leadTask === row.id : el.dataset.offerId === row.id);
      if (existing) {
        const pane = existing.closest('[data-review-pane]');
        if (pane) box.querySelector(`[data-review-tab="${pane.dataset.reviewPane}"]`)?.click();
        for (let parent = existing.parentElement; parent; parent = parent.parentElement) if (parent.tagName === 'DETAILS') parent.open = true;
        existing.hidden = false; existing.style.display = '';
        existing.querySelector('[data-review-open]')?.click();
        existing.scrollIntoView?.({ block: 'center', behavior: 'smooth' }); return;
      }
      const button = e.currentTarget; button.disabled = true;
      const detail = card.querySelector('[data-urgent-detail]');
      pendingOperations++;
      try {
        if (row.kind === 'task') {
          const data = await adm(`/identity/tasks?id=${encodeURIComponent(row.id)}`);
          if (!data.tasks?.length) throw new Error('该任务已处理，请刷新紧急区');
          renderIdentityTasks(detail, data);
        } else if (row.kind === 'lead') {
          const data = await adm(`/leads?id=${encodeURIComponent(row.id)}`);
          if (!data.leads?.length) throw new Error('该线索已处理，请刷新紧急区');
          detail.innerHTML = data.leads.map(leadTaskCard).join(''); bindLeadTasks(detail, data.leads);
        } else location.hash = `admin-offer-${encodeURIComponent(row.id)}`;
        updateUrgentClocks();
      } catch (error) { feedback.textContent = error.message; button.disabled = false; }
      finally { pendingOperations--; interactionVersion++; }
    });
  });
  updateUrgentClocks();
}
