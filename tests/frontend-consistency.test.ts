import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { parseHTML } from 'linkedom';
import { describe, expect, it } from 'vitest';
import { fixture, publicOffer } from './fixtures/frontend';

const css = readFileSync('web/src/head.html', 'utf8'), app = readFileSync('web/src/app.js', 'utf8');
const unpriced = { version: 'v2', status: 'beta_unpriced', method: 'none', period: 'first30', usdEstimate: null, usdMax: null, formula: null, assumptions: ['金额未知，不按零计算。'] };
const click = (f: ReturnType<typeof fixture>, el: Element) => el.dispatchEvent(new f.window.Event('click', { bubbles: true }));
const many = (f: ReturnType<typeof fixture>, n: number, extra = '') => f.run(`OFFERS=Array.from({length:${n}},(_,i)=>({...OFFERS[0],id:'o'+i,t:'羊毛 '+i${extra}}));prepare&&0;`);

describe('loading', () => {
  it('does not draw a page from empty data while the first load is still running', () => {
    const f = fixture(() => ({}), '#today');
    f.run("DATA_LOADING=true;main().innerHTML=emptySheep('正在把羊赶进草地…');render(false);");
    const text = f.document.querySelector('main')!.textContent!;
    expect(text).toContain('正在把羊赶进草地');
    expect(text).not.toContain('今天没什么可薅');
  });
  it('gives longer messages more time on screen', () => {
    const f = fixture(() => ({}));
    expect(f.run("toastMs('已复制')")).toBe(2200);
    expect(f.run(`toastMs('${'需要补充的字段很多'.repeat(8)}')`)).toBeGreaterThan(4000);
    expect(f.run(`toastMs('${'长'.repeat(500)}')`)).toBe(8000);
  });
  it('loads web fonts from the pre-paint script without blocking the page', () => {
    expect(css.replace(/<noscript>[\s\S]*?<\/noscript>/g, '')).not.toMatch(/<link rel="stylesheet" href="https:\/\/fonts\.googleapis\.com/);
    const { window, document } = parseHTML('<html><head><meta name="theme-color"></head><body></body></html>');
    runInContext(readFileSync('web/src/theme.js', 'utf8'), createContext({ window, document, matchMedia: () => ({ matches: false, addEventListener() {} }), localStorage: { getItem: () => null, setItem() {} } }));
    const link = document.querySelector('link[href*="fonts.googleapis.com"]')!;
    expect(link.getAttribute('rel')).toBe('stylesheet');
    expect(link.getAttribute('media')).toBe('print');
    link.dispatchEvent(new window.Event('load'));
    expect(link.getAttribute('media')).toBe('all');
  });
});

describe('value wording', () => {
  it('shows an unpriced offer with one status label, not stacked chips that repeat it', () => {
    const f = fixture(() => ({}), '#all');
    publicOffer(f.run, { ty: 'free', ek: 'unknown', e: null, valuation: unpriced });
    const card = f.run('ocard(OFFERS[0])');
    expect(card).toContain('公测免费 · 价值待定');
    expect(card).not.toContain('暂无可靠价格');
    expect(card).not.toContain('不按零计算');
  });
  it('leads the detail page with the benefit when there is no amount', () => {
    const f = fixture(() => ({ comments: [], nextCursor: null }), '#offer-public-offer');
    publicOffer(f.run, { ty: 'free', ek: 'unknown', e: null, v: 'Odyssey-3 公开研究预览，可免费试用', valuation: unpriced });
    f.run("pOffer('public-offer')");
    expect(f.document.querySelector('[data-detail-benefit]')!.textContent).toBe('Odyssey-3 公开研究预览，可免费试用');
    expect(f.document.querySelector('[data-detail-value]')!.textContent).toContain('公测免费 · 价值待定');
    expect(f.document.querySelector('[data-valuation] .sub')!.textContent).not.toContain('月度参考');
  });
});

describe('deadlines', () => {
  it('draws an unknown deadline as an empty dashed track instead of a partly filled bar', () => {
    const f = fixture(() => ({ comments: [], nextCursor: null }), '#offer-public-offer');
    publicOffer(f.run, { ty: 'free', ek: 'unknown', e: null });
    const card = f.run('ocard(OFFERS[0])');
    expect(card).toContain('class="bar unknown"');
    expect(card).not.toContain('width:60%');
    f.run("pOffer('public-offer')");
    expect(f.document.querySelector('.ring-big [data-deadline-unknown]')).not.toBeNull();
  });
  it('keeps the estimate disclaimer in the section hint instead of repeating it on every countdown card', () => {
    const f = fixture(() => ({}), '#today');
    const app2 = app.slice(app.indexOf('function countdownCandidates'), app.indexOf('function countdownCandidates') + 10);
    expect(app2).toBeTruthy();
    expect(app).not.toContain("'截止估算 · 官方未公布精确时刻'");
  });
});

describe('long lists', () => {
  it('reveals card walls 24 at a time and keeps what was opened across a refresh', () => {
    const f = fixture(() => ({}), '#all');
    publicOffer(f.run);
    many(f, 30);
    f.run("CARD_WALL_SEQ=0;document.querySelector('#main').innerHTML=ocards(OFFERS);");
    const visible = () => f.document.querySelectorAll('#main .ocard:not([hidden])').length;
    expect(visible()).toBe(24);
    const more = f.document.querySelector('[data-more-cards]')!;
    expect(more.textContent).toContain('再显示 6 条');
    click(f, more);
    expect(visible()).toBe(30);
    expect(f.document.querySelector('[data-more-cards]')).toBeNull();
    f.run("CARD_WALL_SEQ=0;document.querySelector('#main').innerHTML=ocards(OFFERS);");
    expect(visible()).toBe(30);
  });
  it('lets the home page show a shorter first page', () => {
    const f = fixture(() => ({}), '#today');
    publicOffer(f.run);
    many(f, 20);
    f.run("CARD_WALL_SEQ=0;document.querySelector('#main').innerHTML=ocards(OFFERS,12);");
    expect(f.document.querySelectorAll('#main .ocard:not([hidden])').length).toBe(12);
  });
  it('collapses long platform lists on the model page', () => {
    const f = fixture(() => ({}), '#models');
    publicOffer(f.run, { models: ['GLM-4.7-Flash'] });
    f.run("OFFERS=Array.from({length:6},(_,i)=>({...OFFERS[0],id:'m'+i,p:'p'+i,plat:{id:'p'+i,name:'平台'+i}}));");
    f.run('pModels()');
    const card = f.document.querySelector('#main .grid .card')!;
    expect(card.querySelectorAll(':scope > .rows > .orow').length).toBe(4);
    expect(card.querySelector('details summary')!.textContent).toContain('还有 2 个平台');
  });
  it('puts sorting in the results bar instead of wrapping alone under the filters', () => {
    const f = fixture(() => ({}), '#all');
    publicOffer(f.run);
    f.run('pAll()');
    expect(f.document.querySelector('.filters #f-sort')).toBeNull();
    expect(f.document.querySelector('[data-results-bar] #f-sort')).not.toBeNull();
  });
});

describe('style tokens', () => {
  it('styles every text field with the shared field look', () => {
    for (const selector of ['textarea', 'input:not([type])', 'input[type="search"]', 'input[type="number"]', 'input[type="password"]']) expect(css).toContain(selector);
  });
  it('uses existing theme tokens for review guidance colours', () => {
    expect(app).not.toContain('--warning-ink');
    expect(app).not.toMatch(/#b26a00|#2e7d32/);
  });
  it('keeps hover motion off offer cards and gives the compare button a touch-sized target', () => {
    expect(css).not.toMatch(/\.ocard:hover\{[^}]*transform/);
    expect(css).toMatch(/@media \(pointer:\s*coarse\)\{[^}]*\.cmp/);
  });
});

describe('homepage intro', () => {
  it('names the site and says plainly what it collects', () => {
    const f = fixture(() => ({}), '#today');
    publicOffer(f.run);
    f.run('pToday()');
    expect(f.document.querySelector('.ph h1')!.textContent).toBe('AI 羊毛牧场');
    const subtitle = f.document.querySelector('.ph p')!.textContent!.replace(/\u00a0/g, ' ');
    for (const word of ['大模型 Token', 'API 额度', '会员', '生图生视频', '官方出处']) expect(subtitle).toContain(word);
    expect([...f.document.querySelectorAll('.ph p .clause')].map(c => c.textContent!.replace(/\u00a0/g, ' '))).toEqual(['免费大模型 Token、API 额度、会员和生图生视频次数，', '每天汇总，条条可追官方出处。']);
    expect(f.document.querySelectorAll('.ph p wbr').length).toBe(4);
    expect(f.run('pageTitle("today")')).toBe('AI 羊毛牧场 · 免费 AI 额度与大模型 Token 福利汇总');
    expect(f.run('pageTitle("calendar")')).toBe('日历 · AI 羊毛牧场');
  });
  it('uses the same descriptor in the browser tab and link previews', () => {
    expect(css).toContain('<title>AI 羊毛牧场 · 免费 AI 额度与大模型 Token 福利汇总</title>');
    expect(css).toContain('<meta property="og:title" content="AI 羊毛牧场 · 免费 AI 额度与大模型 Token 福利汇总">');
    expect(readFileSync('scripts/build-web.mjs', 'utf8')).toContain('免费大模型 Token、API 额度、会员和生图生视频次数，每天汇总，条条可追官方出处。');
  });
});
