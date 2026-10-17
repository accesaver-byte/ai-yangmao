import { describe, expect, it } from 'vitest';
import { fixture } from './fixtures/frontend';

const row = (extra = {}) => ({ key: 'lead:99', kind: 'lead', id: '99', title: '<限时福利>', tier: 'P0', reason: '今天发放', stage: '官方核实中', deadline: null, version: 'a'.repeat(64), ...extra });
const queue = (urgent = [row()]) => ({ urgent, urgencyDismissed: [], pending: [], incomplete: [], pendingPlatforms: [], suggestAutoPublish: [], newLeads: 0 });
const pause = () => new Promise(resolve => setTimeout(resolve, 0));

describe('待审页紧急区', () => {
  it('恢复高优先级卡片后重新排序，不排到普通紧急卡后面', async () => {
    const q = { ...queue([row({ key: 'lead:100', id: '100', tier: 'P1' })]), urgencyDismissed: [row()] };
    const f = fixture(url => url.endsWith('/screening/urgency') ? { ok: true } : q);
    await f.run('admQueue()');
    (f.document.querySelector('[data-urgent-dismissed-list] [data-urgent-suppress]') as any).click(); await pause();
    expect([...f.document.querySelectorAll('[data-urgent-list] [data-urgent-key]')].map(el => el.getAttribute('data-urgent-key'))).toEqual(['lead:99', 'lead:100']);
  });
  it('刷新返回前新打开的处理表单不会被旧响应覆盖', async () => {
    let finish!: (v: unknown) => void;
    const f = fixture(url => url.endsWith('/screening/urgent') ? new Promise(resolve => { finish = resolve; }) : queue());
    await f.run('admQueue()');
    (f.document.querySelector('[data-urgent-refresh]') as any).click(); await pause();
    f.run("document.querySelector('[data-urgent-detail]').innerHTML='<textarea>新输入</textarea>'");
    finish(queue([])); await pause();
    expect(f.document.querySelector('[data-urgent-detail] textarea')?.textContent).toBe('新输入');
    expect((f.document.querySelector('[data-urgent-refresh]') as any).disabled).toBe(false);
  });
  it('刷新与排序请求交错时不覆盖刚保存的偏好', async () => {
    let finish!: (v: unknown) => void;
    const f = fixture(url => url.endsWith('/screening/urgent') ? new Promise(resolve => { finish = resolve; }) : url.endsWith('/screening/urgency') ? { ok: true } : queue());
    await f.run('admQueue()');
    (f.document.querySelector('[data-urgent-refresh]') as any).click(); await pause();
    (f.document.querySelector('[data-urgent-suppress]') as any).click(); await pause();
    finish(queue()); await pause();
    expect(f.document.querySelector('[data-urgent-list]')?.children.length).toBe(0);
    expect(f.document.querySelector('[data-urgent-dismissed-list]')?.children.length).toBe(1);
  });
  it('到期隐藏后才返回的处理卡仍可见并保留输入', async () => {
    const f = fixture(() => queue([row({ deadline: new Date(Date.now()-1000).toISOString() })]));
    await f.run('admQueue()');
    expect(f.document.querySelector('[data-urgent-key]')?.hasAttribute('hidden')).toBe(true);
    f.run("document.querySelector('[data-urgent-detail]').innerHTML='<textarea>迟到的表单</textarea>'; updateUrgentClocks()");
    expect(f.document.querySelector('[data-urgent-key]')?.hasAttribute('hidden')).toBe(false);
    expect(f.document.querySelector('[data-urgent-count]')?.textContent).toBe('0');
  });
  it('位于顶部，转义标题，不提供绕过审核的通过按钮', async () => {
    const f = fixture(() => queue()); await f.run('admQueue()');
    const body = f.document.querySelector('#admBody')!;
    expect(body.firstElementChild?.hasAttribute('data-urgent-section')).toBe(true);
    expect(body.querySelector('[data-urgent-key]')?.textContent).toContain('<限时福利>');
    expect(body.querySelector('[data-urgent-section] [data-act="approve"]')).toBeNull();
    expect(body.querySelector('[data-urgent-clock]')?.textContent).toContain('未确认截止时间');
  });
  it('不紧急带版本提交，保留其他卡片的未保存输入', async () => {
    const calls: any[] = [];
    const f = fixture((url, init) => { if (url.endsWith('/screening/urgency')) { calls.push(JSON.parse(String(init?.body))); return { ok: true }; } return queue(); });
    await f.run('admQueue()');
    f.run("document.querySelector('#admBody').insertAdjacentHTML('beforeend','<textarea id=unsaved>未保存</textarea>')");
    (f.document.querySelector('[data-urgent-suppress]') as any).click(); await pause();
    expect(calls).toEqual([{ key: 'lead:99', expectedVersion: 'a'.repeat(64), suppressed: true }]);
    expect(f.document.querySelector('#unsaved')?.textContent).toBe('未保存');
    expect(f.document.querySelector('[data-urgent-list]')?.children.length).toBe(0);
    expect(f.document.querySelector('[data-urgent-dismissed]')?.hasAttribute('hidden')).toBe(false);
    const restore = f.document.querySelector('[data-urgent-dismissed-list] [data-urgent-suppress]') as any;
    expect(restore.textContent).toBe('恢复优先处理');
    restore.click(); await pause();
    expect(calls[1]).toEqual({ key: 'lead:99', expectedVersion: 'a'.repeat(64), suppressed: false });
    expect(f.document.querySelector('[data-urgent-list]')?.children.length).toBe(1);
    expect(f.document.querySelector('[data-urgent-count]')?.textContent).toBe('1');
    expect(f.document.querySelector('[data-urgent-dismissed]')?.hasAttribute('hidden')).toBe(true);
  });
  it('超过截止时间退出紧急计数，但不销毁已经打开的编辑内容', async () => {
    const f = fixture(() => queue([row({ deadline: new Date(Date.now() - 1000).toISOString() })]));
    await f.run('admQueue()');
    expect(f.document.querySelector('[data-urgent-count]')?.textContent).toBe('0');
    const card = f.document.querySelector('[data-urgent-key]')!;
    card.removeAttribute('hidden'); card.querySelector('[data-urgent-detail]')!.innerHTML = '<textarea>待保存</textarea>';
    f.run('updateUrgentClocks()');
    expect(card.hasAttribute('hidden')).toBe(false);
    expect(card.querySelector('textarea')?.textContent).toBe('待保存');
    expect(card.querySelector('[data-urgent-tier]')?.textContent).toBe('已截止');
    expect((card.querySelector('[data-urgent-suppress]') as any).disabled).toBe(true);
  });
  it('查重任务不在当前分页时按 ID 获取原处理卡', async () => {
    const calls: string[] = [];
    const f = fixture(url => { calls.push(url); return url.includes('/identity/tasks?id=') ? { tasks: [] } : queue([row({ key: 'task:later', kind: 'task', id: 'later' })]); });
    await f.run('admQueue()');
    (f.document.querySelector('[data-urgent-open]') as any).click(); await pause();
    expect(calls.some(url => url.endsWith('/identity/tasks?id=later'))).toBe(true);
    expect(f.document.querySelector('[data-urgent-feedback]')?.textContent).toContain('已处理');
  });
  it('查看处理卡展开原卡片所在折叠区，倒计时归零后退出加急', async () => {
    const f = fixture(() => queue([row({ deadline: new Date(Date.now() + 60000).toISOString() })]));
    await f.run('admQueue()');
    f.run("document.querySelector('#admBody').insertAdjacentHTML('beforeend','<details id=original><article data-lead-task=99 hidden>原处理卡</article></details>')");
    (f.document.querySelector('[data-urgent-open]') as any).click();
    expect((f.document.querySelector('#original') as any).open).toBe(true);
    expect(f.document.querySelector('[data-lead-task]')?.hasAttribute('hidden')).toBe(false);
    expect(f.document.querySelector('[data-urgent-clock]')?.textContent).toContain('还剩');
    f.run("document.querySelector('[data-urgent-end]').dataset.urgentEnd = new Date(Date.now()-1).toISOString(); updateUrgentClocks()");
    expect(f.document.querySelector('[data-urgent-key]')?.hasAttribute('hidden')).toBe(true);
    expect(f.document.querySelector('[data-urgent-count]')?.textContent).toBe('0');
    expect(f.document.querySelector('[data-lead-task]')?.textContent).toBe('原处理卡');
  });
});
