import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { describe, it, expect } from 'vitest';
import { fixture as pageFixture, publicOffer } from './fixtures/frontend';

function fixture(fail = '') {
  const calls: string[] = [];
  const pending: { path: string; resolve: () => void }[] = [];
  const context = createContext({ window: {}, Map, Date, fetch: (path: string) => {
    calls.push(path);
    return new Promise(resolve => pending.push({ path, resolve: () => resolve({ ok: !path.includes(fail || 'never-match'), status: 503,
      json: async () => path.includes('/platforms') ? { platforms: [] } : path.includes('/offers') ? { offers: [] } : path.includes('/memberships') ? { revision: 0, products: [], plans: [] } : {},
    }) }));
  } });
  const run = (code: string) => runInContext(code, context);
  run(readFileSync('web/src/initial-data.js', 'utf8'));
  const release = (match = '') => {
    for (let i = pending.length - 1; i >= 0; i--) if (pending[i].path.includes(match)) pending.splice(i, 1)[0].resolve();
  };
  const load = (fresh = false) => {
    run(readFileSync('web/src/data.js', 'utf8'));
    return run(`loadData({fresh:${fresh}})`);
  };
  return { calls, run, release, load };
}

describe('首屏并行查询', () => {
  it('图表库缺失时仍能渲染活动列表、详情和日历的当天列表', () => {
    const page = pageFixture(() => ({}), '#all');
    publicOffer(page.run, { t: '测试限时福利', ty: 'trial', s: -1, e: 5, ek: 'date' });
    page.run('window.echarts = undefined; echarts = undefined;');
    for (const hash of ['#today', '#all', '#offer-public-offer', '#calendar']) {
      page.run(`location.hash=${JSON.stringify(hash)}; render(false);`);
      expect(page.document.querySelector('#main')?.textContent).toContain('测试限时福利');
    }
    expect(page.document.querySelector('#cal0')?.textContent).toContain('图表暂时不可用');
  });
  it('图表库和应用尚未执行时已发起查询，应用消费同一批结果', async () => {
    const f = fixture();
    expect(f.run('typeof echarts')).toBe('undefined');
    expect(f.calls).toHaveLength(5);
    const loading = f.load();
    f.release(); await loading;
    expect(f.calls).toHaveLength(5);
    expect(f.run('window.YM_INITIAL_REQUESTS')).toBeNull();
    const refreshing = f.run('loadData()');
    expect(f.calls).toHaveLength(10);
    f.release(); await refreshing;
  });
  it('显式刷新不使用首屏旧结果', async () => {
    const f = fixture(); f.release();
    const loading = f.load(true);
    expect(f.calls).toHaveLength(10);
    expect(f.calls.slice(5).every(path => path.includes('fresh='))).toBe(true);
    f.release(); await loading;
  });
  it('可选接口失败仍显示活动', async () => {
    const f = fixture('/memberships'); const loading = f.load(); f.release();
    await loading;
    expect(f.run('MEMBERSHIP_CATALOG_OK')).toBe(false);
  });
  it('必要接口提前失败被保存，应用启动时得到错误', async () => {
    const f = fixture('/offers'); f.release();
    await Promise.resolve();
    await expect(f.load()).rejects.toThrow('/api/offers');
  });
  it('构建产物先执行预取，再执行图表库', () => {
    const html = readFileSync('public/index.html', 'utf8');
    expect(html.indexOf('src="/initial-data.js"')).toBeGreaterThan(0);
    expect(html.indexOf('src="/initial-data.js"')).toBeLessThan(html.indexOf('src="/vendor/echarts.min.js"'));
  });
  it('会员目录和覆盖率悬而未决时首屏可完成，目录先到可独立生效', async () => {
    const f = fixture();
    f.run(readFileSync('web/src/data.js', 'utf8'));
    const loading = f.run('loadData({deferExtras:true})');
    f.release('/platforms'); f.release('/offers'); f.release('/meta');
    const { supplements } = await loading;
    expect(f.run('MEMBERSHIP_CATALOG_OK')).toBe(false);
    expect(f.run('COVERAGE')).toBeNull();
    f.release('/memberships');
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(f.run('MEMBERSHIP_CATALOG_OK')).toBe(true);
    expect(f.run('COVERAGE')).toBeNull();
    f.release('/coverage'); await supplements;
    expect(f.run('COVERAGE')).toEqual({});
  });
  it('旧首屏的附加请求晚到时不覆盖新的刷新状态', async () => {
    const f = fixture();
    f.run(readFileSync('web/src/data.js', 'utf8'));
    const loading = f.run('loadData({deferExtras:true})');
    f.release('/platforms'); f.release('/offers'); f.release('/meta');
    const { supplements } = await loading;
    const refresh = f.run('loadData({fresh:true})');
    f.release('fresh='); await refresh;
    f.run('COVERAGE = {newer:true}; MEMBERSHIP_CATALOG = {revision:42};');
    f.release(); await supplements;
    expect(f.run('COVERAGE')).toEqual({ newer: true });
    expect(f.run('MEMBERSHIP_CATALOG.revision')).toBe(42);
  });
  it('没有图表库时图表区域降级，日历仍可清理和重画', () => {
    const source = readFileSync('web/src/app.js', 'utf8');
    const element = { innerHTML: '' };
    const ctx = createContext({ window: {}, CHARTS: new Set(), $: () => element, $$: () => [element] });
    runInContext(source.slice(source.indexOf('function chart('), source.indexOf('const axisCommon')), ctx);
    expect(runInContext('chart("#test", {})', ctx)).toBeNull();
    expect(element.innerHTML).toContain('活动列表和详情仍可浏览');
    runInContext(source.slice(source.indexOf('function drawMonths('), source.indexOf('function renderDayList(')), ctx);
    expect(() => runInContext('drawMonths([])', ctx)).not.toThrow();
  });
});
