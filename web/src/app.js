/* ============================================================
 * AI 羊毛牧场 · 网页主程序（构建时与 data.js 合并；ECharts 自托管）
 * ============================================================ */

/* ---------- 基础工具 ---------- */
const DAY = 864e5;
let NOW = new Date();
let T0 = new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate());
const dayAt = n => new Date(T0.getFullYear(), T0.getMonth(), T0.getDate() + n);
const pad = n => String(n).padStart(2, '0');
const ymd = dt => `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
const md = dt => `${dt.getMonth() + 1}月${dt.getDate()}日`;
const hm = dt => `${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
const dayIdx = dt => Math.round((new Date(dt.getFullYear(), dt.getMonth(), dt.getDate()) - T0) / DAY);
const WD = ['日', '一', '二', '三', '四', '五', '六'];
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const sum = (a, f) => a.reduce((x, o, i) => x + f(o, i), 0);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const uniq = a => [...new Set(a)];
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
function hash(str) { let h = 2166136261; for (const ch of str) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
const FONT = '"Rubik","PingFang SC","HarmonyOS Sans SC","Microsoft YaHei",sans-serif';
const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* 存不了就只在本次打开有效 */ } },
};
const TZ_FORMATTERS = new Map();
function tzOffset(tz, date) {
  // Calendar cells evaluate the same source zones thousands of times. A formatter
  // can be reused across dates; formatToParts still applies each date's DST offset.
  let f = TZ_FORMATTERS.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    TZ_FORMATTERS.set(tz, f);
  }
  const p = Object.fromEntries(f.formatToParts(date).map(x => [x.type, x.value]));
  return (Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) - date.getTime()) / 60000;
}
function zonedToDate(y, m, d, h, mi, tz, sec = 0) { const guess = Date.UTC(y, m, d, h, mi, sec); const first = guess - tzOffset(tz, new Date(guess)) * 60000; return new Date(guess - tzOffset(tz, new Date(first)) * 60000); }
function luminance(hex) {
  const m = hex.replace('#', '').match(/.{2}/g); if (!m) return 0.5;
  const [r, g, b] = m.map(x => { const c = parseInt(x, 16) / 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const onColor = hex => luminance(hex) > 0.32 ? '#1c2921' : '#ffffff';
function hexA(hex, a) { const m = hex.replace('#', '').match(/.{2}/g); if (!m) return hex; const [r, g, b] = m.map(x => parseInt(x, 16)); return `rgba(${r},${g},${b},${a})`; }

/* ---------- 主题色（从 CSS 变量读取，切换深浅色时重读） ---------- */
function tk() {
  const s = getComputedStyle(document.documentElement); const g = n => s.getPropertyValue(n).trim();
  return {
    bg: g('--bg'), surface: g('--surface'), surface2: g('--surface-2'), ink: g('--ink'), ink2: g('--ink-2'), muted: g('--muted'),
    line: g('--line'), line2: g('--line-2'), tag: g('--tag'), tagSoft: g('--tag-soft'), good: g('--good'), warn: g('--warn'), serious: g('--serious'), critical: g('--critical'),
    s: [1, 2, 3, 4, 5, 6, 7, 8].map(i => g('--s' + i)), q: [0, 1, 2, 3, 4, 5, 6, 7].map(i => g('--q' + i)),
  };
}
let TK = tk();
const typeColor = ty => TK.s[TYPES[ty].slot - 1];
const ptypeColor = pt => TK.s[PTYPE[pt].slot - 1];
const typeVar = ty => `var(--s${TYPES[ty].slot})`;

/** 按公司分组的平台（0043）：同一公司的多个产品合成一组；只列出有条目的平台。 */
function platformGroups(selected = '') {
  const has = new Set(OFFERS.map(o => o.p)), groups = new Map(), rows = [];
  for (const p of PLATFORMS.filter(p => has.has(p.id) || p.id === selected)) {
    if (p.company) { if (!groups.has(p.company)) groups.set(p.company, []); groups.get(p.company).push(p); } else rows.push({ name: p.name, items: [p] });
  }
  for (const [company, items] of groups) rows.push(items.length > 1 ? { name: company, company, items } : { name: items[0].name, items });
  return rows.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
}
/** 公司分组里只显示产品名：去掉名称开头的公司前缀（如“MiniMax 海螺 AI”→“海螺 AI”）；“阿里云百炼”这类无空格的品牌名保持不变。 */
const COMPANY_PREFIX = { 阿里巴巴: ['阿里巴巴', '阿里'], 字节跳动: ['字节跳动', '字节'] };
function productName(p) {
  const prefixes = [...(COMPANY_PREFIX[p.company] || []), p.company].filter(Boolean);
  for (const prefix of prefixes) if (p.name.startsWith(prefix + ' ')) return p.name.slice(prefix.length + 1);
  return p.name;
}
function platformOptionsHtml(selected = '') {
  const opt = (value, label) => `<option value="${esc(value)}" ${selected === value ? 'selected' : ''}>${esc(label)}</option>`;
  return opt('', '全部平台') + platformGroups(selected).map(g => g.company
    ? `<optgroup label="${esc(g.company)}">${opt('co:' + g.company, `${g.company}（全部）`)}${g.items.map(p => opt(p.id, productName(p))).join('')}</optgroup>`
    : opt(g.items[0].id, g.items[0].name)).join('');
}

/* ---------- 数据准备 ---------- */
let PMAP = {}, OMAP = {}, LAST_OK = null;
/** 数据加载后调用：建立索引，计算依赖数据的统计。 */
function prepare() {
  PMAP = Object.fromEntries(PLATFORMS.map(p => [p.id, p]));
  OFFERS = OFFERS.filter(o => PMAP[o.p]);
  OFFERS.forEach(o => { o.plat = PMAP[o.p]; });
  OMAP = Object.fromEntries(OFFERS.map(o => [o.id, o]));
  Object.assign(C, migrateMembershipPreferences(C));
  LS.set('ym-cond', C);
  LAST_OK = (META.lastCollectedAt ?? META.lastSuccessfulCollect) ? new Date(META.lastCollectedAt ?? META.lastSuccessfulCollect) : null;
  RACE = computeRace(); TREND = computeTrend();
  HOLIDAYS.forEach(h => { h.past = holidayPast(h); });
}
/** 往年同一节日前后 7 天内有效过的活动，按平台列出（只用已收录的历史数据推算）。 */
function holidayPast(h) {
  const [y, m, d] = h.d.split('-').map(Number), names = [];
  for (let back = 1; back <= 3; back++) {
    const c = dayIdx(new Date(y - back, m - 1, d)), from = c - 7, to = c + 7;
    OFFERS.forEach(o => {
      const end = o.ek === 'date' ? o.e : o.withdrawnAt ? dayIdx(new Date(o.withdrawnAt)) : o.since;
      if (isLimited(o) && o.since <= to && end >= from) names.push(`${o.plat.name}（${y - back}）`);
    });
  }
  return uniq(names).join('、');
}
const isLimited = o => o.ty !== 'standing' && o.ty !== 'apply';
function statusOf(o, k = 0) {
  const at = k === 0 ? new Date() : dayAt(k);
  if (o.withdrawnAt && Date.parse(o.withdrawnAt) <= at.getTime()) return 'ended';
  if (o.ek === 'date' && endInstant(o).getTime() < at.getTime()) return 'ended';
  if (o.ty === 'standing') return 'standing';
  if (o.ty === 'apply') return 'open';
  if (o.s != null && startInstant(o).getTime() > at.getTime()) return 'upcoming';
  if (o.ek === 'date' && endInstant(o).getTime() - at.getTime() <= 3 * DAY) return 'ending';
  return 'active';
}
const ST = {
  active: { l: '进行中', i: '●', c: 'good' }, ending: { l: '即将结束', i: '◔', c: 'serious' }, upcoming: { l: '未开始', i: '◷', c: '' },
  ended: { l: '已结束', i: '✕', c: '' }, standing: { l: '常驻', i: '∞', c: '' }, stale: { l: '待核验', i: '!', c: 'warn' }, open: { l: '长期开放', i: '◎', c: '' },
};
const activeLimited = o => isLimited(o) && ['active', 'ending'].includes(statusOf(o));
const claimable = o => ['active', 'ending', 'standing'].includes(statusOf(o));
const activeOn = (o, k) => {
  if (!isLimited(o) || statusOf(o) === 'stale') return false;
  const from = o.s == null ? Date.parse(o.discoveredAt) : startInstant(o).getTime();
  const to = Math.min(o.ek === 'date' ? endInstant(o).getTime() : Infinity, o.withdrawnAt ? Date.parse(o.withdrawnAt) : Infinity);
  return from < dayAt(k + 1).getTime() && to >= dayAt(k).getTime();
};
const endInstant = o => { const d = dayAt(o.e); return zonedToDate(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, o.tz, 59); };
const startInstant = o => { if (o.s == null) return new Date(o.discoveredAt); const d = dayAt(o.s); return zonedToDate(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, o.tz); };
const actualEnd = o => { const times = [o.ek === 'date' ? endInstant(o).getTime() : NaN, o.withdrawnAt ? Date.parse(o.withdrawnAt) : NaN].filter(Number.isFinite); return times.length ? new Date(Math.min(...times)) : null; };

/* ---------- 我的条件 / 我的清单（只存在本机浏览器） ---------- */
const C = Object.assign({ only: false, phone: false, card: false, net: false, student: false, biz: false, invite: false, realname: true, pay: true, members: [], subscriptions: [] }, LS.get('ym-cond', {}));
const savedMine = LS.get('ym-mine', {});
const MINE = { want: savedMine.want || [], claimed: savedMine.claimed || [], legacyGot: savedMine.legacyGot || (savedMine.claimed ? [] : savedMine.got || []) };
const localMonth = () => ymd(new Date()).slice(0, 7);
const claimedThisMonth = id => MINE.claimed.some(x => x.id === id && x.month === localMonth());
let CMP = [];
const COND_ITEMS = [
  ['net', '可以使用海外网络'], ['phone', '有海外手机号'], ['card', '有海外信用卡 / PayPal'], ['student', '有学生身份'],
  ['biz', '有公司可做企业认证'], ['invite', '手上有邀请码'], ['realname', '可以完成国内实名'], ['pay', '接受小额充值'],
];
function missing(o) {
  const miss = [];
  for (const r of o.r) {
    const [k, p] = r.split(':');
    if (k === 'none') continue;
    if (k === 'targeted') { miss.push(r); continue; }
    if (k === 'member') continue;
    if (!C[k]) miss.push(r);
  }
  const member = membershipResult(o, C.subscriptions || []);
  if (member !== 'yes') miss.push(member === 'unknown' ? 'membership_unknown' : 'member:未满足会员资格');
  return miss;
}
const eligible = o => missing(o).length === 0;
const view = arr => C.only ? arr.filter(eligible) : arr;
function reqLabel(r) { if (r === 'membership_unknown') return '活动已通过；个人会员资格请按详情原条件核对'; const [k, p] = r.split(':'); if (k === 'member') return `需会员 · ${p}`; if (k === 'pay') return `需充值 ${p}`; return REQ[k]; }
function reqChips(o, mark = false) {
  const nonmember = o.r.filter(r => !r.startsWith('member:'));
  const requirement = membershipRequirementOf(o), result = membershipResult(o, C.subscriptions || []);
  const membershipText = requirement.status === 'needs_review'
    ? `会员条件：${(requirement.legacyText || []).join('；') || '请查看原会员条件'}（个人自动匹配尚未建立）`
    : YMMembership.formatMembership(requirement, MEMBERSHIP_CATALOG);
  const memberPrefix = requirement.status === 'needs_review' ? '✓ 活动已通过 · ' : result === 'unknown' ? '？个人资格需核对 · ' : mark ? result === 'yes' ? '✓ ' : '✕ ' : '';
  const member = requirement.status !== 'not_required' ? `<span style="white-space:normal;overflow-wrap:anywhere" class="chip ${mark && result === 'yes' ? 'have' : mark && result === 'no' ? 'miss' : ''}">${memberPrefix}${esc(membershipText)}</span>` : '';
  return `<div class="chips">${nonmember.map(r => {
    const k = r.split(':')[0];
    const cls = mark && k !== 'none' && k !== 'targeted' ? (!C[k] ? 'miss' : 'have') : '';
    return `<span class="chip ${cls}">${cls === 'have' ? '✓ ' : cls === 'miss' ? '✕ ' : ''}${esc(reqLabel(r))}</span>`;
  }).join('')}${member}</div>`;
}

/* ---------- 薅度雷达（全部按规则算，不调用模型） ---------- */
const REQ_PEN = { pay: 30, member: 35, phone: 25, card: 25, net: 10, realname: 5, biz: 40, student: 30, invite: 25, targeted: 30, unknown: 50 };
const EASE = { auto: 100, member: 90, signup: 80, code: 70, app: 65, topup: 50, form: 30 };
const SRCV = { site: 100, docs: 100, official: 85, staff: 70, tested: 80, media: 30 };
const DIMS = ['价值', '门槛低', '好领取', '剩余时间', '信源可信', '国内直领'];
const WEIGHTS = [0.25, 0.2, 0.15, 0.15, 0.1, 0.15];
function dims(o) {
  const usd = valueNumber(o);
  const v = usd == null ? null : clamp(Math.round(Math.log10(usd + 1) / Math.log10(1001) * 100), 3, 100);
  let th = 100; o.r.forEach(r => { th -= REQ_PEN[r.split(':')[0]] || 0; }); th = Math.max(5, th);
  const st = statusOf(o);
  let tm;
  if (!isLimited(o)) tm = st === 'stale' ? 40 : 100;
  else if (o.ek === 'unknown') tm = 60;
  else if (st === 'ended') tm = 0;
  else if (st === 'upcoming') tm = 100;
  else tm = clamp(Math.round((o.e + 1) / 30 * 100), 4, 100);
  const cn = o.cn ? 100 : (o.r.some(r => ['phone', 'card'].includes(r.split(':')[0])) ? 20 : 50);
  return [v, th, EASE[o.c], tm, SRCV[o.st], cn];
}
const score = o => { const d = dims(o), w = sum(WEIGHTS, (x, i) => d[i] == null ? 0 : x); return Math.round(d.reduce((a, x, i) => a + (x == null ? 0 : x * WEIGHTS[i]), 0) / w); };

/* ---------- 文案格式 ---------- */
function money(u) {
  if (u == null || !Number.isFinite(u)) return '价值待定';
  if (u >= 1000) return '$' + (u >= 10000 ? Math.round(u / 1000) : (u / 1000).toFixed(1)) + 'k';
  return '$' + u.toLocaleString('en-US', { maximumFractionDigits: 2, minimumFractionDigits: u > 0 && u < 1 ? 2 : 0 });
}
// Reviewed V1 and V2 values share a known comparison window. Legacy amounts remain visible,
// but do not silently join rankings or totals until they have been revalued.
const VALUE_METHOD = { face_value: '官方面额', official_price: '官方价格折算', scenario: '用量估算', none: '暂无可靠价格' };
const VALUE_STATUS = { beta_unpriced: '公测免费 · 价值待定', unpriceable: '免费权益 · 暂无法折算', needs_judgment: '估值待核实' };
const VALUE_GROUPS = [['official', '官方口径', 0], ['scenario', '用量估算', 3]];
// Present existing valuation records in plain Chinese without changing their inputs.
const valuationText = text => String(text ?? '').replace(/(?:首|前)\s*30\s*天/g, '一个月')
  .replace(/\b(text|coding|image|video|stt|tts)[-_]v[12]\b/gi, (_, kind) => ({ text: '文本标准用量', coding: '编程标准用量', image: '图像标准用量', video: '视频标准用量', stt: '转写标准用量', tts: '语音合成标准用量' })[kind.toLowerCase()])
  .replace(/编程-v1\b/gi, '编程标准用量')
  .replace(/本轮管理员指定医疗场景为普通文本用量30倍/g, '此处假设医疗场景使用普通文本用量的30倍')
  .replace(/(?:本轮|本次)?管理员(?:本次|本轮)?(?:明确)?(?:指定|选择|采用|接受)/g, '本项估算采用');
const validAmount = n => typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null;
const valuationOf = o => ['v1', 'v2'].includes(o?.valuation?.version) ? o.valuation : null;
const isPriced = o => { const v = valuationOf(o); return !!v && ['priced', 'provisional'].includes(v.status) && ['face_value', 'official_price', 'scenario'].includes(v.method); };
const isReferenceBenchmark = o => { const v = valuationOf(o); return v?.version === 'v2' && typeof v.inputs?.benchmarkType === 'string' && !!v.inputs.benchmarkType.trim(); };
const isApplyBenchmark = o => o.ty === 'apply' && isReferenceBenchmark(o);
const valueGroup = o => isPriced(o) ? (valuationOf(o).method === 'scenario' ? 'scenario' : 'official') : null;
const valueNumber = o => isPriced(o) && o.ty !== 'apply' ? validAmount(valuationOf(o).usdEstimate) : null;
const applyMaximum = o => isPriced(o) && o.ty === 'apply' && !isApplyBenchmark(o) ? validAmount(valuationOf(o).usdMax) : null;
const applyFirst30Maximum = o => isPriced(o) && o.ty === 'apply' && !isApplyBenchmark(o) ? validAmount(valuationOf(o).inputs?.first30Max) : null;
const applyScenarioReference = o => isPriced(o) && isApplyBenchmark(o) ? validAmount(valuationOf(o).usdEstimate) : null;
const applyMonthlyReference = o => isApplyBenchmark(o) ? applyScenarioReference(o) : applyFirst30Maximum(o);
const comparisonValue = o => o.ty === 'apply' ? applyMonthlyReference(o) : valueNumber(o);
const hasDisplayValue = o => (o.ty === 'apply' ? (isApplyBenchmark(o) ? applyScenarioReference(o) : applyMaximum(o)) : valueNumber(o)) != null;
const valueSort = (a, b) => (comparisonValue(b) ?? -1) - (comparisonValue(a) ?? -1);
function valueSummary(list) {
  const pool = list.filter(o => o.ty !== 'apply');
  const by = group => pool.filter(o => valueGroup(o) === group && valueNumber(o) != null);
  const official = by('official'), scenario = by('scenario');
  return { official: sum(official, valueNumber), scenario: sum(scenario, valueNumber), officialN: official.length, scenarioN: scenario.length, priced: official.length + scenario.length, total: pool.length, unknown: pool.filter(o => valueNumber(o) == null).length, legacy: pool.filter(o => !valuationOf(o)).length };
}
const coverageText = s => `已计价 ${s.priced}/${s.total} 条${s.unknown ? ` · ${s.unknown} 条价值待定` : ''}`;
const summaryAmount = (s, group) => s[group + 'N'] ? `${group === 'scenario' ? '≈ ' : ''}${money(s[group])}` : '暂无已计价金额';
const summaryText = s => `官方口径 ${summaryAmount(s, 'official')} · 用量估算 ${summaryAmount(s, 'scenario')} · ${coverageText(s)}`;
const summaryHtml = list => { const s = valueSummary(list); return `<div class="valuation-summary"><span>官方口径 <b>${summaryAmount(s, 'official')}</b></span><span>用量估算 <b>${summaryAmount(s, 'scenario')}</b></span><small>${coverageText(s)} · 统一按一个月比较，申请制另列</small></div>`; };
function valuePeriod(o) {
  const v = valuationOf(o);
  if (!v) return '价值待定';
  if (o.ty === 'apply') return isApplyBenchmark(o) ? '月度使用方案参考' : '完整申请权益上限';
  return { one_time: '一次性 · 月度参考', monthly: '每月刷新 · 月度参考', first30: '月度参考', apply_max: '最高可申请' }[v.period] || '月度参考';
}
function valueTag(o) {
  const v = valuationOf(o), method = isReferenceBenchmark(o) ? (v.method === 'scenario' ? '模型成本参照' : '套餐价格参照') : v ? VALUE_METHOD[v.method] : '计算依据待补充';
  return `<span class="value-tag ${valueGroup(o) || 'unknown'}">${esc(method)}${v?.status === 'provisional' ? ' · 暂定' : ''}</span>`;
}
const valueAssumption = o => { const v = valuationOf(o); return valuationText((v?.assumptions || []).find(x => /期限|持续|截止|覆盖|\d+\s*天|duration|days?/i.test(x)) || v?.assumptions?.[0] || (v?.coverage?.days ? `估值覆盖 ${v.coverage.days} 天` : '')); };
function valLabel(o) {
  const v = valuationOf(o), amount = o.ty === 'apply' ? (isApplyBenchmark(o) ? applyScenarioReference(o) : applyMaximum(o)) : valueNumber(o), old = validAmount(o.usd);
  if (amount == null) {
    // One label per state: the status already says why there is no amount, so no method chip repeats it.
    // A legacy amount keeps its chip: it explains why the old value is not counted.
    const label = v ? VALUE_STATUS[v.status] || '价值待定' : old != null ? `旧参考值 ${money(old)}` : '价值待定';
    return `<span class="value-unknown">${esc(label)}</span>${!v && old != null ? valueTag(o) : ''}`;
  }
  const approx = v.method === 'scenario' || v.status === 'provisional' ? '≈ ' : '';
  const value = o.ty === 'apply' && !isApplyBenchmark(o) ? `最高 ${approx}${money(amount)}` : `${approx}${money(amount)}`;
  return `${value}<small>${valuePeriod(o)}</small>${o.ty === 'apply' ? `<small>${esc(o.val || '权益期限见详情')}</small>` : ''}${valueTag(o)}`;
}
const radarData = o => { const d = dims(o); return { names: DIMS.filter((_, i) => d[i] != null), values: d.filter(x => x != null) }; };
function valuationAlternatives(o) {
  const list = valuationOf(o)?.inputs?.alternatives;
  if (valueNumber(o) == null || !Array.isArray(list)) return [];
  return list.filter(x => x && typeof x.model === 'string' && x.model.trim() && validAmount(x.amount) != null && typeof x.formula === 'string' && x.formula.trim());
}
function detailValueLabel(o, alternative) {
  return alternative ? `≈ ${money(alternative.amount)}<small>月度参考 · 使用方案</small><span class="value-tag scenario">用量估算 · 另一个使用方案</span>` : valLabel(o);
}
function valuationBlock(o) {
  const v = valuationOf(o);
  if (!v) return `<div class="card" data-valuation><h3>估值说明</h3><p class="sub">当前金额缺少完整计算依据，暂不参与金额排行和汇总。</p></div>`;
  const alternatives = valuationAlternatives(o);
  const internalInputKeys = new Set(['alternatives', 'usageVersion', 'ruleIds', 'calculationEngine', 'sourceBindings']);
  const inputs = Object.entries(v.inputs || {}).filter(([key]) => !internalInputKeys.has(key)), sources = (v.sources || []).filter(s => { try { return ['https:', 'http:'].includes(new URL(s.url).protocol); } catch { return false; } });
  const text = x => valuationText(typeof x === 'object' && x !== null ? JSON.stringify(x) : String(x ?? '未公布'));
  const labels = { scenario: '场景', usageVersion: '用量基准版本', inputTokens: '输入 Token', outputTokens: '输出 Token', inputPrice: '输入单价', outputPrice: '输出单价', unitPrice: '单位价格', quantity: '数量', unit: '单位', currency: '币种', coverageDays: '覆盖天数', packagePrice: '套餐价格', packageUnits: '套餐额度', officialMonthlyPrice: '官方月价', first30Max: '月度参考上限', fullApplyMax: '完整申请权益上限', benchmarkType: '参考类型', referencePlan: '参考套餐', referenceModel: '参考模型', ruleIds: '计算规则', usageMultiplier: '用量倍数', pricingBasis: '定价依据', calculationBasis: '计算依据', model: '模型', specification: '规格', resolution: '分辨率', quality: '质量', mode: '模式', priceUnit: '计费单位', priceApplicableAt: '价格适用时间', recipientCount: '领取人数', sharedPool: '共享额度', limits: '适用限制' };
  const benchmarks = { entry_plan: '入门套餐参考', lowest_plan: '最低套餐参考', middle_plan: '中档套餐参考', substitute_model: '替代模型用量参考', accepted_reference: '套餐价格参考', package_ratio: '套餐额度比例参考', modality_sum: '多模态用量参考', discount_reference: '优惠价格参考', reset_reference: '额度重置参考' };
  return `<div class="card" data-valuation><h3>估值说明</h3><p class="sub">${hasDisplayValue(o) ? `${valueTag(o)} ${esc(valuePeriod(o))}${v.reviewedAt ? ` · 核价 ${esc(v.reviewedAt.slice(0, 10))}` : ''}<br>参考购买成本，不代表现金或已实际节省的费用。` : `暂未计入金额${v.reviewedAt ? ` · 核价 ${esc(v.reviewedAt.slice(0, 10))}` : ''}`}</p>
    ${o.ty === 'apply' ? `<div class="valuation-summary" data-apply-values>${isApplyBenchmark(o) ? `<span>月度使用方案参考 <b>${applyScenarioReference(o) == null ? '价值待定' : `≈ ${money(applyScenarioReference(o))}`}</b></span><small>按参考价格与固定用量计算的购买成本，不代表申请额度或保证获批；没有保证可得的下限。</small>` : `<span>月度参考上限 <b>${applyFirst30Maximum(o) == null ? '价值待定' : `${v.method === 'scenario' ? '≈ ' : ''}${money(applyFirst30Maximum(o))}`}</b></span>`}<span>完整申请权益上限 <b>${applyMaximum(o) == null ? '价值待定' : money(applyMaximum(o))}</b></span><small>权益期限：${esc(o.val || '以官方计划为准')}。完整上限覆盖整个计划，各计划期限不同；最高可申请不代表保证获批${v.usdEstimate == null ? '，没有保证可得的下限' : ''}。</small></div>` : ''}
    ${v.baselineModel ? `<p class="small">基准模型：<b>${esc(v.baselineModel)}</b></p>` : ''}
    ${alternatives.length ? `<label class="field" for="valueModel">选择模型使用方案<select id="valueModel"><option value="default" selected>${esc(v.baselineModel || '默认估值')} · 默认基准</option>${alternatives.map((x, i) => x.model === v.baselineModel ? '' : `<option value="${i}">${esc(x.model)} · ≈ ${money(x.amount)}</option>`).join('')}</select></label><p class="small muted" data-model-note role="status">当前为默认基准。其他模型是另一个使用方案；金额已按此活动的覆盖期与配额计算。全站排序、汇总和领取记录使用默认估值。</p>` : ''}
    ${v.coverage ? `<p class="small">计价模型 ${v.coverage.pricedModels}/${v.coverage.totalModels}${v.coverage.days ? ` · 覆盖 ${v.coverage.days} 天` : ''}${v.coverage.pricedModels < v.coverage.totalModels ? ' · 部分模型缺价，金额为暂定值' : ''}</p>` : ''}
    ${v.formula ? `<div class="value-formula" data-detail-formula>${esc(valuationText(v.formula))}</div>` : `<p class="small">${esc(VALUE_STATUS[v.status] || '暂无可靠价格')}</p>`}
    ${validAmount(v.fullValue) != null ? `<p class="small">完整权益参考值：${money(v.fullValue)}（独立展示，不叠加月度参考价值）</p>` : ''}
    ${inputs.length ? `<details><summary>计算输入与限制</summary><dl class="value-inputs">${inputs.map(([key, val]) => `<div><dt>${esc(labels[key] || key)}</dt><dd>${esc(key === 'benchmarkType' ? benchmarks[val] || text(val) : text(val))}</dd></div>`).join('')}</dl></details>` : ''}
    ${(v.assumptions || []).length ? `<ul class="value-assumptions">${v.assumptions.map(x => `<li>${esc(valuationText(x))}</li>`).join('')}</ul>` : ''}
    ${sources.length ? `<details><summary>价格与权益来源（${sources.length}）</summary>${sources.map(s => `<div class="value-source"><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.priceBasis || '价格依据')} ↗</a><small>核价 ${esc((s.checkedAt || '').slice(0, 10))}</small><blockquote>${esc(s.excerpt || '')}</blockquote></div>`).join('')}</details>` : ''}</div>`;
}
function oneTimeEffectiveAt(o) {
  if (o.ek !== 'date' || o.s == null || o.s !== o.e || o.withdrawnAt) return null;
  const match = (o.evidence?.excerpts?.claim || '').match(/(\d{1,2})月(\d{1,2})日\s*(\d{1,2}:\d{2})\s*生效/);
  if (!match) return null;
  const day = dayAt(o.s);
  if (+match[1] !== day.getMonth() + 1 || +match[2] !== day.getDate()) return null;
  return `${+match[1]}月${+match[2]}日 ${match[3]}`;
}
function leftText(o) {
  const st = statusOf(o);
  if (st === 'ended') { const effectiveAt = oneTimeEffectiveAt(o); return effectiveAt ? `${effectiveAt}生效 · 单次发放` : actualEnd(o) ? `${md(actualEnd(o))}结束` : '已结束'; }
  if (st === 'upcoming') return o.s === 1 ? '明天开始' : `${o.s} 天后开始`;
  if (st === 'stale') return `${Math.round(-o.vf)} 天未核验成功`;
  if (st === 'standing') return `常驻 · ${ago(o.vf)}核验`;
  if (st === 'open') return '长期开放申请';
  if (o.evidence?.claimEndDerivation) { const window = countdownWindow(o); if (window) return `${estimatedCountdown(window)} · 截止估算`; }
  if (o.ek === 'unknown') return '截止未知';
  if (o.e === 0) return '今天结束';
  if (o.e === 1) return '明天结束';
  return `还剩 ${o.e} 天`;
}
function ago(vf) { const v = -vf; if (v < 1) return `${Math.max(1, Math.round(v * 24))} 小时前`; return `${Math.round(v)} 天前`; }
function cdText(ms) {
  if (ms <= 0) return '已结束';
  const s = Math.floor(ms / 1000), d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60), sec = s % 60;
  return (d ? `${d}天 ` : '') + `${pad(h)}:${pad(m)}:${pad(sec)}`;
}
function barOf(o) {
  const st = statusOf(o);
  if (st === 'standing') return [1, 'var(--s6)'];
  if (st === 'stale') return [0.4, 'var(--warn)'];
  if (st === 'open') return [1, 'var(--s7)'];
  if (st === 'upcoming') return [1, 'var(--line-2)'];
  if (st === 'ended') return [0, 'var(--line-2)'];
  // No official deadline: an empty dashed track, never a fill that reads as time remaining.
  if (o.ek === 'unknown') return [null, null];
  const frac = clamp((o.e + 0.5) / Math.max(1, o.e - (o.s ?? o.e - 30)), 0.03, 1);
  return [frac, o.e === 0 ? 'var(--critical)' : st === 'ending' ? 'var(--serious)' : 'var(--good)'];
}

/* ---------- 小部件 ---------- */
const etagSvg = col => `<svg viewBox="0 0 14 16" aria-hidden="true"><rect x="4.5" y="0.5" width="5" height="4" rx="1.5" style="fill:${col}"/><rect x="0.5" y="3" width="13" height="12.5" rx="3.5" style="fill:${col}"/><circle cx="7" cy="6.6" r="1.5" style="fill:var(--surface)"/></svg>`;
const etag = ty => `<span class="etag">${etagSvg(typeVar(ty))}${TYPES[ty].l}</span>`;
function stChip(o) {
  const s = statusOf(o);
  let m = ST[s];
  if (s === 'ending' && o.e === 0) m = { l: '今天结束', i: '!', c: 'critical' };
  return `<span class="st ${m.c}"><b>${m.i}</b>${m.l}</span>`;
}
const stBadge = (c, i, l) => `<span class="st ${c}"><b>${i}</b>${l}</span>`;
function miniRadar(o, size = 66) {
  const d = radarData(o).values, n = d.length, c = size / 2, R = size / 2 - 5;
  const pt = (i, r) => { const a = -Math.PI / 2 + i * 2 * Math.PI / n; return [c + Math.cos(a) * r, c + Math.sin(a) * r].map(v => v.toFixed(1)).join(','); };
  const ring = f => Array.from({ length: n }, (_, i) => pt(i, R * f)).join(' ');
  const poly = d.map((v, i) => pt(i, R * Math.max(v, 6) / 100)).join(' ');
  const col = typeVar(o.ty);
  return `<svg class="oc-radar" viewBox="0 0 ${size} ${size}" aria-hidden="true"><polygon points="${ring(1)}" style="fill:var(--surface-2);stroke:var(--line-2)"/><polygon points="${ring(0.5)}" style="fill:none;stroke:var(--line-2)"/><polygon points="${poly}" style="fill:${col};fill-opacity:.3;stroke:${col};stroke-width:1.6;stroke-linejoin:round"/></svg>`;
}
function spark(vals) {
  const w = 120, h = 30, p = 3, mx = Math.max(...vals), mn = Math.min(...vals);
  const x = i => p + i * (w - 2 * p) / (vals.length - 1), y = v => h - p - (v - mn) / ((mx - mn) || 1) * (h - 2 * p);
  const line = vals.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
  return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true"><path d="${line}L${x(vals.length - 1)},${h}L${x(0)},${h}Z" style="fill:currentColor;opacity:.13"/><path d="${line}" style="fill:none;stroke:currentColor;stroke-width:2;vector-effect:non-scaling-stroke;stroke-linejoin:round"/></svg>`;
}
/** Dashed empty ring: the deadline is unknown, so nothing is filled. */
function ringUnknown(size, stroke = 6) {
  const r = (size - stroke) / 2, m = size / 2;
  return `<svg viewBox="0 0 ${size} ${size}" aria-hidden="true" data-deadline-unknown><circle cx="${m}" cy="${m}" r="${r}" style="fill:none;stroke:var(--line-2);stroke-width:${stroke / 2};stroke-dasharray:3 6"/></svg>`;
}
function ringSvg(frac, size, col, stroke = 6) {
  const r = (size - stroke) / 2, c = 2 * Math.PI * r, m = size / 2;
  return `<svg viewBox="0 0 ${size} ${size}" aria-hidden="true"><circle cx="${m}" cy="${m}" r="${r}" style="fill:none;stroke:var(--surface-2);stroke-width:${stroke}"/><circle cx="${m}" cy="${m}" r="${r}" transform="rotate(-90 ${m} ${m})" style="fill:none;stroke:${col};stroke-width:${stroke};stroke-linecap:round;stroke-dasharray:${(c * clamp(frac, 0, 1)).toFixed(1)} ${c.toFixed(1)}"/></svg>`;
}
function emptySheep(msg) {
  return `<div class="empty"><svg viewBox="0 0 120 80" aria-hidden="true"><ellipse cx="60" cy="72" rx="44" ry="5" style="fill:var(--surface-2)"/><g transform="translate(64,46)"><g style="fill:var(--wool);stroke:var(--wool-edge);stroke-width:2">${[0, 1, 2, 3, 4, 5, 6, 7].map(i => `<circle cx="${(Math.cos(i / 8 * 6.28) * 17).toFixed(1)}" cy="${(Math.sin(i / 8 * 6.28) * 10 - 2).toFixed(1)}" r="8"/>`).join('')}</g><ellipse cx="0" cy="-2" rx="18" ry="11" style="fill:var(--wool)"/><g style="fill:var(--face)"><rect x="-12" y="7" width="3.5" height="12" rx="1.5"/><rect x="8" y="7" width="3.5" height="12" rx="1.5"/><ellipse cx="-22" cy="-6" rx="6.5" ry="8.5"/></g><circle cx="-24" cy="-8" r="1.3" style="fill:#fff"/></g><path d="M18 70 l3 -8 l3 8 M28 71 l2 -6 l2 6 M96 70 l3 -7 l3 7" style="fill:none;stroke:var(--hill-4);stroke-width:1.6;stroke-linecap:round"/></svg><div>${msg}</div></div>`;
}

/* ---------- 图标 ---------- */
const svgI = inner => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
const ICON = {
  agent: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="4" y="6" width="16" height="13" rx="4"/><path d="M12 2v4M8 22v-3M16 22v-3M1 11h3M20 11h3M8 15h8"/><circle cx="8" cy="10" r="1"/><circle cx="16" cy="10" r="1"/></svg>',
  today: svgI('<circle class="ic-dot" cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M5.3 18.7l1.6-1.6M17.1 6.9l1.6-1.6"/>'),
  calendar: svgI('<rect x="3.5" y="5" width="17" height="15.5" rx="3"/><path d="M3.5 10h17M8 3v4M16 3v4"/><rect class="ic-dot" x="7" y="13" width="4" height="4" rx="1"/>'),
  timeline: svgI('<rect class="ic-dot" x="3" y="5" width="11" height="3.6" rx="1.8"/><rect x="8" y="10.2" width="13" height="3.6" rx="1.8"/><rect x="5" y="15.4" width="9" height="3.6" rx="1.8"/>'),
  insights: svgI('<path d="M3.5 19.5h17"/><path d="M5 15l4-4.5 3.5 3 6.5-7.5"/><circle class="ic-dot" cx="19" cy="6" r="2.2"/>'),
  all: svgI('<rect class="ic-dot" x="3.5" y="3.5" width="7" height="7" rx="2"/><rect x="13.5" y="3.5" width="7" height="7" rx="2"/><rect x="3.5" y="13.5" width="7" height="7" rx="2"/><rect x="13.5" y="13.5" width="7" height="7" rx="2"/>'),
  library: svgI('<path class="ic-dot" d="M12 12c-2-2.6-3.6-4-5.6-4a4 4 0 0 0 0 8c2 0 3.6-1.4 5.6-4zm0 0c2 2.6 3.6 4 5.6 4a4 4 0 0 0 0-8c-2 0-3.6 1.4-5.6 4z"/>'),
  apply: svgI('<path d="M7 3.5h7l4.5 4.5v12.5H7z"/><path d="M14 3.5V8h4.5"/><path class="ic-dot" d="M9.5 13h6M9.5 16.5h4"/>'),
  models: svgI('<circle class="ic-dot" cx="6" cy="7" r="2.6"/><circle cx="18" cy="6" r="2.2"/><circle cx="12" cy="17.5" r="2.6"/><path d="M8.3 8.3l2.6 6.7M15.9 7.3l-2.9 7.9M8.5 6.8l7.3-.6"/>'),
  mine: svgI('<circle class="ic-dot" cx="12" cy="8.5" r="3.8"/><path d="M4.5 20c1.2-3.8 4.1-5.6 7.5-5.6s6.3 1.8 7.5 5.6"/>'),
  coverage: svgI('<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.5"/><circle class="ic-dot" cx="12" cy="12" r="1.4"/><path d="M12 12l6-6"/>'),
  'valuation-method': svgI('<path d="M5 3.5h14v17H5zM8 7h8M8 11h2M14 11h2M8 15h2M14 15h2"/><path class="ic-dot" d="M8 18h8"/>'),
  admin: svgI('<circle class="ic-dot" cx="12" cy="12" r="3"/><path d="M12 2.8v2.6M12 18.6v2.6M21.2 12h-2.6M5.4 12H2.8M18.5 5.5l-1.8 1.8M7.3 16.7l-1.8 1.8M18.5 18.5l-1.8-1.8M7.3 7.3L5.5 5.5"/>'),
  more: svgI('<circle class="ic-dot" cx="5.5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="18.5" cy="12" r="1.7"/>'),
};
const BRAND = `<svg viewBox="0 0 40 40" aria-hidden="true"><circle cx="20" cy="20" r="19" style="fill:var(--tag-soft)"/><g style="fill:var(--wool);stroke:var(--wool-edge);stroke-width:1.4">${[0, 1, 2, 3, 4, 5, 6].map(i => `<circle cx="${(20 + Math.cos(i / 7 * 6.28 - 1.57) * 8).toFixed(1)}" cy="${(17 + Math.sin(i / 7 * 6.28 - 1.57) * 6).toFixed(1)}" r="5"/>`).join('')}</g><circle cx="20" cy="17" r="7" style="fill:var(--wool)"/><ellipse cx="20" cy="23" rx="6.4" ry="8" style="fill:var(--face)"/><ellipse cx="12.5" cy="20" rx="4.2" ry="1.8" transform="rotate(-20 12.5 20)" style="fill:var(--face)"/><ellipse cx="27.5" cy="20" rx="4.2" ry="1.8" transform="rotate(20 27.5 20)" style="fill:var(--face)"/><rect x="27.2" y="20.5" width="4" height="5" rx="1.3" style="fill:var(--tag)"/><circle cx="17.6" cy="22" r="1.1" style="fill:#fff"/><circle cx="22.4" cy="22" r="1.1" style="fill:#fff"/></svg><span>AI 羊毛牧场</span>`;

/* ---------- 图表 ---------- */
const CHARTS = new Set();
function baseOpt() {
  return {
    textStyle: { fontFamily: FONT, color: TK.ink2 },
    tooltip: { backgroundColor: TK.surface, borderColor: TK.line2, borderWidth: 1, padding: [8, 11], textStyle: { color: TK.ink, fontSize: 12.5, fontFamily: FONT }, extraCssText: 'border-radius:12px;box-shadow:0 8px 24px rgba(0,0,0,.14);' },
    animation: !REDUCED, animationDuration: 650, animationEasing: 'cubicOut',
  };
}
function chart(el, opt, set = CHARTS) {
  if (typeof el === 'string') el = $(el);
  if (!el) return null;
  const c = echarts.init(el, null, { renderer: 'svg' });
  const b = baseOpt();
  if (opt.tooltip) opt.tooltip = Object.assign({}, b.tooltip, opt.tooltip);
  c.setOption(Object.assign(b, opt));
  set.add(c);
  return c;
}
const axisCommon = () => ({ axisLine: { lineStyle: { color: TK.line2 } }, axisTick: { show: false }, axisLabel: { color: TK.muted, fontSize: 11.5 }, splitLine: { lineStyle: { color: TK.line } } });
const legendCommon = () => ({ icon: 'roundRect', itemWidth: 10, itemHeight: 10, itemGap: 12, textStyle: { color: TK.ink2, fontSize: 12 } });

/* ---------- 浮层提示 ---------- */
const tip = () => $('#tip');
function showTip(html, x, y) {
  const t = tip(); t.innerHTML = html; t.hidden = false;
  const w = t.offsetWidth, h = t.offsetHeight;
  let left = x + 14, top = y + 14;
  if (left + w > innerWidth - 8) left = x - w - 14;
  if (top + h > innerHeight - 8) top = y - h - 14;
  t.style.left = Math.max(8, left) + 'px'; t.style.top = Math.max(8, top) + 'px';
}
const hideTip = () => { tip().hidden = true; };
/** Long messages (errors that say what to fix) need time to read: ~10 Chinese characters a second, 2.2–8 s. */
const toastMs = msg => Math.min(8000, Math.max(2200, String(msg).length * 100));
function toast(msg) {
  let t = $('#toast');
  if (!t) { t = document.createElement('div'); t.id = 'toast'; t.className = 'tray'; t.setAttribute('role', 'status'); document.body.appendChild(t); }
  t.textContent = msg; t.hidden = false; t.style.zIndex = 90;
  clearTimeout(toast.h); toast.h = setTimeout(() => { t.hidden = true; }, toastMs(msg));
}

/* ============================================================
 * 羊群主视觉：每只羊一条羊毛。体型 = 价值，耳标颜色 = 类型，羊毛厚度 = 剩余时间。
 * ============================================================ */
function woolRatio(o) { if (o.ek === 'unknown') return 0.7; return clamp(o.e / 10, 0, 1); }
function sheepSvg(p) {
  const o = p.o, r = rng(hash(o.id)), flip = hash(o.id) % 2 ? -1 : 1;
  const wool = woolRatio(o), sheared = wool <= 0.12;
  const rx = 26, ry = 16, n = 12, br = 4.2 + 7.5 * wool;
  let bumps = '';
  for (let i = 0; i < n; i++) { const a = i / n * Math.PI * 2; bumps += `<circle cx="${(Math.cos(a) * rx * 0.9).toFixed(1)}" cy="${(Math.sin(a) * ry * 0.85 - 3).toFixed(1)}" r="${(br * (0.85 + 0.3 * r())).toFixed(1)}"/>`; }
  const core = `<ellipse cx="0" cy="-3" rx="${rx}" ry="${ry}"/>`;
  const body = sheared
    ? `<g class="wool-o" style="fill:var(--skin);stroke:var(--wool-edge);stroke-width:2">${core}</g><g style="fill:var(--wool);stroke:var(--wool-edge);stroke-width:1.2"><circle cx="-8" cy="-15" r="3"/><circle cx="5" cy="-17" r="2.6"/><circle cx="15" cy="-10" r="2.4"/></g>`
    : `<g class="wool-o" style="fill:var(--wool);stroke:var(--wool-edge);stroke-width:2.6">${core}${bumps}</g><g style="fill:var(--wool)">${core}${bumps}</g>`;
  const scissors = sheared ? `<g class="snip" transform="translate(${flip < 0 ? -34 : 20},-40)" style="fill:none;stroke:var(--ink-2);stroke-width:1.8;stroke-linecap:round"><circle cx="0" cy="12" r="3"/><circle cx="7" cy="12" r="3"/><path d="M1.6 9.6L9 0M5.4 9.6L-2 0"/></g>` : '';
  const x = p.x.toFixed(1), y = p.y.toFixed(1), sc = p.sc.toFixed(3);
  const label = `${o.t}，${o.plat.name}，${TYPES[o.ty].l}，${valLabel(o).replace(/<[^>]+>/g, '')}，${leftText(o)}`;
  return `<g class="sheep" tabindex="0" role="link" aria-label="${esc(label)}" data-id="${o.id}" transform="translate(${x},${y})">
    <ellipse cx="0" cy="${(24 * p.sc).toFixed(1)}" rx="${(25 * p.sc).toFixed(1)}" ry="${(4 * p.sc).toFixed(1)}" style="fill:var(--hill-4);opacity:.35"/>
    <g transform="scale(${flip * p.sc},${sc})"><g class="bob" style="animation-delay:-${(r() * 3).toFixed(2)}s">
      <circle cx="${rx + 2}" cy="-6" r="4" style="fill:${sheared ? 'var(--skin)' : 'var(--wool)'};stroke:var(--wool-edge);stroke-width:1.5"/>
      <g style="fill:var(--face)"><rect x="-17" y="9" width="4.4" height="15" rx="2"/><rect x="-8" y="11" width="4.4" height="14" rx="2"/><rect x="6" y="11" width="4.4" height="14" rx="2"/><rect x="14" y="9" width="4.4" height="15" rx="2"/></g>
      ${body}
      <g transform="translate(-29,-10) rotate(-12)">
        ${sheared ? '' : '<circle cx="1" cy="-10" r="5" style="fill:var(--wool);stroke:var(--wool-edge);stroke-width:1.4"/>'}
        <ellipse cx="0" cy="0" rx="8.5" ry="11" style="fill:var(--face)"/>
        <ellipse cx="-8.5" cy="-6" rx="6" ry="2.6" transform="rotate(-25 -8.5 -6)" style="fill:var(--face)"/>
        <ellipse cx="8.5" cy="-7" rx="6" ry="2.6" transform="rotate(25 8.5 -7)" style="fill:var(--face)"/>
        <g transform="translate(10,-5)"><rect x="-3" y="-1" width="7" height="8" rx="2" style="fill:${typeVar(o.ty)};stroke:var(--face);stroke-width:.8"/><circle cx="0.5" cy="1.8" r="1" style="fill:var(--face)"/></g>
        <circle cx="-3" cy="-2" r="1.7" style="fill:#fff"/>
      </g>
    </g></g>${scissors}${valueNumber(o) == null ? '<text x="0" y="-37" text-anchor="middle" style="fill:var(--ink);font-size:14px;font-weight:700">?</text>' : ''}</g>`;
}
function meadowBg(W, H, wx) {
  const hill = (y0, amp, ph, v) => {
    let d = `M0,${H} L0,${y0}`; const steps = 6;
    for (let i = 1; i <= steps; i++) {
      const xx = W * i / steps, yy = y0 + Math.sin(i * 1.3 + ph) * amp, cx = W * (i - 0.5) / steps, cy = y0 + Math.sin((i - 0.5) * 1.3 + ph) * amp - amp * 0.7;
      d += ` Q${cx.toFixed(0)},${cy.toFixed(0)} ${xx.toFixed(0)},${yy.toFixed(0)}`;
    }
    return `<path d="${d} L${W},${H} Z" style="fill:var(${v})"/>`;
  };
  const r = rng(99);
  // Above 640px the weather card overlays the top-right sky (.hero-over), so the sun moves between the clouds.
  const sunX = W > 640 ? W * 0.5 : W - Math.min(110, W * 0.2), sunY = H * 0.17;
  let sky = '';
  if (wx.i >= 60) sky += `<g style="stroke:var(--sun);stroke-width:3;stroke-linecap:round">${[...Array(10)].map((_, i) => { const a = i / 10 * 6.283; return `<path d="M${(sunX + Math.cos(a) * 30).toFixed(1)},${(sunY + Math.sin(a) * 30).toFixed(1)} L${(sunX + Math.cos(a) * 38).toFixed(1)},${(sunY + Math.sin(a) * 38).toFixed(1)}"/>`; }).join('')}</g><circle cx="${sunX}" cy="${sunY}" r="22" style="fill:var(--sun)"/>`;
  const cloud = (cx, cy, s) => `<g transform="translate(${cx},${cy}) scale(${s})" style="fill:var(--cloud);opacity:.92"><ellipse cx="0" cy="0" rx="26" ry="12"/><circle cx="-10" cy="-8" r="11"/><circle cx="8" cy="-11" r="14"/><circle cx="22" cy="-3" r="9"/></g>`;
  if (wx.i < 80) sky += cloud(sunX - 20, sunY + 14, 1.1);
  sky += cloud(W * 0.38, H * 0.12, 0.8) + cloud(W * 0.62, H * 0.2, 0.6);
  if (wx.i < 40) sky += `<g style="stroke:var(--s1);stroke-width:2;stroke-linecap:round;opacity:.6">${[...Array(6)].map((_, i) => `<path d="M${sunX - 34 + i * 10},${sunY + 30} l-3,8"/>`).join('')}</g>`;
  const fenceY = H * 0.43;
  let fence = '';
  for (let x = 14; x < W; x += 58) { const j = (r() - 0.5) * 3; fence += `<path d="M${x},${fenceY + 16 + j} L${x + 0.8},${fenceY - 14 + j}" />`; }
  const rail = yy => { let d = `M0,${(yy + (r() - 0.5) * 2).toFixed(1)}`; for (let x = 60; x <= W + 60; x += 60) d += ` L${x},${(yy + (r() - 0.5) * 2.4).toFixed(1)}`; return `<path d="${d}"/>`; };
  fence = `<g style="fill:none;stroke:var(--fence);stroke-width:3;stroke-linecap:round;opacity:.75">${fence}${rail(fenceY - 6)}${rail(fenceY + 6)}</g>`;
  let tufts = '';
  for (let i = 0; i < Math.round(W / 34); i++) { const x = r() * W, y = H * 0.55 + r() * H * 0.42; tufts += `<path d="M${x.toFixed(0)},${y.toFixed(0)} l2.5,-7 l2.5,7 l2,-5 l2,5"/>`; }
  let flowers = '';
  for (let i = 0; i < Math.round(W / 120); i++) { const x = r() * W, y = H * 0.6 + r() * H * 0.36; flowers += `<g transform="translate(${x.toFixed(0)},${y.toFixed(0)})"><circle r="3.2" style="fill:#fff"/><circle r="1.4" style="fill:var(--tag)"/></g>`; }
  return sky + hill(H * 0.46, 10, 0.3, '--hill-1') + fence + hill(H * 0.55, 12, 2.1, '--hill-2') + hill(H * 0.7, 9, 4.2, '--hill-3') + `<g style="fill:none;stroke:var(--hill-4);stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round">${tufts}</g>` + flowers;
}
function buildFlock(el, list, wx) {
  const W = Math.max(300, Math.round(el.clientWidth || 800));
  const small = W < 640, H = small ? 330 : 400;
  const base = small ? 0.6 : W < 900 ? 0.78 : 0.95;
  if (!list.length) { el.innerHTML = `<svg class="meadow" viewBox="0 0 ${W} ${H}" aria-hidden="true">${meadowBg(W, H, wx)}</svg>` + emptySheep('按你的条件，草地上暂时没有羊。去"我的条件"放宽一点试试。'); return; }
  const maxU = Math.max(1, ...list.map(o => valueNumber(o) ?? 0));
  const r = rng(20260930);
  const items = list.map(o => ({ o, sc: valueNumber(o) == null ? base : base * (0.62 + 0.75 * Math.sqrt(valueNumber(o) / maxU)) })).sort((a, b) => b.sc - a.sc);
  const top = H * (small ? 0.5 : 0.52), bottom = H - 26 * base;
  const placed = [];
  for (const it of items) {
    const rad = 33 * it.sc;
    let best = null, bestGap = -Infinity;
    for (let k = 0; k < 320; k++) {
      const x = 16 + rad * 1.2 + r() * (W - 32 - rad * 2.4);
      const y = top + rad * 0.5 + r() * Math.max(4, bottom - top - rad * 1.3);
      const gap = placed.length ? Math.min(...placed.map(p => Math.hypot(p.x - x, (p.y - y) * 1.5) - p.rad - rad)) : 999;
      if (gap > bestGap) { best = { x, y }; bestGap = gap; }
      if (gap > 8) break;
    }
    placed.push({ ...it, ...best, rad });
  }
  placed.sort((a, b) => a.y - b.y);
  el.innerHTML = `<svg class="meadow" viewBox="0 0 ${W} ${H}" role="group" aria-label="进行中的羊毛，共 ${list.length} 只羊">${meadowBg(W, H, wx)}${placed.map(sheepSvg).join('')}</svg>`;
  el.dataset.w = W;
  $$('.sheep', el).forEach(g => {
    const o = OMAP[g.dataset.id];
    const html = `<b>${esc(o.t)}</b>${esc(o.plat.name)} · ${TYPES[o.ty].l}<br>${valLabel(o).replace(/<small>/, ' ').replace(/<\/small>/, '')} · ${leftText(o)}<br><span class="muted">薅度 ${score(o)} · 点击看详情</span>`;
    g.addEventListener('mousemove', e => showTip(html, e.clientX, e.clientY));
    g.addEventListener('mouseleave', hideTip);
    g.addEventListener('focus', () => { const b = g.getBoundingClientRect(); showTip(html, b.right, b.top); });
    g.addEventListener('blur', hideTip);
    g.addEventListener('click', () => { hideTip(); location.hash = 'offer-' + o.id; });
    g.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); location.hash = 'offer-' + o.id; } });
  });
}

/* ---------- 羊毛天气 ---------- */
function weatherNow() {
  const act = view(OFFERS.filter(activeLimited));
  const fresh = view(OFFERS.filter(o => o.since >= -7 && claimable(o))).length;
  const ending = act.filter(o => statusOf(o) === 'ending').length;
  const val = valueSummary(act).official;
  const i = clamp(Math.round(18 + fresh * 4 + Math.log10(1 + val) * 11 - ending * 2), 5, 99);
  const [t, adv] = i >= 80 ? ['晴', '草肥羊壮，适合出门薅'] : i >= 60 ? ['晴间多云', '新羊毛不少，先领薅度分高的'] : i >= 40 ? ['多云', '羊毛一般，可以等等节日活动'] : ['小雨', '今天没什么可薅，明天再来'];
  return { i, t, adv, fresh, ending, val };
}
function wxIcon(i) {
  const sun = '<circle cx="18" cy="17" r="8" style="fill:var(--sun)"/>';
  const cloud = (dx, dy) => `<g transform="translate(${dx},${dy})" style="fill:var(--cloud);stroke:var(--line-2);stroke-width:1"><path d="M8 32h22a6 6 0 0 0 0-12 9 9 0 0 0-17-2 6.5 6.5 0 0 0-5 14z"/></g>`;
  const rain = '<g style="stroke:var(--s1);stroke-width:2;stroke-linecap:round"><path d="M14 36l-2 4M21 36l-2 4M28 36l-2 4"/></g>';
  const inner = i >= 80 ? sun + '<g style="stroke:var(--sun);stroke-width:2.4;stroke-linecap:round"><path d="M18 3v4M18 27v4M4 17h4M28 17h4M8 7l3 3M25 24l3 3M8 27l3-3M25 10l3-3"/></g>' : i >= 60 ? sun + cloud(4, 2) : i >= 40 ? cloud(2, -2) : cloud(2, -6) + rain;
  return `<svg viewBox="0 0 40 42" aria-hidden="true">${inner}</svg>`;
}

/* ============================================================
 * 页面
 * ============================================================ */
const main = () => $('#main');
/** Site descriptor: homepage subtitle, the landing tab title, and (in head.html / build.sh) link previews. */
const SITE_TAGLINE = '免费大模型 Token、API 额度、会员和生图生视频次数，每天汇总，条条可追官方出处。';
/** Break only at 、/， pauses: keep 大模型 Token and API 额度 together, and each clause on its own line when it fits. */
const taglineHtml = () => SITE_TAGLINE.replace(/ /g, '\u00a0').replace(/([、，])/g, '$1<wbr>')
  .replace(/^(.+?，<wbr>)(每天.+)$/, '<span class="clause">$1</span><span class="clause">$2</span>');
const pageTitle = name => !name || name === 'today' ? 'AI 羊毛牧场 · 免费 AI 额度与大模型 Token 福利汇总' : `${TITLES[name] || '今天'} · AI 羊毛牧场`;
const ph = (title, desc = '', extra = '') => `<div class="ph"><div><h1>${title}</h1>${desc ? `<p>${desc}</p>` : ''}</div>${extra}</div>`;
const secH = (title, hint = '') => `<div class="sec-h"><h2>${title}</h2>${hint ? `<span class="hint">${hint}</span>` : ''}</div>`;
function ribbon() {
  if(META.degraded)return `<div class="ribbon" role="status">只读模式：数据库今日额度已用尽，显示 ${esc(new Date(META.snapshotAt).toLocaleString())} 的已批准快照。数据可能延迟，领取前请核对官方；后台审核与采集暂时暂停。</div>`;
  const ago2 = LAST_OK ? Math.max(0, Math.round((NOW - LAST_OK) / 3600000)) : null;
  return `<div class="ribbon"><span class="live"><i></i>最近一次抓取：<b>${LAST_OK ? `${ago2 < 1 ? '1 小时内' : ago2 + ' 小时前'}（${hm(LAST_OK)}）` : '—'}</b></span><span>${META.coverageDegraded ? '部分抓取或核验尚未完成' : '只收能追到官方出处的羊毛，每条都附官方原文'}</span></div>`;
}
function ocard(o, hidden = false) {
  const [frac, col] = barOf(o), track = frac == null ? '<div class="bar unknown" aria-hidden="true"></div>' : `<div class="bar" aria-hidden="true"><i style="width:${(frac * 100).toFixed(0)}%;background:${col}"></i></div>`;
  return `<article class="ocard"${hidden ? ' hidden' : ''}>
    <a class="stretch" href="#offer-${o.id}" aria-label="${esc(o.t)}"></a>
    <div class="oc-top">${etag(o.ty)}${stChip(o)}</div>
    <div style="min-width:0"><p class="oc-title">${esc(o.t)}</p><div class="oc-plat">${esc(o.plat.name)} · ${CLAIM[o.c]}</div><div class="oc-val">${valLabel(o)}</div>${hasDisplayValue(o) && valueAssumption(o) ? `<div class="small muted value-assumption">${esc(valueAssumption(o))}</div>` : ''}</div>
    ${miniRadar(o)}
    <div class="oc-foot">
      ${track}
      <div class="oc-meta"><span>${leftText(o)}</span><span class="row" style="gap:6px"><span class="score" title="${valueNumber(o) == null ? '价值未计入，按其余五项计算' : '六项薅度分'}">${score(o)}<small>薅度${valueNumber(o) == null ? ' · 5项' : ''}</small></span><button class="cmp" type="button" data-cmp="${o.id}" aria-pressed="${CMP.includes(o.id)}">对比</button></span></div>
      ${reqChips(o)}
    </div>
  </article>`;
}
/**
 * Long card walls show a page at a time. All cards are rendered (filters, compare state and links keep working)
 * and the rest are revealed in steps; the opened count is kept per page so the 5-minute refresh does not collapse it.
 */
const CARD_PAGE = 24, CARD_SHOWN = new Map();
let CARD_WALL_SEQ = 0;
const moreCardsLabel = (next, left) => `再显示 ${next} 条（还有 ${left} 条）`;
function ocards(list, page = CARD_PAGE) {
  if (!list.length) return emptySheep('这里暂时没有羊毛。');
  const key = `${location.hash}|${CARD_WALL_SEQ++}`, shown = Math.max(page, CARD_SHOWN.get(key) || 0), left = list.length - shown;
  return `<div class="ocards">${list.map((o, i) => ocard(o, i >= shown)).join('')}</div>${left > 0 ? `<button class="btn more-cards" type="button" data-more-cards="${esc(key)}" data-page="${page}">${moreCardsLabel(Math.min(page, left), left)}</button>` : ''}`;
}
function showMoreCards(button) {
  const wall = button.previousElementSibling, page = +button.dataset.page;
  const hidden = [...wall.children].filter(card => card.hasAttribute('hidden'));
  hidden.slice(0, page).forEach(card => card.removeAttribute('hidden'));
  CARD_SHOWN.set(button.dataset.moreCards, wall.children.length - Math.max(0, hidden.length - page));
  const left = hidden.length - page;
  if (left > 0) button.textContent = moreCardsLabel(Math.min(page, left), left); else button.remove();
}
function orow(o, when) {
  return `<a class="orow" href="#offer-${o.id}"><span class="when">${when}</span><span class="t">${esc(o.t)}<small>${esc(o.plat.name)} · ${TYPES[o.ty].l} · ${valLabel(o).replace(/<[^>]+>/g, ' ')}</small></span>${stChip(o)}</a>`;
}
function kpi(label, value, unit, series, color = 'var(--s1)') {
  return `<div class="kpi"><span class="k-l">${label}</span><span class="k-v">${value}${unit ? `<small>${unit}</small>` : ''}</span><span style="color:${color}">${spark(series)}</span></div>`;
}
/** 最近 14 天每天的真实数量。 */
function daily(fn) { return Array.from({ length: 14 }, (_, i) => view(OFFERS.filter(o => fn(o, i - 13))).length); }
function seriesTo(end, n = 14, seed = 1, spread = 0.35) {
  const r = rng(seed); const out = []; let v = end;
  for (let i = 0; i < n; i++) { out.unshift(Math.max(0, Math.round(v))); v = v * (1 - spread * (r() - 0.35) * 0.4); }
  out[n - 1] = end; return out;
}

/** Deadline reminders are separate from current-claimability/valuation totals. */
function countdownWindow(o) {
  if (!isLimited(o) || o.withdrawnAt) return null;
  const derivation = o.evidence?.claimEndDerivation;
  if (derivation?.kind === 'relative_duration') {
    if (derivation.latestEndAt) return { end: new Date(derivation.latestEndAt), earliest: derivation.precision === 'date' ? new Date(derivation.earliestEndAt) : null, estimated: true };
    if (derivation.estimatedEndAt) return { end: new Date(derivation.estimatedEndAt), estimated: true };
    const [y,m,d] = derivation.anchorValue.slice(0,10).split('-').map(Number);
    return { earliest: zonedToDate(y,m-1,d+(derivation.durationDays || 7),0,0,o.tz || 'UTC'), end: zonedToDate(y,m-1,d+(derivation.durationDays || 7)+1,0,0,o.tz || 'UTC'), estimated: true };
  }
  const globalWeek = o.ty === 'free' && /(?:免费|限免).{0,4}(?:一周|7\s*天)|free.{0,20}(?:a|one|1)\s*week/i.test(o.t)
    && !/(?:领取|激活|注册|兑换)后.{0,8}(?:一周|7\s*天)/.test(o.v || '');
  const source = Object.values(o.evidence?.excerpts || {}).join(' ');
  const relativeOnly = globalWeek && /(?:for|next)\s+(?:a|one|1)\s+week|免费.{0,4}一周|一周.{0,4}免费|7\s*days?/i.test(source)
    && !/(?:until|through|ends?\s+on|截止|截至).{0,24}(?:\d{4}-\d{2}-\d{2}|\d{1,2}[月/]\d{1,2}|[A-Za-z]+\s+\d{1,2})/i.test(source);
  if (o.ek === 'date' && !relativeOnly) return { end: endInstant(o), estimated: false };
  // A global one-week free campaign is not a personal credit-validity period.
  if (!globalWeek) return null;
  const published = o.publishedAt;
  const exactAnchor = published && /T\d{2}:\d{2}/.test(published) ? new Date(published) : null;
  const date = published && /^\d{4}-\d{2}-\d{2}$/.test(published) ? published : o.s != null ? ymd(dayAt(o.s)) : null;
  if (!exactAnchor && !date) return null;
  if (exactAnchor && Number.isFinite(exactAnchor.getTime())) return { end: new Date(exactAnchor.getTime() + 7 * DAY), estimated: true };
  const [y,m,d] = date.split('-').map(Number);
  // Date-only announcements give a full-day uncertainty window, never a fictitious exact midnight deadline.
  const earliest = zonedToDate(y,m-1,d+7,0,0,o.tz || 'UTC');
  const end = zonedToDate(y,m-1,d+8,0,0,o.tz || 'UTC');
  return { end, earliest, estimated: true };
}
function countdownCandidates(offers, now = NOW) {
  return offers.map(o => ({ o, window: countdownWindow(o) })).filter(({o,window}) => window
    && statusOf(o) !== 'ended' && statusOf(o) !== 'upcoming'
    && window.end > now && window.end - now <= 7 * DAY).sort((a,b) => a.window.end - b.window.end);
}
function estimatedCountdown(window, now = NOW) {
  const hi = Math.max(0, Math.ceil((window.end - now) / DAY));
  const lo = window.earliest ? Math.max(0, Math.ceil((window.earliest - now) / DAY)) : hi;
  return lo === hi ? `约 ${hi} 天` : `约 ${lo}–${hi} 天`;
}

/* ---------- 今天 ---------- */
function pToday() {
  const act = view(OFFERS.filter(activeLimited));
  const stand = view(OFFERS.filter(o => statusOf(o) === 'standing'));
  const upcoming = view(OFFERS.filter(o => isLimited(o) && statusOf(o) === 'upcoming')).sort((a, b) => a.s - b.s);
  const ending = act.filter(o => statusOf(o) === 'ending');
  const wx = weatherNow();
  const todayValues = [...act, ...stand];
  const soon = countdownCandidates(view(OFFERS));
  // The landing page says plainly what the site collects; 羊毛 alone is a metaphor newcomers have to decode.
  main().innerHTML = ribbon() + ph('AI 羊毛牧场', taglineHtml()) + `
  <div class="hero">
    <div class="hero-over">
      <div class="total"><span class="l">${C.only ? '按你的条件，' : ''}当前可领 · 月度参考价值</span>${summaryHtml(todayValues)}</div>
      <div class="wx" title="指数参考新增条数、即将结束条数与官方口径月度参考价值；用量估算和未知价值不作零处理"><div>${wxIcon(wx.i)}</div><div><div class="row" style="gap:6px;align-items:baseline"><span class="i">${wx.i}</span><span class="t">今日羊毛指数 · ${wx.t}</span></div><div class="t">${wx.adv}</div><div class="t">条数与官方参考值</div></div></div>
    </div>
    <div id="flock"></div>
    <div class="flock-value-note"><span>羊的大小按月度购买参考成本比较。</span><a href="#valuation-method">参考价值怎么算？</a></div>
    <div class="flock-legend"><span><b>羊越大</b>，月度参考价值越高</span><span><b>价值待定</b>的羊用固定大小，并标 ?</span><span><b>毛越厚</b>，剩余时间越多</span><span><b>剃秃的</b>今明两天结束</span><span class="legend">${Object.keys(TYPES).filter(isTypeLimited).map(t => `<span>${etagSvg(typeVar(t)).replace('<svg ', '<svg style="width:12px;height:14px" ')}${TYPES[t].l}</span>`).join('')}</span></div>
  </div>
  <section class="kpis">
    ${kpi('进行中', act.length, '条', daily((o, k) => activeOn(o, k) && statusOf(o, k) !== 'upcoming'))}
    ${kpi('本周新增', wx.fresh, '条', daily((o, k) => o.since <= k && o.since > k - 7))}
    ${kpi('3 天内结束', ending.length, '条', daily((o, k) => activeOn(o, k) && o.ek === 'date' && o.e - k <= 3), 'var(--serious)')}
    ${kpi('常驻额度', stand.length, '项', daily((o, k) => o.ty === 'standing' && o.since <= k), 'var(--s6)')}
  </section>
  <section>${secH('倒计时', '未来 7 天内结束；“约”为按公告周期估算')}
    <div class="clocks">${soon.map(({o,window}) => {
      const end = window.end, total = Math.max(DAY, end - startInstant(o)), frac = clamp((end - NOW) / total, 0, 1);
      const col = end - NOW <= DAY ? 'var(--critical)' : end - NOW <= 3 * DAY ? 'var(--serious)' : 'var(--good)';
      const timer = window.estimated ? `<div class="cd" data-estimated-end="${end.getTime()}"${window.earliest ? ` data-estimated-start="${window.earliest.getTime()}"` : ''}>${estimatedCountdown(window)}</div>` : `<div class="cd" data-end="${end.getTime()}">${cdText(end - NOW)}</div>`;
      // The section hint explains “约”; the full note stays available on hover instead of on every card.
      return `<a class="clock" href="#offer-${o.id}"${window.estimated ? ' title="截止为估算：官方未公布精确时刻"' : ''}>${ringSvg(frac, 54, col)}<div style="min-width:0">${timer}<div class="ttl">${esc(o.t)}</div></div></a>`;
    }).join('') || emptySheep('没有即将结束的活动。')}</div>
  </section>
  <section class="grid g2">
    <div class="card"><h3>进行中的类型分布</h3><p class="sub">点一块，查看这一类的全部羊毛</p><div class="chart" id="cType" style="height:270px"></div></div>
    <div class="card"><h3>按模态分</h3><p class="sub">一条羊毛可能同时覆盖多个模态</p><div class="chart" id="cModal" style="height:270px"></div></div>
  </section>
  <section>${secH('即将开始', '官方已公布、还没开始的活动')}
    <div class="rows">${upcoming.map(o => orow(o, `${md(dayAt(o.s))}开始`)).join('') || emptySheep('暂时没有已公布的新活动。')}</div>
  </section>
  <section>${secH('进行中的羊毛', '按薅度分排序')}${ocards(act.slice().sort((a, b) => score(b) - score(a)), 12)}</section>`;

  buildFlock($('#flock'), act, wx);
  const types = Object.keys(TYPES).filter(isTypeLimited).map(t => ({ t, n: act.filter(o => o.ty === t).length })).filter(x => x.n);
  const cT = chart('#cType', {
    tooltip: { trigger: 'item', formatter: p => `${p.marker}${p.name}<br><b>${p.value}</b> 条 · ${p.percent}%` },
    legend: Object.assign(legendCommon(), { bottom: 0 }),
    series: [{ type: 'pie', radius: ['50%', '72%'], center: ['50%', '43%'], itemStyle: { borderRadius: 5, borderColor: TK.surface, borderWidth: 2 }, label: { show: false }, data: types.map(x => ({ name: TYPES[x.t].l, value: x.n, ty: x.t, itemStyle: { color: typeColor(x.t) } })) }],
    graphic: [
      { type: 'text', left: 'center', top: '33%', style: { text: String(act.length), fill: TK.ink, font: `700 30px ${FONT}`, textAlign: 'center' } },
      { type: 'text', left: 'center', top: '47%', style: { text: '条进行中', fill: TK.muted, font: `12px ${FONT}`, textAlign: 'center' } },
    ],
  });
  cT && cT.on('click', p => { ALLF = Object.assign(defaultAllF(), { ty: p.data.ty }); location.hash = 'all'; });
  const mods = Object.keys(MODAL).map(m => ({ m, n: act.filter(o => o.m.includes(m)).length }));
  const cM = chart('#cModal', {
    grid: { left: 8, right: 36, top: 8, bottom: 8, containLabel: true },
    tooltip: { trigger: 'item', formatter: p => `${p.name}<br><b>${p.value}</b> 条` },
    xAxis: Object.assign(axisCommon(), { type: 'value', minInterval: 1, splitLine: { lineStyle: { color: TK.line } } }),
    yAxis: Object.assign(axisCommon(), { type: 'category', inverse: true, data: mods.map(x => MODAL[x.m]), axisLabel: { color: TK.ink2, fontSize: 12.5 } }),
    series: [{ type: 'bar', barWidth: 14, data: mods.map(x => ({ value: x.n, m: x.m })), itemStyle: { color: TK.s[0], borderRadius: [0, 4, 4, 0] }, label: { show: true, position: 'right', color: TK.ink2, fontFamily: FONT } }],
  });
  cM && cM.on('click', p => { ALLF = Object.assign(defaultAllF(), { m: p.data.m }); location.hash = 'all'; });
}
function isTypeLimited(t) { return t !== 'standing' && t !== 'apply'; }

/* ---------- 日历 ---------- */
const CAL = { metric: 'count', sel: ymd(T0) };
function dayStats(k) {
  const list = view(OFFERS.filter(o => activeOn(o, k)));
  return {
    list, n: list.length, values: valueSummary(list),
    starts: view(OFFERS.filter(o => isLimited(o) && o.s === k)), ends: view(OFFERS.filter(o => isLimited(o) && o.ek === 'date' && o.e === k)),
    hol: HOLIDAYS.find(h => h.d === ymd(dayAt(k))),
  };
}
function pCalendar() {
  const months = [-1, 0, 1, 2].map(i => new Date(T0.getFullYear(), T0.getMonth() + i, 1));
  const hols = HOLIDAYS.filter(h => { const k = dayIdx(new Date(h.d + 'T00:00:00')); return k >= -10 && k <= 150; });
  main().innerHTML = ribbon() + ph('日历', '点任意一天，看那天能薅什么。草色越深，那天的羊毛越多。',
    `<div class="row"><div class="seg" role="group" aria-label="颜色表示"><button type="button" data-metric="count" aria-pressed="${CAL.metric === 'count'}">当天条数</button>${VALUE_GROUPS.map(([key, label]) => `<button type="button" data-metric="${key}" aria-pressed="${CAL.metric === key}">${label} · 月度</button>`).join('')}</div><label class="field" style="flex-direction:row;align-items:center;gap:8px"><span>跳到</span><input type="date" id="pickDate" value="${CAL.sel}"></label></div>`) + `
  <p class="small muted">金额统一按一个月比较，不按日重复累计。价值待定保留条数和活动；? 表示有活动但当前口径没有金额。</p>
  <div class="row small muted" style="margin:-4px 0 12px;gap:14px"><span class="row" style="gap:6px">少 <span class="ramp">${[0, 2, 4, 6, 7].map(i => `<i style="background:var(--q${i})"></i>`).join('')}</span> 多</span><span class="row" style="gap:6px"><i class="sw" style="background:var(--s1);border-radius:50%"></i>当天开始</span><span class="row" style="gap:6px"><i class="sw" style="background:var(--muted);border-radius:50%"></i>当天结束</span><span class="row" style="gap:6px"><i class="sw" style="background:var(--tag)"></i>节日 / 购物节</span></div>
  <div class="months">${months.map((m, i) => `<div class="card month"><h3>${m.getFullYear()}年${m.getMonth() + 1}月</h3><div class="chart" id="cal${i}" style="height:262px"></div></div>`).join('')}</div>
  <section id="dayList"></section>
  <section>${secH('节日提醒', '往年这些节点常有厂商发羊毛')}<div class="hols">${hols.map(h => { const dd = new Date(h.d + 'T00:00:00'); const k = dayIdx(dd); return `<div class="hol"><b>${h.n} · ${md(dd)}</b><span class="muted">${k < 0 ? `${-k} 天前` : k === 0 ? '就是今天' : `还有 ${k} 天`}</span><span>${h.past ? `往年发过：${h.past}` : '往年记录积累中'}</span></div>`; }).join('')}</div></section>`;
  drawMonths(months);
  renderDayList();
  $$('[data-metric]').forEach(b => b.addEventListener('click', () => { CAL.metric = b.dataset.metric; render(true); }));
  $('#pickDate').addEventListener('change', e => { if (e.target.value) { CAL.sel = e.target.value; drawMonths(months); renderDayList(); } });
}
function drawMonths(months) {
  $$('.month .chart').forEach(el => { const c = echarts.getInstanceByDom(el); if (c) { CHARTS.delete(c); c.dispose(); } });
  const all = [];
  months.forEach(m => { const days = new Date(m.getFullYear(), m.getMonth() + 1, 0).getDate(); for (let d = 1; d <= days; d++) all.push(dayStats(dayIdx(new Date(m.getFullYear(), m.getMonth(), d)))); });
  const metric = s => CAL.metric === 'count' ? s.n : s.list.some(o => valueGroup(o) === CAL.metric && valueNumber(o) != null) ? s.values[CAL.metric] : null;
  const mx = Math.max(1, ...all.map(s => metric(s) ?? 0));
  months.forEach((m, i) => {
    const days = new Date(m.getFullYear(), m.getMonth() + 1, 0).getDate();
    const cells = [];
    for (let d = 1; d <= days; d++) {
      const dt = new Date(m.getFullYear(), m.getMonth(), d), k = dayIdx(dt), s = dayStats(k), val = metric(s);
      const fill = val == null || val === 0 ? TK.surface2 : TK.q[clamp(Math.round(Math.sqrt(val / mx) * 7), 0, 7)];
      cells.push({ date: ymd(dt), d, k, s, val, fill });
    }
    const c = chart('#cal' + i, {
      tooltip: {
        trigger: 'item', formatter: p => {
          const x = cells[p.dataIndex]; const dt = new Date(x.date + 'T00:00:00');
          return `<b>${md(dt)} 周${WD[dt.getDay()]}</b><br>有效 ${x.s.n} 条<br>月度参考价值 · ${summaryText(x.s.values)}${x.s.hol ? `<br>节日：${x.s.hol.n}` : ''}${x.s.starts.length ? `<br>开始：${x.s.starts.map(o => esc(o.t)).join('、')}` : ''}${x.s.ends.length ? `<br>结束：${x.s.ends.map(o => esc(o.t)).join('、')}` : ''}`;
        },
      },
      calendar: { orient: 'vertical', range: `${m.getFullYear()}-${pad(m.getMonth() + 1)}`, cellSize: ['auto', 36], left: 6, right: 6, top: 24, bottom: 4, splitLine: { show: false }, itemStyle: { color: 'transparent', borderWidth: 0 }, dayLabel: { firstDay: 1, nameMap: ['日', '一', '二', '三', '四', '五', '六'], color: TK.muted, fontSize: 11, margin: 6 }, monthLabel: { show: false }, yearLabel: { show: false } },
      series: [{
        type: 'custom', coordinateSystem: 'calendar', data: cells.map(x => [x.date, x.val]),
        renderItem: (params, api) => {
          const x = cells[params.dataIndex], pt = api.coord(api.value(0));
          const w = params.coordSys.cellWidth - 4, h = params.coordSys.cellHeight - 4;
          const isToday = x.k === 0, isSel = x.date === CAL.sel;
          const kids = [
            { type: 'rect', shape: { x: pt[0] - w / 2, y: pt[1] - h / 2, width: w, height: h, r: 7 }, style: { fill: x.fill, stroke: isSel ? TK.ink : isToday ? TK.tag : null, lineWidth: isSel || isToday ? 2 : 0 } },
            { type: 'text', style: { text: `${x.d}${x.val == null && x.s.n ? '?' : ''}`, x: pt[0], y: pt[1], align: 'center', verticalAlign: 'middle', fill: x.val == null || x.val === 0 ? TK.muted : onColor(x.fill), font: `${isToday ? 700 : 500} 12px ${FONT}` } },
          ];
          if (x.s.hol) kids.push({ type: 'polygon', shape: { points: [[pt[0] - w / 2 + 2, pt[1] - h / 2 + 2], [pt[0] - w / 2 + 11, pt[1] - h / 2 + 2], [pt[0] - w / 2 + 2, pt[1] - h / 2 + 11]] }, style: { fill: TK.tag } });
          if (x.s.starts.length) kids.push({ type: 'circle', shape: { cx: pt[0] + w / 2 - 6, cy: pt[1] - h / 2 + 6, r: 3 }, style: { fill: TK.s[0], stroke: TK.surface, lineWidth: 1 } });
          if (x.s.ends.length) kids.push({ type: 'circle', shape: { cx: pt[0] + w / 2 - 6, cy: pt[1] + h / 2 - 6, r: 3 }, style: { fill: TK.muted, stroke: TK.surface, lineWidth: 1 } });
          return { type: 'group', children: kids };
        },
      }],
    });
    c && c.on('click', p => { CAL.sel = cells[p.dataIndex].date; $('#pickDate').value = CAL.sel; drawMonths(months); renderDayList(); });
  });
}
function renderDayList() {
  const dt = new Date(CAL.sel + 'T00:00:00'), k = dayIdx(dt), s = dayStats(k);
  const standN = view(OFFERS.filter(o => o.ty === 'standing' && Date.parse(o.discoveredAt) < dayAt(k + 1).getTime() && statusOf(o, k) === 'standing')).length;
  const when = k === 0 ? '今天' : k < 0 ? `${-k} 天前` : `${k} 天后`;
  $('#dayList').innerHTML = secH(`${md(dt)} 周${WD[dt.getDay()]} · ${when}`, `当天有效 ${s.n} 条限时羊毛；另有 ${standN} 项常驻额度`) + summaryHtml(s.list) +
    (s.hol ? `<p class="small"><span class="sample">${s.hol.n}</span> ${s.hol.past ? `往年这个时候发过羊毛的平台：${s.hol.past}` : '节日前后常有厂商发羊毛，留意推送'}</p>` : '') +
    (k < 0 ? '<p class="small muted">这是过去的日期，列出的是那天有效的羊毛。</p>' : k > 0 ? '<p class="small muted">这是未来的日期，只包含官方已公布的活动；"截止未知"的活动到那天不一定还在。</p>' : '') +
    `<div class="rows">${s.list.sort((a, b) => score(b) - score(a)).map(o => orow(o, o.ek === 'date' ? `至${md(dayAt(o.e))}` : '截止未知')).join('') || emptySheep('这一天没有限时羊毛。')}</div>`;
}

/* ---------- 时间线（甘特图） ---------- */
function pTimeline() {
  // 默认显示前 30 天到后 45 天；数据包含全部历史活动，拖动下方滑块可以往前看
  const viewLo = -30, hi = 45;
  const all = view(OFFERS.filter(o => isLimited(o) && (o.s == null || o.s <= hi)));
  const lo = Math.max(-730, Math.min(viewLo, ...all.map(o => o.since)));
  const items = all;
  const rowsIds = uniq(items.slice().sort((a, b) => (a.ek === 'date' ? a.e : 999) - (b.ek === 'date' ? b.e : 999)).map(o => o.p));
  const rows = rowsIds.map(id => PMAP[id].name);
  const h = rows.length * 34 + 90;
  main().innerHTML = ribbon() + ph('时间线', '每个平台一行，横条是活动的起止时间。竖线是今天，描边的是 3 天内结束的活动。往前拖动可以看历史活动。') +
    `<div class="legend" style="margin-bottom:10px">${Object.keys(TYPES).filter(isTypeLimited).map(t => `<span><i class="sw" style="background:${typeVar(t)}"></i>${TYPES[t].l}</span>`).join('')}<span><i class="sw" style="background:linear-gradient(90deg,var(--muted),transparent)"></i>截止未知</span></div>
    <div class="card" style="padding:10px 6px"><div class="chart" id="cGantt" style="height:${h}px"></div></div>
    <p class="small muted">可以拖动下方滑块或用触控板缩放时间范围。点横条看详情。</p>`;
  const data = items.map(o => {
    const s = Math.max(lo, o.since), e = o.ek === 'date' ? o.e + 1 : o.withdrawnAt ? dayIdx(new Date(o.withdrawnAt)) + 1 : hi;
    return { value: [rowsIds.indexOf(o.p), dayAt(s).getTime(), dayAt(e).getTime()], o };
  });
  const c = chart('#cGantt', {
    grid: { left: 8, right: 16, top: 26, bottom: 46, containLabel: true },
    tooltip: { trigger: 'item', formatter: p => { const o = p.data.o; return `<b>${esc(o.t)}</b>${esc(o.plat.name)} · ${TYPES[o.ty].l}<br>${valLabel(o)}<br>${o.s != null ? md(dayAt(o.s)) : `${md(dayAt(o.since))}起（官方未写开始日）`} → ${o.ek === 'date' ? md(dayAt(o.e)) : '截止未知'}<br>${leftText(o)}`; } },
    xAxis: Object.assign(axisCommon(), { type: 'time', min: dayAt(lo).getTime(), max: dayAt(hi).getTime(), position: 'top', axisLabel: { color: TK.muted, fontSize: 11, formatter: v => { const d = new Date(v); return `${d.getMonth() + 1}/${d.getDate()}`; } }, splitLine: { show: true, lineStyle: { color: TK.line } } }),
    yAxis: Object.assign(axisCommon(), { type: 'category', data: rows, inverse: true, axisLabel: { color: TK.ink2, fontSize: 12 }, splitLine: { show: false } }),
    dataZoom: [{ type: 'inside', xAxisIndex: 0, filterMode: 'weakFilter', startValue: dayAt(viewLo).getTime(), endValue: dayAt(hi).getTime() }, { type: 'slider', xAxisIndex: 0, height: 18, bottom: 10, filterMode: 'weakFilter', startValue: dayAt(viewLo).getTime(), endValue: dayAt(hi).getTime(), borderColor: TK.line, fillerColor: TK.tagSoft, handleStyle: { color: TK.surface, borderColor: TK.line2 }, textStyle: { color: TK.muted }, dataBackground: { lineStyle: { color: TK.line2 }, areaStyle: { color: TK.surface2 } } }],
    series: [{
      type: 'custom', encode: { x: [1, 2], y: 0 }, data,
      renderItem: (params, api) => {
        const o = data[params.dataIndex].o, cat = api.value(0), a = api.coord([api.value(1), cat]), b = api.coord([api.value(2), cat]);
        const bh = api.size([0, 1])[1] * 0.56, cs = params.coordSys;
        const rect = echarts.graphic.clipRectByRect({ x: a[0], y: a[1] - bh / 2, width: Math.max(3, b[0] - a[0] - 2), height: bh }, { x: cs.x, y: cs.y, width: cs.width, height: cs.height });
        if (!rect) return null;
        const col = typeColor(o.ty), st = statusOf(o);
        const fill = o.ek === 'unknown' ? new echarts.graphic.LinearGradient(0, 0, 1, 0, [{ offset: 0, color: col }, { offset: 1, color: hexA(col, 0.06) }]) : col;
        const kids = [{ type: 'rect', shape: Object.assign({ r: 4 }, rect), style: { fill, opacity: st === 'ended' ? 0.35 : st === 'upcoming' ? 0.55 : 1, stroke: st === 'ending' ? (o.e === 0 ? TK.critical : TK.serious) : null, lineWidth: st === 'ending' ? 2 : 0 } }];
        if (rect.width > 70) {
          const maxCh = Math.floor((rect.width - 12) / 12.5);
          const txt = o.t.length > maxCh ? o.t.slice(0, Math.max(1, maxCh - 1)) + '…' : o.t;
          kids.push({ type: 'text', style: { text: txt, x: rect.x + 6, y: rect.y + rect.height / 2, verticalAlign: 'middle', fill: o.ek === 'unknown' || st === 'ended' ? TK.ink : onColor(col), font: `500 11.5px ${FONT}` } });
        }
        return { type: 'group', children: kids };
      },
      markLine: { symbol: 'none', silent: true, data: [{ xAxis: NOW.getTime() }], lineStyle: { color: TK.ink, width: 1.5, type: 'solid' }, label: { formatter: '今天', color: TK.ink, fontFamily: FONT, fontSize: 11, position: 'start' } },
    }],
  });
  c && c.on('click', p => { if (p.data && p.data.o) location.hash = 'offer-' + p.data.o.id; });
}

/* ---------- 全部 ---------- */
const defaultAllF = () => ({ ty: '', m: '', c: '', p: '', st: 'claimable', req: '', value: '', sort: 'score' });
let ALLF = defaultAllF();
function filtered() {
  let list = view(OFFERS.slice());
  const f = ALLF;
  if (f.ty) list = list.filter(o => o.ty === f.ty);
  if (f.m) list = list.filter(o => o.m.includes(f.m));
  if (f.c) list = list.filter(o => o.c === f.c);
  if (f.p) list = list.filter(o => f.p.startsWith('co:') ? o.plat?.company === f.p.slice(3) : o.p === f.p);
  if (f.value === 'official') list = list.filter(o => valueGroup(o) === 'official' && hasDisplayValue(o));
  if (f.value === 'scenario') list = list.filter(o => valueGroup(o) === 'scenario' && hasDisplayValue(o));
  if (f.value === 'unknown') list = list.filter(o => !hasDisplayValue(o));
  if (f.st === 'claimable') list = list.filter(claimable);
  else if (f.st) list = list.filter(o => statusOf(o) === f.st);
  const has = (o, ks) => o.r.some(r => ks.includes(r.split(':')[0]));
  if (f.req === 'zero') list = list.filter(o => o.r.length > 0 && o.r.every(r => r === 'none'));
  if (f.req === 'nooversea') list = list.filter(o => !has(o, ['phone', 'card', 'net']));
  if (f.req === 'nopay') list = list.filter(o => !has(o, ['pay', 'member']));
  if (f.req === 'special') list = list.filter(o => has(o, ['student', 'biz', 'invite', 'targeted']));
  const endKey = o => o.ek === 'date' ? o.e : isLimited(o) ? 500 : 900;
  const sorters = { score: (a, b) => score(b) - score(a), new: (a, b) => b.fs - a.fs, end: (a, b) => endKey(a) - endKey(b), value: valueSort };
  return list.sort(sorters[f.sort]);
}
function pAll() {
  const sel = (id, label, opts) => `<label class="field" for="${id}">${label}<select id="${id}" data-f="${id.slice(2)}">${opts.map(([v, l]) => `<option value="${v}" ${ALLF[id.slice(2)] === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>`;
  main().innerHTML = ribbon() + ph('全部羊毛', '筛选、排序，或者勾几条放在一起对比。') + `
  <div class="filters">
    ${sel('f-ty', '类型', [['', '全部类型'], ...Object.entries(TYPES).map(([k, v]) => [k, v.l])])}
    ${sel('f-m', '模态', [['', '全部模态'], ...Object.entries(MODAL)])}
    ${sel('f-req', '门槛', [['', '不限'], ['zero', '零门槛'], ['nooversea', '不需要海外条件'], ['nopay', '不用花钱'], ['special', '学生 / 企业 / 邀请 / 定向']])}
    ${sel('f-c', '领取方式', [['', '全部方式'], ...Object.entries(CLAIM)])}
    <label class="field" for="f-p">平台<select id="f-p" data-f="p">${platformOptionsHtml(ALLF.p)}</select></label>
    ${sel('f-st', '状态', [['claimable', '现在或即将可领'], ['', '全部状态'], ['active', '进行中'], ['ending', '即将结束'], ['upcoming', '未开始'], ['standing', '常驻'], ['ended', '已结束']])}
    ${sel('f-value', '估值方法', [['', '全部方法'], ['official', '仅看官方价值'], ['scenario', '用量估算'], ['unknown', '价值待定']])}
  </div>
  <div class="row small muted" data-results-bar style="justify-content:space-between;margin-bottom:10px"><span id="allCount"></span><span class="row" style="gap:8px"><label class="row" for="f-sort" style="gap:6px">排序<select id="f-sort" data-f="sort" style="width:auto">${[['score', '薅度分高'], ['new', '新上架'], ['end', '快截止'], ['value', '月度参考价值高']].map(([v, l]) => `<option value="${v}" ${ALLF.sort === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label><button class="btn sm" type="button" id="resetF">清空筛选</button></span></div>
  <div id="allList"></div>`;
  const draw = () => { const l = filtered(); $('#allCount').textContent = `共 ${l.length} 条${C.only ? '（已按你的条件过滤）' : ''}`; $('#allList').innerHTML = ocards(l); };
  $$('[data-f]').forEach(s => s.addEventListener('change', () => { ALLF[s.dataset.f] = s.value; draw(); }));
  $('#resetF').addEventListener('click', () => { ALLF = defaultAllF(); render(true); });
  const platform = $('#f-p');
  let refreshing = false;
  const refresh = async () => {
    if (refreshing) return;
    refreshing = true;
    const previous = { OFFERS, PLATFORMS, META, COVERAGE };
    try {
      await loadData({ fresh: true });
      prepare();
      if (!platform.isConnected || route()[0] !== 'all') return;
      platform.innerHTML = platformOptionsHtml(ALLF.p);
      draw();
    } catch (_) {
      ({ OFFERS, PLATFORMS, META, COVERAGE } = previous);
      prepare(); // Preserve the loaded list and filter controls during network failures.
    } finally { refreshing = false; }
  };
  platform.addEventListener('focus', refresh);
  draw();
  refresh();
}

/* ---------- 常驻额度库 ---------- */
function pLibrary() {
  const list = view(OFFERS.filter(o => o.ty === 'standing'));
  const available = list.filter(claimable);
  const totals = pid => valueSummary(available.filter(o => o.p === pid));
  const pids = uniq(available.map(o => o.p)).sort((a, b) => (totals(b).official + totals(b).scenario) - (totals(a).official + totals(a).scenario));
  const mods = Object.keys(MODAL);
  const fresh = list.slice().sort((a, b) => a.vf - b.vf);
  const rank = pids.filter(pid => totals(pid).priced > 0);
  main().innerHTML = ribbon() + ph('常驻额度库', '长期权益沿用已批准条款；如发放方明确撤回或条件变化，再由管理员修订。') + summaryHtml(available) + `
  <section class="grid g2" style="margin-top:0">
    ${VALUE_GROUPS.map(([group, label]) => `<div class="card"><h3>平台 × 模态 · ${label}</h3><p class="sub">月度参考价值；同一共享权益在各适用模态展示，格子之间不能相加。? 表示覆盖但此口径未计价。</p><div class="chart" id="cMatrix-${group}" style="height:${pids.length * 30 + 60}px"></div></div>`).join('')}
  </section>
  <section><div class="card"><h3>常驻额度月度价值排行</h3><p class="sub">按平台汇总当前可领权益，官方口径与用量估算分别列值；未知不进入美元排行。刷新周期见各活动。</p><div class="chart" id="cRank" style="height:${rank.length * 42 + 90}px"></div></div></section>
  <section>${secH('批准与证据记录', '最近一次核验时间仅作记录，不会使已批准权益自动失效')}
    <div class="card tbl" style="padding:4px 8px"><table><thead><tr><th>额度</th><th>平台</th><th>月度参考价值</th><th>最近核验</th><th>状态</th></tr></thead><tbody>
    ${fresh.map(o => { const status = statusOf(o) === 'standing' ? stBadge('good', '✓', '已批准') : stChip(o); return `<tr class="link" data-href="#offer-${o.id}"><td>${esc(o.t)}</td><td>${esc(o.plat.name)}</td><td class="n">${valLabel(o)}</td><td class="n">${ago(o.vf)}</td><td>${status}</td></tr>`; }).join('')}
    </tbody></table></div>
  </section>
  <section>${secH('全部常驻额度')}${ocards(list.slice().sort((a, b) => score(b) - score(a)))}</section>`;
  VALUE_GROUPS.forEach(([group, label]) => {
    const cells = [];
    pids.forEach((pid, y) => mods.forEach((m, x) => {
      const covered = available.filter(o => o.p === pid && o.m.includes(m)), summary = valueSummary(covered);
      cells.push({ x, y, v: summary[group + 'N'] ? summary[group] : null, covered: covered.length > 0, summary, pid, m });
    }));
    const mx = Math.max(1, ...cells.map(c => c.v ?? 0));
    const cm = chart('#cMatrix-' + group, {
      grid: { left: 8, right: 8, top: 26, bottom: 6, containLabel: true },
      tooltip: { trigger: 'item', formatter: p => { const c = cells[p.dataIndex]; return `<b>${esc(PMAP[c.pid].name)}</b> · ${MODAL[c.m]}<br>${!c.covered ? '不覆盖这个模态' : `${label} · 月度参考价值：${summaryAmount(c.summary, group)}<br>${coverageText(c.summary)}`}`; } },
      xAxis: Object.assign(axisCommon(), { type: 'category', position: 'top', data: mods.map(m => MODAL[m]), axisLine: { show: false }, axisLabel: { color: TK.ink2, fontSize: 12 } }),
      yAxis: Object.assign(axisCommon(), { type: 'category', inverse: true, data: pids.map(pid => PMAP[pid].name), axisLine: { show: false }, axisLabel: { color: TK.ink2, fontSize: 12 } }),
      series: [{ type: 'custom', data: cells.map(c => [c.x, c.y, c.v]), renderItem: (params, api) => {
        const c = cells[params.dataIndex], pt = api.coord([api.value(0), api.value(1)]), sz = api.size([1, 1]), w = sz[0] - 4, h = sz[1] - 4;
        const fill = c.v != null ? TK.q[clamp(Math.round(Math.sqrt(c.v / mx) * 7), 1, 7)] : TK.surface2;
        const kids = [{ type: 'rect', shape: { x: pt[0] - w / 2, y: pt[1] - h / 2, width: w, height: h, r: 5 }, style: { fill, stroke: c.covered && c.v == null ? TK.muted : null, lineDash: [3, 3] } }];
        if (c.covered && w > 34) kids.push({ type: 'text', style: { text: c.v == null ? '?' : `${group === 'scenario' ? '≈' : ''}${money(c.v)}`, x: pt[0], y: pt[1], align: 'center', verticalAlign: 'middle', fill: c.v == null ? TK.muted : onColor(fill), font: `500 11px ${FONT}` } });
        return { type: 'group', children: kids };
      } }],
    });
    cm && cm.on('click', p => { location.hash = 'platform-' + cells[p.dataIndex].pid; });
  });
  const cr = chart('#cRank', {
    grid: { left: 8, right: 70, top: 34, bottom: 6, containLabel: true },
    legend: Object.assign(legendCommon(), { top: 0 }),
    tooltip: { trigger: 'item', formatter: p => `${esc(p.name)}<br>${p.seriesName} · 月度参考价值：<b>${money(p.value)}</b><br>${coverageText(totals(p.data.pid))}` },
    xAxis: Object.assign(axisCommon(), { type: 'value', axisLabel: { color: TK.muted, formatter: v => money(v) } }),
    yAxis: Object.assign(axisCommon(), { type: 'category', inverse: true, data: rank.map(pid => PMAP[pid].name), axisLabel: { color: TK.ink2, fontSize: 12 } }),
    series: VALUE_GROUPS.map(([group, name, col]) => ({ name, type: 'bar', barWidth: 10, data: rank.map(pid => ({ value: totals(pid)[group + 'N'] ? totals(pid)[group] : null, pid })), itemStyle: { color: TK.s[col], borderRadius: [0, 4, 4, 0] }, label: { show: true, position: 'right', color: TK.ink2, formatter: p => p.value == null ? '' : `${group === 'scenario' ? '≈' : ''}${money(p.value)}`, fontFamily: FONT } })),
  });
  cr && cr.on('click', p => { location.hash = 'platform-' + p.data.pid; });
}

/* ---------- 申请制 ---------- */
const APPLY_VIEW = { period: 'first30' };
function pApply() {
  const first30 = APPLY_VIEW.period === 'first30';
  const amount = first30 ? applyMonthlyReference : applyMaximum;
  const label = first30 ? '月度参考价值' : '完整申请权益上限';
  const list = view(OFFERS.filter(o => o.ty === 'apply')).sort((a, b) => (amount(b) ?? -1) - (amount(a) ?? -1));
  const known = list.filter(o => amount(o) != null), priced = known.filter(o => amount(o) > 0);
  main().innerHTML = ribbon() + ph('申请制', '需要提交材料、等待审核的资助。最高可申请不代表保证获批；申请制独立展示，不计入普通权益的月度汇总。') + `
  <div class="card"><div class="seg" role="group" aria-label="申请价值比较周期">${[['first30', '月度参考价值'], ['full', '完整申请权益上限']].map(([key, text]) => `<button type="button" data-apply-period="${key}" aria-pressed="${APPLY_VIEW.period === key}">${text}</button>`).join('')}</div><h3 style="margin-top:12px">${label}</h3><p class="sub">${first30 ? '月度参考上限只使用已核实的释放安排，未知时保留卡片。月度使用方案参考单列为参考价格与固定用量的购买成本，不代表申请额度或保证获批。' : '完整上限覆盖整个资助或会员计划，各计划期限不同，金额不能理解为相同时间内可获得的权益；期限见卡片与详情。使用方案参考不进入完整申请上限图。'}对数刻度；已计价 ${known.length}/${list.length} 条，价值待定保留活动展示，零参考值不进入对数图。无保底时不生成下限。</p><div class="legend">${VALUE_GROUPS.map(([_, method, color]) => `<span><i class="sw" style="background:var(--s${color + 1})"></i>${method}</span>`).join('')}${first30 && priced.some(isApplyBenchmark) ? '<span><i class="sw" style="background:var(--s4)"></i>月度使用方案参考</span>' : ''}</div><div class="chart" id="cApply" style="height:${priced.length * 40 + 50}px"></div></div>
  <section>${ocards(list)}</section>`;
  const c = chart('#cApply', {
    grid: { left: 8, right: 64, top: 6, bottom: 6, containLabel: true },
    tooltip: { trigger: 'item', formatter: p => { const o = OMAP[p.data.id], benchmark = isApplyBenchmark(o); return `${esc(o.t)}<br>${benchmark ? '月度使用方案参考' : first30 ? '月度参考上限' : label}：${benchmark || valueGroup(o) === 'scenario' ? '≈ ' : ''}${money(amount(o))}<br>权益期限：${esc(o.val || '以官方计划为准')}<br>${valueTag(o)}<br>${benchmark ? '参考购买成本，不代表申请额度或保证获批；没有保证可得的下限' : `最高可申请不代表保证获批${valuationOf(o).usdEstimate == null ? '；没有保证可得的下限' : ''}`}`; } },
    xAxis: Object.assign(axisCommon(), { type: 'log', min: Math.min(1, ...priced.map(amount)), axisLabel: { color: TK.muted, formatter: v => money(v) } }),
    yAxis: Object.assign(axisCommon(), { type: 'category', inverse: true, data: priced.map(o => o.plat.name), axisLabel: { color: TK.ink2, fontSize: 12 } }),
    series: [{ name: `${first30 ? '月度参考上限' : label}（方法见图例）`, type: 'bar', barWidth: 14, data: priced.map(o => ({ value: isApplyBenchmark(o) ? null : amount(o), id: o.id, itemStyle: { color: valueGroup(o) === 'scenario' ? TK.s[3] : TK.s[0] } })), itemStyle: { borderRadius: [0, 4, 4, 0] }, label: { show: true, position: 'right', color: TK.ink2, formatter: p => p.value == null ? '' : `${valueGroup(OMAP[p.data.id]) === 'scenario' ? '≈' : ''}${money(p.value)}`, fontFamily: FONT } },
      ...(first30 ? [{ name: '月度使用方案参考', type: 'bar', barWidth: 14, data: priced.map(o => ({ value: isApplyBenchmark(o) ? amount(o) : null, id: o.id })), itemStyle: { color: TK.s[3], borderRadius: [0, 4, 4, 0] }, label: { show: true, position: 'right', color: TK.ink2, formatter: p => p.value == null ? '' : `≈${money(p.value)}`, fontFamily: FONT } }] : [])],
  });
  c && c.on('click', p => { location.hash = 'offer-' + p.data.id; });
  $$('[data-apply-period]').forEach(button => button.addEventListener('click', () => { APPLY_VIEW.period = button.dataset.applyPeriod; CHARTS.forEach(chart => chart.dispose()); CHARTS.clear(); pApply(); }));
}

/* ---------- 按模型找 ---------- */
const modelKey = YMModels.modelIdentityKey;
function modelIndex() {
  const idx = new Map();
  OFFERS.filter(o => statusOf(o) !== 'ended').forEach(o => YMModels.normalizeModelNames(o.models || []).forEach(name => {
    const k = modelKey(name); if (!k) return;
    if (!idx.has(k)) idx.set(k, { name, offers: [] });
    const e = idx.get(k); if (!e.offers.includes(o)) e.offers.push(o);
  }));
  return [...idx.values()].map(e => ({ ...e, plats: uniq(e.offers.map(o => o.p)).length }))
    .sort((a, b) => b.plats - a.plats || b.offers.length - a.offers.length || a.name.localeCompare(b.name));
}
let MODEL_Q = '';
function pModels() {
  const all = modelIndex();
  const q = MODEL_Q.trim().toLowerCase();
  const list = q ? all.filter(m => YMModels.modelMatches(m.name, q)) : all;
  const limited = o => o.ty !== 'standing' && o.ty !== 'apply';
  const row = o => `<a class="orow" href="#offer-${o.id}" style="grid-template-columns:auto minmax(0,1fr) auto"><span>${etag(o.ty)}</span><span class="t">${esc(o.plat.name)}<small>${esc(o.t)}</small></span>${stChip(o)}</a>`;
  main().innerHTML = ribbon() + ph('按模型找', '同一个模型，在哪些平台能免费用？限时免费会标出截止时间。') + `
    <div class="row" style="margin-bottom:12px;gap:10px;flex-wrap:wrap"><input type="search" id="modelQ" value="${esc(MODEL_Q)}" placeholder="搜模型，如 GLM、Gemini、DeepSeek" style="flex:1;min-width:200px;padding:8px 12px"><span class="small muted">${all.length} 个模型 · ${uniq(all.flatMap(m => m.offers.map(o => o.p))).length} 个平台</span></div>
    ${list.length ? `<div class="grid g2">${list.map(m => `<div class="card"><div class="row" style="justify-content:space-between;align-items:baseline;gap:8px"><h3 style="margin:0">${esc(m.name)}</h3><span class="small muted">${m.plats} 个平台${m.offers.some(limited) ? ' · 含限时' : ''}</span></div>
      <div class="rows" style="margin-top:8px">${m.offers.slice(0, 4).map(row).join('')}</div>${m.offers.length > 4 ? `<details><summary class="small muted" style="cursor:pointer;padding:8px 4px 0">还有 ${m.offers.length - 4} 个平台</summary><div class="rows">${m.offers.slice(4).map(row).join('')}</div></details>` : ''}</div>`).join('')}</div>`
      : `<div class="card">${emptySheep(all.length ? '没有找到这个模型。' : '还没有记录到具体的免费模型。')}</div>`}`;
  const inp = $('#modelQ');
  inp.addEventListener('input', () => { MODEL_Q = inp.value; const pos = inp.selectionStart; pModels(); const n = $('#modelQ'); n.focus(); n.setSelectionRange(pos, pos); });
}

/* ---------- 洞察 ---------- */
const RESETS = []; // Codex 重置记录：等我们自己的重置条目积累起来再展示
let RACE = { months: [], series: [] }, TREND = { labels: [], nw: [], ed: [], by: {} };
/** Historical offers count once using their own first-30-day reference values. */
function computeRace() {
  const months = [...Array(6)].map((_, i) => new Date(T0.getFullYear(), T0.getMonth() - 5 + i, 1));
  const pool = view(OFFERS.filter(o => o.ty !== 'apply' && valueNumber(o) != null && o.since <= 0));
  const total = pid => { const v = valueSummary(pool.filter(o => o.p === pid)); return v.official + v.scenario; };
  const ids = uniq(pool.map(o => o.p)).sort((a, b) => total(b) - total(a)).slice(0, 12);
  return {
    months: months.map(d => `${d.getFullYear()}年${d.getMonth() + 1}月`),
    series: ids.map(id => {
      const out = { id };
      VALUE_GROUPS.forEach(([group]) => {
        out[group] = months.map((_, i) => {
          const entries = pool.filter(o => o.p === id && valueGroup(o) === group && dayAt(Math.floor(o.since)) < (months[i + 1] || dayAt(1)));
          return entries.length ? sum(entries, valueNumber) : null;
        });
      });
      return out;
    }),
  };
}
/** 最近 12 周：每周新增（按活动出现的日子）与结束（按截止日），以及新增的类型构成。 */
function computeTrend() {
  const labels = [], nw = [], ed = [], by = {};
  Object.keys(TYPES).forEach(t => { by[t] = []; });
  const mon = dayAt(-((T0.getDay() + 6) % 7));
  for (let w = 11; w >= 0; w--) {
    const a = dayIdx(new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() - w * 7)), b = a + 7;
    labels.push(w === 0 ? '本周' : `${dayAt(a).getMonth() + 1}/${dayAt(a).getDate()}`);
    const fresh = view(OFFERS.filter(o => o.since >= a && o.since < b));
    nw.push(fresh.length); ed.push(view(OFFERS.filter(o => { const end = actualEnd(o); return end && end <= NOW && dayIdx(end) >= a && dayIdx(end) < b; })).length);
    Object.keys(TYPES).forEach(t => by[t].push(fresh.filter(o => o.ty === t).length));
  }
  return { labels, nw, ed, by };
}
function pInsights() {
  if (!OFFERS.length) { main().innerHTML = ribbon() + ph('洞察', '把整片牧场放在一起看：哪里该先薅、谁最大方、羊毛从哪来。') + emptySheep('第一批羊毛审核通过后，这里会出现图表。'); return; }
  const ended = view(OFFERS.filter(o => statusOf(o) === 'ended')).sort((a, b) => actualEnd(b) - actualEnd(a));
  main().innerHTML = ribbon() + ph('洞察', '把整片牧场放在一起看：哪里该先薅、谁最大方、羊毛从哪来、什么时候会重置。') + `
  <section style="margin-top:0"><div class="card"><h3>薅羊毛四象限</h3><p class="sub">横轴是门槛难度，纵轴是月度参考价值（对数刻度）；图例区分官方口径与用量估算。限时活动的气泡越大，剩余时间越多。申请制另列；价值待定及零参考值不进入对数图。</p><div class="chart" id="cQuad" style="height:400px"></div></div></section>
  <section><div class="card"><h3>羊毛从哪来、怎么到你手里</h3><p class="sub">平台类型 → 羊毛类型 → 领取方式 → 主要门槛</p><div class="hscroll"><div class="chart" id="cSankey" style="height:470px"></div></div></div></section>
  <section>${summaryHtml(view(OFFERS.filter(o => o.ty !== 'apply')))}</section>
  <section class="grid g2">
    <div class="card"><h3>谁最大方</h3><p class="sub">按官方口径与用量估算分区，面积 = 收录活动的月度参考价值，含已结束历史；申请制另列，未知不当零。</p><div class="chart" id="cTree" style="height:360px"></div><div class="legend">${VALUE_GROUPS.map(([_, label, color]) => `<span><i class="sw" style="background:var(--s${color + 1})"></i>${label}</span>`).join('')}</div></div>
    <div class="card"><div class="row" style="justify-content:space-between"><div><h3>大方榜</h3><p class="sub" style="margin:0">近 6 个月回放：按活动出现月份累加月度参考价值；两种方法分别列值，首帧包含更早历史。</p></div><button class="btn sm pri" type="button" id="racePlay">▶ 回放</button></div><div class="chart" id="cRace" style="height:340px"></div></div>
  </section>
  <section><div class="card" id="resetBox"><h3>重置时钟</h3><p class="sub">Codex、Claude Code 等额度重置的历史分布（按官方发布时间，换算成你的本地时间）。只展示历史，不预测下一次；次数图保留所有已收录重置，无法估值不当作零。</p>${resetBlock()}</div></section>
  <section class="grid g2">
    <div class="card"><h3>每周新增与结束</h3><p class="sub">最近 12 周</p><div class="chart" id="cTrend" style="height:280px"></div></div>
    <div class="card"><h3>新增羊毛的类型构成</h3><p class="sub">最近 12 周，按周堆叠</p><div class="chart" id="cStack" style="height:280px"></div></div>
  </section>
  <section>${secH('羊毛墓地', '已经结束的羊毛。点墓碑看它活了多久、平台过去的发放规律。')}
    <div class="graves">${ended.map(o => { const end = dayIdx(actualEnd(o)); const life = Math.max(1, end - o.since + 1); return `<a class="grave" href="#offer-${o.id}"><span class="rip">R.I.P.</span><b>${esc(o.t)}</b><span>${esc(o.plat.name)}</span><span>存活 <span class="age">${life}</span> 天</span><span class="muted">${md(dayAt(o.since))} – ${md(dayAt(end))}</span>${o.why ? `<span class="chip">${esc(o.why)}</span>` : ''}</a>`; }).join('')}</div>
  </section>`;

  drawResetClock();
  // 四象限
  const groups = VALUE_GROUPS.map(([group, name, col]) => [name, o => valueGroup(o) === group, col]);
  const live = view(OFFERS.filter(o => statusOf(o) !== 'ended' && valueNumber(o) != null && valueNumber(o) > 0));
  const vals = live.map(valueNumber).sort((a, b) => a - b), med = vals[Math.floor(vals.length / 2)] || 10;
  const quadMin = vals.length ? Math.pow(10, Math.floor(Math.log10(vals[0]))) : 0.1;
  const quadMax = vals.length ? Math.pow(10, Math.ceil(Math.log10(vals[vals.length - 1] * 1.1))) : 100;
  const cq = chart('#cQuad', {
    grid: { left: 10, right: 20, top: 40, bottom: 34, containLabel: true },
    legend: Object.assign(legendCommon(), { top: 4, left: 0 }),
    tooltip: { trigger: 'item', formatter: p => { const o = OMAP[p.data.id]; return `<b>${esc(o.t)}</b>${esc(o.plat.name)}<br>${valLabel(o).replace(/<[^>]+>/g, ' ')} · 门槛难度 ${p.data.value[0]}<br>${leftText(o)}`; } },
    xAxis: Object.assign(axisCommon(), { type: 'value', min: 0, max: 100, name: '门槛难度 →', nameLocation: 'end', nameGap: 8, nameTextStyle: { color: TK.muted, fontSize: 11, verticalAlign: 'top', padding: [14, 0, 0, 0] } }),
    yAxis: Object.assign(axisCommon(), { type: 'log', min: quadMin, max: quadMax, name: '月度参考价值 ↑', nameTextStyle: { color: TK.muted, fontSize: 11, align: 'left' }, axisLabel: { color: TK.muted, fontSize: 11, formatter: v => money(v) } }),
    series: groups.map(([name, fn, col], gi) => ({
      name, type: 'scatter',
      data: live.filter(fn).map(o => { const d = dims(o); const size = isLimited(o) ? (o.ek === 'date' ? 10 + clamp(o.e, 0, 30) * 0.8 : 22) : 14; return { id: o.id, value: [100 - d[1], valueNumber(o)], symbol: o.ty === 'standing' ? 'diamond' : 'circle', symbolSize: size }; }),
      itemStyle: { color: TK.s[col], opacity: 0.85, borderColor: TK.surface, borderWidth: 2 },
      emphasis: { scale: 1.2 },
      ...(gi === 0 ? {
        markArea: { silent: true, itemStyle: { color: TK.tagSoft, opacity: 0.7 }, label: { color: TK.ink, fontFamily: FONT, fontSize: 12, position: 'insideTopLeft', padding: [6, 8] }, data: [[{ name: '优先薅：价值高 · 门槛低', xAxis: 0, yAxis: med }, { xAxis: 50, yAxis: quadMax }]] },
        markLine: { silent: true, symbol: 'none', lineStyle: { color: TK.line2, type: 'solid' }, label: { show: false }, data: [{ xAxis: 50 }, { yAxis: med }] },
      } : {}),
    })),
  });
  cq && cq.on('click', p => { if (p.data && p.data.id) location.hash = 'offer-' + p.data.id; });

  // 桑基图
  const mainReq = o => { let best = 'none', pen = -1; o.r.forEach(r => { const k = r.split(':')[0]; const v = REQ_PEN[k] || 0; if (v > pen) { pen = v; best = k; } }); return REQ[best]; };
  const flow = view(OFFERS.filter(o => statusOf(o) !== 'ended'));
  const L = {};
  const add = (a, b, col) => { const key = a + '\u0000' + b; L[key] = L[key] || { source: a, target: b, value: 0, col }; L[key].value += 1; };
  flow.forEach(o => { const pt = PTYPE[o.plat.type].l, ty = TYPES[o.ty].l, cl = CLAIM[o.c], rq = mainReq(o); add(pt, ty, typeColor(o.ty)); add(ty, cl, typeColor(o.ty)); add(cl, rq, null); });
  const nodeNames = uniq(Object.values(L).flatMap(l => [l.source, l.target]));
  const typeByLabel = Object.fromEntries(Object.entries(TYPES).map(([k, v]) => [v.l, k]));
  chart('#cSankey', {
    tooltip: { trigger: 'item', formatter: p => p.dataType === 'edge' ? `${p.data.source} → ${p.data.target}<br><b>${p.data.value}</b> 条` : `<b>${p.name}</b>` },
    series: [{
      type: 'sankey', left: 8, right: 110, top: 10, bottom: 10, nodeWidth: 12, nodeGap: 10, draggable: false, layoutIterations: 64,
      label: { color: TK.ink, fontFamily: FONT, fontSize: 12 },
      data: nodeNames.map(n => ({ name: n, itemStyle: { color: typeByLabel[n] ? typeColor(typeByLabel[n]) : TK.ink2, borderWidth: 0 } })),
      links: Object.values(L).map(l => ({ source: l.source, target: l.target, value: l.value, lineStyle: { color: l.col || TK.line2, opacity: l.col ? 0.32 : 0.55, curveness: 0.5 } })),
      emphasis: { focus: 'adjacency' },
    }],
  });

  // Each method has its own treemap region; no unlabelled combined total.
  const ranked = view(OFFERS.filter(o => o.ty !== 'apply'));
  const tree = VALUE_GROUPS.map(([group, name, col]) => ({ name, group, itemStyle: { color: TK.s[col] }, children: uniq(ranked.map(o => o.p)).map(pid => {
    const summary = valueSummary(ranked.filter(o => o.p === pid));
    return { name: PMAP[pid].name, value: summary[group], pid, group, summary, label: { color: onColor(TK.s[col]) } };
  }).filter(x => x.summary[group + 'N'] > 0 && x.value > 0) })).filter(x => x.children.length);
  const ct = chart('#cTree', {
    tooltip: { trigger: 'item', formatter: p => p.data.group ? `<b>${esc(p.name)}</b><br>${p.data.group === 'scenario' ? '用量估算 ≈' : '官方口径'} ${money(p.value)} · 月度参考${p.data.summary ? `<br>${coverageText(p.data.summary)}` : ''}` : '官方口径与用量估算分别列值' },
    series: [{ type: 'treemap', roam: false, nodeClick: false, breadcrumb: { show: false }, left: 0, right: 0, top: 0, bottom: 0,
      itemStyle: { borderColor: TK.surface, borderWidth: 2, gapWidth: 2, borderRadius: 6 },
      upperLabel: { show: true, height: 24, color: TK.ink, formatter: p => p.data.group ? p.name : '' },
      label: { show: true, fontFamily: FONT, fontSize: 12, formatter: p => p.data.pid ? `${p.name}\n${p.data.group === 'scenario' ? '≈' : ''}${money(p.value)}` : p.data.group ? p.name : '', lineHeight: 16 }, data: tree,
    }],
  });
  ct && ct.on('click', p => { if (p.data?.pid) location.hash = 'platform-' + p.data.pid; });

  // 大方榜赛跑
  const raceData = (mi, group) => RACE.series.map(s => ({ value: s[group][mi], name: PMAP[s.id].name, pid: s.id }));
  const last = RACE.months.length - 1;
  const raceSeries = mi => VALUE_GROUPS.map(([group, name, col]) => ({ name, type: 'bar', barWidth: 10, data: raceData(mi, group), itemStyle: { color: TK.s[col], borderRadius: [0, 4, 4, 0] }, label: { show: true, position: 'right', valueAnimation: true, color: TK.ink2, fontFamily: FONT, formatter: p => p.value == null ? '' : `${group === 'scenario' ? '≈' : ''}${money(p.value)}` } }));
  const cr = chart('#cRace', {
    grid: { left: 8, right: 70, top: 64, bottom: 8, containLabel: true },
    legend: Object.assign(legendCommon(), { top: 28 }),
    tooltip: { trigger: 'item', formatter: p => `${esc(p.name)}<br>${p.seriesName} · 月度参考价值：${money(p.value)}` },
    xAxis: Object.assign(axisCommon(), { type: 'value', max: 'dataMax', axisLabel: { color: TK.muted, formatter: v => money(v) } }),
    yAxis: Object.assign(axisCommon(), { type: 'category', inverse: true, data: RACE.series.map(s => PMAP[s.id].name), axisLabel: { color: TK.ink2, fontSize: 12 } }),
    series: raceSeries(last), animationDuration: 0, animationDurationUpdate: REDUCED ? 0 : 900, animationEasingUpdate: 'linear',
    graphic: [{ type: 'text', id: 'mon', right: 8, top: 4, style: { text: RACE.months[last], fill: TK.muted, font: `700 20px ${FONT}`, textAlign: 'right' } }],
  });
  cr && cr.on('click', p => { if (p.data?.pid) location.hash = 'platform-' + p.data.pid; });
  $('#racePlay').addEventListener('click', e => {
    const btn = e.currentTarget; btn.disabled = true; let mi = 0;
    const step = () => { if (!cr || cr.isDisposed()) return; cr.setOption({ series: raceSeries(mi), graphic: [{ id: 'mon', style: { text: RACE.months[mi] } }] }); mi++; if (mi <= last) setTimeout(step, 1000); else btn.disabled = false; };
    step();
  });

  // 趋势
  chart('#cTrend', {
    grid: { left: 8, right: 40, top: 34, bottom: 6, containLabel: true },
    legend: Object.assign(legendCommon(), { top: 0, left: 0 }),
    tooltip: { trigger: 'axis', axisPointer: { type: 'line', lineStyle: { color: TK.line2 } } },
    xAxis: Object.assign(axisCommon(), { type: 'category', data: TREND.labels, boundaryGap: false }),
    yAxis: Object.assign(axisCommon(), { type: 'value', minInterval: 1 }),
    series: [['新增', TREND.nw, 0], ['结束', TREND.ed, 1]].map(([n, d, i]) => ({ name: n, type: 'line', data: d, smooth: 0.3, symbol: 'circle', symbolSize: 5, showSymbol: false, lineStyle: { width: 2, color: TK.s[i] }, itemStyle: { color: TK.s[i] }, areaStyle: i === 0 ? { color: TK.s[0], opacity: 0.1 } : undefined, endLabel: { show: true, color: TK.ink2, fontFamily: FONT, formatter: p => `${p.value}` } })),
  });
  chart('#cStack', {
    grid: { left: 8, right: 12, top: 56, bottom: 6, containLabel: true },
    legend: Object.assign(legendCommon(), { top: 0, left: 0, itemGap: 8, textStyle: { color: TK.ink2, fontSize: 11 } }),
    tooltip: { trigger: 'axis', axisPointer: { type: 'line', lineStyle: { color: TK.line2 } } },
    xAxis: Object.assign(axisCommon(), { type: 'category', data: TREND.labels, boundaryGap: false }),
    yAxis: Object.assign(axisCommon(), { type: 'value', minInterval: 1 }),
    series: Object.keys(TYPES).map(t => ({ name: TYPES[t].l, type: 'line', stack: 'all', data: TREND.by[t], symbol: 'none', smooth: 0.25, lineStyle: { width: 1, color: TK.surface }, areaStyle: { color: typeColor(t), opacity: 0.9 }, itemStyle: { color: typeColor(t) } })),
  });
}

/* ---------- 重置时钟 ---------- */
// 带“额度重置”标签的条目；有官方发布时间（精确到时刻）的才参与星期 × 时段分布
const resetList = () => OFFERS.filter(o => (o.tags || []).includes('reset')).map(o => ({ o, at: o.publishedAt ? new Date(o.publishedAt) : startInstant(o), exact: !!o.publishedAt })).sort((a, b) => b.at - a.at);
function resetBlock() {
  const list = resetList();
  if (list.length < 3) return emptySheep(list.length ? `已收录 ${list.length} 次重置，满 3 次后显示分布。` : '还没有收录到额度重置。');
  const ts = list.map(x => x.at.getTime()).sort((a, b) => a - b);
  const gaps = ts.slice(1).map((t, i) => (t - ts[i]) / DAY), avg = gaps.length ? sum(gaps, g => g) / gaps.length : 0;
  const last = list[0], plats = uniq(list.map(x => x.o.plat.name));
  return `<section class="kpis" style="margin-top:6px">
      <div class="kpi"><span class="k-l">已收录重置</span><span class="k-v">${list.length}<small>次 · ${plats.length} 个平台</small></span></div>
      <div class="kpi"><span class="k-l">平均间隔</span><span class="k-v">${avg.toFixed(1)}<small>天</small></span></div>
      <div class="kpi"><span class="k-l">最近一次</span><span class="k-v">${Math.max(0, Math.round((NOW - last.at) / DAY))}<small>天前 · ${esc(last.o.plat.name)}</small></span></div>
    </section>
    <div class="chart" id="cReset" style="height:260px"></div>
    <div class="rows" style="margin-top:8px">${list.slice(0, 8).map(x => orow(x.o, `${md(x.at)}${x.exact ? ' ' + hm(x.at) : ''}`)).join('')}</div>`;
}
function drawResetClock() {
  const list = resetList().filter(x => x.exact);
  if (!$('#cReset') || !list.length) return;
  const cnt = {};
  list.forEach(x => { const k = `${(x.at.getDay() + 6) % 7}-${x.at.getHours()}`; (cnt[k] = cnt[k] || []).push(x); });
  const data = Object.entries(cnt).map(([k, xs]) => { const [d, h] = k.split('-').map(Number); return { value: [h, d, xs.length], xs }; });
  chart('#cReset', {
    grid: { left: 8, right: 16, top: 10, bottom: 24, containLabel: true },
    tooltip: { trigger: 'item', formatter: p => `周${WD[(p.data.value[1] + 1) % 7]} ${pad(p.data.value[0])}:00 前后 · ${p.data.value[2]} 次<br>${p.data.xs.map(x => `${md(x.at)} ${esc(x.o.t)}`).join('<br>')}` },
    xAxis: Object.assign(axisCommon(), { type: 'value', min: 0, max: 23, interval: 3, axisLabel: { color: TK.muted, formatter: v => `${v}:00` } }),
    yAxis: Object.assign(axisCommon(), { type: 'category', inverse: true, data: ['周一', '周二', '周三', '周四', '周五', '周六', '周日'], axisLabel: { color: TK.ink2 } }),
    series: [{ type: 'scatter', data, symbolSize: v => 10 + v[2] * 7, itemStyle: { color: TK.s[0], opacity: 0.85, borderColor: TK.surface, borderWidth: 2 } }],
  });
}

/* ---------- 平台页 ---------- */
function pPlatform(id) {
  const p = PMAP[id];
  if (!p) { main().innerHTML = ribbon() + emptySheep('没找到这个平台。<a href="#today">回到今天</a>'); return; }
  const list = view(OFFERS.filter(o => o.p === id)).sort((a, b) => b.since - a.since);
  const live = list.filter(o => statusOf(o) !== 'ended');
  const avg = i => { const known = list.map(o => dims(o)[i]).filter(x => x != null); return known.length ? Math.round(sum(known, x => x) / known.length) : null; };
  const pd = [clamp(list.length * 22, 10, 100), null, avg(1), avg(5), avg(4), list.some(o => o.ty === 'standing') ? 100 : 30];
  const platformValueGroups = VALUE_GROUPS.map(([group, label, color]) => {
    const known = list.filter(o => valueGroup(o) === group && valueNumber(o) != null);
    return { label, color, value: known.length ? Math.round(sum(known, o => dims(o)[0]) / known.length) : null };
  }).filter(x => x.value != null);
  if (platformValueGroups.length) pd[1] = 0; // enable the axis; each method supplies its own value below
  const platformDims = ['发放频率', '平均已计价价值', '门槛友好', '国内可用', '信源透明', '常驻额度'];
  main().innerHTML = ribbon() + `<div class="crumb"><a href="#all">全部羊毛</a> / 平台</div>` + ph(esc(p.name), `${PTYPE[p.type].l} · 已准入白名单${p.x ? ` · 监控的 X 账号：${esc(p.x)}` : ''}`, p.site ? `<a class="btn" href="${p.site}" target="_blank" rel="noopener">打开官网 ↗</a>` : '') + `
  <section class="kpis" style="margin-top:0">
    <div class="kpi"><span class="k-l">收录过的羊毛</span><span class="k-v">${list.length}<small>条</small></span></div>
    <div class="kpi"><span class="k-l">现在可领</span><span class="k-v">${list.filter(claimable).length}<small>条</small></span></div>
    <div class="kpi"><span class="k-l">已结束</span><span class="k-v">${list.length - live.length}<small>条</small></span></div>
  </section>
  <section class="card"><h3>历史活动的月度参考价值合计</h3><p class="sub">每条活动计一次，含已结束历史；分别按官方口径与用量估算汇总，申请制另列。不是累计实际发放金额。</p>${summaryHtml(list)}</section>
  <section class="grid g2">
    <div class="card"><h3>平台雷达</h3><p class="sub">价值维度按官方口径、用量估算分别平均已计价月度参考价值；${coverageText(valueSummary(list))}。缺价值不按最低分，无已计价金额时省略价值维度。</p><div class="chart" id="cPRadar" style="height:300px"></div></div>
    <div class="card"><h3>发放历史</h3><p class="sub">每条羊毛从开始到结束；常驻额度画到今天</p><div class="chart" id="cPHist" style="height:${Math.max(160, list.length * 34 + 70)}px"></div></div>
  </section>
  <section>${secH('这个平台的羊毛')}${ocards(list)}</section>`;
  chart('#cPRadar', {
    legend: Object.assign(legendCommon(), { bottom: 0 }),
    tooltip: { trigger: 'item' },
    radar: { indicator: platformDims.filter((_, i) => pd[i] != null).map(n => ({ name: n, max: 100 })), radius: '64%', center: ['50%', '54%'], splitNumber: 4, axisName: { color: TK.ink2, fontSize: 12 }, splitLine: { lineStyle: { color: TK.line2 } }, splitArea: { areaStyle: { color: [TK.surface, TK.surface2] } }, axisLine: { lineStyle: { color: TK.line2 } } },
    series: [{ type: 'radar', data: (platformValueGroups.length ? platformValueGroups : [{ label: '价值未计入', color: 0, value: null }]).map(group => ({ value: pd.map((x, i) => i === 1 ? group.value : x).filter(x => x != null), name: group.label, areaStyle: { color: TK.s[group.color], opacity: 0.18 }, lineStyle: { color: TK.s[group.color], width: 2 }, itemStyle: { color: TK.s[group.color] }, symbolSize: 5 })) }],
  });
  const lo = Math.max(-400, Math.min(-60, ...list.map(o => o.since))), hi = Math.max(20, ...list.map(o => o.ek === 'date' ? o.e + 1 : 0));
  const hd = list.map((o, i) => ({ value: [i, dayAt(Math.max(lo, o.since)).getTime(), dayAt(o.ek === 'date' ? o.e + 1 : 0.2).getTime()], o }));
  const ch = chart('#cPHist', {
    grid: { left: 8, right: 16, top: 24, bottom: 8, containLabel: true },
    tooltip: { trigger: 'item', formatter: q => `<b>${esc(q.data.o.t)}</b><br>${valLabel(q.data.o)}<br>${leftText(q.data.o)}` },
    xAxis: Object.assign(axisCommon(), { type: 'time', position: 'top', min: dayAt(lo).getTime(), max: dayAt(hi).getTime(), axisLabel: { color: TK.muted, fontSize: 11, formatter: v => { const d = new Date(v); return `${d.getMonth() + 1}/${d.getDate()}`; } } }),
    yAxis: Object.assign(axisCommon(), { type: 'category', inverse: true, data: list.map(o => o.t.length > 12 ? o.t.slice(0, 11) + '…' : o.t), axisLabel: { color: TK.ink2, fontSize: 11.5 }, splitLine: { show: false } }),
    series: [{
      type: 'custom', encode: { x: [1, 2], y: 0 }, data: hd,
      renderItem: (params, api) => {
        const o = hd[params.dataIndex].o, a = api.coord([api.value(1), api.value(0)]), b = api.coord([api.value(2), api.value(0)]), bh = api.size([0, 1])[1] * 0.5;
        const st = statusOf(o), c = typeColor(o.ty);
        return { type: 'rect', shape: { x: a[0], y: a[1] - bh / 2, width: Math.max(4, b[0] - a[0]), height: bh, r: 4 }, style: { fill: c, opacity: st === 'ended' ? 0.4 : 1 } };
      },
      markLine: { symbol: 'none', silent: true, data: [{ xAxis: NOW.getTime() }], lineStyle: { color: TK.ink, width: 1.2, type: 'solid' }, label: { formatter: '今天', color: TK.ink, fontSize: 11, position: 'start' } },
    }],
  });
  ch && ch.on('click', q => { if (q.data && q.data.o) location.hash = 'offer-' + q.data.o.id; });
}

/* ---------- 详情页 ---------- */
const STEPS = {
  signup: ['打开官方页面（见下方"打开官方领取页"）', '完成注册和所需的身份验证', '额度自动发放，在控制台的余额或用量页查看'],
  auto: ['无需操作，额度或权益自动生效', '在官方控制台或产品设置里确认'],
  member: ['确认你的会员档位符合要求', '权益自动生效，在产品的用量页查看'],
  topup: ['在活动期内完成指定金额的充值', '赠送部分自动到账，留意赠送余额的有效期'],
  form: ['准备材料（公司或学生身份证明等）', '在官方申请页提交表单', '等待审核邮件，通常需要 1 到 4 周'],
  app: ['下载官方 App 并登录', '按活动页提示签到或领取'],
  code: ['向已有用户索取邀请链接或兑换码', '用链接注册，或在账户设置里兑换', '双方权益自动到账'],
};
const NOTE_DRAFTS = new Map();
const NOTE_SAVES = new Set();
const COMMENT_STATE = new Map();
let ANON_SESSION = null;
let ANON_NAME = '';
const commentAdmin = () => !!ADM.token && ADM.role === 'admin';
async function commentRequest(path, body, administrator = false) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (administrator) headers.Authorization = 'Bearer ' + ADM.token;
  const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store', headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) { const error = new Error(result.error || '留言暂时不可用'); error.status = response.status; throw error; }
  return result;
}
function anonymousCommentSession() {
  if (!ANON_SESSION) ANON_SESSION = commentRequest('/api/community/session', {}).then(result => {
    if (!/^羊毛党\d{6}$/.test(result.name)) throw new Error('匿名身份暂时不可用');
    ANON_NAME = result.name; return result.name;
  }).catch(error => { ANON_SESSION = null; throw error; });
  return ANON_SESSION;
}
function commentState(id) {
  if (!COMMENT_STATE.has(id)) COMMENT_STATE.set(id, { comments: [], nextCursor: null, loaded: false, loading: false, version: 0, attempt: null, message: '', removing: new Set() });
  return COMMENT_STATE.get(id);
}
function commentCard(o) {
  const state = commentState(o.id);
  return `<div class="card" id="noteBox"><h3>💬 牧场心得</h3>
    <p class="small muted">分享你实际领取、使用的体验，帮助大家参考和避雷。留言公开可见。</p>
    <form id="noteForm" style="display:flex;flex-direction:column;gap:8px">
      <label class="small" for="commentInput">以 <strong data-comment-author>${commentAdmin() ? 'admin' : esc(ANON_NAME || '匿名访客')}</strong> 留言</label>
      <textarea id="commentInput" name="note" rows="3" maxlength="500" required style="width:100%;padding:10px;border:1px solid var(--line-2);border-radius:10px;background:var(--surface);resize:vertical" placeholder="实际薅到了吗？到账、速度、限流或踩坑情况如何？（最多 500 字）">${esc(NOTE_DRAFTS.get(o.id) || '')}</textarea>
      <div class="row" style="align-items:center;flex-wrap:wrap"><button class="btn sm pri" type="submit" ${NOTE_SAVES.has(o.id) ? 'disabled' : ''}>${NOTE_SAVES.has(o.id) ? '发表中…' : '发表心得'}</button><span class="small muted" data-comment-count>${(NOTE_DRAFTS.get(o.id) || '').length}/500</span><span data-notemsg role="status" class="small" style="font-weight:600">${esc(state.message || (NOTE_DRAFTS.has(o.id) ? '未发表' : ''))}</span></div>
      <p class="small muted" style="margin:0">无需登录；匿名名字保留在此浏览器。请勿发布隐私、广告或辱骂内容。</p>
    </form>
    <div class="row" style="justify-content:space-between;margin:18px 0 8px"><strong class="small">大家的心得</strong><button class="btn sm" type="button" data-comment-refresh>刷新留言</button></div>
    <div data-comments aria-live="polite"></div><p class="small" data-comment-loadmsg role="status"></p><button class="btn sm" type="button" data-comment-more hidden>加载更多</button>
  </div>`;
}
function paintComments(box, state) {
  const list = $('[data-comments]', box);
  list.innerHTML = state.comments.length ? state.comments.map(comment => `<article data-comment-id="${esc(comment.id)}" style="padding:12px 0;border-top:1px solid var(--line)">
    <div class="row small" style="align-items:center;flex-wrap:wrap"><strong>${esc(comment.author)}</strong><time class="muted" datetime="${esc(comment.createdAt)}">${esc(new Date(comment.createdAt).toLocaleString('zh-CN'))}</time>${commentAdmin() ? `<button class="btn sm" type="button" data-comment-delete="${esc(comment.id)}" style="margin-left:auto" ${state.removing.has(String(comment.id)) ? 'disabled' : ''}>删除</button>` : ''}</div>
    <p style="margin:7px 0 0;white-space:pre-wrap;overflow-wrap:anywhere">${esc(comment.content)}</p></article>`).join('') : `<p class="small muted">${state.loaded ? '还没有心得，来分享第一条吧。' : '正在加载心得…'}</p>`;
  $('[data-comment-more]', box).hidden = !state.nextCursor;
  $('[data-comment-more]', box).disabled = state.loading;
}
function setupComments(o) {
  const box = $('#noteBox'), form = $('#noteForm'), state = commentState(o.id), input = $('[name="note"]', form);
  const currentBox = () => route()[0] === 'offer' && route()[1] === o.id ? $('#noteBox') : null;
  const message = (text, failed = false) => {
    state.message = text;
    const target = currentBox()?.querySelector('[data-notemsg]');
    if (target) { target.textContent = text; target.style.color = failed ? 'var(--critical-ink)' : ''; }
  };
  paintComments(box, state);
  const load = async (more = false) => {
    if (more && (!state.nextCursor || state.loading)) return;
    const version = ++state.version, cursor = more ? state.nextCursor : null;
    state.loading = true;
    const live = currentBox(); if (live) { paintComments(live, state); if (more) $('[data-comment-loadmsg]', live).textContent = '加载中…'; }
    try {
      const result = await commentRequest(`/api/offers/${encodeURIComponent(o.id)}/comments${cursor ? '?before=' + encodeURIComponent(cursor) : ''}`);
      if (!Array.isArray(result.comments)) throw new Error('留言暂时不可用');
      if (state.version !== version) return;
      state.comments = more ? [...state.comments, ...result.comments.filter(c => !state.comments.some(old => old.id === c.id))] : result.comments;
      state.nextCursor = result.nextCursor; state.loaded = true;
      const live = currentBox(); if (live) $('[data-comment-loadmsg]', live).textContent = '';
    } catch (error) { const live = currentBox(); if (live && state.version === version) $('[data-comment-loadmsg]', live).textContent = '未能加载心得：' + error.message; }
    finally { if (state.version === version) { state.loading = false; const live = currentBox(); if (live) paintComments(live, state); } }
  };
  $('[data-comment-refresh]', box).addEventListener('click', () => load());
  $('[data-comment-more]', box).addEventListener('click', () => load(true));
  if (!commentAdmin()) anonymousCommentSession().then(name => { const live = currentBox(); if (live) $('[data-comment-author]', live).textContent = name; }).catch(error => message('获取匿名身份失败：' + error.message, true));
  form.addEventListener('input', () => {
    if (input.value) NOTE_DRAFTS.set(o.id, input.value); else NOTE_DRAFTS.delete(o.id);
    $('[data-comment-count]', form).textContent = input.value.length + '/500';
    message(NOTE_SAVES.has(o.id) ? '发表中，当前修改会保留' : input.value ? '未发表' : '');
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (NOTE_SAVES.has(o.id)) return;
    const draft = input.value, content = draft.trim(), administrator = commentAdmin();
    if (!content || content.length > 500) { message('请填写 1–500 字的心得', true); return; }
    NOTE_DRAFTS.set(o.id, draft);
    if (!state.attempt || state.attempt.content !== content || state.attempt.administrator !== administrator) state.attempt = { content, requestId: crypto.randomUUID(), administrator };
    const attempt = state.attempt;
    NOTE_SAVES.add(o.id); $('button[type="submit"]', form).disabled = true; message('发表中…');
    try {
      if (!administrator) await anonymousCommentSession();
      if (!state.loaded) await state.initialLoad;
      const path = `/api/${administrator ? 'admin/' : ''}offers/${encodeURIComponent(o.id)}/comments`;
      const result = await commentRequest(path, { content: attempt.content, requestId: attempt.requestId }, administrator);
      if (!result.comment?.id) throw new Error('未能确认是否发表成功，请重试');
      ++state.version; state.loading = false;
      state.comments = [result.comment, ...state.comments.filter(c => c.id !== result.comment.id)];
      state.loaded = true; state.attempt = null;
      const live = currentBox(), currentInput = live?.querySelector('[name="note"]');
      const current = currentInput?.value ?? NOTE_DRAFTS.get(o.id);
      if (current === draft) { NOTE_DRAFTS.delete(o.id); if (currentInput) currentInput.value = ''; message('已发表，所有人可见'); }
      else message('当前修改未保存');
      if (live) { paintComments(live, state); $('[data-comment-loadmsg]', live).textContent = ''; $('[data-comment-count]', live).textContent = (currentInput?.value.length || 0) + '/500'; }
    } catch (error) {
      if (error.status === 401 && !administrator) { ANON_SESSION = null; ANON_NAME = ''; }
      message('没有发表：' + error.message, true);
    } finally {
      NOTE_SAVES.delete(o.id);
      const button = currentBox()?.querySelector('button[type="submit"]'); if (button) { button.disabled = false; button.textContent = '发表心得'; }
    }
  });
  box.addEventListener('click', async event => {
    const button = event.target.closest('[data-comment-delete]');
    if (!button || button.disabled || !commentAdmin()) return;
    const article = button.closest('[data-comment-id]');
    if (!article.querySelector('[data-comment-delete-confirm]')) { button.insertAdjacentHTML('afterend', '<span data-comment-delete-confirm class="small">确定删除？ <button class="btn sm" type="button" data-comment-confirm>确认删除</button><button class="btn sm" type="button" data-comment-cancel>取消</button></span>'); return; }
  });
  box.addEventListener('click', async event => {
    const cancel = event.target.closest('[data-comment-cancel]'); if (cancel) { cancel.closest('[data-comment-delete-confirm]').remove(); return; }
    const button = event.target.closest('[data-comment-confirm]'); if (!button || button.disabled) return;
    const article = button.closest('[data-comment-id]'), id = article.dataset.commentId;
    button.disabled = true; state.removing.add(id);
    try { await commentRequest(`/api/admin/comments/${encodeURIComponent(id)}/delete`, {}, true); ++state.version; state.loading = false; state.comments = state.comments.filter(c => String(c.id) !== id); const live = currentBox(); if (live) paintComments(live, state); message('已删除'); }
    catch (error) { button.disabled = false; message('删除失败：' + error.message, true); }
    finally { state.removing.delete(id); }
  });
  state.initialLoad = load();
}
async function resolveOfferHash(id) {
  const hash=location.hash;
  try {const response=await fetch('/api/offers/'+encodeURIComponent(id),{headers:{Accept:'application/json'}});if(!response.ok)throw new Error('not found');const data=await response.json();if(location.hash!==hash)return;
    if(!data.canonicalOfferId||data.canonicalOfferId===id)throw new Error('not found');
    if(!OMAP[data.canonicalOfferId]){await loadData({fresh:true});prepare();}
    if(location.hash!==hash)return;if(!OMAP[data.canonicalOfferId])throw new Error('not found');
    history.replaceState(null,'','#offer-'+encodeURIComponent(data.canonicalOfferId));render(false);
  }catch{if(location.hash===hash)main().innerHTML=ribbon()+emptySheep('没找到这条羊毛。<a href="#today">回到今天</a>');}
}
function pOffer(id) {
  const o = OMAP[id];
  if (!o) { main().innerHTML=ribbon()+emptySheep('正在查找活动…');resolveOfferHash(id);return; }
  const st = statusOf(o), d = dims(o), sc = score(o), miss = missing(o);
  const effectiveAt = oneTimeEffectiveAt(o);
  const definiteMissing = miss.filter(item => item !== 'membership_unknown').length;
  const qualificationSummary = miss.includes('membership_unknown')
    ? definiteMissing ? `按你的条件，还差 ${definiteMissing} 项；个人会员资格请按原条件核对` : '活动已通过；个人会员资格请按原条件核对'
    : definiteMissing ? `按你的条件，还差 ${definiteMissing} 项` : '按你的条件，全部满足';
  const tzName = TZ[o.tz] || o.tz, viewerTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  let timeBlock;
  if (isLimited(o) && o.ek === 'date' && st !== 'ended') {
    const target = st === 'upcoming' ? startInstant(o) : endInstant(o);
    const total = endInstant(o) - startInstant(o), frac = st === 'upcoming' ? 1 : (endInstant(o) - NOW) / total;
    const col = o.e === 0 ? 'var(--critical)' : st === 'ending' ? 'var(--serious)' : st === 'upcoming' ? 'var(--s1)' : 'var(--good)';
    timeBlock = `<div class="ring-big">${ringSvg(frac, 92, col, 8)}<div><div class="small muted">${st === 'upcoming' ? '距离开始' : '距离领取截止'}</div><div class="cd" data-end="${target.getTime()}">${cdText(target - NOW)}</div><div class="small muted">按官方${tzName}换算成你的本地时间</div></div></div>`;
  } else if (st === 'ended') timeBlock = `<div class="ring-big">${ringSvg(0, 92, 'var(--muted)', 8)}<div><div class="cd">已结束</div><div class="small muted">${leftText(o)}${o.why ? ` · ${esc(o.why)}` : ''}</div></div></div>`;
  else if (o.ek === 'unknown') timeBlock = `<div class="ring-big">${ringUnknown(92, 8)}<div><div class="cd">截止未知</div><div class="small muted">发放方未公布截止日；明确撤回或条件变化时更新</div></div></div>`;
  else timeBlock = `<div class="ring-big">${ringSvg(1, 92, o.ty === 'apply' ? 'var(--s7)' : 'var(--s6)', 8)}<div><div class="cd">${o.ty === 'apply' ? '长期开放' : '常驻'}</div><div class="small muted">沿用已批准条款 · 证据核验于${ago(o.vf)}</div></div></div>`;
  if (o.evidence?.claimEndDerivation && st !== 'ended' && st !== 'upcoming') {
    const window = countdownWindow(o);
    if (window) timeBlock = `<div class="ring-big">${ringSvg(0.6,92,st === 'stale' ? 'var(--warn)' : 'var(--good)',8)}<div><div class="small muted">距离推算截止</div><div class="cd" data-estimated-end="${window.end.getTime()}"${window.earliest ? ` data-estimated-start="${window.earliest.getTime()}"` : ''}>${estimatedCountdown(window)}</div><div class="small muted">按公告活动周期推算 · 精确截止待确认</div></div></div>`;
  }
  const endLocal = o.ek === 'date' ? endInstant(o) : null;
  const deadline = effectiveAt ? `${esc(effectiveAt)}<small>官方图片标注的${tzName}权益生效时间；不是领取截止或卡片失效时间</small>` : o.evidence?.claimEndDerivation ? `${md(dayAt(o.e))}（推算）<small>按公告活动周期推算，官方未公布精确截止时刻</small>` : o.ek === 'date' ? `${md(dayAt(o.e))} 23:59<small>官方按${tzName}${endLocal && o.tz !== viewerTz ? `；你的本地时间 ${md(endLocal)} ${hm(endLocal)}` : ''}</small>` : o.ek === 'unknown' ? '截止未知<small>发放方未公布截止日期</small>' : '长期<small>没有截止日期</small>';
  const verify = o.verify === 'evidence_missing' ? '此前的抓取未能逐字匹配原文，可能是网页改写；批准记录保留，当前状态按截止日期或明确撤回判定，不要求重新审批。' : `${ago(o.vf)}核验：${o.verify || '官方页面可以打开'}`;
  const officialUrl = (o.evidence && o.evidence.url) || o.plat.site;
  const hist = [];
  hist.push([o.fs, `系统发现（最早出现在：${o.early}）`]);
  if (o.pub != null && o.pub !== o.s) hist.push([o.pub, '官方发布']);
  if (o.s != null && o.s <= 0) hist.push([o.s, effectiveAt ? `权益于${effectiveAt}生效` : '活动开始（按官方公布时间）']);
  (o.rev || []).forEach(rv => hist.push([rv.at, `条款修订：${rv.from} → ${rv.to}`]));
  if (st === 'ended' && !effectiveAt) hist.push([o.withdrawnAt ? dayIdx(new Date(o.withdrawnAt)) : o.e, o.withdrawnAt ? `确认停止领取${o.why ? `（${o.why}）` : ''}` : '已到官方公布的领取截止时间']);
  if (o.vfDay != null) hist.push([o.vfDay, '最近一次成功核验']);
  hist.sort((a, b) => b[0] - a[0]);
  const same = OFFERS.filter(x => x.p === o.p && x.id !== o.id);
  const wanted = MINE.want.includes(o.id), got = claimedThisMonth(o.id);
  main().innerHTML = ribbon() + `<div class="crumb"><a href="${esc(offerReturnHash)}" data-offer-back>← 返回</a> / <a href="#platform-${o.p}">${esc(o.plat.name)}</a></div>
  <div class="dt-top">${etag(o.ty)}${stChip(o)}<span class="score" title="薅度分">${sc}<small>薅度</small></span></div>
  <h1 class="dt-title">${esc(o.t)}</h1>
  <div class="row" style="margin:6px 0 18px">
    ${officialUrl ? `<a class="btn pri" href="${esc(officialUrl)}" target="_blank" rel="noopener">打开官方页面 ↗</a>` : ''}
    <button class="btn" type="button" data-want="${o.id}" aria-pressed="${wanted}">${wanted ? '★ 想领' : '☆ 想领'}</button>
    <button class="btn" type="button" data-got="${o.id}" aria-pressed="${got}">${got ? '✓ 本月已领' : '记为本月已领'}</button>
    <button class="btn" type="button" data-cmp="${o.id}" aria-pressed="${CMP.includes(o.id)}">加入对比</button>
    ${ADM.token ? '<button class="btn" type="button" data-online-edit>✏️ 在线编辑</button>' : ''}
  </div>
  <div data-online-edit-box style="margin:-6px 0 18px"></div>
  <div class="dt-grid">
    <div style="display:flex;flex-direction:column;gap:14px;min-width:0">
      <div class="card"><div class="row" style="justify-content:space-between;align-items:flex-start;gap:16px"><div><div class="small muted">赠送内容</div>${hasDisplayValue(o) ? `<div class="bigval" data-detail-value>${valLabel(o)}</div><div style="margin-top:4px">${esc(o.v)}</div>` : `<div class="dt-benefit" data-detail-benefit>${esc(o.v)}</div><div class="small muted" data-detail-value>${valLabel(o)}</div>`}</div>${timeBlock}</div></div>
      ${valuationBlock(o)}
      <div class="facts">
        <div class="fact"><div class="l">领取方式</div><div class="v">${CLAIM[o.c]}</div></div>
        <div class="fact"><div class="l">领取开始</div><div class="v">${o.s != null ? md(dayAt(o.s)) : '已开放'}</div></div>
        <div class="fact"><div class="l">${effectiveAt ? '权益生效' : '领取截止'}</div><div class="v">${deadline}</div></div>
        <div class="fact"><div class="l">额度有效期</div><div class="v">${esc(o.val)}<small>领取之后多久失效，和领取截止是两回事</small></div></div>
        <div class="fact"><div class="l">适用对象</div><div class="v">${AUD[o.aud]}</div></div>
        <div class="fact"><div class="l">模态</div><div class="v">${o.m.map(m => MODAL[m]).join('、')}</div></div>
      </div>
      <div class="card"><h3>适用资格</h3><p class="sub">${qualificationSummary} · <a href="#" data-open-cond style="text-decoration:underline">修改我的条件</a></p>${reqChips(o, true)}${o.r.includes('targeted') ? '<p class="small muted" style="margin:8px 0 0">定向发放：只有部分账号收到，能不能领要看你的账号。</p>' : ''}${o.aud === 'unclear' ? '<p class="small muted" style="margin:8px 0 0">官方没写清楚谁能领，这里不宣称人人可领。</p>' : ''}</div>
      <div class="card"><h3>领取步骤</h3><ol class="steps">${((o.steps && o.steps.length) ? o.steps : (STEPS[o.c] || [])).map(s => `<li>${esc(s)}</li>`).join('')}</ol></div>
      <div class="card"><h3>官方证据</h3><p class="sub">信源：${SRC[o.st]}${o.st === 'staff' ? '（白名单内的在职员工账号）' : ''} · ${verify}</p>${st==='stale'&&ADM.token?`<p class="small"><a href="#admin-offer-${encodeURIComponent(o.id)}">去后台核对证据 →</a></p>`:''}
        <div class="rows">${[['benefit', '权益'], ['eligibility', '资格'], ['claim', '领取方式'], ['validity', '有效期']].map(([k, l]) => { const ex = o.evidence && o.evidence.excerpts && o.evidence.excerpts[k]; return `<div class="orow" style="grid-template-columns:auto minmax(0,1fr)">${ex ? `<span class="st good"><b>✓</b>${l}</span>` : `<span class="st warn"><b>!</b>${l}</span>`}<span class="t">${ex ? `「${esc(ex)}」` : '官方原文里没有找到对应说明'}<small>${ex ? '官方原文逐字摘录' : '以官方页面为准'}</small></span></div>`; }).join('')}</div>
        <p class="small muted" style="margin:10px 0 0">来源：${officialUrl ? `<a href="${esc(officialUrl)}" target="_blank" rel="noopener" style="text-decoration:underline">${esc(officialUrl)}</a>` : '—'}</p>
      </div>
    </div>
    <div style="display:flex;flex-direction:column;gap:14px;min-width:0">
      <div class="card"><h3>薅度雷达</h3><p class="sub">${valueNumber(o) == null ? '价值未计入，按其余五项重分配权重' : '六项按规则计算；价值为月度参考价值'}，薅度分 ${sc}</p><div class="chart" id="cRadar" style="height:280px"></div>
        <div class="rows">${DIMS.map((n, i) => `<div class="row small" style="gap:10px;padding:3px 0"><span style="width:64px;color:var(--ink-2)">${n}</span>${d[i] == null ? '<span class="small muted" style="flex:1">未计入评分</span>' : `<span class="meter" style="flex:1"><i style="width:${d[i]}%;background:${typeVar(o.ty)}"></i></span>`}<span class="num tnum" style="width:28px;text-align:right">${d[i] ?? '—'}</span></div>`).join('')}</div></div>
      ${ADM.token ? `<div class="card" id="revBox"><h3>条款修订记录</h3>${(o.rev || []).length ? `<div class="diff">${o.rev.map(rv => `<div><span class="small muted">${md(dayAt(rv.at))}</span><br><del>${esc(rv.from)}</del> → <ins>${esc(rv.to)}</ins></div>`).join('')}</div>` : '<p class="small muted" style="margin:0">收录以来条款没有变化。</p>'}</div>` : ''}
      <div class="card"><h3>状态时间轴</h3><ul class="tl">${hist.map(([t, s], i) => `<li class="${i ? '' : 'hot'}"><time>${md(dayAt(t))}</time>${esc(s)}</li>`).join('')}</ul></div>
      ${commentCard(o)}
    </div>
  </div>
  ${same.length ? `<section>${secH(`${esc(o.plat.name)} 的其他羊毛`)}${ocards(same)}</section>` : ''}`;
  const modelSelect = $('#valueModel');
  modelSelect?.addEventListener('change', () => {
    const alternative = modelSelect.value === 'default' ? null : valuationAlternatives(o)[Number(modelSelect.value)];
    if (modelSelect.value !== 'default' && !alternative) { modelSelect.value = 'default'; return; }
    $('[data-detail-value]').innerHTML = detailValueLabel(o, alternative);
    $('[data-detail-formula]').textContent = valuationText(alternative?.formula || valuationOf(o).formula);
    $('[data-model-note]').textContent = alternative ? `另一个使用方案：${alternative.model}。参考金额已按此活动的覆盖期与配额计算；全站仍按默认基准 ${valuationOf(o).baselineModel || '估值'} 排序、汇总和记录领取。` : '当前为默认基准。其他模型是另一个使用方案；金额已按此活动的覆盖期与配额计算。全站排序、汇总和领取记录使用默认估值。';
  });
  setupComments(o);
  // 修订记录按需读取
  const revisionBox = $('#revBox');
  (revisionBox ? adm(`/offers/${encodeURIComponent(o.id)}`) : Promise.resolve(null)).then(j => {
    const box = revisionBox; if (!box?.isConnected || route()[1] !== o.id || !j?.revisions?.length) return;
    const F = { valueText: '额度', claimEnd: '截止', claimStart: '开始', membershipRequirement: '会员资格', requirements: '门槛', usdEstimate: '折合美元', usdMax: '最高可申请额度', valuation: '估值', title: '标题', creditValidity: '有效期', endKind: '截止类型', type: '类型', audience: '适用对象', steps: '领取步骤', claimMethod: '领取方式', modalities: '模态', platformId: '平台', sourceTz: '时区', evidence: '官方证据' };
    // 修订内容转成人能读的文字：枚举用中文名，列表逐条，证据只说明链接和级别变化
    const say = (field, v) => {
      if (v == null || v === '') return '（空）';
      if (field === 'type') return TYPES[v]?.l || v;
      if (field === 'claimMethod') return CLAIM[v] || v;
      if (field === 'audience') return AUD[v] || v;
      if (field === 'requirements') return v.map(r => reqLabel(r)).join('、');
      if (field === 'modalities') return v.map(m => MODAL[m] || m).join('、');
      if (Array.isArray(v)) return v.join('；');
      return String(v);
    };
    const line = x => {
      if (x.field !== 'evidence') return `${F[x.field] || x.field}：<del>${esc(say(x.field, x.from))}</del> → <ins>${esc(say(x.field, x.to))}</ins>`;
      const a = x.from || {}, b = x.to || {}, parts = [];
      if (a.tier !== b.tier) parts.push(`级别 <del>${esc(SRC[a.tier] || a.tier || '（空）')}</del> → <ins>${esc(SRC[b.tier] || b.tier)}</ins>`);
      if (a.url !== b.url) parts.push(`链接换成 <ins>${esc(b.url || '')}</ins>`);
      if (JSON.stringify(a.excerpts) !== JSON.stringify(b.excerpts)) parts.push('原文摘录已更新');
      return `官方证据：${parts.join('；') || '重新抓取'}`;
    };
    box.innerHTML = `<h3>条款修订记录</h3><div class="diff">${j.revisions.map(rv => `<div><span class="small muted">${esc(rv.at.slice(0, 10))}</span>${rv.diff.map(x => `<br>${line(x)}`).join('')}</div>`).join('')}</div>`;
  }).catch(() => undefined);
  const col = typeColor(o.ty);
  chart('#cRadar', {
    tooltip: { trigger: 'item' },
    radar: { indicator: radarData(o).names.map(n => ({ name: n, max: 100 })), radius: '66%', center: ['50%', '54%'], splitNumber: 4, axisName: { color: TK.ink2, fontSize: 12 }, splitLine: { lineStyle: { color: TK.line2 } }, splitArea: { areaStyle: { color: [TK.surface, TK.surface2] } }, axisLine: { lineStyle: { color: TK.line2 } } },
    series: [{ type: 'radar', data: [{ value: radarData(o).values, name: o.t, areaStyle: { color: col, opacity: 0.25 }, lineStyle: { color: col, width: 2 }, itemStyle: { color: col }, symbolSize: 5 }] }],
  });
}

/* ---------- 我的 ---------- */
function condForm() {
  return `<label class="tog"><span>只看确定符合的<small>旧版已批准会员条件若尚未自动匹配，会暂时隐藏；关闭筛选可按原条件查看。</small></span><input type="checkbox" data-c="only" ${C.only ? 'checked' : ''}></label>
  ${COND_ITEMS.map(([k, l]) => `<label class="tog"><span>${l}</span><input type="checkbox" data-c="${k}" ${C[k] ? 'checked' : ''}></label>`).join('')}
  <div class="small muted" style="margin:14px 0 6px">我已有的会员</div>
  ${subscriptionControls()}
  <p class="small muted" style="margin:12px 0 0">只保存在这台设备的浏览器里，不会上传。</p>`;
}
function pMine() {
  const pool = OFFERS.filter(o => claimable(o) && eligible(o));
  const claims = MINE.claimed.filter(x => x.month === localMonth());
  const got = claims.map(x => OMAP[x.id]).filter(Boolean), want = MINE.want.map(id => OMAP[id]).filter(Boolean);
  const claimed = valueSummary(claims), potential = valueSummary([...pool.filter(o => !claims.some(x => x.id === o.id)), ...claims]);
  main().innerHTML = ribbon() + ph('我的', '你的条件决定全站显示什么；想领和已领的清单只存在这台设备上。') + `
  <section class="grid g2" style="margin-top:0">
    <div class="card"><h3>本月薅羊毛进度</h3><p class="sub">本月领取时记录的月度参考价值 / 当前可领及本月已领参考价值。按方法分别计算，不代表已实际节省的费用。</p>
      <div class="value-progress">${VALUE_GROUPS.map(([group, label, col]) => `<div class="prog">${ringSvg(potential[group] > 0 ? claimed[group] / potential[group] : 0, 110, `var(--s${col + 1})`, 10)}<div class="kv"><span class="small muted">本月已记领 · ${label}</span><b>${summaryAmount(claimed, group)}</b><span class="small muted">可领及已领 ${summaryAmount(potential, group)}</span></div></div>`).join('')}</div><p class="small muted">本月记录 ${claims.length} 条 · ${coverageText(claimed)}。部分旧领取记录缺少计算依据和领取周期，保留记录，但不计入金额。</p></div>
    <div class="card"><h3>我的条件</h3>${condForm()}</div>
  </section>
  <section>${secH(`想领（${want.length}）`)}${want.length ? `<div class="rows">${want.map(o => orow(o, leftText(o))).join('')}</div>` : emptySheep('在详情页点"想领"，会出现在这里。')}</section>
  <section>${secH(`本月已领（${got.length}）`)}${got.length ? `<div class="rows">${got.map(o => orow(o, '本月已领')).join('')}</div>` : emptySheep('在详情页点"本月已领"，会计入本月进度。')}</section>
  ${MINE.legacyGot.length ? `<section>${secH(`旧版已领（日期未知 · ${MINE.legacyGot.length}）`)}<p class="small muted">这些记录保留在本机，不计入本月金额。</p><div class="rows">${MINE.legacyGot.map(id => OMAP[id] ? `<div class="row">${orow(OMAP[id], '日期未知')}<button class="btn sm" type="button" data-remove-legacy="${esc(id)}">移除</button></div>` : '').join('')}</div></section>` : ''}`;
}

/* ---------- 参考价值计算方法 ---------- */
function pValuationMethod() {
  const topics = [['meaning', '先看懂金额'], ['window', '月度与有效期'], ['prices', '价格从哪来'], ['usage', '默认用量'], ['pools', '模型与额度池'], ['benchmarks', '参照与申请制'], ['evidence', '查看每条依据']];
  main().innerHTML = ribbon() + `<div class="crumb"><a href="#today">今天的牧场</a><span>/</span><span>参考价值</span></div>` + ph('参考价值怎么算', '把不同羊毛放在同一把尺子上，方便你挑适合自己的权益。') + `
  <article class="method-page">
    <div class="method-intro"><b>参考价值，是买到相近权益的参考成本。</b><p>它不代表现金、保证到账、实际节省，也不是你的实际账单。能否领取、用得完多少，仍要看活动条件和你的需要。</p></div>
    <nav class="method-toc" aria-label="计算方法目录">${topics.map(([id, label]) => `<button type="button" data-method-section="${id}">${label}</button>`).join('')}</nav>
    <section id="method-meaning" tabindex="-1">
      <h2>先看懂页面上的金额</h2>
      <dl class="method-defs">
        <div><dt>官方口径</dt><dd>按真实赠金面额或官方购买价折算。标为“套餐价格参照”的暂定金额还包含参照假设，需要看该条说明；这一组同样只是购买参考成本。</dd></div>
        <div><dt>用量估算</dt><dd>按代表模型的价格，乘一份固定的使用量，再考虑实际期限和配额。通常带有“≈”。</dd></div>
        <div><dt>价值待定</dt><dd>价格、兑换关系或规格还不足以可靠计算。留空不等于 $0，也不按零参与金额排行和汇总。</dd></div>
      </dl>
    </section>
    <section id="method-window" tabindex="-1">
      <h2>统一看一个月，保留完整权益</h2>
      <p>“月度”使用领取或激活后<strong>最多 30 天</strong>的比较窗口，方便把期限不同的活动放在一起看。它不是自然月账单，也不会把短试用放大成一个月。</p>
      <ul>
        <li><strong>短期使用权：</strong>按实际覆盖天数缩小默认用量。例如只开放 1 天的视频体验，600 秒 ÷ 30 = 20 秒，再按真实配额封顶。</li>
        <li><strong>固定一次性赠金或积分：</strong>按实际赠额算购买参考成本。赠金只有效 7 天，不会因为 7 ÷ 30 而抹掉余额；有效期和使用限制会另行说明。</li>
        <li><strong>年会员：</strong>明确采用年价时，月度参考为年价 ÷ 12，完整年值另列。例如 $120/年 ÷ 12 = $10/月；附带模型和功能不再重复叠加。</li>
      </ul>
      <p class="method-note">领取截止决定还能不能领，额度有效期决定领到后能用多久。两者都需要看，参考金额不能替代这两个日期。</p>
    </section>
    <section id="method-prices" tabindex="-1">
      <h2>先找匹配的正常购买价</h2>
      <p>同一份权益，优先用<strong>本平台同权益的售价或加购价</strong>；其次是<strong>同版本原厂价</strong>；再其次是<strong>同版本 OpenRouter 付费价</strong>。模型、规格、计费单位、输入与输出方向都要匹配，不能借另一个版本的低价来算。</p>
      <p>套餐通常选<strong>普通月付入门档的正常价</strong>。首月优惠、指定套餐、年付折月价或地区价若被采用，会在该条说明中写清楚，不能当作常规续费价。</p>
      <p>外币按有来源和日期的汇率折成美元，先算总量再统一舍入。周末可用最近工作日汇率；具体价格与汇率日期请看每条“估值说明”。</p>
    </section>
    <section id="method-usage" tabindex="-1">
      <h2>不限量，也用一份固定用量比较</h2>
      <p>“不限量”没有可直接相加的面额，所以用<strong>代表模型 × 标准用量</strong>来算。下面是一整个月的默认比较用量，不是平台承诺的免费额度，也不是对所有人实际用量的预测。</p>
      <div class="method-table-wrap"><table class="method-table"><caption class="sr">月度默认比较用量</caption><thead><tr><th scope="col">用途</th><th scope="col">默认月度用量</th></tr></thead><tbody>
        <tr><th scope="row">通用文本</th><td>输入 100 万 Token<br>输出 20 万 Token</td></tr>
        <tr><th scope="row">编程</th><td>输入 1,000 万 Token<br>输出 100 万 Token</td></tr>
        <tr><th scope="row">图像</th><td>100 张</td></tr>
        <tr><th scope="row">视频</th><td>600 秒</td></tr>
        <tr><th scope="row">语音转写</th><td>1,200 分钟</td></tr>
        <tr><th scope="row">语音合成</th><td>10,000 字符</td></tr>
      </tbody></table></div>
      <p>文本和编程是同一模态下的两种消费方案，根据活动用途选用；同一份共享额度不会按两种方案重复相加。短期限按实际覆盖缩小用量，免费配额不足时按配额封顶。</p>
      <div class="method-example"><b>文本计算例子</b><p>若输入价为 $2/百万 Token、输出价为 $8/百万 Token，完整月度参考为 1 × $2 + 0.2 × $8 = <strong>$3.60</strong>。若只能用 15 天，先把用量减半；若实际配额更少，再按配额算。</p></div>
    </section>
    <section id="method-pools" tabindex="-1">
      <h2>多个模型与多个额度池，怎么避免重复算</h2>
      <p>普通多模型活动先按<strong>同用途、同规格</strong>去掉别名和重复版本，再分别计算成本，取<strong>较低中位数</strong>：奇数取中间项，偶数取较低的中间项。例如 $2、$4、$8、$10，参考值为 $4。不会把每个模型的金额全加起来。</p>
      <p>缺价模型不会当成 $0。若只覆盖部分模型，说明中会标出缺价和暂定范围；信息不足时保留“价值待定”。同版本公测模型还没有付费价时，也不会拿免费期的 $0 生成购买参考值。</p>
      <p>文本、图片、视频等有<strong>真实独立的免费额度池</strong>，才可各选一个匹配的用途计算后相加。若共用一份积分或余额，只算一次，通常采用一个用途，不能把同一池同时当成图片、视频和文本三份权益。</p>
    </section>
    <section id="method-benchmarks" tabindex="-1">
      <h2>有些金额是参照方案，要连着假设一起看</h2>
      <p>积分兑换关系不透明，或权益没有直接售价时，部分条目采用指定入门套餐、代表模型或套餐倍数作<strong>暂定参照</strong>。这会注明是“套餐价格参照”或“模型成本参照”，并写出选择与限制。参照套餐的积分单价，不表示已证明不同套餐的同名积分可以等量互换；参照模型也不等于实际赠送的模型。</p>
      <div class="method-example"><b>试用卡与重置的分数参照</b><p>若某条明确采用 $20 月费 ÷ 4，参考就是 <strong>$5</strong>；它不是所有 7 天卡的通用算法，也不表示恢复了四分之一的真实 Token。多张卡先算单卡参照，再乘本次实际卡数；不据此声称每张卡都有额外独立 Token 池。</p></div>
      <p>有两种都适用、可复算的算法时，可以取较低值，并保留其他算法与规格差异。特定条目接受的套餐、倍数或候选价，只适用于该条，不自动推广给其他活动。</p>
      <p><strong>申请制单独看：</strong>真实的最高可申请额度，按官方计划和完整期限列出；月度上限只有明确释放安排时才算。“月度使用方案参考”则是指定模型与工作量的购买成本，和申请额度独立，既不表示保证获批，也不表示有保证可得的下限，不混入普通羊毛合计。</p>
      <p class="method-note">例如海纳百川的特定医疗机构方案，采用通用文本月用量的 30 倍（输入 3,000 万、输出 600 万 Token）。这是该方案的工作量假设，不是所有医疗工具的默认用量，也不是机构资助上限。</p>
    </section>
    <section id="method-evidence" tabindex="-1">
      <h2>每一条，都可以回到计算依据</h2>
      <p>打开羊毛详情的<strong>“估值说明”</strong>，可以查看采用的套餐或模型、数量与单位、公式、来源、核价日期、汇率和适用限制。金额看起来相近，也可能来自不同的权益期限或假设，请把说明一起看。</p>
      <a class="btn pri" href="#today">回牧场挑羊毛</a>
    </section>
  </article>`;
  $$('[data-method-section]').forEach(button => button.addEventListener('click', () => {
    const section = $('#method-' + button.dataset.methodSection);
    if (!section) return;
    section.scrollIntoView({ behavior: REDUCED ? 'instant' : 'smooth', block: 'start' });
    section.focus({ preventScroll: true });
  }));
}

/* ---------- 覆盖范围 ---------- */
function pCoverage() {
  const cv = COVERAGE || { platforms: PLATFORMS.length, sources: 0, byKind: {}, officialPages: [] };
  const K = { web_list: ['官网页面 / 帮助文档', '每 6 小时，只看羊毛相关句子是否变化'], rss: ['官方 RSS', '每 6 小时'], json: ['官方接口', '每 6 小时'], aihot: ['AIHOT 公开接口', '每小时，含 Codex 重置与赠额'], hn: ['Hacker News', '线索，每 6 小时'], reddit: ['Reddit', '线索，由常开机器中继'], email: ['订阅邮箱', '计划中'], manual: ['补录', '通过 Hermes 转发链接'], sweep: ['周六发现扫描', '计划中'], discord: ['Discord 公告频道', '计划中'] };
  const rows = Object.entries(cv.byKind || {}).map(([k, v]) => [K[k] ? K[k][0] : k, K[k] ? K[k][1] : '', `${v.enabled} 个`, v.failing ? stBadge('warn', '!', `${v.failing} 个连续失败`) : stBadge('good', '✓', '正常')]);
  const gaps = [
    ['微信公众号', '没有自动抓取；靠官网同步公告和补录。', 'warn'],
    ['X（推特）', '只覆盖 AIHOT 已跟踪的账号和官网同步公告。', 'warn'],
    ['Discord', '计划中：关注厂商官方公告频道。', 'critical'], ['产品内通知 / 私信邮件', '计划中：订阅邮箱。', 'critical'],
  ];
  const plist = uniq((cv.officialPages || []).map(x => x.platformId));
  main().innerHTML = ribbon() + ph('覆盖范围', '我们在看哪些地方、还有哪些看不到。只收能追到官方出处的羊毛，不保证覆盖全球所有活动，也不保证抓到所有短时福利。') + `
  <section class="kpis" style="margin-top:0">
    <div class="kpi"><span class="k-l">已准入平台</span><span class="k-v">${cv.platforms}<small>个</small></span></div>
    <div class="kpi"><span class="k-l">监控信源</span><span class="k-v">${cv.sources}<small>个</small></span></div>
    <div class="kpi"><span class="k-l">最近成功采集</span><span class="k-v">${LAST_OK ? hm(LAST_OK) : '—'}</span></div>
    <div class="kpi"><span class="k-l">采集频率</span><span class="k-v">6<small>小时一次</small></span></div>
  </section>
  <section>${secH('正在监控')}<div class="card tbl" style="padding:4px 8px"><table><thead><tr><th>渠道</th><th>方式</th><th>规模</th><th>状态</th></tr></thead><tbody>${rows.map(r => `<tr><td>${r[0]}</td><td>${r[1]}</td><td>${r[2]}</td><td>${r[3]}</td></tr>`).join('')}</tbody></table></div></section>
  <section>${secH('官方页面监控', `${plist.length} 个平台`)}<div class="chips">${plist.map(id => PMAP[id] ? `<a class="chip" href="#platform-${id}">${esc(PMAP[id].name)}</a>` : '').join('')}</div></section>
  <section>${secH('已知缺口')}<div class="rows">${gaps.map(g => `<div class="orow" style="grid-template-columns:auto minmax(0,1fr)">${stBadge(g[2], g[2] === 'critical' ? '✕' : '!', g[2] === 'critical' ? '暂不覆盖' : '部分覆盖')}<span class="t">${g[0]}<small>${g[1]}</small></span></div>`).join('')}</div></section>
  <section>${secH('平台白名单', `${platformGroups().length} 家（只列有条目的平台）`)}<div class="chips">${platformGroups().map(g => g.company
    ? `<span class="chip"><b>${esc(g.company)}</b>&nbsp;${g.items.map(p => `<a href="#platform-${p.id}">${esc(productName(p))}</a>`).join(' · ')}</span>`
    : `<a class="chip" href="#platform-${g.items[0].id}">${etagSvg(ptypeColor(g.items[0].type)).replace('<svg ', '<svg style="width:10px;height:12px" ')}${esc(g.items[0].name)}</a>`).join('')}</div></section>`;
}

/* ---------- 后台 ---------- */
/* ---------- 后台（管理员密钥登录；数据走 /api/admin） ---------- */
// 管理员密钥：默认存 sessionStorage（刷新不丢，关标签页即清除）；勾选“记住”才存 localStorage。读写失败就只在内存里。
const ADM_KEY = 'ym-admin-token';
const admStore = {
  load() { try { return sessionStorage.getItem(ADM_KEY) || localStorage.getItem(ADM_KEY) || ''; } catch (e) { return ''; } },
  save(token, remember) { try { sessionStorage.setItem(ADM_KEY, token); if (remember) localStorage.setItem(ADM_KEY, token); else localStorage.removeItem(ADM_KEY); } catch (e) { /* 存不了就只在本次打开有效 */ } },
  clear() { try { sessionStorage.removeItem(ADM_KEY); localStorage.removeItem(ADM_KEY); } catch (e) { /* 忽略 */ } },
};
const ADM = { token: admStore.load(), tab: 'queue' };
async function restoreAdminRole() {
  if (!ADM.token || ADM.role) return;
  try { const me = await adm('/whoami'); ADM.role = me.role; ADM.who = me.who; }
  catch { /* Normal browsing remains available if the stored administrator session fails. */ }
}
function dateTimeInput(value) {
  const d = new Date(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === value ? `${value}T00:00` : '';
  return value && Number.isFinite(d.getTime()) ? new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '';
}
async function adm(path, body) {
  const r = await fetch('/api/admin' + path, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: 'Bearer ' + ADM.token, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401) { ADM.token = ''; ADM.role = ''; admStore.clear(); throw new Error('管理员密钥不正确，请重新登录'); }
  if (!r.ok) throw Object.assign(new Error((j.error || ('请求失败 ' + r.status)) + (Array.isArray(j.issues) && j.issues.length ? '：' + j.issues.map(i => `${FIELD_L[i.path?.[0]] || i.path?.join('.') || ''} ${i.message}`.trim()).join('；') : '')), { body: j });
  return j;
}
const TIER_L = { site: '官网', docs: '官方文档', official: '官方账号', staff: '员工账号', media: '媒体 / 社区转述', tested: '管理员实测（我亲自领到过）' };
const EX_L = [['benefit', '权益'], ['eligibility', '资格'], ['claim', '领取方式'], ['validity', '有效期']];
const TAG_L = { reset: '额度重置', referral: '邀请奖励', discount: '首月 / 限时折扣', daily: '每日刷新' }; // 与 src/shared/spec.ts TAGS 一致
/** 上架前检查：服务器按 src/shared/spec.ts 算好，这里只负责显示。 */
function checksBlock(o) {
  const main = (o.checks || []).filter(i => i.level !== 'info'), info = (o.checks || []).filter(i => i.level === 'info');
  const line = i => `<div class="orow" style="grid-template-columns:auto minmax(0,1fr);padding:5px 2px">${i.level === 'block' ? stBadge('critical', '✕', '必须补') : stBadge('warn', '!', '建议补')}<span class="t" style="font-weight:400;font-size:13px">${esc(i.label)}：${esc(i.problem)}<small>影响：${esc(i.sections.join('、'))}</small></span></div>`;
  return `<div class="card" style="padding:8px 10px;background:var(--surface-2)"><div class="small" style="font-weight:600;margin-bottom:2px">${o.reviewState==='approved'?'公开字段检查':'上架前检查'}</div>${main.length ? `<div class="rows">${main.map(line).join('')}</div>` : '<div class="small" style="color:var(--good-ink)">✓ 字段齐全，网站所有栏目和推送都能正确显示</div>'}${info.length ? `<div class="small muted" style="margin-top:4px">可选：${info.map(i => esc(i.label)).join('、')}</div>` : ''}</div>`;
}
const REASON_LABEL = { relay_station: '中转站', account_pool: '号池', personal_giveaway: '个人赠送', ordinary_discount: '普通折扣', model_news_only: '仅模型新闻', unverifiable: '无法核实', paid_bundle: '付费套餐自带', non_ai: '不是 AI 额度', wrong_platform: '平台归错', duplicate: '重复', expired: '旧活动 · 日期查不到', other: '其他', not_ai: '不是 AI 额度', wrong_type: '分类错', vague: '额度不明', insufficient_evidence: '证据不足', wrong_field: '字段错' };
const RC = ['relay_station', 'account_pool', 'personal_giveaway', 'ordinary_discount', 'model_news_only', 'unverifiable', 'paid_bundle', 'non_ai', 'wrong_platform', 'duplicate', 'expired', 'other'].map(code => [code, REASON_LABEL[code]]);
const FIELD_L = { models: '免费模型', tags: '标签', publishedAt: '发布时间', usdMax: '最高可申请额度', valuation: '估值', steps: '领取步骤', sourceTz: '官方时区', modalities: '模态', title: '标题', type: '类型', valueText: '额度', usdEstimate: '折合美元', claimStart: '开始', claimEnd: '截止', endKind: '截止方式', creditValidity: '有效期', audience: '适用对象', membershipRequirement: '会员资格', requirements: '门槛', modalities: '模态', platformId: '平台', sourceTz: '时区', claimMethod: '领取方式' };
const SUG = { approve: ['good', '✓', '建议通过'], history: ['good', '⌛', '建议作为历史上架'], reject: ['bad', '✕', '建议拒绝'], judge: ['warn', '?', '需要你判断'] };
const RCL_ALL = { ...REASON_LABEL };
function reviewDiffRows(changes) {
  const rows = [];
  const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  const visit = (field, before, after) => {
    if (JSON.stringify(before ?? null) === JSON.stringify(after ?? null)) return;
    if (field === 'evidence.capturedAt' || field === 'evidence.pageHash') return;
    if (object(before) || object(after)) {
      const a = object(before) ? before : {}, b = object(after) ? after : {};
      for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) visit(`${field}.${key}`, a[key], b[key]);
      return;
    }
    const empty = v => v == null || v === '' || (Array.isArray(v) && v.length === 0);
    if (empty(before) && empty(after)) return;
    rows.push({ field, before, after, kind: empty(before) ? 'add' : empty(after) ? 'remove' : 'modify' });
  };
  for (const change of changes || []) visit(change.field, change.from, change.to);
  return rows;
}
function reviewDiffLabel(field) {
  const evidence = { 'evidence.url': '证据链接', 'evidence.tier': '证据级别', 'evidence.excerpts.benefit': '权益原文', 'evidence.excerpts.eligibility': '资格原文', 'evidence.excerpts.claim': '领取方式原文', 'evidence.excerpts.validity': '有效期原文' };
  return evidence[field] || (field === 'sourceId' ? '采集信源' : FIELD_L[field]) || field;
}
function reviewDiffValue(field, value) {
  if (field === 'type') return TYPES[value]?.l || String(value);
  if (field === 'audience') return AUD[value] || String(value);
  if (field === 'claimMethod') return CLAIM[value] || String(value);
  if (field === 'endKind') return { date: '有截止日期', unknown: '截止未知', standing: '常驻 / 申请制' }[value] || String(value);
  if (field === 'evidence.tier') return TIER_L[value] || String(value);
  if (field === 'platformId') return PLATFORMS.find(p => p.id === value)?.name || String(value);
  if (field === 'requirements') return reqLabel(value);
  if (field === 'tags') return TAG_L[value] || String(value);
  if (field === 'modalities') return MODAL[value] || String(value);
  if (field === 'usdEstimate' || field === 'usdMax') return `$${value}`;
  return typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value);
}
/** LCS keeps the matching context readable, including repeated list items and Chinese text. */
function reviewDiffOps(a, b) {
  const ops = [], emit = (kind, value) => { const last = ops.at(-1); if (last?.kind === kind) last.values.push(value); else ops.push({ kind, values: [value] }); };
  if ((a.length + 1) * (b.length + 1) > 200000) {
    let start = 0, end = 0;
    while (start < a.length && start < b.length && a[start] === b[start]) start++;
    while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
    a.slice(0, start).forEach(v => emit('same', v));
    a.slice(start, a.length - end).forEach(v => emit('remove', v));
    b.slice(start, b.length - end).forEach(v => emit('add', v));
    a.slice(a.length - end).forEach(v => emit('same', v));
    return ops;
  }
  const width = b.length + 1, dp = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) dp[i * width + j] = a[i] === b[j] ? dp[(i + 1) * width + j + 1] + 1 : Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1]);
  let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { emit('same', a[i++]); j++; }
    else if (j < b.length && (i === a.length || dp[i * width + j + 1] > dp[(i + 1) * width + j])) emit('add', b[j++]);
    else emit('remove', a[i++]);
  }
  return ops;
}
function reviewDiffPair(row) {
  const a = row.before, b = row.after;
  const absent = v => v == null || v === '' || (Array.isArray(v) && !v.length);
  const mark = (text, kind) => kind === 'remove' ? `<del>${esc(text)}</del>` : kind === 'add' ? `<ins>${esc(text)}</ins>` : esc(text);
  if (Array.isArray(a) || Array.isArray(b)) {
    const ops = reviewDiffOps(Array.isArray(a) ? a.map(v => JSON.stringify(v)) : [], Array.isArray(b) ? b.map(v => JSON.stringify(v)) : []);
    const side = kind => `<ol>${ops.flatMap(op => op.kind === (kind === 'before' ? 'add' : 'remove') ? [] : op.values.map(v => `<li>${mark(reviewDiffValue(row.field, JSON.parse(v)), op.kind)}</li>`)).join('')}</ol>`;
    return { before: absent(a) ? '<span class="muted">未填写</span>' : side('before'), after: absent(b) ? '<span class="muted">已清空</span>' : side('after') };
  }
  const ops = reviewDiffOps(absent(a) ? [] : Array.from(reviewDiffValue(row.field, a)), absent(b) ? [] : Array.from(reviewDiffValue(row.field, b)));
  const side = kind => ops.filter(op => op.kind !== (kind === 'before' ? 'add' : 'remove')).map(op => mark(op.values.join(''), op.kind)).join('');
  return { before: absent(a) ? '<span class="muted">未填写</span>' : side('before'), after: absent(b) ? '<span class="muted">已清空</span>' : side('after') };
}
function reviewDiffBlock(o) {
  if (!o.pendingUpdate) return '';
  if (!Array.isArray(o.updateDiff)) return '<div class="review-diff small">更新差异暂未加载，请刷新后核对旧版与新版。</div>';
  const rows = reviewDiffRows(o.updateDiff);
  const counts = { add: 0, remove: 0, modify: 0 }; rows.forEach(row => counts[row.kind]++);
  const labels = { add: '新增', remove: '删除', modify: '修改' };
  return `<details open class="review-diff" data-update-diff><summary><b>本次更新对比</b><span class="review-diff-counts">${Object.entries(counts).filter(([, n]) => n).map(([kind, n]) => `<span class="diff-badge diff-${kind}">${labels[kind]} ${n}</span>`).join('')}</span></summary><p class="small muted">逐项比较当前公开内容与待审更新，高亮处表示增删改。</p>${rows.length ? rows.map(row => { const pair = reviewDiffPair(row); return `<section class="review-diff-field" data-diff-field="${esc(row.field)}"><div class="review-diff-heading"><b>${esc(reviewDiffLabel(row.field))}</b><span class="diff-badge diff-${row.kind}">${labels[row.kind]}</span></div><div class="review-diff-pair"><div><span class="small muted">当前公开</span><div class="review-diff-value">${pair.before}</div></div><div><span class="small muted">待审更新</span><div class="review-diff-value">${pair.after}</div></div></div></section>`; }).join('') : '<p class="small">条款字段没有变化，仅核验记录更新。</p>'}</details>`;
}

function sugBlock(o, live = false) {
  const g = o.suggestion; if (!g) return '';
  const [tone, icon, defaultLabel] = SUG[g.verdict] || SUG.judge;
  const label = g.verdict === 'reject' ? (live ? '建议下架' : o.pendingUpdate ? '建议拒绝本次更新' : '建议拒绝收录')
    : o.pendingUpdate && g.verdict === 'approve' ? '建议接受更新' : defaultLabel;
  const rejectLabel = live ? '下架此条目' : o.pendingUpdate ? '拒绝更新，保留已上架内容' : '拒绝收录';
  const color = tone === 'bad' ? 'var(--critical-ink)' : tone === 'warn' ? 'var(--warn-ink)' : 'var(--good-ink)';
  return `<div class="card" style="padding:8px 10px;border-left:4px solid ${color};margin:0"><div class="row" style="gap:8px;flex-wrap:wrap"><b style="color:${color}">${icon} ${label}</b>${g.code ? `<span class="chip">${esc(RCL_ALL[g.code] || g.code)}</span>` : ''}<span class="small muted">${esc(g.by || '')}${g.at ? ' · ' + esc(g.at.slice(0, 10)) : ''}</span></div><div class="small warn-note" style="margin-top:4px;color:var(--ink)">${esc(g.reason || '')}</div>${g.verdict === 'reject' ? `<p class="small" style="margin:6px 0 0">同意此建议：点击下方“${rejectLabel}”，再确认。${o.pendingUpdate && !live ? '已上架内容继续公开。' : ''}</p>` : ''}</div>`;
}
function reviewActions(o, live) {
  const edit = o.pendingUpdate && !live ? '修改更新' : live ? o.status==='stale'?'核对并修订证据':'补字段' : '修改';
  if (live) return `<div class="row review-actions"><span class="st ${o.status==='stale'?'warn':'good'}"><b>${o.status==='stale'?'!':'✓'}</b>${o.status==='stale'?'已批准 · 待核验':'已上架'}</span><button class="btn sm" type="button" data-act="edit">${edit}</button>${ADM.role === 'reviewer' ? '' : `<button class="btn sm bad" type="button" data-act="rejectopen">${o.status==='stale'?'核实后下架':'下架此条目'}</button>`}</div>`;
  if(o.preparation?.stage==='collecting')return '<p class="small muted">系统正在补齐官方证据，暂不需要你作通过或拒绝决定。</p><div class="row review-actions"><button class="btn sm" data-act="edit">补充准确入口或资料</button></div>';
  const accept = o.pendingUpdate ? '接受更新' : o.status === 'ended' ? '通过并收录历史' : '通过并上架';
  const tested = o.evidenceTier === 'media';
  const blocked = o.preparation?.stage==='blocked'||(o.checks || []).some(i => i.level === 'block')
    || o.pendingUpdate && o.membershipRequirement?.status === 'needs_review';
  return `<div class="row review-actions"><button class="btn sm good" type="button" ${blocked ? `disabled title="先点“${edit}”补齐标红的字段"` : `data-act="${tested ? 'tested' : 'approve'}"${tested ? ' title="官方没有文字公告，但你亲自领到过"' : ''}`}>✓ ${tested ? '我已实测，' : ''}${accept}</button><button class="btn sm" type="button" data-act="edit">${edit}</button><button class="btn sm bad" type="button" data-act="rejectopen">✕ ${o.pendingUpdate ? '拒绝更新，保留已上架内容' : '拒绝收录'}</button></div>${blocked ? `<p class="small" style="margin:0;color:var(--critical-ink)">先点“${edit}”补齐“必须补”的字段</p>` : ''}${o.pendingUpdate ? '<p class="small muted" style="margin:0">接受更新会替换已上架内容；拒绝更新会保留已上架内容。</p>' : ''}`;
}
function pAdmin(focusId) {
  if (focusId) { ADM.tab = 'queue'; ADM.sug = 'all'; }
  if (!ADM.token) {
    main().innerHTML = ribbon() + ph('后台', '用管理员密钥登录。刷新页面不用重新输入，关掉标签页后需要重新登录；勾选“记住”则一直保留，直到退出登录。') + `
    <form id="admLogin" class="card" style="max-width:460px;display:flex;flex-direction:column;gap:10px">
      <label class="field" for="admTok">管理员密钥<input type="password" id="admTok" autocomplete="off" placeholder="输入管理员密钥"></label>
      <label class="row small" style="gap:6px;align-items:center"><input type="checkbox" id="admRemember"> 在这台电脑上记住（公用电脑不要勾选）</label>
      <button class="btn pri" type="submit">登录</button><p class="small muted" id="admErr" style="margin:0"></p>
    </form>`;
    $('#admLogin').addEventListener('submit', async e => {
      e.preventDefault(); ADM.token = $('#admTok').value.trim();
      try { const me = await adm('/whoami'); ADM.role = me.role; ADM.who = me.who; admStore.save(ADM.token, $('#admRemember').checked); render(true); } catch (err) { $('#admErr').textContent = err.message; }
    });
    return;
  }
  if (!ADM.role) { adm('/whoami').then(me => { ADM.role = me.role; ADM.who = me.who; render(true); }).catch(err => { main().innerHTML = `<div class="card"><p>${esc(err.message)}</p></div>`; }); main().innerHTML = emptySheep('加载中…'); return; }
  const reviewer = ADM.role === 'reviewer';
  const tabs = reviewer ? [['queue', '待审'], ['leads', '线索'], ['manual', '补录']] : [['screening', '初筛'], ['fast', '⚡ 快速上架'], ['queue', '待审'], ['quality', '准确率'], ['leads', '线索'], ['manual', '补录'], ['platforms', '平台'], ['health', '采集健康']];
  if (!tabs.some(([k]) => k === ADM.tab)) ADM.tab = 'queue';
  main().innerHTML = ph('审核工作台', reviewer ? `审核员：${esc(ADM.who)}` : '', `<button class="btn sm" type="button" id="admOut">退出登录</button>`) + `
  <div class="seg admin-tabs" role="tablist" style="margin-bottom:14px">${tabs.map(([k, l]) => `<button type="button" data-admtab="${k}" aria-pressed="${ADM.tab === k}">${l}</button>`).join('')}</div>
  <div id="admBody">${emptySheep('加载中…')}</div>`;
  $('#admOut').addEventListener('click', () => { ADM.token = ''; ADM.role = ''; ADM.who = ''; admStore.clear(); render(true); });
  $$('[data-admtab]').forEach(b => b.addEventListener('click', () => { if (ADM.tab === 'fast' || b.dataset.admtab === 'fast') ADM.fastPrefill = null; ADM.tab = b.dataset.admtab; if (route()[1]) location.hash = 'admin'; render(true); }));
  ({ screening: admScreening, fast: admFastTrack, queue: admQueue, quality: admQuality, leads: admLeads, manual: admManual, platforms: admPlatforms, health: admHealth })[ADM.tab]().catch(err => { $('#admBody').innerHTML = `<div class="card"><p>${esc(err.message)}</p></div>`; if (!ADM.token) render(true); });
}
function officialReviewBlock(o) {
  const r=o.officialReview;
  if(o.reviewState==='approved'&&!r)return '';
  if(!r && o.evidenceTier!=='media'&&o.preparation?.stage!=='collecting')return '';
  const at=value=>Number.isNaN(Date.parse(value))?'时间未知':new Date(value).toLocaleString('zh-CN');
  const labels={checking:'正在搜索与复核',matched:'AI 已匹配官方原文，待你审核',unresolved:'暂未找到充分官方证据',failed:'复核受阻，等待重试'};
  const manualReady=o.preparation?.stage==='ready'&&['failed','unresolved'].includes(r?.status);
  const historical=o.reviewState==='approved';
  return `<details class="small" data-official-review><summary style="cursor:pointer;font-weight:600">🔎 ${historical?'审批前的补证记录（已人工通过）':manualReady?'系统补证未完成 · 可人工审核':r?labels[r.status]||'官方复核':'等待自动搜索官方出处'}</summary>
    <p>${esc(r?.reason || '工作流会自动搜索官网、官方文档和已登记的官方 X 账号，找到原文后补全待审字段。')}</p>
    ${r?`<p>已尝试 ${r.attempts} 次 · ${esc(at(r.checkedAt))}${r.nextAttemptAt?` · 下次重试 ${esc(at(r.nextAttemptAt))}`:r.status==='unresolved'||r.status==='failed'?(o.evidenceTier==='media'?' · 等待人工核对，可重新排队':' · 已保留现有官方证据，等待人工审核'):''}</p>`:''}
    ${r?.originUrl?`<p>原社区线索：<a href="${esc(r.originUrl)}" target="_blank" rel="noopener">${esc(r.originUrl)}</a></p>`:''}
    ${r?.queries?.length?`<p>搜索词：${r.queries.map(esc).join('；')}</p>`:''}
    ${(r?.candidates||[]).map(url=>`<p><a href="${esc(url)}" target="_blank" rel="noopener">${esc(url)}</a></p>`).join('')}
    ${r?.changedFields?.length?`<p>补全字段：${r.changedFields.map(f=>esc(FIELD_L[f]||f)).join('、')}</p>`:''}
    ${(o.evidenceTier==='media'||o.preparation?.stage==='blocked')&&r?.status!=='checking'?'<button class="btn sm" type="button" data-official-retry>重新排入官方复核</button>':''}</details>`;
}
function leadTaskCard(l) {
  const r=l.resolution, labels={checking:'正在自动核验',retry:'等待自动重试',manual:'需要你判断',linked:'已关联活动',closed:'已结束线索'};
  const when=r?.nextAttemptAt?new Date(r.nextAttemptAt).toLocaleString('zh-CN'):null;
  return `<div class="card" data-lead-task="${l.id}" style="margin-bottom:8px"><b>#${l.id} ${esc(l.title||'线索')}</b><p class="small">${labels[r?.status]||'已排入自动官方复核'}${when?` · 下次 ${esc(when)}`:''}${r?` · 已尝试 ${r.attempts} 次`:''}</p>
    <p class="small">${esc(l.note||'将读取原文、核对官方出处及已有活动')}</p><a href="${esc(l.url)}" target="_blank" rel="noopener">查看原始线索 ↗</a>
    ${r?.evidenceUrl?`<p class="small"><a href="${esc(r.evidenceUrl)}" target="_blank" rel="noopener">处理依据 ↗</a> ${esc(r.quote||'')}</p>`:''}
    <details style="margin-top:8px"><summary>处理这条线索</summary><label class="field">处理依据<input data-lead-reason placeholder="例如：同一次发放的进度说明"></label>
    <label class="field">关联已有条目<input data-lead-offer placeholder="粘贴条目网址、4 位短码（如 2r48）或完整 ID"></label>
    <div class="row"><button class="btn sm" data-lead-resolve="retry">重新官方核验</button><button class="btn sm" data-lead-resolve="linked">关联已有活动</button><button class="btn sm" data-lead-resolve="closed">结束线索</button></div><p class="small" role="status" data-lead-feedback></p></details>
    ${ADM.role==='admin'?'<button type="button" class="btn sm" data-lead-fast>转到快速上架</button>':''}</div>`;
}
function bindLeadTasks(box,tasks){
  box.querySelectorAll('[data-lead-task]').forEach(card=>{
    const l=tasks.find(x=>String(x.id)===card.dataset.leadTask);if(!l)return;
    card.querySelector('[data-lead-fast]')?.addEventListener('click',()=>openFastTrackForm({benefit:l.title||'',url:l.url||'',note:(l.note||'').slice(0,1000)},l.id));
    card.querySelectorAll('[data-lead-resolve]').forEach(button=>button.addEventListener('click',async()=>{
      const outcome=button.dataset.leadResolve,reason=card.querySelector('[data-lead-reason]').value.trim(),offerId=card.querySelector('[data-lead-offer]').value.trim(),message=card.querySelector('[data-lead-feedback]');
      if(outcome!=='retry'&&reason.length<2){message.textContent='请先填写处理依据';return;}
      if(outcome==='linked'&&!offerId){message.textContent='请填写要关联的条目：网址、短码或 ID';return;}
      const buttons=card.querySelectorAll('[data-lead-resolve]');buttons.forEach(b=>b.disabled=true);
      try{const done=await adm(`/leads/${l.id}/resolve`,{expectedVersion:l.reviewVersion,outcome,reason:reason||'管理员要求重新官方核验',...(offerId?{offerId}:{})});
        message.textContent=outcome==='retry'?'已排入自动官方复核，下轮处理':outcome==='linked'?`已关联到 [${done?.offer?.code??''}] ${done?.offer?.title??''}`:'已结束，处理依据已保存';
        card.dataset.resolved='1';
      }catch(e){message.textContent=e.message;buttons.forEach(b=>b.disabled=false);}
    }));
  });
}
// Refresh only platform choices; never redraw an open editor or discard its draft.
function adminPlatformOptions(id = '', name = '') {
  const list = PLATFORMS.slice();
  if (id && !list.some(p => p.id === id)) list.push({ id, name: name || id });
  return list.sort((a, b) => a.name.localeCompare(b.name, 'zh')).map(p =>
    `<option value="${esc(p.id)}" ${p.id === id ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
}
let adminPlatformsRefresh = null;
async function refreshAdminPlatforms() {
  if (adminPlatformsRefresh) return adminPlatformsRefresh;
  adminPlatformsRefresh = (async () => {
    try {
      const response = await fetch(`/api/platforms?fresh=${Date.now()}`, { cache: 'no-store', headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error(`平台列表 ${response.status}`);
      const data = await response.json();
      if (!Array.isArray(data.platforms)) throw new Error('平台列表格式不正确');
      PLATFORMS = data.platforms.map(p => ({ id: p.id, name: p.name, type: p.type, site: p.site || '', x: (p.xHandles || []).join(' · '), company: p.company || '', aliases: p.aliases || [] }));
      PMAP = Object.fromEntries(PLATFORMS.map(p => [p.id, p]));
      $$('#admBody select[name="platformId"]').forEach(select => {
        const id = select.value, name = select.selectedOptions?.[0]?.textContent || id;
        select.innerHTML = adminPlatformOptions(id, name);
      });
    } catch (_) { /* Keep cached choices and the current offer's explicit platform option. */ }
  })();
  try { await adminPlatformsRefresh; }
  finally { adminPlatformsRefresh = null; }
}
const IDENTITY_KIND={initial:'新活动',terms_change:'条款变更',evidence_reopen:'补足证据',identity:'待核对的权益',merge_conflict:'身份冲突'};
function identityFactsTable(previous,current){
 const names={issuerProductId:'发放产品',mechanism:'领取机制',benefitPools:'额度与周期',eligibility:'资格',geography:'地区',claimChannels:'领取渠道',costs:'费用与续费',claimWindow:'领取窗口',occurrenceAnchor:'独立活动依据'};
 const words={once:'单次',calendar:'自然周期',rolling:'滚动周期',daily:'每日',monthly:'每月',signup_grant:'注册赠额',recurring_quota:'周期额度',poolKey:'额度池',amount:'额度',cadence:'重置周期',models:'模型',modalities:'模态',creditValidity:'额度有效期',kind:'周期方式',unit:'单位',period:'周期',upfrontAmount:'预付金额',currency:'币种',subscriptionRequired:'需订阅',autoRenewal:'自动续费',start:'开始',end:'结束',timezone:'时区',text:'文本',day:'天',month:'月'};
 const show=v=>{if(v==null||v.state==='unknown')return '未确认';if(v.state==='not_applicable')return '不适用';if(v.state==='known')return show(v.value);if(Array.isArray(v))return v.map(show).join('；\n');if(typeof v==='object'){if(v.unit&&v.value!==undefined)return v.value+' '+(v.currency||words[v.unit]||v.unit);return Object.entries(v).filter(([k])=>k!=='evidenceRefs').map(([k,x])=>(words[k]||k)+'：'+show(x)).join('\n');}if(typeof v==='boolean')return v?'是':'否';return words[v]||String(v);};
 return `<div style="overflow:auto"><table class="small"><thead><tr><th>关键事实</th><th>${previous?'已批准':'无已批准版本'}</th><th>本次待审</th></tr></thead><tbody>${Object.keys(current||{}).filter(k=>k!=='schemaVersion').map(k=>`<tr><th>${esc(names[k]||k)}</th><td style="white-space:pre-wrap">${esc(show(previous?.[k]))}</td><td style="white-space:pre-wrap">${esc(show(current[k]))}</td></tr>`).join('')}</tbody></table></div>`;
}
function renderIdentityTasks(box,data,append=false,managedIds=new Set()){
 if(!append)box.innerHTML='<div class="review-group-label">权益查重</div>'+(data.error?`<p role="alert">${esc(data.error)}，请刷新重试。</p>`:'');
 for(const t of data.tasks||[]){
 if(managedIds.has(t.id))continue;
 const card=document.createElement('article');card.className='card';card.dataset.identityTask=t.id;card.dataset.offerId=t.entity?.canonical_offer_id||'';card.style.marginBottom='14px';
 const candidate=t.sources?.[0],historyOverflow=!!t.reviewPreparation?.canDecide&&t.reviewPreparation.scanned>(t.historyOptions||[]).length&&!t._historyLoaded,canDecide=t.reviewPreparation?.canDecide!==false&&!historyOverflow,historyOptions=(t.historyOptions||[]).filter(o=>o.offerId),needsIdentity=['identity','merge_conflict'].includes(t.kind)||(t.kind==='evidence_reopen'&&!t.entity);
 const canPrepareNow=needsIdentity&&!canDecide&&['needs_system_review','history_incomplete'].includes(t.reviewPreparation?.state)&&(t.sources||[]).length>0&&(t.sources||[]).every(source=>source.provenance?.sourceVerified&&!source.provenance?.truncated);
 const earlyReject=needsIdentity&&!canDecide&&!t.visibilityBlocked&&t.sources?.length===1;
 const nextAttemptMs=Date.parse(t.reviewPreparation?.nextAttemptAt||''),nextAttemptLabel=Number.isFinite(nextAttemptMs)?nextAttemptMs<=Date.now()?'等待下一轮定时任务':new Date(nextAttemptMs).toLocaleString('zh-CN'):null;
 card.innerHTML=`<div class="row" style="justify-content:space-between"><b>${esc(t.display?.title||t.candidateDisplay?.title||IDENTITY_KIND[t.kind]||'活动审核')}</b><span class="chip">${esc(t.visibilityRestoration?'恢复发布待审':IDENTITY_KIND[t.kind]||t.kind)}</span></div><p>${esc(t.display?.valueText||t.candidateDisplay?.valueText||'先核对原文，再决定是否属于同一活动。')}</p>
 ${t.reviewPreparation?.urgency==='imminent'?`<p class="small warn-note" data-identity-urgency>记录的领取截止：${esc(t.reviewPreparation.deadline||'即将到期')}。系统优先核查；证据不足时仍保持待审，不会自动上架。</p>`:t.reviewPreparation?.urgency==='time_limited'?`<p class="small warn-note" data-identity-urgency>${t.reviewPreparation.deadline?`记录的领取截止：${esc(t.reviewPreparation.deadline)}。`:'限时权益，准确截止日期尚未确认。'}系统优先核查；请留意实际截止时间。</p>`:t.reviewPreparation?.urgency==='dated'?`<p class="small" data-identity-urgency>记录的领取截止：${esc(t.reviewPreparation.deadline)}</p>`:t.reviewPreparation?.urgency==='expired'?'<p class="small warn-note" data-identity-urgency>记录的领取期限已过；如仍属实，只能核对是否作为历史活动保留。</p>':''}
 ${!canDecide?`<div class="card small" data-identity-preparation><b>${historyOverflow?'历史活动需要逐页核对':'系统核查中'}</b><p>${esc(t.reviewPreparation?.reason||'历史活动尚未查完')}</p><p>${historyOverflow?'请加载完整列表；读完之前不能判断是否为独立活动。':'这一步不用填写内部身份 ID，也不需要先通过或拒绝。'}</p>${nextAttemptLabel?`<p>最早可重试：${esc(nextAttemptLabel)}；由下一轮定时任务执行。</p>`:''}${historyOverflow?'<button type="button" class="btn sm" data-identity-load-history>加载完整历史活动</button>':''}${canPrepareNow?'<button type="button" class="btn sm" data-identity-prepare-now>立即核对历史活动</button>':''}</div>`:''}
 ${canDecide&&needsIdentity?`<div class="card small" data-identity-guidance><b>系统建议 · 仍需人工决定</b><p>${esc(t.reviewPreparation?.reason||'请根据官方原文核对是否为同一次发放。')}</p>${t.reviewPreparation?.modelResult?.relation==='SAME'&&historyOptions.some(o=>o.entityId===t.reviewPreparation.modelResult.entityId)?`<p>模型辅助找到可能对应的旧活动：${esc(historyOptions.find(o=>o.entityId===t.reviewPreparation.modelResult.entityId)?.title)}。请核对领取机制与活动轮次，不能据此直接通过。</p>`:t.reviewPreparation?.modelResult?'<p>模型未能确认唯一对应活动；请以官方原文和完整历史列表为准。</p>':''}</div>`:''}
 ${t.reviewPreparation?.manualHint?`<div class="small warn-note" data-identity-manual-hint><b>${t.reviewPreparation.manualHint.kind==='previously_rejected'?'人工标记：疑似曾被拒绝':'人工标记：疑似重复'}</b><p>${esc(t.reviewPreparation.manualHint.reason)}</p><p>仍待核对，不会据此自动合并、拒绝或上架。</p></div>`:''}
 ${needsIdentity&&t.candidateDisplay?`<div class="small"><b>本次候选</b> · ${esc(PMAP[t.candidateDisplay.platformId]?.name||t.candidateDisplay.platformId||'发放方待核')} · ${esc(t.candidateDisplay.claimMethod||'领取方式待核')}</div>`:''}
 ${!needsIdentity && t.display ? reviewValuationBlock(t.display) : ''}
 ${needsIdentity&&canDecide?`<details data-identity-history><summary>已核对的同平台历史活动（${esc(t.reviewPreparation?.scanned??historyOptions.length)} 项）</summary><p class="small">同一来源或相似标题只是线索，需核对是否为同一轮、同一领取方式。</p>${historyOptions.slice(0,12).map(o=>`<p class="small">${o.sameSource?'<b>同一来源页面 · 优先核对</b> · ':''}${esc(o.title)} · ${esc(o.valueText)} · ${esc(o.offerId)}${o.sourceUrl?` · ${esc(o.sourceUrl)}`:''}</p>`).join('')||'<p class="small">未找到可展示的旧活动，提交时仍会核对旧拒绝决定。</p>'}</details>`:''}
 <details><summary>查看结构化事实与去重详情</summary>${identityFactsTable(t.previousFacts,t.facts||candidate?.facts)}</details>
 <p class="small">人工保留字段（只读）：${(t.protectedFields||[]).map(x=>esc(FIELD_L[x]||x)).join('、')||'无'}</p>
 <details><summary>过往决定</summary>${(t.decisions||[]).map(d=>`<p>${esc(d.action)}：${esc(d.reason_text||d.reason_code)}<br><small>${esc(d.scope_json)}</small></p>`).join('')||'<p>暂无决定</p>'}</details>
 ${(t.sources?.length||0)>1&&needsIdentity?`<p class="small warn-note" data-identity-group>同一活动的 ${t.sources.length} 条报道已合并到这张卡：你的决定作用于所选来源，其余来源按重复一并结案；拒绝则整组拒绝。若其中有不同的活动，请先在“本次处理的候选”里逐条处理。</p>`:''}
 <details open><summary>来源与原文（${t.sources?.length||0}${t.sourcesComplete===false?'＋':''}）</summary>${(t.sources||[]).map(source=>`<p class="small">${t.reviewPreparation?.sourceReverified&&(t.reviewPreparation.sourceReverifiedCandidateIds||[t.reviewPreparation.sourceCandidateId]).includes(source.candidateId)?'✓ 已重新核验这一段官方原文':source.provenance?.sourceVerified?'✓ 已核实发放方官方来源':'! 来源尚待核实'}</p><p><a href="${esc(source.final_url)}" target="_blank" rel="noopener">${esc(source.final_url)}</a></p>${(source.quotes||[]).map(q=>`<blockquote style="white-space:pre-wrap">${esc(q.quote)}</blockquote>`).join('')}`).join('')}${t.reviewPreparation?.sourceReverified&&t.reviewPreparation.sourceUrl?`<p class="small">最近重新核验的官方页面：<a href="${esc(t.reviewPreparation.sourceUrl)}" target="_blank" rel="noopener">${esc(t.reviewPreparation.sourceUrl)}</a></p>`:''}${t.sourcesComplete===false?'<p>更多来源已保存；当前显示前 10 条。</p>':''}</details>
 ${!t.sources?.length&&t.display?.evidence?`<details open><summary>候选证据（请核对原文）</summary><p>${esc(t.display.evidence.url)}</p>${Object.values(t.display.evidence.excerpts||{}).filter(Boolean).map(q=>`<blockquote>${esc(q)}</blockquote>`).join('')}</details>`:''}
 <label class="field">拒绝类别<select data-identity-category><option value="">拒绝时必选</option>${RC.filter(([k]) => !['not_ai', 'wrong_type'].includes(k)).map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select></label>
 <label class="field">决定说明<input data-identity-reason placeholder="拒绝或身份判断时填写依据"></label>
 ${needsIdentity&&canDecide?`<label class="field">本次处理的候选<select data-identity-candidate>${(t.sources||[]).map((c,i)=>`<option value="${esc(c.candidateId)}" ${i===0?'selected':''}>${esc(c.final_url)}</option>`).join('')}</select></label><label class="field">可能对应的旧活动${t.historyOptions?`<select data-identity-target><option value="">先选择或保持为空</option>${historyOptions.map(o=>`<option value="${esc(o.entityId)}">[${esc(({approved:'已上架',rejected:'已拒绝',pending:'待审'})[o.reviewState]||'状态待确认')}] ${esc(o.title)} · ${esc(o.valueText)}${o.offerId?' · '+esc(o.offerId):''}</option>`).join('')}</select>`:'<input data-identity-target placeholder="请输入已核对的内部活动身份 ID">'}</label><p class="small muted">关联同一活动请选择已上架主条；与已拒绝记录重复时，请使用“拒绝”，类别选“重复”，并在说明中写明原记录。</p><label class="field">已核对发放平台<select data-identity-product><option value="">保留候选原值</option>${PLATFORMS.map(p=>`<option value="${esc(p.id)}" ${t.reviewPreparation?.productId===p.id?'selected':''}>${esc(p.name)}</option>`).join('')}</select></label><label class="field">已核对领取机制<select data-identity-mechanism><option value="">保留候选原值</option>${Object.entries({signup_grant:'注册赠额',recurring_quota:'周期额度',referral:'邀请奖励',identity_grant:'身份福利',trial:'试用',temporary_free_access:'限时免费',extra_reset:'额外重置',application_grant:'申请额度',other:'其他'}).map(([key,label])=>`<option value="${key}">${label}</option>`).join('')}</select></label>`:''}
 ${needsIdentity&&canDecide&&ADM.role!=='reviewer'?'<details data-identity-claim-advanced><summary class="small">高级（少用）：本候选就是以前某条被拒绝的主张</summary><p class="small muted">普通拒绝不需要这里。只有要把本候选挂到一条旧的拒绝决定上时才用。</p><label class="field">已核对的原拒绝决定 ID<input data-identity-claim-decision></label><button type="button" class="btn sm" data-identity-claim-search>查询已拒主张</button><div data-identity-claim-options></div><button type="button" class="btn sm" data-identity-action="same_claim">关联原拒绝主张</button></details>':''}
 ${t.visibilityBlocked?'<p role="alert">活动已暂停发布，请管理员先明确重开。</p>':''}
 ${needsIdentity&&!canDecide&&!t.visibilityBlocked?'<details data-identity-early-hint open><summary>我已核对：直接结案（不必等系统）</summary><p class="small">在“决定说明”写清依据（如已上架条目的链接或短码）。点下即生效：整张卡（含所有来源）按所选原因拒绝结案，不会上架；属实的新福利请用下方 ⚡ 快速上架。</p><button type="button" class="btn sm" data-identity-hint="suspected_duplicate">确认重复并结案</button><button type="button" class="btn sm" data-identity-hint="previously_rejected">按所选拒绝类别结案</button></details>':''}
 ${earlyReject?'<details data-identity-early-review><summary>我已核实：提前拒绝此单个候选</summary><p class="small">仅当你已核对它与旧权益或原拒绝主张确实重复时使用。请写明依据；此操作记录新的人工拒绝，不会合并旧活动或自动上架。</p><button type="button" class="btn sm" data-identity-action="reject">预览拒绝此候选</button></details>':''}
 ${canDecide&&!t.visibilityBlocked?'<p class="small muted" style="margin:6px 0 2px">选好后点下面一个按钮，再点出现的「✅ 确认提交」才会保存。</p>':''}
 <div class="row review-actions">${(t.visibilityBlocked||!canDecide?[]:!needsIdentity?[['approve','预览通过'],['reject','预览拒绝']]:[...(t.historyOptions&&!historyOptions.length?[]:[['same','关联同一活动']]),['new','建立独立待审活动'],...(t.historyOptions&&!historyOptions.length?[]:[['distinct','确认与所选旧活动不同']]),['reject','拒绝（整张卡，只需类别和说明）']]).map(([a,l])=>`<button type="button" class="btn sm" data-identity-action="${a}">${l}</button>`).join('')}</div>
 <div data-identity-preview hidden></div><p role="status" data-identity-feedback></p>
 ${ADM.role==='admin'?'<button type="button" class="btn sm" data-identity-fast-track>转到快速上架</button>':''}`;
 box.append(card);
 if(box.closest('.review-workspace'))compactReviewCard(card,{title:t.display?.title||t.candidateDisplay?.title||'活动查重',value:t.display?.valueText||t.candidateDisplay?.valueText,status:!canDecide?'系统核查中':'查重待决',action:'核对活动',url:t.sources?.[0]?.final_url,facts:[['待处理',t.reviewPreparation?.reason],['来源数量',String(t.sources?.length||0)]]});
 card.querySelector('[data-identity-fast-track]')?.addEventListener('click',()=>openFastTrackForm({platformId:t.candidateDisplay?.platformId||t.display?.platformId||'',url:t.candidateDisplay?.evidenceUrl||t.sources?.[0]?.final_url||t.display?.evidence?.url||'',benefit:String(t.candidateDisplay?.valueText||t.display?.valueText||t.candidateDisplay?.title||'').slice(0,500),title:String(t.candidateDisplay?.title||t.display?.title||'').slice(0,120)},null,{identityTaskId:t.id}));
 card.querySelectorAll('[data-identity-hint]').forEach(button=>button.addEventListener('click',async()=>{
  const reason=card.querySelector('[data-identity-reason]').value.trim(),feedback=card.querySelector('[data-identity-feedback]');
  // 2026-10-16: a manual mark used to be only a hint the system never acted on. It now closes the card at once.
  if(reason.length<8){feedback.textContent='请至少写 8 字依据（如已上架条目的链接或短码）';return;}
  const duplicate=button.dataset.identityHint==='suspected_duplicate',category=duplicate?'duplicate':card.querySelector('[data-identity-category]')?.value||'';
  if(!category){feedback.textContent='请先在“拒绝类别”选择原因';return;}
  button.disabled=true;
  try{await adm('/identity/tasks/'+encodeURIComponent(t.id)+'/resolve',{action:'reject',requestId:'ui-identity-close-'+Date.now()+'-'+Math.random().toString(36).slice(2),expectedRevision:t.revision,reasonCategory:category,reason:(duplicate?'管理员确认重复：':'管理员结案：')+reason});feedback.textContent='已结案：整张卡按'+(REASON_LABEL[category]||category)+'拒绝，不会上架。';card.querySelectorAll('button:not([data-review-close]):not([data-review-open]),input,select').forEach(b=>b.disabled=true);card.style.opacity=.5;}
  catch(error){feedback.textContent=error.message;button.disabled=false;}
 }));
 card.querySelector('[data-identity-prepare-now]')?.addEventListener('click',async event=>{
  const button=event.currentTarget,feedback=card.querySelector('[data-identity-feedback]');button.disabled=true;
  try{
   for(let page=0;page<4;page++){
    const result=await adm('/identity/tasks/'+encodeURIComponent(t.id)+'/prepare',{requestId:'ui-identity-prepare-'+Date.now()+'-'+Math.random().toString(36).slice(2),expectedRevision:t.revision});
    t.revision=result.revision;
    if(result.status==='scanning')continue;
    if(result.status==='needs_source'){feedback.textContent='历史核对已启动，但官方来源仍需系统补证；请保留待审。';button.disabled=false;return;}
    await admQueue();return;
   }
   feedback.textContent='已核对四页历史活动；点击可继续，尚不能作身份决定。';button.disabled=false;
  }catch(error){feedback.textContent=error.message;button.disabled=false;}
 });
 card.querySelector('[data-identity-load-history]')?.addEventListener('click',async event=>{
  const button=event.currentTarget;button.disabled=true;
  try{
   let cursor=t._historyPageCursor||'',all=t._historyPageEntries||[],complete=false;
   for(let pageNumber=0;pageNumber<4;pageNumber++){
    const page=await adm('/identity/tasks/'+encodeURIComponent(t.id)+'/comparisons'+(cursor?'?cursor='+encodeURIComponent(cursor):''));
    if(page.issuerProductId!==t.reviewPreparation.productId||!Array.isArray(page.entries))throw new Error('历史来源发生变化，请刷新后重试');
    all=[...new Map([...all,...page.entries].map(item=>[item.entityId,item])).values()];
    complete=page.complete===true;cursor=page.nextCursor||'';
    if(complete||!cursor)break;
   }
   t._historyPageEntries=all;t._historyPageCursor=cursor;
   if(!complete){button.textContent='已核对 '+all.length+' 项，继续加载';button.disabled=false;return;}
   t.historyOptions=all;t._historyLoaded=true;
   card.remove();renderIdentityTasks(box,{tasks:[t]},true,managedIds);
  }catch(error){card.querySelector('[data-identity-feedback]').textContent=error.message;button.disabled=false;}
 });
 let claimCursor='';
 card.querySelector('[data-identity-claim-search]')?.addEventListener('click',async event=>{const button=event.currentTarget,options=card.querySelector('[data-identity-claim-options]');button.disabled=true;try{const product=candidate?.facts?.issuerProductId,productId=product?.state==='known'?product.value:t.reviewPreparation?.productId,query=new URLSearchParams({cursor:claimCursor,...(productId?{productId}:{})});const page=await adm('/identity/claim-decisions?'+query);for(const d of page.decisions||[]){const section=document.createElement('section');section.innerHTML=`<p>${esc(d.reason)}<br><small>${esc(d.id)}</small></p>${identityFactsTable(null,d.facts)}${(d.quotes||[]).map(q=>`<blockquote>${esc(q.quote)}</blockquote>`).join('')}<button type="button" class="btn sm" data-identity-claim-choice>选择此拒绝决定</button>`;section.querySelector('button').addEventListener('click',()=>{card.querySelector('[data-identity-claim-decision]').value=d.id;});options.append(section);}claimCursor=page.nextCursor||'';button.textContent=page.nextCursor?'加载更多已拒主张':'已加载全部拒绝主张';button.disabled=!page.nextCursor;}catch(error){options.textContent=error.message;button.disabled=false;}});
 card.querySelectorAll('[data-identity-action]').forEach(button=>button.addEventListener('click',()=>{
  const action=button.dataset.identityAction,reason=card.querySelector('[data-identity-reason]').value.trim(),target=card.querySelector('[data-identity-target]')?.value.trim();const feedback=card.querySelector('[data-identity-feedback]');
  const reasonCategory=card.querySelector('[data-identity-category]')?.value||'';
  if(action==='reject'&&!reasonCategory){feedback.textContent='请先选择拒绝类别';return;}
  if(action!=='approve'&&reason.length<(earlyReject&&action==='reject'?8:2)){feedback.textContent=earlyReject&&action==='reject'?'请至少写 8 字说明重复或原拒绝依据':'请先填写决定说明';return;}if(['same','distinct'].includes(action)&&!target){feedback.textContent='请填写已核对的活动身份 ID';return;}
  const claimDecision=card.querySelector('[data-identity-claim-decision]')?.value.trim();if(action==='same_claim'&&(!claimDecision||reason.length<8)){feedback.textContent='请填写原拒绝决定 ID 和至少 8 字的对应依据';return;}
  const payload={action,requestId:'ui-'+Date.now()+'-'+Math.random().toString(36).slice(2),expectedRevision:t.revision,...(reason?{reason}:{}),...(action==='reject'?{reasonCategory,...(earlyReject?{scope:{kind:'claim',candidateId:t.sources[0].candidateId}}:{})}:{}),...(['same','new','distinct','same_claim'].includes(action)?{candidateId:card.querySelector('[data-identity-candidate]').value,...(action==='same_claim'?{decisionId:claimDecision}:target?{entityId:target}:{})}: {})};
  if(['same','new','distinct','same_claim'].includes(action)){
   const chosen=t.sources.find(s=>s.candidateId===payload.candidateId);const facts=JSON.parse(JSON.stringify(chosen?.facts||{}));const refs=(chosen?.quotes||[]).map(q=>q.id).filter(Boolean);const product=card.querySelector('[data-identity-product]').value,mechanism=card.querySelector('[data-identity-mechanism]').value;
   // "Same as a listed perk" is the owner's call (server owner-override): no mechanism needed, and no facts sent —
   // attaching the platform select made the candidate's facts "known" and disabled that path (2026-10-16 即梦 card).
   if(action!=='same'){
   if(['new','distinct'].includes(action)&&facts.mechanism?.state!=='known'&&!mechanism){feedback.textContent='先在“已核对领取机制”里选择领取机制（建立新活动需要）';feedback.scrollIntoView?.({block:'center'});return;}
   if((product||mechanism)&&!refs.length){feedback.textContent='缺少可引用原文，请先补充证据';return;}
   if(product)facts.issuerProductId={state:'known',value:product,evidenceRefs:refs};if(mechanism)facts.mechanism={state:'known',value:mechanism,evidenceRefs:refs};if(product||mechanism)payload.facts=facts;
   }
  }
  const preview=card.querySelector('[data-identity-preview]');preview.hidden=false;preview.innerHTML=`<p>将按当前审核版本 ${t.revision} ${action==='approve'?'确认通过，发布本次条款':action==='reject'?earlyReject?'拒绝此单个候选并保留审计记录；不会合并旧活动或上架':'确认拒绝本次候选，保留历史决定':action==='same_claim'?'确认与原拒绝主张对应；复用原拒绝，符合补证规则时保持待审':'确认活动身份，保留待审状态'}。</p><button class="btn pri" data-identity-confirm>✅ 确认提交${action==='approve'?'通过':action==='reject'?'拒绝':'身份判断'}</button>`;preview.style.border='1px solid var(--pri,#f5c518)';preview.style.padding='8px';preview.style.borderRadius='8px';preview.scrollIntoView?.({block:'center',behavior:'smooth'});
  preview.querySelector('button').addEventListener('click',async event=>{const confirmButton=event.currentTarget;confirmButton.disabled=true;try{const result=await adm('/identity/tasks/'+encodeURIComponent(t.id)+'/resolve',payload);if(result.outcome==='deferred'&&result.retryable){feedback.textContent='历史决定尚未检查完，请继续检查；当前任务仍保持待审。';confirmButton.textContent='继续检查';confirmButton.disabled=false;return;}feedback.textContent='决定已保存';card.querySelectorAll('button:not([data-review-close]):not([data-review-open]),input,select').forEach(b=>b.disabled=true);
   // Grouped card: the decision applies to the chosen source; the other reports of the same perk close as its duplicates in one call.
   const others=['same','new','distinct'].includes(action)?(t.sources||[]).filter(x=>x.candidateId!==payload.candidateId):[];
   if(others.length){try{await adm('/identity/tasks/'+encodeURIComponent(t.id)+'/resolve',{action:'reject',requestId:'ui-group-'+Date.now()+'-'+Math.random().toString(36).slice(2),expectedRevision:t.revision+1,reasonCategory:'duplicate',reason:`同组其余 ${others.length} 条来源与本次处理的来源为同一活动${result.canonicalOfferId?'（'+result.canonicalOfferId+'）':''}`});feedback.textContent=`决定已保存；同组其余 ${others.length} 条来源已按重复一并结案`;}catch(error){feedback.textContent=`决定已保存；同组其余 ${others.length} 条未能一并结案（${error.message}），请刷新后处理`;}}
  }catch(error){feedback.textContent=error.message;confirmButton.disabled=false;}});
 }));
 }
 if(data.nextCursor){const more=document.createElement('button');more.className='btn sm';more.textContent='加载更多活动';box.append(more);more.addEventListener('click',async()=>{more.disabled=true;try{const page=await adm('/identity/tasks?cursor='+encodeURIComponent(data.nextCursor));more.remove();renderIdentityTasks(box,page,true,managedIds);}catch(error){more.disabled=false;more.textContent=error.message;}});}
}

function reviewValuationBlock(o) {
  const v = valuationOf(o);
  if (!v) return '<div class="small warn-note" data-review-valuation>参考价值尚无完整计算依据；不能仅填写金额后通过审核。</div>';
  const sources = (v.sources || []).filter(s => { try { return ['https:', 'http:'].includes(new URL(s.url).protocol); } catch { return false; } });
  return `<details data-review-valuation open><summary>参考价值：${esc(({priced:'已估值',provisional:'暂定估值',...VALUE_STATUS})[v.status] || '待核实')}${v.usdEstimate != null ? ` · ${money(v.usdEstimate)}` : ''}${v.usdMax != null ? ` · 最高可申请 ${money(v.usdMax)}` : ''}</summary>
    <p class="small">${esc(({one_time:'一次性',monthly:'每月',first30:'月度参考价值',apply_max:'申请制'})[v.period] || v.period)}${v.baselineModel ? ` · 基准模型：${esc(v.baselineModel)}` : ''}</p>
    ${v.formula ? `<div class="value-formula">${esc(v.formula)}</div>` : '<p class="small">金额留空，不按零元计入汇总。</p>'}
    ${(v.assumptions || []).map(x => `<p class="small">${esc(x)}</p>`).join('')}
    ${sources.map(s => `<div class="value-source"><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.priceBasis || '价格与权益依据')} ↗</a><small>核价 ${esc(s.checkedAt || '')}</small><blockquote>${esc(s.excerpt || '')}</blockquote></div>`).join('')}
    <p class="small muted">请核对权益数量、模型、单位与计算依据；通过审核后才公开本次结果。</p></details>`;
}

/** One review card; live = already listed (edit/unpublish, no approve). Shared by the queue and the listing page's online edit. */
function adminCard(o, live = false) {
  return `<article class="card" data-code="${o.code}" data-task-id="${esc(o.identityTaskId||'')}" data-offer-id="${esc(o.id)}" data-live="${live ? 1 : ''}" data-type="${esc(o.type)}" data-sug="${o.suggestion?.verdict || 'none'}" style="display:flex;flex-direction:column;gap:10px">
    <div class="row" style="justify-content:space-between"><span class="row" style="gap:8px">${TYPES[Object.keys(TYPES).find(k => TYPES[k].l === o.type)] ? etag(Object.keys(TYPES).find(k => TYPES[k].l === o.type)) : esc(o.type)}<span class="chip">${esc(o.platform)}</span><span class="st ${o.evidenceTier === 'media' ? 'warn' : 'good'}"><b>${o.evidenceTier === 'media' ? '!' : '✓'}</b>${TIER_L[o.evidenceTier] || o.evidenceTier}</span>${o.pendingUpdate ? '<span class="st warn"><b>!</b>条款更新待审，旧版仍公开</span>' : ''}${o.status === 'ended' ? '<span class="st"><b>⌛</b>已结束，通过后计入历史</span>' : ''}</span><span class="small muted num">${esc(o.code)}</span></div>
    <div><div style="font-weight:600;font-size:16px">${esc(o.title)}</div><div class="${/未写明|不明确/.test(o.value) ? 'warn-note' : ''}" style="margin-top:4px">${esc(o.value)}</div><div class="small muted" style="margin-top:4px">${esc(o.end)} · 额度有效期：${esc(o.creditValidity || '未写')} · 门槛：${o.requirements.map(r => esc(reqLabel(r))).join('、')} · 对象：${AUD[o.audience] || o.audience}</div></div>
    ${o.preparation&&!live?`<div class="small warn-note" data-review-preparation><b>${esc(o.preparation.label)}</b><p>${esc(o.preparation.reason)}</p></div>`:''}
    ${reviewDiffBlock(o)}
    ${sugBlock(o, live)}
    ${checksBlock(o)}
    ${reviewValuationBlock(o)}
    <div class="rows">${EX_L.filter(([k]) => k !== 'claim' || o.excerpts[k]).map(([k, l]) => `<div class="orow" style="grid-template-columns:auto minmax(0,1fr);padding:6px 2px">${o.excerpts[k] ? `<span class="st good"><b>✓</b>${l}</span>` : `<span class="st warn"><b>!</b>${l}</span>`}<span class="t" style="font-weight:400;font-size:13.5px">${o.excerpts[k] ? '「' + esc(o.excerpts[k]) + '」' : '原文里没有找到'}</span></div>`).join('')}</div>
    <div class="small" style="word-break:break-all">来源：<a href="${esc(o.evidenceUrl)}" target="_blank" rel="noopener" style="text-decoration:underline">${esc(o.evidenceUrl)}</a></div>
    ${officialReviewBlock(o)}
    ${reviewActions(o, live)}
    ${o.reviewMemo ? `<details open class="small"><summary style="cursor:pointer;font-weight:600">🔍 核验记录（仅管理员可见）</summary><div style="white-space:pre-wrap;margin-top:6px;color:var(--ink-2)">${esc(o.reviewMemo)}</div></details>` : ''}
    <details><summary class="small" style="cursor:pointer">💬 牧场心得${o.adminNote ? '（已写）' : '（可选，公开显示）'}</summary><div class="row" style="margin-top:6px;align-items:flex-start"><textarea data-note rows="2" maxlength="500" style="flex:1;min-width:160px" placeholder="实际用下来怎么样？比如：免费模型速度慢、容易限流">${esc(o.adminNote || '')}</textarea><button class="btn sm" type="button" data-act="note">保存心得</button><span data-note-status role="status" class="small" style="align-self:center"></span></div></details>
    <div data-rejectbox hidden style="display:flex;flex-direction:column;gap:8px">
      <p class="small muted" style="margin:0">${live ? '下架后，本条目不再公开显示，审核记录保留。' : o.pendingUpdate ? '确认后仅拒绝本次更新提案，已上架内容保持原样、继续公开。' : '拒绝后，本条目不会上架。已结束但属实的活动请点“修改”补全开始和截止日期，再通过并收录历史。'}</p>
      <div class="chips">${RC.map(([k, l]) => `<button class="btn sm" type="button" data-rc="${k}" aria-pressed="false">${l}</button>`).join('')}</div>
      <div class="row review-actions"><input type="text" placeholder="补充理由（写清楚，模型以后学得更快）" data-reason style="flex:1;min-width:160px;padding:6px 10px"><button class="btn sm bad" type="button" data-act="reject" disabled>${live ? '确认下架' : o.pendingUpdate ? '确认拒绝更新，保留已上架内容' : '确认拒绝收录'}</button></div>
    </div>
    <template data-edittemplate><form data-editform hidden class="filters" style="margin:0">
      ${[['title', '标题', o.title], ['valueText', '额度', o.value], ['creditValidity', '额度有效期', o.creditValidity || '']].map(([k, l, v]) => `<label class="field">${l}<input type="text" name="${k}" value="${esc(v)}"></label>`).join('')}
      <label class="field">领取开始（可空）<input type="date" name="claimStart" value="${esc(o.claimStart || '')}"></label>
      <label class="field">领取截止（可空）<input type="date" name="claimEnd" value="${esc(o.claimEnd || '')}"></label>
      <label class="field">确定的月度参考价值（可空）<input type="number" step="any" min="0" name="usdEstimate" value="${o.usdEstimate ?? ''}"></label>
      <label class="field">最高可申请额度（申请制，可空）<input type="number" step="any" min="0" name="usdMax" value="${o.usdMax ?? ''}"></label>
      <label class="field">官方时区（日期按哪里的时间算）<select name="sourceTz">${(() => { const tz = o.sourceTz || 'UTC', opts = [['Asia/Shanghai', '北京时间（中国厂商）'], ['America/Los_Angeles', '美国西部时间（多数美国厂商）'], ['America/New_York', '美国东部时间'], ['Europe/London', '英国时间'], ['Europe/Paris', '欧洲中部时间'], ['Asia/Tokyo', '日本时间'], ['Asia/Singapore', '新加坡时间'], ['UTC', '世界标准时间 UTC（官方没写时区）']]; return (opts.some(([k]) => k === tz) ? opts : [...opts, [tz, tz]]).map(([k, l]) => `<option value="${k}" ${k === tz ? 'selected' : ''}>${l}</option>`).join(''); })()}</select></label>
      <label class="field">官方发布时间（可空，按你电脑的本地时间填；额度重置要精确到分钟）<input type="datetime-local" name="publishedAt" value="${dateTimeInput(o.publishedAt)}">${/^\d{4}-\d{2}-\d{2}$/.test(o.publishedAt || '') && dateTimeInput(o.publishedAt) ? '<span class="small muted">仅有日期，00:00 是填表占位；未改动则保留日期精度。</span>' : ''}${o.publishedAt && !dateTimeInput(o.publishedAt) ? '<span class="small" role="alert" style="color:var(--critical-ink)">原发布时间无效，请核对后补填；保存时空值会清除原错误日期。</span>' : ''}</label>
      ${(() => { const rq = o.requirements || [], val = k => (rq.find(r => r.startsWith(k + ':')) || '').slice(k.length + 1);
        return `<div class="field" style="grid-column:1/-1">门槛（领之前必须满足的条件，可多选；手机号、信用卡、网络只指海外）<div class="chips">${['none', 'realname', 'phone', 'card', 'net', 'biz', 'student', 'invite', 'targeted', 'unknown'].map(k => `<label class="chip"><input type="checkbox" name="req" value="${k}" ${rq.includes(k) ? 'checked' : ''}> ${REQ[k]}${k === 'student' ? '（含教师）' : ''}</label>`).join('')}</div>
        <div class="row" style="gap:8px;flex-wrap:wrap;margin-top:6px"><label class="chip"><input type="checkbox" name="req" value="pay" ${val('pay') ? 'checked' : ''}> 需充值</label><input type="text" name="reqPay" value="${esc(val('pay'))}" placeholder="充多少，如 首充 10 元" style="flex:1;min-width:160px"></div></div>`; })()}
      <div class="field" style="grid-column:1/-1" data-membership-editor>正在加载会员资格目录…</div>
      <div class="field" style="grid-column:1/-1">模态<div class="chips">${Object.entries(MODAL).map(([k, l]) => `<label class="chip"><input type="checkbox" name="modalities" value="${k}" ${(o.modalities || []).includes(k) ? 'checked' : ''}> ${l}</label>`).join('')}</div></div>
      <div class="field" style="grid-column:1/-1">标签<div class="chips">${Object.entries(TAG_L).map(([k, l]) => `<label class="chip"><input type="checkbox" name="tags" value="${k}" ${(o.tags || []).includes(k) ? 'checked' : ''}> ${l}</label>`).join('')}</div></div>
      <label class="field" style="grid-column:1/-1">领取步骤（一行一步）<textarea name="steps" rows="3">${esc((o.steps || []).join('\n'))}</textarea></label>
      <label class="field" style="grid-column:1/-1">免费模型（逗号分隔，按官方写法；用于“按模型找”）<input type="text" name="models" value="${esc((o.models || []).join('，'))}" placeholder="如：Gemini 3.8 Flash，GLM-4.7-Flash"></label>
      <label class="field" style="grid-column:1/-1">官方证据链接<input type="url" name="evidenceUrl" value="${esc(o.evidenceUrl)}"></label>
      <label class="field">证据级别<select name="evidenceTier">${Object.entries(TIER_L).map(([key, name]) => `<option value="${key}" ${o.evidenceTier === key ? 'selected' : ''}>${name}</option>`).join('')}</select></label>
      ${EX_L.map(([key, name]) => `<label class="field" style="grid-column:1/-1">${name}原文摘录<textarea name="excerpt_${key}" rows="3">${esc(o.excerpts[key] || '')}</textarea></label>`).join('')}
      <label class="field">类型<select name="type">${Object.entries(TYPES).map(([k, v]) => `<option value="${k}" ${v.l === o.type ? 'selected' : ''}>${v.l}</option>`).join('')}</select></label>
      <label class="field">截止方式<select name="endKind">${[['date', '有截止日期'], ['unknown', '截止未知'], ['standing', '常驻 / 申请制']].map(([k, l]) => `<option value="${k}" ${o.endKind === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <label class="field">领取方式<select name="claimMethod">${Object.entries(CLAIM).map(([k, l]) => `<option value="${k}" ${o.claimMethod === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <label class="field">平台<select name="platformId">${adminPlatformOptions(o.platformId || PLATFORMS.find(p => p.name === o.platform)?.id, o.platform)}</select></label>
      <label class="field">适用对象<select name="audience">${Object.entries(AUD).map(([k, l]) => `<option value="${k}" ${o.audience === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <label class="field" style="grid-column:1/-1">为什么这样改（可选，但强烈建议写）<input type="text" name="__reason" placeholder="例如：要先付费升级才送，属于充值赠送"></label>
      <div class="row review-actions" style="grid-column:1/-1;align-items:center"><button class="btn sm pri" type="submit">${!live || o.pendingUpdate ? '保存草稿' : '保存'}</button><span data-formmsg role="alert" class="small" style="font-weight:600"></span></div>
    </form></template>
  </article>`;
}
/** Wires a review card's actions. ctx: find(code, live, taskId) → card data, done(el, message), reload() after a draft save. */
function bindAdminCards(scope, ctx) {
  $$('[data-code]', scope).forEach(el => {
    const code = el.dataset.code, live = el.dataset.live === '1', o = ctx.find(code, live, el.dataset.taskId);
    el.querySelector('[data-official-retry]')?.addEventListener('click',async e=>{
      const button=e.currentTarget;button.disabled=true;
      try { await adm(`/offers/${code}/official-retry`,{}); button.textContent='已排队，定时任务会自动复核'; }
      catch(error){button.disabled=false;toast(error.message);}
    });
    // 失败原因显示在按钮旁边，不只在顶部闪一下
    const actMsg = (msg, bad = true) => { let m = el.querySelector('[data-actmsg]'); if (!m) { m = document.createElement('p'); m.dataset.actmsg = ''; m.className = 'small'; m.style.cssText = 'margin:0;font-weight:600'; el.querySelector('[data-act]').closest('.row').after(m); } m.style.color = bad ? 'var(--critical-ink)' : ''; m.textContent = msg; };
    el.querySelector('[data-act="approve"]')?.addEventListener('click', async () => { try { const r = await adm(`/offers/${code}/approve`, {expectedReviewVersion:o?.reviewVersion}); ctx.done(el, `${o?.pendingUpdate ? '已接受更新' : '已通过'}：${r.title}`); } catch (e) { actMsg((o?.pendingUpdate ? '没有接受更新：' : '没有通过：') + e.message); } });
    // 社区传闻 → 管理员实测 → 通过：证据级别改为“管理员实测”，链接和摘录保持原样
    el.querySelector('[data-act="tested"]')?.addEventListener('click', async () => {
      try {
        const managed=/^(identity|entity):/.test(o.reviewVersion||'');
        const saved=await adm(`/offers/${code}/edit`, { fields: { evidence: { url: o.evidenceUrl, tier: 'tested', capturedAt: new Date().toISOString(), excerpts: o.excerpts } }, approve: !managed, expectedReviewVersion:o?.reviewVersion, reason: '社区转述，管理员亲自领到过', reasonCode: 'wrong_field' });
        if(managed||saved.approved===false){toast('已登记亲测并保存待审草稿，请核对后单独通过');await ctx.reload();return;}
        ctx.done(el, `已按管理员实测${o.pendingUpdate ? '接受更新' : '通过'}：${o.title}`);
      } catch (e) { actMsg((o.pendingUpdate ? '没有接受更新：' : '没有通过：') + e.message); }
    });
    const noteInput = el.querySelector('[data-note]'), noteButton = el.querySelector('[data-act="note"]'), noteStatus = el.querySelector('[data-note-status]');
    noteInput.addEventListener('input', () => { if (noteStatus.textContent !== '未保存') noteStatus.textContent = '未保存'; });
    noteButton.addEventListener('click', async () => {
      if (noteButton.disabled) return;
      const note = noteInput.value;
      noteButton.disabled = true; noteStatus.textContent = '保存中…';
      try {
        const saved = await adm(`/offers/${code}/note`, { note });
        if (o && !o.pendingUpdate && saved.reviewVersion && !o.reviewVersion?.startsWith('identity:')) {const entityPrefix=o.reviewVersion?.match(/^(entity:[^:]+:\d+:)/)?.[1];o.reviewVersion=entityPrefix?entityPrefix+saved.reviewVersion:saved.reviewVersion;}
        noteStatus.textContent = noteInput.value === note ? '已保存' : '当前修改未保存';
      } catch (e) { noteStatus.textContent = '没有保存：' + e.message; }
      finally { noteButton.disabled = false; }
    });
    const rb = el.querySelector('[data-rejectbox]');
    let rc = null;
    el.querySelector('[data-act="rejectopen"]')?.addEventListener('click', () => {
      rb.hidden = !rb.hidden;
      // 有“建议拒绝”时自动填好理由代码和理由，确认即可
      const g = o?.suggestion;
      if (!rb.hidden && g?.verdict === 'reject' && !rc && !el.querySelector('[data-reason]').value) {
        rc = g.code || ''; el.querySelector('[data-reason]').value = g.reason || '';
        rb.querySelectorAll('[data-rc]').forEach(x => x.setAttribute('aria-pressed', x.dataset.rc === rc));
        const rejectButton = el.querySelector('[data-act="reject"]'); if (rejectButton) rejectButton.disabled = !rc;
      }
    });
    rb.querySelectorAll('[data-rc]').forEach(b => b.addEventListener('click', () => { rc = rc === b.dataset.rc ? null : b.dataset.rc; rb.querySelectorAll('[data-rc]').forEach(x => x.setAttribute('aria-pressed', x.dataset.rc === rc)); const rejectButton = el.querySelector('[data-act="reject"]'); if (rejectButton) rejectButton.disabled = !rc; }));
    el.querySelector('[data-act="reject"]')?.addEventListener('click', async () => {
      const reason = el.querySelector('[data-reason]').value.trim();
      if (!rc) { toast('先选择拒绝类别'); return; }
      try {
        // 已上架的卡片：下架（对已上架条目调用 reject 只会丢弃更新提案，不会撤下）
        if (live) { if (!reason) { toast('写一句下架理由'); return; } const r = await adm(`/offers/${code}/unpublish`, { reason, reasonCategory: rc, reasonCode: rc, expectedReviewVersion:o?.visibilityVersion??o?.reviewVersion }); ctx.done(el, `已下架：${r.title}`); return; }
        const r = await adm(`/offers/${code}/reject`, { expectedReviewVersion:o?.reviewVersion, reason: reason || undefined, reasonCategory: rc, reasonCode: rc }); ctx.done(el, o?.pendingUpdate ? `已拒绝更新，保留已上架内容：${r.title}` : `已拒绝收录：${r.title}`);
      } catch (e) { toast(e.message); }
    });
    el.querySelector('[data-act="edit"]').addEventListener('click', () => {
      let f = el.querySelector('[data-editform]');
      if (!f) {
        const template = el.querySelector('[data-edittemplate]');
        template.replaceWith(template.content.cloneNode(true));
        f = el.querySelector('[data-editform]');
        f.addEventListener('submit', submitEdit);
        mountMembershipEditor(f, o);
        const platform = f.querySelector('select[name="platformId"]');
        platform.innerHTML = adminPlatformOptions(o.platformId || PLATFORMS.find(p => p.name === o.platform)?.id, o.platform);
        platform.addEventListener('focus', refreshAdminPlatforms);
      }
      f.hidden = !f.hidden;
    });
    const submitEdit = async e => {
      e.preventDefault(); const form = e.currentTarget; const fd = Object.fromEntries(new FormData(form));
      const msg = form.querySelector('[data-formmsg]'), btn = form.querySelector('button[type="submit"]');
      msg.style.color = ''; msg.textContent = '保存中…'; btn.disabled = true;
      try {
      const reason = String(fd.__reason || '').trim(); delete fd.__reason;
      const newEvidence = { url: String(fd.evidenceUrl).trim(), tier: String(fd.evidenceTier), capturedAt: new Date().toISOString(), excerpts: {} };
      for (const [key] of EX_L) { newEvidence.excerpts[key] = String(fd[`excerpt_${key}`] || '').trim(); delete fd[`excerpt_${key}`]; }
      delete fd.evidenceUrl; delete fd.evidenceTier;
      const num = v => (String(v ?? '').trim() === '' ? null : Number(v));
      const checked = name => [...form.querySelectorAll(`input[name="${name}"]:checked`)].map(x => x.value);
      const pub = String(fd.publishedAt || '').trim();
      if (pub && Number.isNaN(Date.parse(pub))) throw new Error('官方发布时间格式不对');
      if (!checked('modalities').length) throw new Error('至少选一个模态');
      const req = checked('req').map(k => k === 'pay' ? `pay:${String(fd.reqPay || '').trim() || '充值'}` : k);
      if (!req.length && membershipRequirementOf(o).status === 'not_required' && (!form.membershipEditor?.touched || form.membershipEditor.requirement.status === 'not_required')) throw new Error('门槛至少勾一项；没有任何条件就勾“零门槛”');
      if (req.includes('none') && req.length > 1) throw new Error('勾了“零门槛”就不能再勾其他门槛');
      delete fd.req; delete fd.reqPay;
      const fields = { ...fd, ...membershipEditFields(o, form.membershipEditor, req, !!form.nonmemberTouched, newEvidence.url), models: [...new Set(String(fd.models || '').split(/[,，、;；]/).map(x => x.trim()).filter(Boolean))],
        usdEstimate: num(fd.usdEstimate), usdMax: num(fd.usdMax), modalities: checked('modalities'), tags: checked('tags'), publishedAt: pub ? (pub === dateTimeInput(o.publishedAt) ? o.publishedAt : new Date(pub).toISOString()) : null,
        steps: String(fd.steps || '').split('\n').map(x => x.trim()).filter(Boolean).slice(0, 10), sourceTz: String(fd.sourceTz || 'UTC').trim() };
      if (o.valuation && (fields.usdEstimate !== (o.usdEstimate ?? null) || fields.usdMax !== (o.usdMax ?? null))) throw new Error('金额须与公式和价格来源一起修改，不能只改数字；当前表单保留原估值，请通过完整估值审核提交更正');
      if (newEvidence.url !== o.evidenceUrl || newEvidence.tier !== o.evidenceTier || EX_L.some(([key]) => newEvidence.excerpts[key] !== (o.excerpts[key] || ''))) fields.evidence = newEvidence;
      ['claimStart', 'claimEnd', 'creditValidity'].forEach(k => { if (!fields[k]) fields[k] = null; });
      const managed=/^(identity|entity):/.test(o.reviewVersion||'');
      if(managed){
        if(fields.platformId&&fields.platformId!==o.platformId)throw new Error('发放平台属于活动身份，请在身份核对流程中更正');
        delete fields.platformId;
        const baseline={...o,type:Object.keys(TYPES).find(k=>TYPES[k].l===o.type)||o.type,valueText:o.value,usdEstimate:o.usdEstimate??o.usd??null};
        const comparable=(key,value)=>JSON.stringify(Array.isArray(value)&&key!=='steps'?[...new Set(value)].sort():value??null);
        for(const key of Object.keys(fields))if(key!=='evidence'&&comparable(key,fields[key])===comparable(key,baseline[key]))delete fields[key];
        if(!Object.keys(fields).length){msg.textContent='没有修改，仍保持待审';btn.disabled=false;return;}
      }
      const r = await adm(`/offers/${code}/edit`, { fields, approve: false, expectedReviewVersion:o?.reviewVersion, reason: reason || undefined, reasonCode: fields.type !== undefined && Object.keys(TYPES).find(k => TYPES[k].l === el.dataset.type) !== fields.type ? 'wrong_type' : 'wrong_field' });
      if(managed || !live || o.pendingUpdate || r.pendingUpdate){toast('草稿已保存，尚未通过上架');await ctx.reload();return;}
      const result = '已保存';
      ctx.done(el, r.changed.length ? `已修改 ${r.changed.map(f => FIELD_L[f] || f).join('、')}；${result}` : `没有改动，${result}`);
      msg.textContent = '';
      } catch (err) { btn.disabled = false; msg.style.color = 'var(--critical-ink)'; msg.textContent = '没有保存：' + err.message; console.error('[admin] 保存失败', err); }
    };
  });
}
/**
 * Online edit on a listing page (admin or reviewer key in this browser). Reuses the review card, so saving goes through
 * POST /offers/:ref/edit with the review version: field contract, membership catalog and publication checks still apply;
 * an identity-managed listing saves a draft that is published only by an explicit approve at its new version.
 */
async function openOnlineEdit(button) {
  const box = $('[data-online-edit-box]'), id = route()[1];
  if (!box || !id) return;
  button.disabled = true; box.innerHTML = '<p class="small muted">正在读取当前审核版本…</p>';
  try {
    if (!ADM.role) { const me = await adm('/whoami'); ADM.role = me.role; ADM.who = me.who; }
    if (!['admin', 'reviewer'].includes(ADM.role)) throw new Error('只有管理员或审核员可以在线编辑');
    await refreshAdminPlatforms();
    const { offer: o } = await adm('/offers/' + encodeURIComponent(id));
    const draft = !!o.pendingUpdate || /^identity:/.test(o.reviewVersion || '') || o.reviewState === 'pending';
    box.innerHTML = `<p class="small muted">${draft ? '有一份待发布的修改：核对后点“通过”才会公开；也可以继续修改或拒绝这次修改。' : '保存时按审核合同校验字段与版本；需要另行审核的改动会保存为待发布修改。'}</p>${adminCard(o, !draft)}`;
    const finish = (el, msg) => { el.style.opacity = .45; el.querySelectorAll('button,input,select,textarea').forEach(x => { x.disabled = true; }); toast(msg); box.insertAdjacentHTML('afterbegin', '<p class="small" role="status">已提交。<button class="btn sm" type="button" data-online-reload>刷新查看公开内容</button></p>'); box.querySelector('[data-online-reload]').addEventListener('click', () => location.reload()); };
    bindAdminCards(box, { find: () => o, done: finish, reload: () => openOnlineEdit(button) });
    if (ADM.role === 'reviewer') $$('[data-plat],[data-autopub],[data-withdraw]', box).forEach(x => x.remove());
    if (!draft) box.querySelector('[data-act="edit"]')?.click();
  } catch (err) { box.innerHTML = `<p class="small" style="color:var(--critical-ink)">${esc(err.message)}</p>`; }
  finally { button.disabled = false; }
}
document.addEventListener('click', e => { const button = e.target.closest?.('[data-online-edit]'); if (button) openOnlineEdit(button); });
/* Queue cards keep their original form nodes and handlers inside a native dialog.
 * Switching workspaces only hides panels; it never reconstructs an unsaved draft. */
function compactReviewCard(card, info) {
  if(card.querySelector('[data-review-dialog]'))return;
  card.classList.add('review-tile');
  const dialog=document.createElement('dialog');dialog.className='review-dialog';dialog.dataset.reviewDialog='';dialog.setAttribute('aria-label',info.title||'审核详情');
  const top=document.createElement('div');top.className='review-dialog-bar';
  top.innerHTML=`<strong>${esc(info.action||'审核详情')}</strong><button type="button" class="btn sm" data-review-close aria-label="关闭详情">关闭</button>`;
  dialog.append(top);
  const body=document.createElement('div');body.className='review-dialog-body';
  while(card.firstChild)body.append(card.firstChild);
  dialog.append(body);
  card.innerHTML=`<div class="review-tile-meta"><span>${esc(info.platform||'')}</span><span class="review-state">${esc(info.status||'待处理')}</span></div><h3 class="review-tile-title">${esc(info.title||'待处理条目')}</h3>${info.value?`<p class="review-tile-value">${esc(info.value)}</p>`:''}<dl class="review-tile-facts">${(info.facts||[]).filter(([,value])=>value).map(([label,value])=>`<div><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`).join('')}</dl><div class="review-tile-actions"><button type="button" class="btn review-primary" data-review-open>${esc(info.action||'审核详情')}</button>${info.url?`<a class="btn" href="${esc(info.url)}" target="_blank" rel="noopener">查看来源</a>`:''}</div>`;
  card.append(dialog);
  const opener=card.querySelector('[data-review-open]');
  opener.addEventListener('click',()=>{if(dialog.showModal)dialog.showModal();else dialog.setAttribute('open','');});
  dialog.querySelector('[data-review-close]').addEventListener('click',()=>{if(dialog.close)dialog.close();else dialog.removeAttribute('open');opener.focus?.();});
}
function compactOfferCards(scope, find) {
  scope.querySelectorAll('[data-code]').forEach(card=>{
    const o=find(card.dataset.code,card.dataset.live==='1',card.dataset.taskId);if(!o)return;
    compactReviewCard(card,{title:o.title,platform:o.platform,value:o.value,url:o.evidenceUrl,
      status:card.dataset.live==='1'?(o.status==='stale'?'已批准 · 待核验':'已上架'):o.pendingUpdate?'条款更新待审':o.preparation?.label||'等待决定',
      action:card.dataset.live==='1'?'补齐字段':'审核详情',facts:[['领取条件',(o.requirements||[]).map(reqLabel).join('、')],['领取期限',o.end],['证据',TIER_L[o.evidenceTier]||o.evidenceTier],...(o.preparation?.reason?[['待处理',o.preparation.reason]]:[])]});
  });
}
function reviewWorkspace(box, q, counts) {
  box.classList.add('review-workspace');
  const specs=[['activities','权益审核',counts.activities],['leads','线索复核',counts.leadReview],['live','已上架、字段待补',(q.incomplete||[]).length]];
  const nav=document.createElement('nav');nav.className='review-workspaces';nav.dataset.reviewSummary='';nav.setAttribute('role','tablist');nav.setAttribute('aria-label','审核环节');
  nav.innerHTML=specs.map(([key,label,count])=>`<button type="button" role="tab" id="review-tab-${key}" aria-controls="review-pane-${key}" data-review-tab="${key}" class="review-tone-${key}">${label} <span ${key==='activities'?'data-activity-count':''}>${count}</span></button>`).join('');
  box.querySelector('[data-review-summary]')?.remove();box.prepend(nav);
  const panels={};
  for(const [key,label] of specs){const panel=document.createElement('section');panel.className=`review-pane review-tone-${key}`;panel.dataset.reviewPane=key;panel.hidden=true;panel.id='review-pane-'+key;panel.setAttribute('role','tabpanel');panel.setAttribute('aria-labelledby','review-tab-'+key);panel.innerHTML=`<h2 class="review-workspace-title">${label}</h2>`;panels[key]=panel;box.append(panel);}
  const move=(selector,key)=>box.querySelectorAll(selector).forEach(node=>panels[key]?.append(node));
  move('[data-activity-section]','activities');move('[data-lead-section], [data-priority-section]','leads');move('[data-live-section], [data-stale-approved]','live');
  const suggestions=box.querySelector('[data-sugtab]')?.parentElement;if(suggestions)panels.activities.insertBefore(suggestions,panels.activities.querySelector('[data-activity-section]'));
  for(const key of ['leads','live'])if(panels[key]&&panels[key].children.length===1)panels[key].insertAdjacentHTML('beforeend','<p class="muted">暂无待处理事项</p>');
  const select=key=>{
    if(!panels[key])key='activities';ADM.workspace=key;
    Object.entries(panels).forEach(([name,panel])=>{panel.hidden=name!==key;});
    nav.querySelectorAll('[data-review-tab]').forEach(button=>{const active=button.dataset.reviewTab===key;button.setAttribute('aria-selected',String(active));button.tabIndex=active?0:-1;});
    if(key==='live'){const details=panels.live.querySelector('[data-incomplete]');if(details&&!details.open){details.open=true;details.dispatchEvent(new window.Event('toggle'));}}
  };
  nav.querySelectorAll('[data-review-tab]').forEach(button=>button.addEventListener('click',()=>select(button.dataset.reviewTab)));
  nav.addEventListener('keydown',event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();const buttons=[...nav.querySelectorAll('button')],index=buttons.indexOf(event.target);const next=event.key==='Home'?0:event.key==='End'?buttons.length-1:(index+(event.key==='ArrowRight'?1:-1)+buttons.length)%buttons.length;select(buttons[next].dataset.reviewTab);buttons[next].focus();});
  return select;
}

function openFastTrackForm(fields = {}, leadId = null, link = {}, onDone = null) {
  ADM.fastPrefill = { fields, leadId, link, onDone };
  ADM.tab = 'fast';
  if (route()[1]) location.hash = 'admin';
  render(true);
}

async function admScreening() {
  const box = $('#admBody');
  box.innerHTML = `<h2>线索初筛</h2>
    <details data-intake-rules><summary>入口关键词规则</summary><div data-intake-body>展开后读取…</div></details>
    <details data-spot-check><summary>自动关闭抽查</summary><div data-spot-body>展开后读取…</div></details>
    <details data-noisy><summary>噪声信源</summary><div data-noisy-body>展开后读取…</div></details>`;
  const rules=box.querySelector('[data-intake-rules]'),spot=box.querySelector('[data-spot-check]'),noisy=box.querySelector('[data-noisy]');
  noisy.addEventListener('toggle',()=>{if(noisy.open&&!noisy.dataset.loaded){noisy.dataset.loaded='1';loadNoisySources(noisy.querySelector('[data-noisy-body]'));}});
  rules.addEventListener('toggle',()=>{if(rules.open&&!rules.dataset.loaded){rules.dataset.loaded='1';loadIntakeRules(rules.querySelector('[data-intake-body]'));}});
  spot.addEventListener('toggle',()=>{if(spot.open&&!spot.dataset.loaded){spot.dataset.loaded='1';loadSpotCheck(spot.querySelector('[data-spot-body]'));}});
}

async function admFastTrack() {
  await refreshAdminPlatforms();
  const box=$('#admBody'),draft=ADM.fastPrefill;
  box.classList.add('review-workspace','review-tone-fast');
  box.innerHTML=`<div class="review-fast-layout"><section><h2>⚡ 快速上架</h2>${fastTrackFormHtml(draft?.fields||{})}</section>
    <section data-fast-track-review><h2>处理进度 <span class="small" data-ft-count>…</span></h2><div data-ft-jobs>正在读取…</div></section></div>`;
  bindFastTrackForm(box.querySelector('[data-fast-track]'),draft?.leadId||null,async()=>{await draft?.onDone?.();ADM.fastPrefill=null;await loadFastTrackJobs(box.querySelector('[data-ft-jobs]'));},draft?.link||{});
  await loadFastTrackJobs(box.querySelector('[data-ft-jobs]'));
}

async function admPlatforms() {
  const box=$('#admBody');
  const q=await adm('/queue');
  if(!box?.isConnected||ADM.tab!=='platforms')return;
  box.innerHTML=`<h2>平台与信源</h2>
    <section><h3>新平台待准入</h3>${(q.pendingPlatforms||[]).map(p=>`<div class="card row" style="justify-content:space-between;margin-bottom:8px"><span>${esc(p.name)}（${esc(p.id)}）${p.site?` · <a href="${esc(p.site)}" target="_blank" rel="noopener">官网</a>`:''}</span><span class="row"><button class="btn sm good" data-plat="${esc(p.id)}:approve">准入</button><button class="btn sm bad" data-plat="${esc(p.id)}:reject">拒绝</button></span></div>`).join('')||'<p class="muted">没有待准入平台。</p>'}</section>
    ${(q.suggestAutoPublish||[]).length?`<section><h3>自动上架建议</h3>${q.suggestAutoPublish.map(x=>`<div class="card" style="margin-bottom:8px">信源 ${esc(x.id)} 已连续原样通过 ${x.cleanStreak} 条 <button class="btn sm" data-autopub="${esc(x.id)}">放开自动上架</button></div>`).join('')}</section>`:''}`;
  $$('[data-plat]',box).forEach(b=>b.addEventListener('click',async()=>{const [id,act]=b.dataset.plat.split(':');await adm(`/platforms/${id}/${act}`,{});toast('已处理');admPlatforms();}));
  $$('[data-autopub]',box).forEach(b=>b.addEventListener('click',async()=>{await adm(`/sources/${b.dataset.autopub}/auto-publish`,{on:true});toast('已放开自动上架');admPlatforms();}));
}

async function admQueue() {
  const box = $('#admBody');
  const [q,identity] = await Promise.all([adm('/queue'),adm('/identity/tasks').catch(error=>({tasks:[],error:error.message})),refreshAdminPlatforms()]);
  if (!box?.isConnected || ADM.tab !== 'queue') return;
  const counts=q.counts||{activities:q.pending.length+(identity.tasks?.length||0),leadReview:q.leadTasks?.length||0,newLeads:q.newLeads};
  const managedIds=new Set(q.managedTaskIds||[]);
  const readyCards=q.pending.filter(o=>!o.preparation||o.preparation.stage==='ready');
  const evidenceCards=q.pending.filter(o=>o.preparation&&o.preparation.stage!=='ready');
  // live：已上架的条目（字段待补），只显示修改，不显示通过和拒绝
  const card = adminCard;
  const sugCount = k => q.pending.filter(o => (o.suggestion?.verdict || 'none') === k).length;
  const sugTabs = [['all', '全部', q.pending.length], ['approve', '建议通过', sugCount('approve')], ['history', '建议作为历史', sugCount('history')], ['reject', '建议拒绝', sugCount('reject')], ['judge', '需要你判断', sugCount('judge')], ['none', '未标注', sugCount('none')]].filter(([k, , n]) => k === 'all' || n);
  box.innerHTML = `${q.leadTasks?.length?`<details data-lead-section open><summary>待复核 · ${counts.leadReview} 条</summary>${q.leadTasks.slice(0,10).map(leadTaskCard).join('')}${q.leadTasks.length>10?`<details><summary>其余 ${q.leadTasks.length-10} 条线索复核</summary>${q.leadTasks.slice(10).map(leadTaskCard).join('')}</details>`:''}</details>`:''}
    ${q.priorityLeads?.filter(l=>l.status==='new').length?`<section data-priority-section><h3>重要新线索</h3>${q.priorityLeads.filter(l=>l.status==='new').map(l=>`<div data-priority-lead="${l.id}"><p>#${l.id} ${esc(l.title||'')} · 将在下一轮研判</p>${ADM.role==='admin'?'<button type="button" class="btn sm" data-priority-fast>转到快速上架</button>':''}</div>`).join('')}</section>`:''}
    ${sugTabs.length > 2 ? `<div class="seg" role="tablist" style="margin-bottom:12px;flex-wrap:wrap">${sugTabs.map(([k, l, n]) => `<button type="button" data-sugtab="${k}" aria-pressed="${(ADM.sug || 'all') === k}">${l} ${n}</button>`).join('')}</div>` : ''}
    ${q.needsVerification?.length ? `<details data-stale-approved><summary>已批准 · 待核验 ${q.needsVerification.length} 项</summary><div data-stale-body class="grid g2"></div><button type="button" class="btn sm" data-stale-more hidden>加载更多待核验活动</button></details>` : ''}
    <section data-activity-section><div class="review-group-label">等待你决定 · ${readyCards.length} 项</div><div class="grid g2">${readyCards.map(o=>card(o)).join('')||'<p class="small muted">当前没有资料齐备的活动需要你决定。</p>'}</div>${evidenceCards.length?`<details data-system-evidence open><summary>系统补证 / 补证受阻 · ${evidenceCards.length} 项</summary><div class="grid g2">${evidenceCards.map(o=>card(o)).join('')}</div></details>`:''}<div data-identity-slot></div></section>
    ${q.incomplete?.length ? `<section data-live-section><details data-incomplete><summary style="cursor:pointer">字段待补 · ${q.incomplete.length}</summary><div class="grid g2" data-incomplete-body></div></details></section>` : ''}`;
  const selectWorkspace=reviewWorkspace(box,q,counts);
  const identityBox=box.querySelector('[data-identity-slot]');identityBox.dataset.identityReview='';const remainingTasks=(identity.tasks||[]).filter(t=>!managedIds.has(t.id));if(remainingTasks.length||identity.error||identity.nextCursor)renderIdentityTasks(identityBox,{...identity,tasks:remainingTasks},false,managedIds);
  bindLeadTasks(box,q.leadTasks||[]);
  box.querySelectorAll('[data-lead-task]').forEach(card=>{const l=q.leadTasks.find(l=>String(l.id)===card.dataset.leadTask);compactReviewCard(card,{title:l.title,url:l.url,status:({checking:'核验中',retry:'等待重试',manual:'需要判断'})[l.resolution?.status]||'待复核',action:'复核线索',facts:[['待处理',l.note],['下次重试',l.resolution?.nextAttemptAt]]});});
  box.querySelectorAll('[data-priority-lead]').forEach(el=>{const lead=(q.priorityLeads||[]).find(l=>String(l.id)===el.dataset.priorityLead);el.querySelector('[data-priority-fast]')?.addEventListener('click',()=>openFastTrackForm({benefit:String(lead.title||'').slice(0,500),url:lead.url||''},lead.id));});
  const applySug = () => $$('[data-sug]', box).forEach(el => { if (el.closest('details')) return; el.style.display = !ADM.sug || ADM.sug === 'all' || el.dataset.sug === ADM.sug ? '' : 'none'; });
  $$('[data-sugtab]', box).forEach(b => b.addEventListener('click', () => { ADM.sug = b.dataset.sugtab; $$('[data-sugtab]', box).forEach(x => x.setAttribute('aria-pressed', x === b)); applySug(); }));
  applySug();
  const done = (el, msg) => { if(el.dataset.live!=='1'&&!el.dataset.completed){el.dataset.completed='1';const counter=box.querySelector('[data-activity-count]');if(counter)counter.textContent=String(Math.max(0,Number(counter.textContent)-1));} el.style.opacity = .45; el.querySelectorAll('button:not([data-review-close]):not([data-review-open]),input,select').forEach(x => { x.disabled = true; }); toast(msg); };
  const findCard=(code,live,taskId)=>(live?[...(q.incomplete||[]),...(q.needsVerification||[])]:q.pending).find(x=>x.code===code&&(!taskId||x.identityTaskId===taskId));
  const bindCards=scope=>{bindAdminCards(scope,{find:findCard,done,reload:admQueue});compactOfferCards(scope,findCard);};
  bindCards(box);
  const staleSection=box.querySelector('[data-stale-approved]');let staleShown=0;
  const loadStale=()=>{
    if(!staleSection?.open)return;
    const batch=(q.needsVerification||[]).slice(staleShown,staleShown+10),holder=document.createElement('div');
    holder.innerHTML=batch.map(o=>card(o,true)).join('');bindCards(holder);
    const target=staleSection.querySelector('[data-stale-body]');while(holder.firstChild)target.append(holder.firstChild);
    staleShown+=batch.length;staleSection.querySelector('[data-stale-more]').hidden=staleShown>=(q.needsVerification||[]).length;
  };
  staleSection?.addEventListener('toggle',()=>{if(staleSection.open&&staleShown===0)loadStale();});
  staleSection?.querySelector('[data-stale-more]')?.addEventListener('click',loadStale);
  const incomplete = box.querySelector('[data-incomplete]');
  const loadIncomplete = () => {
    if (!incomplete.open || incomplete.dataset.loaded) return;
    const target = incomplete.querySelector('[data-incomplete-body]');
    target.innerHTML = q.incomplete.map(o => card(o, true)).join('');
    incomplete.dataset.loaded = '1';
    bindCards(target);
  };
  incomplete?.addEventListener('toggle', loadIncomplete);
  selectWorkspace(ADM.workspace||'activities');
  const focusId = route()[0] === 'admin' ? route()[1] : null;
  if (focusId) {
    if (!q.pending.some(o => o.id === focusId) && q.incomplete?.some(o => o.id === focusId) && incomplete) { incomplete.open = true; loadIncomplete(); }
    const staleIndex=(q.needsVerification||[]).findIndex(o=>o.id===focusId);
    if(staleIndex>=0&&staleSection){staleSection.open=true;while(staleShown<=staleIndex)loadStale();}
    const target = $$('[data-offer-id]', box).find(el => el.dataset.offerId === focusId);
    if (target) {
      selectWorkspace(target.closest('[data-review-pane]')?.dataset.reviewPane||'activities');
      target.querySelector('[data-review-open]')?.click();
      target.style.display = ''; target.style.outline = '2px solid var(--tag)'; target.tabIndex = -1;
      target.dataset.focused = '1'; target.focus({ preventScroll: true }); target.scrollIntoView?.({ block: 'center' });
    } else {
      const message = document.createElement('p'); message.className = 'small'; message.setAttribute('role', 'status');
      message.textContent = '这条已不在待审队列，可能已经处理。'; box.prepend(message);
    }
  }
  if (ADM.role === 'reviewer') $$('[data-withdraw]', box).forEach(x => x.remove());
}
async function admQuality() {
  const q = await adm('/quality?days=30');
  const pct = (a, b) => b ? Math.round(a / b * 100) + '%' : '—';
  const RCL = REASON_LABEL;
  const fields = Object.entries(q.fields).sort((a, b) => b[1] - a[1]);
  const reasons = Object.entries(q.reasons).sort((a, b) => b[1] - a[1]);
  const srcs = Object.entries(q.bySource).sort((a, b) => b[1].total - a[1].total);
  $('#admBody').innerHTML = `<p class="small muted">最近 30 天你的审核（不含系统自动去重）。原样通过率越高，说明抽取越准；某个字段修改得多，就是模型最该改进的地方。你的修改和拒绝理由会在下一轮采集时附给模型参考，每周六再归纳成规则等你批准。</p>
    <section class="kpis" style="margin-top:0">
      <div class="kpi"><span class="k-l">已审核</span><span class="k-v">${q.reviewed}<small>条</small></span></div>
      <div class="kpi"><span class="k-l">原样通过</span><span class="k-v">${pct(q.approvedClean, q.reviewed)}</span></div>
      <div class="kpi"><span class="k-l">修改后通过</span><span class="k-v">${q.edits}<small>条</small></span></div>
      <div class="kpi"><span class="k-l">拒绝</span><span class="k-v">${q.rejects}<small>条</small></span></div></section>
    <div class="grid g2">
      <div class="card"><h3>最常被改的字段</h3>${fields.length ? `<div class="rows">${fields.map(([f, n]) => `<div class="row small" style="gap:10px;padding:4px 0"><span style="width:72px">${FIELD_L[f] || f}</span><span class="meter" style="flex:1"><i style="width:${Math.round(n / fields[0][1] * 100)}%"></i></span><span class="num">${n}</span></div>`).join('')}</div>` : '<p class="small muted">还没有修改记录。</p>'}</div>
      <div class="card"><h3>拒绝理由</h3>${reasons.length ? `<div class="rows">${reasons.map(([k, n]) => `<div class="row small" style="gap:10px;padding:4px 0"><span style="width:92px">${RCL[k] || k}</span><span class="meter" style="flex:1"><i style="width:${Math.round(n / reasons[0][1] * 100)}%;background:var(--critical)"></i></span><span class="num">${n}</span></div>`).join('')}</div>` : '<p class="small muted">还没有拒绝记录。</p>'}</div>
    </div>
    <section>${secH('各信源的原样通过率', '连续原样通过 5 条的信源会被提议放开自动上架')}<div class="card tbl" style="padding:4px 8px"><table><thead><tr><th>信源</th><th>审核数</th><th>原样通过率</th></tr></thead><tbody>${srcs.map(([k, v]) => `<tr><td>${esc(k)}</td><td class="n">${v.total}</td><td class="n">${pct(v.clean, v.total)}</td></tr>`).join('') || '<tr><td colspan="3" class="muted">暂无</td></tr>'}</tbody></table></div></section>
    ${ADM.role==='admin'?'<section data-review-stats class="card small">正在读取最近 7 天的审核分工…</section>':''}`;
  const stats=$('#admBody [data-review-stats]');
  if(stats)adm('/review-stats?days=7').then(r=>{if(stats.isConnected)stats.textContent=`最近 7 天 · 线索 ${r.leads.total}：系统处理 ${r.leads.system}、入口规则 ${r.leads.rule}、人工关闭 ${r.leads.owner}、待处理 ${r.leads.open} · 查重卡 ${r.identity.total}：网页 ${r.identity.web}、快速上架 ${r.identity.fastTrack}、代理/脚本 ${r.identity.agent}、系统 ${r.identity.system}、待处理 ${r.identity.open}`;}).catch(()=>{stats.remove();});
}
async function admLeads() {
  const box = $('#admBody');
  box.innerHTML = `<p class="small muted">每小时优先研判重置、赠额和限时福利；每轮保留名额消化旧线索。受阻线索会进入官方复核；具体进度和处理按钮在“待审”的线索复核区。已关联/已结束可在这里追溯处理原因。</p>
    <form id="admPlatform" class="card" style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:12px"><input name="name" placeholder="平台名称" required><select name="type"><option value="lab">模型厂商</option><option value="cloud">云厂商</option><option value="infra">推理平台</option><option value="tool">AI 工具</option><option value="new">新玩家</option></select><input name="site" type="url" placeholder="经核验的官网 https://" required><button class="btn sm" type="submit">送交平台准入</button></form>
    <div class="row" style="gap:12px;margin-bottom:12px"><label class="field">线索状态<select data-lead-status>${[['all','全部未处理'],['new','新线索'],['reviewing','自动复核/待判断'],['linked','已关联'],['rejected','已结束']].map(([value,label])=>`<option value="${value}" ${value === (ADM.leadStatus || 'all') ? 'selected' : ''}>${label}</option>`).join('')}</select></label><span data-lead-count class="small muted"></span></div>
    <div class="rows" data-lead-rows></div><div class="row" style="gap:10px;margin-top:12px"><button class="btn sm" type="button" data-lead-more hidden>加载更早的线索</button><span data-lead-message role="status" class="small"></span></div>`;
  $('#admPlatform').addEventListener('submit', async e => { e.preventDefault(); const form = e.currentTarget; const fields = Object.fromEntries(new FormData(form)); try { const host = new URL(fields.site).hostname.replace(/^www\./, '').split('.'); fields.id = (host.length > 2 && !['com', 'cn', 'ai', 'io', 'dev', 'co'].includes(host.at(-2)) ? host.at(-2) : host[0]).toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+/, '') || 'new-platform'; const r = await adm('/platforms', fields); toast(`平台 ${r.id} 已进入待准入，请在“平台”页核实`); form.reset(); } catch (err) { toast(err.message); } });
  const rows = box.querySelector('[data-lead-rows]'), more = box.querySelector('[data-lead-more]'), message = box.querySelector('[data-lead-message]'), select = box.querySelector('[data-lead-status]');
  let nextCursor = null, total = 0, request = 0, retryReset = false;
  const count = () => { box.querySelector('[data-lead-count]').textContent = `已显示 ${rows.querySelectorAll('[data-lead]').length} / ${total} 条`; };
  const load = async (reset = false) => {
    const current = ++request, status = select.value;
    more.disabled = true; message.textContent = '加载中…';
    try {
      const result = await adm(`/leads?limit=60&status=${status}${!reset && nextCursor != null ? `&before=${nextCursor}` : ''}`);
      if (current !== request || !box.isConnected) return;
      if (reset) rows.innerHTML = '';
      const existing = new Set($$('[data-lead]', rows).map(row => Number(row.dataset.lead)));
      for (const l of result.leads.filter(l => !existing.has(l.id))) {
        const row = document.createElement('div'); row.className = 'orow'; row.dataset.lead = l.id; row.style.gridTemplateColumns = 'auto minmax(0,1fr) auto';
        row.innerHTML = `<span class="when">#${l.id}</span><span class="t">${esc(l.title || '(无标题)')}<small><span class="chip">${esc(l.origin)}</span> <span class="chip">${l.status === 'reviewing' ? (l.resolution?.status==='manual'?'需要你判断':'自动官方复核') : l.status==='linked'?'已关联':l.status==='rejected'?'已结束':'新线索'}</span> <a href="${esc(l.url)}" target="_blank" rel="noopener" style="text-decoration:underline;word-break:break-all">${esc(l.url)}</a>${l.note ? `<br>${esc(l.note)}` : ''}</small></span><span class="row">${['new','reviewing'].includes(l.status) ? `<select data-lead-category><option value="">选择类别</option>${RC.filter(([k]) => !['not_ai','wrong_type'].includes(k)).map(([k, label]) => `<option value="${k}">${label}</option>`).join('')}</select>` : ''}${l.status === 'reviewing' ? '<button class="btn sm" type="button" data-retry>重新研判</button>' : ''}${['new','reviewing'].includes(l.status)?'<button class="btn sm" type="button" data-dismiss disabled>忽略</button>':''}</span>`;
        row.querySelector('[data-lead-category]')?.addEventListener('change', event => { const dismiss = row.querySelector('[data-dismiss]'); if (dismiss) dismiss.disabled = !event.currentTarget.value; });
        row.querySelectorAll('[data-dismiss],[data-retry]').forEach(button => button.addEventListener('click', async () => {
          if (button.disabled) return;
          const retry = button.hasAttribute('data-retry');
          const reasonCategory = row.querySelector('[data-lead-category]')?.value;
          if (!retry && !reasonCategory) { message.textContent = '请先选择拒绝类别'; return; }
          button.disabled = true;
          try {
            await adm(`/leads/${l.id}/${retry ? 'retry' : 'dismiss'}`, {expectedVersion:l.reviewVersion, ...(!retry ? {reasonCategory} : {})});
            if (retry) toast('已排入下一轮官方复核');
            if (retry && select.value === 'all') { row.querySelector('.chip + .chip').textContent = '自动官方复核'; button.remove(); }
            else { row.remove(); total = Math.max(0, total - 1); }
            count();
          } catch (err) { message.textContent = err.message; button.disabled = false; }
        }));
        rows.append(row);
      }
      nextCursor = result.nextCursor ?? null; total = result.total ?? rows.querySelectorAll('[data-lead]').length;
      retryReset = false; more.textContent = '加载更早的线索'; more.hidden = nextCursor == null; count(); message.textContent = total ? '' : '没有待处理的线索。';
    } catch (err) { if (current === request) { retryReset = reset; more.hidden = false; more.textContent = '重试加载'; message.textContent = `没有加载：${err.message}`; } }
    finally { if (current === request) more.disabled = false; }
  };
  select.addEventListener('change', () => { ADM.leadStatus = select.value; load(true); });
  more.addEventListener('click', () => load(retryReset));
  await load(true);
}
/* ⚡ 快速上架：管理员担保的官方链接 + 主要权益，免费模型补其余字段，补齐即上架。 */
const FT_STATE = { queued: '排队等模型读取', extracting: '模型读取中', publishing: '正在上架', needs_owner: '自动补全未完成', published: '已上架', rejected: '已拒绝' };
const SPOT_CATS = ['non_ai', 'relay_station', 'account_pool', 'personal_giveaway', 'ordinary_discount', 'paid_bundle', 'model_news_only', 'duplicate', 'expired'];
async function loadSpotCheck(body) {
  body.textContent = '正在读取…';
  let data, cards, refusals; try { [data, { cards }, { refusals }] = await Promise.all([adm('/screening/spot-check?days=7'), adm('/screening/spot-check/cards?days=7'), adm('/screening/spot-check/refusals?days=7')]); } catch (e) { body.textContent = '读取失败：' + e.message; return; }
  body.className = 'small';
  const row = it => `<div data-spot="${it.id}" class="row" style="gap:6px;flex-wrap:wrap;align-items:center;padding:4px 0;border-bottom:1px solid var(--line,#333)"><a href="${esc(it.url)}" target="_blank" rel="noopener" style="flex:1;min-width:220px">${esc(it.title)}</a><span class="muted">${esc(it.origin)} · ${it.closedBy === 'gate0_link' ? '系统判为重复并关联' : it.closedBy === 'rule' ? '入口规则' : '自动研判'}：${esc(it.reason.slice(0, 40))}</span><select data-spot-cat>${SPOT_CATS.map(k => `<option value="${k}" ${k === it.category ? 'selected' : ''}>${esc(REASON_LABEL[k] || k)}</option>`).join('')}</select><button class="btn sm" data-spot-wrong>${it.recoveryPending ? '继续恢复待审' : it.closedBy === 'gate0_link' ? '↩ 不是重复，放回队列' : '✗ 误关，恢复待审'}</button><button class="btn sm" data-spot-fast>⚡ 上架</button></div>`;
  const likely = data.items.filter(i => i.likely), rest = data.items.filter(i => !i.likely);
  const group = (key, label, list, open) => list.length ? `<details ${open ? 'open' : ''} data-spot-group="${key}"><summary>${label} · ${list.length} 条</summary><p><button class="btn sm pri" data-spot-confirm>✅ 本组其余都关得对</button> <span role="status" data-spot-msg></span></p>${list.map(row).join('')}</details>` : '';
  body.innerHTML = `<p class="muted">系统自己关闭、你还没看过的线索。先看“可能误关”（标题提到已知厂商或免费、额度、赠送等词）。确认关得对的会成为里程碑 2 的校准样本，类别请按实际选；误关可恢复待审，恢复完成前可继续操作；⚡ 上架仍按管理员快速上架流程执行。入口规则误关超过 10%（至少 10 次命中）会自动停用。</p>
    ${cards.length ? `<details open data-spot-cards><summary>🤖 系统查重结案 · ${cards.length} 张</summary><p class="muted">模型判为与已上架活动重复、且没有新金额/模型/门槛的查重卡，已按重复结案。判错的点“不是重复”放回查重队列。</p>${cards.map(card => `<div data-spot-card="${esc(card.decisionId)}" class="row" style="gap:6px;flex-wrap:wrap;align-items:center;padding:4px 0;border-bottom:1px solid var(--line,#333)"><a href="${esc(card.url)}" target="_blank" rel="noopener" style="flex:1;min-width:220px">${esc(card.title)}</a><span class="muted">与已上架「<a href="#offer-${esc(card.offerId)}">${esc(card.offerTitle)}</a>」重复 · 置信度 ${esc(String(card.confidence))}</span><button class="btn sm" data-card-ok>✅ 关得对</button><button class="btn sm" data-card-undo>↩ 不是重复，放回队列</button></div>`).join('')}</details>` : ''}
    ${refusals.length ? `<details data-spot-refusals><summary>🧠 沿用你的拒绝自动结案 · ${refusals.length} 条</summary><p class="muted">同一页面的同一段内容你已经拒绝过、重读时也没有新金额/模型/门槛，系统按你当时的决定结案。不该沿用的点“恢复审核”，这段内容会回到查重队列，之后不再自动结案。</p>${refusals.map(r => `<div data-spot-refusal="${esc(r.decisionId)}" class="row" style="gap:6px;flex-wrap:wrap;align-items:center;padding:4px 0;border-bottom:1px solid var(--line,#333)"><a href="${esc(r.url)}" target="_blank" rel="noopener" style="flex:1;min-width:220px">${esc(r.title)}</a><span class="muted">重读结案 ${r.closedReads} 次 · 你的理由：${esc(r.reason.slice(0, 50))}</span><button class="btn sm" data-refusal-undo>↩ 不该沿用，恢复审核</button></div>`).join('')}</details>` : ''}
    ${group('likely', '⚠️ 可能误关', likely, true)}${group('rest', '其余自动关闭', rest, false)}${data.items.length || cards.length || refusals.length ? '' : '<p class="muted">最近 7 天没有待抽查的自动关闭线索。</p>'}`;
  const done = (el, text) => { el.style.opacity = .45; el.querySelectorAll('button,select').forEach(x => { x.disabled = true; }); if (text) el.insertAdjacentHTML('beforeend', `<span class="small">${esc(text)}</span>`); };
  body.querySelectorAll('[data-spot]').forEach(el => {
    const id = Number(el.dataset.spot), it = data.items.find(x => x.id === id);
    const recover = async (fresh = false) => {
      el.dataset.handled = '1';
      const buttons = el.querySelectorAll('button,select'); buttons.forEach(x => { x.disabled = true; });
      let retired = false;
      try {
        let result;
        do {
          el.querySelector('[data-spot-wrong]').textContent = '正在恢复待审…';
          result = await adm(`/screening/spot-check/${id}/wrong`, { expectedVersion: fresh ? undefined : it.expectedVersion });
          fresh = false;
          it.expectedVersion = result.expectedVersion; retired ||= result.ruleRetired;
        } while (result.more);
        done(el, `${result.recovery?.state === 'completed' ? '已恢复审核流程（未自动上架）' : '恢复待继续'}${retired ? '，误关规则已停用' : ''}`);
      } catch (e) {
        el.querySelector('[data-spot-wrong]').textContent = '继续恢复待审';
        buttons.forEach(x => { x.disabled = false; }); toast(`恢复尚未完成：${e.message}；请刷新或继续恢复`);
      }
    };
    el.querySelector('[data-spot-wrong]').addEventListener('click', () => recover());
    el.querySelector('[data-spot-fast]').addEventListener('click', () => openFastTrackForm({benefit:it.title.slice(0,500),url:it.url},id,{},async()=>recover(true)));
  });
  body.querySelectorAll('[data-spot-refusal]').forEach(el => {
    const button = el.querySelector('[data-refusal-undo]');
    button.addEventListener('click', async () => {
      button.disabled = true;
      try { await adm(`/screening/spot-check/refusals/${encodeURIComponent(el.dataset.spotRefusal)}/undo`, {}); done(el, '已恢复审核（未自动上架）'); }
      catch (e) { button.disabled = false; toast(`恢复失败：${e.message}`); }
    });
  });
  body.querySelectorAll('[data-spot-card]').forEach(el => {
    const id = encodeURIComponent(el.dataset.spotCard), buttons = el.querySelectorAll('button');
    el.querySelector('[data-card-ok]').addEventListener('click', async () => {
      buttons.forEach(x => { x.disabled = true; });
      try { await adm(`/screening/spot-check/cards/${id}/confirm`, {}); done(el, '已确认'); } catch (e) { buttons.forEach(x => { x.disabled = false; }); toast(e.message); }
    });
    el.querySelector('[data-card-undo]').addEventListener('click', async () => {
      buttons.forEach(x => { x.disabled = true; });
      try { let result; do { result = await adm(`/screening/spot-check/cards/${id}/undo`, {}); } while (result.more); done(el, '已放回查重队列（未自动上架）'); }
      catch (e) { buttons.forEach(x => { x.disabled = false; }); toast(`放回尚未完成：${e.message}；可再点一次继续`); }
    });
  });
  body.querySelectorAll('[data-spot-confirm]').forEach(button => button.addEventListener('click', async () => {
    const groupEl = button.closest('[data-spot-group]'), msg = groupEl.querySelector('[data-spot-msg]');
    const rows = [...groupEl.querySelectorAll('[data-spot]')].filter(el => !el.dataset.handled && !data.items.find(it => it.id === Number(el.dataset.spot)).recoveryPending);
    button.disabled = true; let confirmed = 0;
    try {
      for (let i = 0; i < rows.length; i += 15) {
        const chunk = rows.slice(i, i + 15);
        const r = await adm('/screening/spot-check/confirm', { items: chunk.map(el => ({ id: Number(el.dataset.spot), category: el.querySelector('[data-spot-cat]').value, expectedVersion: data.items.find(it => it.id === Number(el.dataset.spot)).expectedVersion })) });
        confirmed += r.confirmed; chunk.forEach(el => { el.dataset.handled = '1'; done(el); }); msg.textContent = `已确认 ${confirmed} 条…`;
      }
      msg.textContent = `已确认 ${confirmed} 条关得对`;
    } catch (e) { msg.textContent = e.message; button.disabled = false; }
  }));
}
/* 噪声信源（2026-10-22）：30 天里反复重读却没有带来新福利的信源，供管理员判断是否停用（拉黑）。 */
async function loadNoisySources(body) {
  body.textContent = '正在读取…';
  let data; try { data = await adm('/screening/noisy-sources?days=30'); } catch (e) { body.textContent = '读取失败：' + e.message; return; }
  body.className = 'small';
  body.innerHTML = `<p class="muted">最近 30 天被重读至少 5 次、却没有带来任何新上架福利的信源。多数是已上架福利的官网价格页或文档页，继续保留能第一时间发现条款变化；只有整页都是过时内容（如旧教程文章）才建议停用。停用只停止采集，不影响已有条目和审核记录。</p>
    ${data.sources.map(src => `<div data-noisy-source="${esc(src.id)}" class="row" style="gap:6px;flex-wrap:wrap;align-items:center;padding:4px 0;border-bottom:1px solid var(--line,#333)"><a href="${esc(src.url)}" target="_blank" rel="noopener" style="flex:1;min-width:220px">${esc(src.id)}</a><span class="muted">重读 ${src.reads} 次 · 进查重 ${src.cards} · 自动结案 ${src.autoClosed}${src.enabled ? '' : ' · 已停用'}</span>${src.enabled ? '<input data-noisy-reason value="整页是过时内容，反复重读没有新福利" style="min-width:220px" aria-label="停用理由"><button class="btn sm" data-noisy-off>停用</button>' : ''}</div>`).join('') || '<p class="muted">最近 30 天没有噪声信源。</p>'}`;
  body.querySelectorAll('[data-noisy-source]').forEach(el => {
    const button = el.querySelector('[data-noisy-off]'); if (!button) return;
    button.addEventListener('click', async () => {
      const reason = el.querySelector('[data-noisy-reason]').value.trim(); if (reason.length < 2) { toast('请写明停用理由'); return; }
      button.disabled = true;
      try { await adm(`/sources/${encodeURIComponent(el.dataset.noisySource)}/enabled`, { on: false, reason }); el.style.opacity = .45; el.querySelector('[data-noisy-reason]').remove(); button.replaceWith(Object.assign(document.createElement('span'), { className: 'small', textContent: '已停用' })); }
      catch (e) { button.disabled = false; toast(`停用失败：${e.message}`); }
    });
  });
}
const INTAKE_CATS = ['non_ai', 'ordinary_discount', 'relay_station', 'account_pool', 'personal_giveaway'];
async function loadIntakeRules(body) {
  body.textContent = '正在读取…';
  let data; try { data = await adm('/screening/rules'); } catch (e) { body.textContent = '读取失败：' + e.message; return; }
  const active = data.rules.filter(r => r.status === 'active'), scope = r => r.scopeKind === 'global' ? '全部来源' : `仅 ${esc(r.scopeValue)}`;
  const catOpts = sel => INTAKE_CATS.map(k => `<option value="${k}" ${k === sel ? 'selected' : ''}>${esc(REASON_LABEL[k])}</option>`).join('');
  body.className = 'small';
  body.innerHTML = `<p class="muted">启用的规则在线索进入时按标题匹配，直接关闭，不再研判、搜索或进审核。建议来自你在线索阶段的拒绝（只学“非 AI、优惠券/折扣、中转站、账号池、个人分享”）；会命中已上架或已关联福利的规则会被拒绝创建。</p>
    <h4>建议 · ${data.suggestions.length} 条</h4>${data.suggestions.map((g, i) => `<div class="card" data-intake-sug="${i}" style="margin:6px 0"><b>标题含「${esc(g.pattern.replace(/\\/g, ''))}」</b> · ${esc(REASON_LABEL[g.category])} · ${scope(g)} · 你已拒绝 ${g.hits} 条<ul>${g.examples.map(t => `<li>${esc(t)}</li>`).join('')}</ul><label class="row" style="gap:6px"><input type="checkbox" data-apply checked> 同时关闭现有未处理的同类线索</label><div class="row"><button class="btn sm pri" data-intake-on>启用</button><button class="btn sm" data-intake-off>不再建议</button></div><p role="status" data-intake-msg></p></div>`).join('') || '<p class="muted">暂无建议：同一类拒绝累计 3 条以上、且标题有共同词时才会出现。</p>'}
    <h4>启用中 · ${active.length} 条</h4>${active.map(r => `<p data-intake-rule="${esc(r.id)}">「${esc(r.pattern)}」 · ${esc(REASON_LABEL[r.category] || r.category)} · ${scope(r)} · 已拦截 ${r.hits} 条 <button class="btn sm" data-intake-retire>停用</button></p>`).join('') || '<p class="muted">还没有启用的规则。</p>'}
    <details><summary>手动添加规则</summary><form data-intake-add class="row" style="gap:6px;flex-wrap:wrap"><input name="pattern" required minlength="2" placeholder="标题关键词或正则，如 购物券|外卖券"><select name="category">${catOpts('non_ai')}</select><input name="scopeValue" placeholder="仅限来源（可空，如 linuxdo）"><label class="row" style="gap:4px"><input type="checkbox" name="applyToOpen" checked> 关闭现有同类</label><button class="btn sm pri">添加</button><p role="status" data-intake-msg></p></form></details>`;
  const create = async (payload, msg) => {
    try {
      const r = await adm('/screening/rules', payload); let closed = r.closed || 0;
      for (let more = r.more, i = 0; more && i < 30; i++) { msg.textContent = `已启用，正在关闭现有同类线索（${closed} 条）…`; const next = await adm(`/screening/rules/${encodeURIComponent(r.rule.id)}/apply`, {}); closed += next.closed; more = next.more && next.closed > 0; }
      msg.textContent = payload.status === 'declined' ? '已不再建议' : `已启用${closed ? `，并关闭 ${closed} 条现有线索` : ''}`; return true;
    }
    catch (e) { msg.textContent = e.message + (e.body?.conflicts?.length ? '：' + e.body.conflicts.join('；') : ''); return false; }
  };
  body.querySelectorAll('[data-intake-sug]').forEach(card => {
    const g = data.suggestions[Number(card.dataset.intakeSug)], msg = card.querySelector('[data-intake-msg]');
    const base = { pattern: g.pattern, category: g.category, scopeKind: g.scopeKind, scopeValue: g.scopeValue, exampleRefs: g.exampleRefs };
    card.querySelector('[data-intake-on]').addEventListener('click', async e => { e.target.disabled = true; if (!await create({ ...base, applyToOpen: card.querySelector('[data-apply]').checked }, msg)) e.target.disabled = false; });
    card.querySelector('[data-intake-off]').addEventListener('click', async e => { e.target.disabled = true; await create({ ...base, status: 'declined' }, msg); });
  });
  body.querySelectorAll('[data-intake-retire]').forEach(button => button.addEventListener('click', async () => {
    button.disabled = true; try { await adm('/screening/rules/' + encodeURIComponent(button.closest('[data-intake-rule]').dataset.intakeRule) + '/retire', { reason: '管理员停用' }); button.textContent = '已停用'; } catch (e) { button.disabled = false; toast(e.message); }
  }));
  const form = body.querySelector('[data-intake-add]');
  form.addEventListener('submit', async e => {
    e.preventDefault(); const fd = Object.fromEntries(new FormData(form));
    await create({ pattern: fd.pattern.trim(), category: fd.category, ...(fd.scopeValue.trim() ? { scopeKind: 'origin', scopeValue: fd.scopeValue.trim() } : {}), applyToOpen: !!fd.applyToOpen }, form.querySelector('[data-intake-msg]'));
  });
}
function fastTrackFormHtml(p = {}) {
  return `<form data-fast-track class="card" style="display:flex;flex-direction:column;gap:10px;max-width:640px${p.inline ? ';margin-top:8px' : ''}">
    <p class="small muted" style="margin:0">确认官方发布或亲测可领后提交；系统补齐字段并直接上架。</p>
    <label class="field">厂商<select name="platformId"><option value="">＋ 新厂商（在下面填写）</option>${adminPlatformOptions(p.platformId)}</select></label>
    <div class="row" data-ft-new style="gap:8px;flex-wrap:wrap"><input name="newName" placeholder="新厂商名称"><select name="newType">${Object.entries(PTYPE).map(([k, v]) => `<option value="${k}" ${k === 'new' ? 'selected' : ''}>${v.l}</option>`).join('')}</select></div>
    <label class="field">官方链接<input type="url" name="url" required placeholder="https://（官网、公众号文章、厂商 X 推文）" value="${esc(p.url || '')}"></label>
    <label class="field">主要权益<input name="benefit" required minlength="2" maxlength="500" placeholder="比如：Odyssey-3 公开研究预览，可免费试用" value="${esc(p.benefit || '')}"></label>
    <label class="field">依据<select name="basis"><option value="official">官方发布</option><option value="tested">我亲测可领</option></select></label>
    <details><summary class="small">可选：标题、日期、备注</summary><label class="field">标题<input name="title" maxlength="120" value="${esc(p.title || '')}"></label><div class="row" style="gap:8px"><label class="field">开始<input type="date" name="claimStart"></label><label class="field">截止<input type="date" name="claimEnd"></label></div><label class="field">备注（给模型的提示）<input name="note" maxlength="1000" value="${esc(p.note || '')}"></label></details>
    <details data-ft-membership><summary class="small">可选：手动指定会员资格（留空由模型补全）</summary><div class="field" data-membership-editor>展开后加载会员目录…</div></details>
    <button class="btn pri" type="submit">⚡ 快速上架</button><p class="small" role="status" data-ft-msg></p></form>`;
}
function bindFastTrackForm(form, leadId, onDone, link = {}) {
  const select = form.querySelector('[name="platformId"]'), extra = form.querySelector('[data-ft-new]'), msg = form.querySelector('[data-ft-msg]');
  const sync = () => { extra.hidden = !!select.value; };
  select.addEventListener('change', sync); sync();
  // The catalog loads only when the owner opens the picker: this form appears on many cards at once.
  const member = form.querySelector('[data-ft-membership]');
  const mountMember = () => { const host = member.querySelector('[data-membership-editor]'), fresh = host.cloneNode(false); fresh.textContent = '正在加载会员资格目录…'; host.replaceWith(fresh); form.membershipEditor = undefined; mountMembershipEditor(form, { requirements: [] }, {selectionOnly:true}); };
  member.addEventListener('toggle', () => { if (member.open && !form.membershipEditor) mountMember(); });
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(form)), button = form.querySelector('button[type="submit"]');
    if (!fd.platformId && !fd.newName.trim()) { msg.textContent = '请选择厂商，或填写新厂商名称'; return; }
    const body = { url: fd.url, benefit: fd.benefit.trim(), basis: fd.basis, ...(fd.platformId ? { platformId: fd.platformId } : { newPlatform: { name: fd.newName.trim(), type: fd.newType } }),
      ...Object.fromEntries(['title', 'claimStart', 'claimEnd', 'note'].filter(k => fd[k]?.trim()).map(k => [k, fd[k].trim()])), ...(leadId ? { leadId } : {}), ...link };
    if (form.membershipEditor?.touched && form.membershipEditor.selectedPlanIds.length) {
      try { const { membershipRequirement } = membershipEditFields({ requirements: [] }, form.membershipEditor, [], false, fd.url); if (membershipRequirement.status !== 'not_required') { body.membershipRequirement = membershipRequirement; body.membershipSelectionOnly = true; } }
      catch (err) { msg.textContent = err.message; return; }
    }
    button.disabled = true;
    try {
      const r = await adm('/fast-track', body);
      msg.textContent = `官方地址${r.registered.kind === 'existing' ? '已在白名单' : '已登记'}；${r.dispatched ? '已触发采集，模型读取后自动上架' : '下一轮采集读取后自动上架'}。进度见本页任务列表。`;
      form.reset(); sync(); if (form.membershipEditor) { member.open = false; form.membershipEditor = undefined; } await onDone?.();
    } catch (err) { msg.textContent = err.message; } finally { button.disabled = false; }
  });
}
async function settleFastTrack(id, r) { for (let i = 0; r.state === 'publishing' && i < 8; i++) r = await adm(`/fast-track/${id}/advance`, {}); return r; }
function fastTrackCompleteHtml(j) {
  if(j.missing.includes('membershipCatalog')||j.catalogBlock||/会员产品未经核实|套餐未经核实/.test(j.error||''))return `<div data-ft-catalog-block><p class="small warn-note">会员目录资料尚未核实，重复抽取不会解决。核实产品与套餐资料后，系统会让模型重新选择；不需要重填本条的全部字段。</p>${(j.catalogBlock?.entries||[]).map(e=>`<p class="small">${esc(e.name)} · ${e.status==='retired'?'已停用':'待核实'} <a href="${esc(e.sourceUrl)}" target="_blank" rel="noopener">目录来源 ↗</a></p>`).join('')}<details data-ft-directory><summary>核实或补充会员目录</summary><div data-ft-catalog></div></details><button class="btn sm" type="button" data-ft-retry>目录已更新，让模型重新读取</button></div>`;
  const all = ['title', 'type', 'claimMethod', 'modalities', 'requirements', 'endKind', 'claimEnd', 'membershipRequirement'], need = new Set(j.missing.length ? [...j.missing, ...(j.missing.includes('endKind') ? ['claimEnd'] : [])] : all);
  const memberText = (j.requirements || []).filter(r => r.startsWith('member:')).map(r => r.slice(7));
  if (!memberText.length && !j.missing.includes('membershipRequirement')) need.delete('membershipRequirement');
  const field = {
    title: '<label class="field">标题<input name="title" maxlength="120"></label>',
    type: `<label class="field">类型<select name="type">${Object.entries(TYPES).map(([k, v]) => `<option value="${k}">${v.l}</option>`).join('')}</select></label>`,
    claimMethod: `<label class="field">领取方式<select name="claimMethod">${Object.entries(CLAIM).map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select></label>`,
    modalities: `<div class="field">模态<div class="chips">${Object.entries(MODAL).map(([k, l]) => `<label class="chip"><input type="checkbox" name="modalities" value="${k}"> ${l}</label>`).join('')}</div></div>`,
    requirements: `<div class="field">门槛<div class="chips">${Object.entries(REQ).filter(([k]) => k !== 'unknown').map(([k, l]) => `<label class="chip"><input type="checkbox" name="requirements" value="${k}"> ${l}</label>`).join('')}</div></div>`,
    endKind: `<label class="field">截止方式<select name="endKind"><option value="unknown">截止未知</option><option value="date">有截止日期</option><option value="standing">常驻 / 申请制</option></select></label>`,
    claimEnd: '<label class="field">截止日期<input type="date" name="claimEnd"></label>',
    membershipRequirement: `<div class="field"><span>会员资格${memberText.length ? `<span class="small muted">（模型读到：${esc(memberText.join('、'))}）</span>` : ''}</span><div data-membership-editor>正在加载会员资格目录…</div></div>`,
  };
  return `<form data-ft-complete style="display:flex;flex-direction:column;gap:8px;margin-top:6px"><p class="small">${j.missing.length ? '模型多次补全仍未解决：' + j.missing.map(k => esc(FIELD_L[k] || k)).join('、') : '可以让模型重试；如有额外信息，也可手动修正。'}</p>
    ${all.filter(k => need.has(k)).map(k => field[k]).join('')}<div class="row" style="gap:8px"><button class="btn sm pri" type="submit">补齐并上架</button><button class="btn sm" type="button" data-ft-retry>让模型重新读取</button></div></form>`;
}
async function loadFastTrackJobs(box) {
  try {
    let { jobs } = await adm('/fast-track');
    const paused = jobs.filter(j => j.state === 'needs_owner');
    if (paused.length) { await Promise.all(paused.map(j => adm(`/fast-track/${j.id}/reconcile`, {}).catch(() => null))); ({jobs} = await adm('/fast-track')); }
    if(!box.isConnected)return;
    const pending=jobs.filter(j=>!['published','rejected'].includes(j.state)).sort((a,b)=>Number(b.state==='needs_owner')-Number(a.state==='needs_owner'));
    const completed=jobs.filter(j=>['published','rejected'].includes(j.state));
    const count=box.closest('#admBody')?.querySelector('[data-ft-count]');if(count)count.textContent=String(pending.length);
    const card=j=>`<div class="card" data-ft-job="${esc(j.id)}" style="margin:6px 0"><b>${esc(j.platformName)}</b> · ${esc(j.benefit)}
      <p class="small">${esc((j.missing.includes('membershipCatalog')||/会员产品未经核实|套餐未经核实/.test(j.error||''))?'会员目录待核实':FT_STATE[j.state]||j.state)}${j.offerId ? ` · <a href="/#offer-${esc(j.offerId)}" target="_blank" rel="noopener">查看条目</a>` : ''}${j.leadId ? ` · 线索 #${j.leadId}` : ''} · <a href="${esc(j.url)}" target="_blank" rel="noopener">官方链接 ↗</a>${j.error ? ` · ${esc(j.error)}` : ''}${j.resolution?.reason ? ` · ${esc(j.resolution.reason)}` : ''}</p>
      ${j.state === 'needs_owner' ? fastTrackCompleteHtml(j) : ''}${j.state === 'publishing' ? '<button class="btn sm" type="button" data-ft-advance>继续上架</button>' : ''}</div>`;
    box.innerHTML=(pending.length?pending.map(card).join(''):'<p class="small muted">没有未完成的快速上架任务。</p>')+(completed.length?`<details data-ft-completed><summary>已完成记录 · ${completed.length}</summary><div class="review-completed-grid">${completed.map(card).join('')}</div></details>`:'');
    const job = card => jobs.find(j => j.id === card.dataset.ftJob), need = card => job(card)?.missing || [];
    box.querySelectorAll('[data-ft-job]').forEach(card => {
      const j=job(card),completedJob=['published','rejected'].includes(j.state);compactReviewCard(card,{platform:j.platformName,title:j.benefit,url:j.url,status:FT_STATE[j.state]||j.state,action:completedJob?'查看记录':j.state==='needs_owner'?'处理阻塞':'查看进度',facts:[['待处理',j.error],['缺少字段',(j.missing||[]).map(k=>FIELD_L[k]||k).join('、')]]});
      const complete = card.querySelector('[data-ft-complete]');
      if (complete?.querySelector('[data-membership-editor]')) mountMembershipEditor(complete, { platformId:job(card).platformId,requirements: job(card).requirements || [],membershipRequirement:job(card).membershipRequirement }, {selectionOnly:true});
      const id = card.dataset.ftJob, done = r => { toast(r.state === 'published' ? '已上架' : r.state === 'needs_owner' ? (r.error || '还缺字段：' + (r.missing || []).map(k => FIELD_L[k] || k).join('、')) : '已提交'); loadFastTrackJobs(box); };
      const directory=card.querySelector('[data-ft-directory]');
      directory?.addEventListener('toggle',async()=>{if(!directory.open||directory.dataset.loaded)return;directory.dataset.loaded='1';const host=directory.querySelector('[data-ft-catalog]');try{MEMBERSHIP_CATALOG=await adm('/memberships');MEMBERSHIP_CATALOG_OK=true;const redraw=()=>{renderMembershipCatalog(host,redraw);adm(`/fast-track/${id}/reconcile`,{}).then(r=>{if(r.state==='queued'||r.state==='published')done(r);}).catch(error=>toast(error.message));};renderMembershipCatalog(host,redraw);}catch(error){host.textContent=error.message;directory.dataset.loaded='';}});
      card.querySelector('[data-ft-complete]')?.addEventListener('submit', async e => {
        e.preventDefault(); const form = e.currentTarget, fd = new FormData(form), fields = {};
        for (const key of ['title', 'type', 'claimMethod', 'endKind', 'claimEnd']) if (fd.get(key)) fields[key] = String(fd.get(key)).trim();
        for (const key of ['modalities', 'requirements']) if (form.querySelector(`[name="${key}"]`)) fields[key] = fd.getAll(key);
        if (form.querySelector('[data-membership-editor]')) {
          if (!form.membershipEditor?.touched && need(card).includes('membershipRequirement')) { toast('请先勾选适用的会员套餐'); return; }
          if (form.membershipEditor?.touched) { try { fields.membershipRequirement = membershipEditFields(job(card), form.membershipEditor, [], false, job(card).url).membershipRequirement; fields.membershipSelectionOnly = true; } catch (err) { toast(err.message); return; } }
        }
        try { done(await settleFastTrack(id, await adm(`/fast-track/${id}/complete`, { fields }))); } catch (err) { toast(err.message); }
      });
      card.querySelector('[data-ft-retry]')?.addEventListener('click', async () => { try { await adm(`/fast-track/${id}/retry`, {}); done({ state: 'queued' }); } catch (err) { toast(err.message); } });
      card.querySelector('[data-ft-advance]')?.addEventListener('click', async () => { try { done(await settleFastTrack(id, { state: 'publishing' })); } catch (err) { toast(err.message); } });
    });
  } catch (err) { box.textContent = err.message; }
}
async function admManual() {
  await refreshAdminPlatforms();
  $('#admBody').innerHTML = `<form id="admAdd" class="card" style="display:flex;flex-direction:column;gap:10px;max-width:640px"><p class="sub" style="margin:0">粘贴官网公告、公众号文章、推文或新闻链接。下一轮采集（最多 6 小时，也可以在 GitHub 手动触发）会抓取并研判，结果进待审。</p>
    <label class="field">链接<input type="url" name="url" required placeholder="https://"></label><label class="field">备注（可选）<input type="text" name="note" placeholder="比如：DeepSeek 桌面版送 6 元"></label><button class="btn pri" type="submit">补录</button></form>
    <form id="admSrc" class="card" style="display:flex;flex-direction:column;gap:10px;max-width:640px;margin-top:12px"><p class="sub" style="margin:0">补信源：给已登记的平台加一个官方页面（福利页、价格页、帮助文档、博客或 RSS），之后每轮采集都会抓它。只收发放方自己的官方页面。</p>
    <label class="field">平台<select name="platformId" required>${adminPlatformOptions()}</select></label><label class="field">官方链接<input type="url" name="url" required placeholder="https://"></label>
    <label class="field">类型<select name="kind"><option value="web_list">网页</option><option value="rss">RSS</option><option value="json">官方接口</option></select></label>
    <label class="field">级别<select name="tier"><option value="site">官网页面</option><option value="docs">官方文档</option><option value="official">官方账号（博客、公众号、X）</option><option value="staff">员工账号</option></select></label><button class="btn pri" type="submit">加入信源</button></form>`;
  $('#admSrc select[name="platformId"]').addEventListener('focus', refreshAdminPlatforms);
  $('#admSrc').insertAdjacentHTML('afterend', `<section id="admDiscord" class="card" style="display:flex;flex-direction:column;gap:10px;max-width:640px;margin-top:12px"><p class="sub" style="margin:0">Discord 频道：你在自己的服务器关注了厂商公告频道后，在这里把它登记到对应平台，之后它的公告才会成为线索。未登记的频道会被跳过并列在下面。</p><div data-discord-unmapped class="small muted">正在读取未登记频道…</div>
    <form data-discord-manual style="display:flex;flex-direction:column;gap:8px"><label class="field">平台<select name="platformId" required>${adminPlatformOptions()}</select></label><label class="field">频道链接<input name="link" required placeholder="https://discord.com/channels/服务器编号/频道编号"></label><label class="field">名称<input name="name" required placeholder="比如：Higgsfield AI #announcements"></label><button class="btn pri" type="submit">登记 Discord 频道</button></form></section>`);
  const discordBox = $('#admDiscord [data-discord-unmapped]');
  const registerDiscord = async payload => { try { await adm('/discord/publishers', payload); toast('已登记 Discord 频道，下一轮采集开始读取'); await loadDiscordUnmapped(); } catch (err) { toast(err.message); } };
  const loadDiscordUnmapped = async () => { try { const { origins } = await adm('/discord/unmapped'); discordBox.innerHTML = origins.length ? origins.map((o, i) => `<div class="row" style="gap:8px;flex-wrap:wrap;align-items:center"><a href="${esc(o.messageUrl)}" target="_blank" rel="noopener">打开被跳过的消息</a><small>${esc(o.guildId)}/${esc(o.channelId)}</small><select data-discord-platform="${i}">${adminPlatformOptions()}</select><input data-discord-name="${i}" placeholder="名称" style="max-width:180px"><button class="btn sm" type="button" data-discord-register="${i}">登记</button></div>`).join('') : '没有未登记的频道。'; discordBox.querySelectorAll('[data-discord-register]').forEach(b => b.addEventListener('click', () => { const i = b.dataset.discordRegister, o = origins[Number(i)]; const name = discordBox.querySelector(`[data-discord-name="${i}"]`).value.trim(); if (!name) { toast('写一个名称，比如 厂商 #announcements'); return; } registerDiscord({ platformId: discordBox.querySelector(`[data-discord-platform="${i}"]`).value, name, guildId: o.guildId, channelId: o.channelId }); })); } catch (err) { discordBox.textContent = err.message; } };
  $('#admDiscord [data-discord-manual]').addEventListener('submit', async e => { e.preventDefault(); const form = e.currentTarget; await registerDiscord(Object.fromEntries(new FormData(form))); form.reset(); });
  loadDiscordUnmapped();

  $('#admSrc').addEventListener('submit', async e => { e.preventDefault(); const form = e.currentTarget; try { const r = await adm('/sources', Object.fromEntries(new FormData(form))); toast(`已加入信源 ${r.id}，下一轮采集开始抓取`); form.reset(); } catch (err) { toast(err.message); } });
  $('#admAdd').addEventListener('submit', async e => { e.preventDefault(); const form = e.currentTarget; const fd = Object.fromEntries(new FormData(form)); try { const r = await adm('/manual', { url: fd.url, note: fd.note || undefined }); toast(`已补录（线索 #${r.leadId}）`); form.reset(); } catch (err) { toast(err.message); } });
}
function deliveryCard(x) {
  const channel={feishu:'飞书',telegram:'Telegram '}[x.channel]||x.channel+' ';
  const purpose={digest:'每日汇总',urgent:'临期提醒'}[x.kind]||x.kind;
  const state={pending:'发送结果待确认',unknown:'发送结果不确定'}[x.status]||x.status;
  const time=Number.isFinite(Date.parse(x.createdAt))?new Date(x.createdAt).toLocaleString('zh-CN',{hour12:false}):x.createdAt;
  const sending=x.status==='pending'&&Date.now()-Date.parse(x.createdAt)<10*60_000;
  return `<article class="card delivery-card" data-delivery="${esc(x.id)}"><h3>${esc(channel)}${esc(purpose)} · ${esc(state)}</h3>
    <p class="small muted">发起时间：${esc(time)}</p>${sending?'<p class="small">发送可能仍在进行，10 分钟后核对。</p>':''}
    <label class="field">核对依据<input type="text" placeholder="例如：在飞书中找到这条日报" data-reason></label>
    <div class="row"><button class="btn sm good" data-outcome="delivered" ${sending?'disabled':''}>确认已收到</button><button class="btn sm bad" data-outcome="not_delivered" ${sending?'disabled':''}>确认未收到，可重试</button></div>
    <details><summary>技术记录</summary><p class="small muted">编号：${esc(x.id)}${x.error?`<br>错误：${esc(x.error)}`:''}</p></details></article>`;
}
async function admHealth() {
  const h = await adm('/health');
  $('#admBody').innerHTML = `<section class="kpis" style="margin-top:0">
      <div class="kpi"><span class="k-l">最近成功采集</span><span class="k-v">${h.hoursSince == null ? '—' : h.hoursSince.toFixed(1)}<small>小时前</small></span></div>
      <div class="kpi"><span class="k-l">连续失败的信源</span><span class="k-v">${h.failingSources.length}<small>个</small></span></div>
      <div class="kpi"><span class="k-l">今日模型 token</span><span class="k-v">${Math.round(h.tokensToday / 1000)}<small>k${h.tokenCap ? ` / ${Math.round(h.tokenCap / 1000)}k` : ' · 调试期不设总上限'}</small></span></div>
      <div class="kpi"><span class="k-l">今日数据库读取（UTC）</span><span class="k-v">${h.d1Usage?.rowsRead != null ? `${(h.d1Usage.rowsRead / 10000).toFixed(0)}<small>万 / ${h.d1Usage.limits.rowsRead / 10000} 万行</small>` : '—<small>' + (h.d1Usage?.configured ? '读取失败' : '未配置') + '</small>'}</span></div>
      <div class="kpi"><span class="k-l">本月付费兜底</span><span class="k-v">¥${h.costMonthCny.toFixed(2)}<small>/ ¥10</small></span></div></section>
    ${h.officialReviewCounts?`<div class="card" style="margin-bottom:12px"><b>官方出处复核</b><p class="small">待处理 ${h.officialReviewCounts.waiting??0} · 进行中 ${h.officialReviewCounts.checking} · 退避重试 ${h.officialReviewCounts.retrying??0} · 已匹配 ${h.officialReviewCounts.matched} · 重试耗尽待人工 ${h.officialReviewCounts.exhausted??0} · 占位超时 ${h.officialReviewCounts.stalled??0}</p><p class="small muted">条目内可查看原线索、搜索出处、失败原因和下次重试时间。自动补全后仍需审核。</p></div>`:''}
    ${h.leadWorkflow?`<div class="card" style="margin-bottom:12px"><b>线索到审核</b><p class="small">待研判 ${h.leadWorkflow.new} · 线索复核 ${h.leadWorkflow.reviewing} · 需你判断 ${h.leadWorkflow.rescueManual??0} · 等待重试 ${h.leadWorkflow.rescueRetrying??0} · 重要线索 ${h.leadWorkflow.important}</p><p class="small muted">受阻线索会自动复核；在“待审”的线索复核区查看下次时间和处理原因，可关联已有活动或结束线索。</p></div>`:''}
    ${h.coverageDegraded?`<div class="card" style="margin-bottom:12px"><span class="st warn"><b>!</b>最近全量采集覆盖不完整</span><p class="small">核验失败 ${h.lastCollectAttempt?.stats?.verificationFailed??'未记录'} 次 · 核验延期 ${h.lastCollectAttempt?.stats?.verificationDeferred??'未记录'} 条。抓到网页不代表其中每项福利仍有效。</p></div>`:''}
    ${h.d1Usage?.rowsRead != null && h.d1Usage.rowsRead > h.d1Usage.limits.rowsRead * 0.7 ? `<div class="card" style="margin-bottom:12px"><span class="st warn"><b>!</b>数据库读取接近免费额度</span><p class="small" style="margin:6px 0 0">今天已读 ${Math.round(h.d1Usage.rowsRead / 10000)} 万行，免费版每天上限 500 万行，超了全站会无法加载，到 UTC 0 点（东京 9 点）才恢复。先停掉手动采集和批量操作，或在 Cloudflare 升级 Workers 付费版。</p></div>` : ''}
    ${h.dispatchFailures?.length ? `<div class="card" style="margin-bottom:12px"><span class="st warn"><b>!</b>定时采集没能触发</span><p class="small" style="margin:6px 0 0">最近 48 小时有 ${h.dispatchFailures.length} 次触发 GitHub 采集失败（已自动重试一次）：</p><ul class="small">${h.dispatchFailures.map(f => `<li>${esc(f.at.slice(0, 16).replace('T', ' '))} UTC：${esc(f.error || '')}</li>`).join('')}</ul><p class="small muted" style="margin:0">常见原因：GitHub 令牌过期或被重新生成。换上新令牌后在这里会恢复正常。</p></div>` : ''}
    ${h.uncertainDeliveries?.length ? `<section>${secH('投递结果需核对', '先在对应渠道核对是否收到，再记录结果')}${h.uncertainDeliveries.map(deliveryCard).join('')}</section>` : ''}
    <div class="card tbl" style="padding:4px 8px"><table><thead><tr><th>信源</th><th>类型</th><th>最近成功</th><th>状态</th><th>放权</th></tr></thead><tbody>${h.sources.filter(x => x.enabled).map(x => { const stale = !x.lastOkAt || Date.now() - Date.parse(x.lastOkAt) > 12 * 3600_000; return `<tr><td title="${esc(x.url)}">${esc(x.id)}</td><td class="small muted">${x.kind}</td><td class="small">${x.lastOkAt ? esc(x.lastOkAt.slice(5, 16).replace('T', ' ')) : '—'}</td><td>${x.failStreak >= 3 ? stBadge('critical', '✕', `连续失败 ${x.failStreak} 次`) : stale ? stBadge('warn', '!', '超过 12 小时未成功') : x.failStreak ? stBadge('warn', '!', '偶发失败') : stBadge('good', '✓', '正常')}</td><td class="small">${x.autoPublish ? '自动上架' : `人工（${x.cleanStreak}/5）`}</td></tr>`; }).join('')}</tbody></table></div>`;
  $$('[data-delivery] [data-outcome]').forEach(button => button.addEventListener('click', async () => { const box = button.closest('[data-delivery]'); const reason = box.querySelector('[data-reason]').value.trim(); if (reason.length < 4) { toast('请先写明人工核对依据'); return; } try { await adm(`/notify/${box.dataset.delivery}/resolve`, { outcome: button.dataset.outcome, reason }); toast('人工核对结果已记录'); admHealth(); } catch (e) { toast(e.message); } }));
}
function ecg(h) {
  let s = '';
  h.forEach((ok, i) => {
    const x = 2 + i * 5.2;
    s += ok ? `<path d="M${x.toFixed(1)},14 h1 l1,-8 l1.2,13 l1,-5 h1" style="fill:none;stroke:var(--good);stroke-width:1.3;stroke-linejoin:round"/>` : `<path d="M${x.toFixed(1)},14 h5.2" style="stroke:var(--critical);stroke-width:2"/><circle cx="${(x + 2.6).toFixed(1)}" cy="14" r="1.8" style="fill:var(--critical)"/>`;
  });
  return `<svg class="ecg" viewBox="0 0 160 26" aria-label="最近 30 次抓取，失败 ${h.filter(x => !x).length} 次">${s}</svg>`;
}

/* ============================================================
 * 外壳：导航、条件面板、对比、路由
 * ============================================================ */
function pAgent() {
  const mcp = 'https://ai-yangmao.com/api/mcp';
  const skillBase = 'https://ai-yangmao.com/ai-yangmao-public';
  const prompt = '安装并使用 AI 羊毛牧场公开查询 Skill：' + skillBase + '/SKILL.md 。先读取 https://ai-yangmao.com/api/agent 的能力说明，然后查询最新日报，或按我的用途和领取条件筛选权益。';
  let system = /win/i.test(navigator.userAgentData?.platform || navigator.platform || navigator.userAgent || '') ? 'windows' : 'unix';
  const block = (label, text, id) => '<div class="agent-code"><div class="row"><span class="small muted">' + esc(label) + '</span><button type="button" class="btn sm" data-agent-copy="' + id + '" aria-label="复制' + esc(label) + '">复制</button></div><pre id="' + id + '">' + esc(text) + '</pre></div>';
  const tools = ['yangmao_search_offers', 'yangmao_get_offer', 'yangmao_get_daily', 'yangmao_get_catalog'];
  const examples = ['给我最新一期羊毛日报。', '找不绑卡、不用付费的图像生成工具。', '我不是学生，没有海外手机号，但有某个会员，哪些羊毛适合我？', '列出未来 3 天截止的权益，附官方出处和领取步骤。'];
  main().innerHTML = ph('Agent 接入', '让你的 agent 读日报、找羊毛，并按你的条件判断能不能领。') +
    '<div class="agent-page"><div class="agent-intro"><b>选一种方式，就能开始查询</b><p>Skill 告诉 agent 怎么查，MCP 把查询工具接到客户端。任选一种即可，也可以搭配使用。</p><div class="chips"><span class="chip">公开只读</span><span class="chip">无需 API Key</span><span class="chip">无需项目仓库</span></div></div>' +
    '<div class="agent-platform"><span class="small muted">你的系统</span><div class="seg" role="group" aria-label="使用的操作系统"><button type="button" data-agent-os="windows" aria-pressed="false">Windows</button><button type="button" data-agent-os="unix" aria-pressed="false">macOS / Linux</button></div></div>' +
    '<section>' + secH('安装 Skill', '让 agent 了解查询方式与资格判断') + '<p>把下面这段话交给能安装技能的 agent；也可以自己在本机安装。</p>' + block('给 agent 的提示词', prompt, 'agentPrompt') +
    '<details class="agent-install" open><summary>自己在本机安装</summary><label class="agent-select">使用的 Agent<select data-agent-skill-client aria-label="Skill 使用的 Agent"><option value="codex" selected>Codex / 使用 .agents 技能目录的 Agent</option><option value="claude">Claude Code</option></select></label><p class="small muted" data-agent-install-hint aria-live="polite"></p><div data-agent-install-code></div><p class="small muted">安装器校验文件并在更新前备份旧版。安装后开启新对话；若未识别到技能，重启客户端。</p></details>' +
    '<div class="row"><a class="btn" href="/ai-yangmao-public/SKILL.md" target="_blank" rel="noopener">查看 Skill</a><a class="btn" href="/ai-yangmao-public/agents/openai.yaml" target="_blank" rel="noopener">查看技能元数据</a></div></section>' +
    '<section>' + secH('连接 MCP', '在客户端直接使用四个查询工具') + '<p>使用远程连接，传输方式为 Streamable HTTP，无需填写 Token 或在本机启动服务。</p>' + block('MCP 地址', mcp, 'agentMcp') +
    '<label class="agent-select">使用的客户端<select data-agent-mcp-client aria-label="MCP 客户端"><option value="codex" selected>Codex</option><option value="claude">Claude Code</option><option value="cursor">Cursor</option><option value="other">其他支持远程 MCP 的客户端</option></select></label><div data-agent-mcp-code></div>' +
    '<div class="agent-check"><b>怎么知道连接好了？</b><p>开启新对话，查看客户端的 MCP 工具列表，应出现以下四个工具，再试着问“给我最新一期羊毛日报”。</p><div class="chips">' + tools.map(tool => '<code class="chip">' + tool + '</code>').join('') + '</div></div></section>' +
    '<section>' + secH('可以这样问') + '<ul class="agent-examples">' + examples.map((text, i) => '<li><span id="agentExample' + i + '">' + esc(text) + '</span><button type="button" class="btn sm" data-agent-copy="agentExample' + i + '" aria-label="复制示例问题 ' + (i + 1) + '">复制问题</button></li>').join('') + '</ul></section>' +
    '<section>' + secH('结果怎么看') + '<p>日报与飞书共用一份固定内容，只提供最新一期；不是当天的会标明日期。领取前，agent 会继续查询当前详情。</p><p>资格分为符合、不符合和还需确认。你没提供的条件不会被猜成满足；价值待定不会按零计算。遇到快照或采集覆盖不完整，会注明时间与限制。</p><div class="row"><a class="btn" href="/api/agent" target="_blank" rel="noopener">读取能力说明</a><a class="btn" href="/api/agent/daily?format=markdown" target="_blank" rel="noopener">读取最新日报</a><a class="btn" href="/api/agent/search?requirement=nopay&format=markdown" target="_blank" rel="noopener">查看筛选示例</a></div></section></div>';
  const page = main().querySelector('.agent-page');
  const updateSkill = () => {
    const client = page.querySelector('[data-agent-skill-client]').value;
    const folder = client === 'claude' ? '.claude' : '.agents';
    const path = system === 'windows' ? '%USERPROFILE%\\' + folder + '\\skills\\ai-yangmao-public' : '~/' + folder + '/skills/ai-yangmao-public';
    const command = system === 'windows' ? [
      '& {',
      "  $ErrorActionPreference = 'Stop'",
      "  $installer = Join-Path $env:TEMP ('ai-yangmao-' + [guid]::NewGuid().ToString('N') + '.ps1')",
      '  try {',
      "    $download = Invoke-WebRequest -UseBasicParsing '" + skillBase + "/install.ps1' -TimeoutSec 30 -MaximumRedirection 0",
      '    [IO.File]::WriteAllBytes($installer, $download.RawContentStream.ToArray())',
      '    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installer' + (client === 'claude' ? " -Dir (Join-Path $env:USERPROFILE '.claude\\skills\\ai-yangmao-public')" : ''),
      "    if ($LASTEXITCODE -ne 0) { throw 'Skill installation failed.' }",
      '  } finally {',
      '    if (Test-Path -LiteralPath $installer) { Remove-Item -LiteralPath $installer -Force }',
      '  }',
      '}',
    ].join('\n') : [
      'curl --fail --silent --show-error ' + skillBase + '/install.sh -o /tmp/ai-yangmao-install.sh',
      'bash /tmp/ai-yangmao-install.sh' + (client === 'claude' ? ' --dir "$HOME/.claude/skills/ai-yangmao-public"' : ''),
    ].join('\n');
    page.querySelector('[data-agent-install-hint]').textContent = (system === 'windows' ? '在 PowerShell 中运行；支持 Windows PowerShell 5.1 和 PowerShell 7，无需 Bash、Node.js 或管理员权限。' : '在 macOS / Linux 终端中运行。') + ' 安装到 ' + path + '。';
    page.querySelector('[data-agent-install-code]').innerHTML = block(system === 'windows' ? 'Windows PowerShell 安装命令' : 'macOS / Linux 安装命令', command, 'agentInstall');
  };
  const updateMcp = () => {
    const client = page.querySelector('[data-agent-mcp-client]').value;
    let html;
    if (client === 'codex') {
      const path = system === 'windows' ? '%USERPROFILE%\\.codex\\config.toml' : '~/.codex/config.toml';
      html = '<p class="small muted">已安装 Codex CLI 时，在终端运行以下命令；添加后用 list 查看配置。</p>' +
        block('Codex MCP 命令', 'codex mcp add ai-yangmao --url ' + mcp + '\ncodex mcp list', 'agentCodex') +
        '<details class="agent-install"><summary>手动编辑 Codex 配置（TOML）</summary><p class="small muted">将下面的服务段添加到 ' + esc(path) + '，保留已有配置。</p>' +
        block('Codex TOML 配置', '[mcp_servers.ai-yangmao]\nurl = "' + mcp + '"', 'agentCodexConfig') + '</details>';
    } else if (client === 'claude') {
      html = '<p class="small muted">在已安装 Claude Code 的终端中运行。用户级配置可在不同项目中使用；用 get 查看该服务。</p>' +
        block('Claude Code MCP 命令', 'claude mcp add --transport http --scope user ai-yangmao ' + mcp + '\nclaude mcp get ai-yangmao', 'agentClaude');
    } else if (client === 'cursor') {
      const path = system === 'windows' ? '%USERPROFILE%\\.cursor\\mcp.json' : '~/.cursor/mcp.json';
      html = '<p class="small muted">在 ' + esc(path) + ' 中添加以下服务。已有 mcpServers 时只合并 ai-yangmao 这一项，保留其他服务；保存后重新打开客户端。</p>' +
        block('Cursor JSON 配置', JSON.stringify({ mcpServers: { 'ai-yangmao': { url: mcp } } }, null, 2), 'agentConfig');
    } else {
      html = '<div class="agent-check"><p>打开客户端的 MCP 或连接器设置，添加远程服务：</p><dl><div><dt>名称</dt><dd>ai-yangmao</dd></div><div><dt>地址</dt><dd>' + mcp + '</dd></div><div><dt>传输方式</dt><dd>Streamable HTTP</dd></div><div><dt>认证</dt><dd>无需认证</dd></div></dl><p class="small muted">使用客户端自己的配置格式；上方 Cursor JSON 和 Codex TOML 分别用于对应客户端。</p></div>';
    }
    page.querySelector('[data-agent-mcp-code]').innerHTML = html;
  };
  const updateSystem = () => {
    page.querySelectorAll('[data-agent-os]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.agentOs === system)));
    updateSkill();
    updateMcp();
  };
  page.querySelectorAll('[data-agent-os]').forEach(button => button.addEventListener('click', () => { system = button.dataset.agentOs; updateSystem(); }));
  page.querySelector('[data-agent-skill-client]').addEventListener('change', updateSkill);
  page.querySelector('[data-agent-mcp-client]').addEventListener('change', updateMcp);
  const copyTimers = new WeakMap();
  page.addEventListener('click', async event => {
    const button = event.target.closest?.('[data-agent-copy]');
    if (!button || button.disabled) return;
    const label = button.dataset.agentCopyLabel ||= button.textContent;
    button.disabled = true;
    try {
      await navigator.clipboard.writeText(document.getElementById(button.dataset.agentCopy).textContent);
      if (!button.isConnected) return;
      button.textContent = '已复制';
      toast('已复制');
      clearTimeout(copyTimers.get(button));
      copyTimers.set(button, setTimeout(() => { if (button.isConnected) button.textContent = label; }, 1600));
    } catch { if (button.isConnected) toast('复制未完成，请选中文字手动复制'); }
    finally { button.disabled = false; }
  });
  updateSystem();
}
const PAGES = { today: pToday, calendar: pCalendar, timeline: pTimeline, insights: pInsights, all: pAll, library: pLibrary, apply: pApply, models: pModels, mine: pMine, coverage: pCoverage, 'valuation-method': pValuationMethod, agent:pAgent, admin: pAdmin };
const NAVS = [
  ['逛牧场', [['today', '今天'], ['calendar', '日历'], ['timeline', '时间线'], ['insights', '洞察']]],
  ['找羊毛', [['all', '全部羊毛'], ['library', '常驻额度库'], ['apply', '申请制'], ['models', '按模型找']]],
  ['我', [['mine', '我的']]],
  ['关于', [['agent','Agent 接入'], ['valuation-method', '参考价值怎么算'], ['coverage', '覆盖范围']]],
];
const TITLES = Object.fromEntries(NAVS.flatMap(g => g[1]));
function drawShell() {
  $$('[data-brand]').forEach(el => { el.innerHTML = BRAND; });
  $('#sideNav').innerHTML = NAVS.map(([g, items]) => `<div class="nav-sep">${g}</div>${items.map(([k, l]) => `<a href="#${k}" data-nav="${k}">${ICON[k]}${l}</a>`).join('')}`).join('');
  $('#tabbar').innerHTML = [['today', '今天'], ['calendar', '日历'], ['timeline', '时间线'], ['insights', '洞察']].map(([k, l]) => `<a href="#${k}" data-nav="${k}">${ICON[k]}<span>${l}</span></a>`).join('') + `<button type="button" data-more>${ICON.more}<span>更多</span></button>`;
  $('#sideFoot').innerHTML = `<span class="live"><i></i>最近更新 ${LAST_OK ? hm(LAST_OK) : '—'}</span><a href="/rss.xml" target="_blank" rel="noopener" style="text-decoration:underline">RSS 订阅</a><a href="#coverage" style="text-decoration:underline">只收能追到官方出处的羊毛，不保证覆盖所有活动</a>`;
  $('#sideFoot').insertAdjacentHTML('beforeend', window.YMTheme?.control() || '');
  drawCondBtn();
}
function drawCondBtn() {
  const n = COND_ITEMS.filter(([k]) => !['realname', 'pay'].includes(k) && C[k]).length + (C.subscriptions || []).length;
  $$('[data-open-cond]').forEach(b => { if (b.classList.contains('cond-btn')) b.innerHTML = `我的条件${n ? `<span class="badge">${n}</span>` : ''}${C.only ? ' · 只看确定符合' : ''}`; });
}
function markNav(name) {
  $$('[data-nav]').forEach(a => { const on = a.dataset.nav === name; a.classList.toggle('on', on); if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
  const moreOn = !['today', 'calendar', 'timeline', 'insights'].includes(name);
  const mb = $('[data-more]'); if (mb) mb.classList.toggle('on', moreOn);
}
let SHEET_CHARTS = new Set();
function openSheet(title, html, after) {
  $('#sheetPanel').innerHTML = `<div class="sheet-head"><h2 id="sheetTitle">${title}</h2><button class="btn sm" type="button" data-close>关闭</button></div>${html}`;
  $('#sheet').hidden = false;
  document.body.style.overflow = 'hidden';
  after && after();
  const f = $('#sheetPanel [data-close]'); f && f.focus();
}
function closeSheet() {
  SHEET_CHARTS.forEach(c => c.dispose()); SHEET_CHARTS.clear();
  $('#sheet').hidden = true; document.body.style.overflow = '';
}
function openCond() { openSheet('我的条件', condForm()); }
function openMore() {
  const items = [['all', '全部羊毛'], ['library', '常驻额度库'], ['apply', '申请制'], ['models', '按模型找'], ['mine', '我的'], ['agent','Agent 接入'], ['valuation-method', '参考价值怎么算'], ['coverage', '覆盖范围'], ...(ADM.token ? [['admin', '后台']] : [])];
  openSheet('更多', `<div class="more-nav">${items.map(([k, l]) => `<a href="#${k}" data-close>${ICON[k]}${l}</a>`).join('')}</div><div class="appearance-row"><span>外观</span>${window.YMTheme?.control() || ''}</div>`);
}
function drawTray() {
  const t = $('#tray');
  if (!CMP.length) { t.hidden = true; return; }
  t.hidden = false;
  t.innerHTML = `<span>已选 ${CMP.length} 条对比（最多 3 条）</span><button class="btn sm" type="button" data-cmp-open>开始对比</button><button class="btn sm" type="button" data-cmp-clear style="background:transparent;color:var(--bg);border-color:transparent">清空</button>`;
}
function openCompare() {
  const list = CMP.map(id => OMAP[id]);
  const compareValue = list.every(o => valueNumber(o) != null);
  const compareDims = DIMS.filter((_, i) => i !== 0 || compareValue);
  const rowsDef = [['额度', o => valLabel(o).replace(/<[^>]+>/g, ' ')], ['薅度分', o => score(o)], ['类型', o => TYPES[o.ty].l], ['门槛', o => o.r.map(reqLabel).join('、')], ['领取截止／权益生效', o => oneTimeEffectiveAt(o) ? `生效 ${oneTimeEffectiveAt(o)}` : o.ek === 'date' ? md(dayAt(o.e)) : o.ek === 'unknown' ? '截止未知' : '长期'], ['额度有效期', o => o.val]];
  openSheet('对比', `<p class="small muted">参考值以一个月为比较窗口，方法见各条标签。${compareValue ? '' : '有活动价值待定或属于申请制，雷达统一省略价值维度，不按零比较。'}</p><div class="chart" id="cCmp" style="height:300px"></div><div class="tbl"><table><thead><tr><th></th>${list.map((o, i) => `<th><span class="row" style="gap:6px;flex-wrap:nowrap"><i class="sw" style="background:var(--s${i + 1})"></i>${esc(o.plat.name)}</span></th>`).join('')}</tr></thead><tbody>${rowsDef.map(([k, f]) => `<tr><td class="muted">${k}</td>${list.map(o => `<td style="white-space:normal;min-width:120px">${esc(f(o))}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`, () => {
    chart('#cCmp', {
      legend: Object.assign(legendCommon(), { bottom: 0, data: list.map(o => o.t.length > 14 ? o.t.slice(0, 13) + '…' : o.t) }),
      tooltip: { trigger: 'item' },
      radar: { indicator: compareDims.map(n => ({ name: n, max: 100 })), radius: '60%', center: ['50%', '46%'], splitNumber: 4, axisName: { color: TK.ink2, fontSize: 12 }, splitLine: { lineStyle: { color: TK.line2 } }, splitArea: { areaStyle: { color: [TK.surface, TK.surface2] } }, axisLine: { lineStyle: { color: TK.line2 } } },
      series: [{ type: 'radar', data: list.map((o, i) => ({ value: dims(o).filter((_, i) => i !== 0 || compareValue), name: o.t.length > 14 ? o.t.slice(0, 13) + '…' : o.t, lineStyle: { color: TK.s[i], width: 2 }, itemStyle: { color: TK.s[i] }, areaStyle: { color: TK.s[i], opacity: 0.12 }, symbolSize: 5 })) }],
    }, SHEET_CHARTS);
  });
}

let offerReturnHash = '#today';
function route() {
  const h = decodeURIComponent(location.hash.slice(1)) || 'today';
  if (h.startsWith('admin-offer-')) return ['admin', h.slice(12)];
  if (h.startsWith('offer-')) return ['offer', h.slice(6)];
  if (h.startsWith('platform-')) return ['platform', h.slice(9)];
  return [PAGES[h] ? h : 'today', null];
}
/** True while boot's first data load runs: a tab change must not draw a page from empty data. */
let DATA_LOADING = false;
function render(keepScroll) {
  if (DATA_LOADING) { markNav(route()[0]); return; }
  CARD_WALL_SEQ = 0;
  NOW = new Date();
  TK = tk();
  const [name, arg] = route();
  if (name !== 'offer') offerReturnHash = location.hash || '#today';
  CHARTS.forEach(c => c.dispose()); CHARTS.clear(); hideTip();
  const y = window.scrollY;
  if (name === 'offer') pOffer(arg); else if (name === 'platform') pPlatform(arg); else if (name === 'admin') pAdmin(arg); else PAGES[name]();
  markNav(name === 'offer' || name === 'platform' ? '' : name);
  document.title = name === 'offer' && OMAP[arg] ? `${OMAP[arg].t} · AI 羊毛牧场` : name === 'platform' && PMAP[arg] ? `${PMAP[arg].name} · AI 羊毛牧场` : pageTitle(name);
  drawTray();
  if (keepScroll) window.scrollTo(0, y); else window.scrollTo(0, 0);
}

/* ---------- 全局事件 ---------- */
document.addEventListener('click', e => {
  const moreCards = e.target.closest('[data-more-cards]');
  if (moreCards) { showMoreCards(moreCards); return; }
  const t = e.target.closest('[data-open-cond],[data-more],[data-close],[data-cmp],[data-cmp-open],[data-cmp-clear],[data-want],[data-got],[data-remove-legacy],[data-mem],tr[data-href]');
  if (!t) return;
  if (t.matches('[data-open-cond]')) { e.preventDefault(); openCond(); return; }
  if (t.matches('[data-more]')) { openMore(); return; }
  if (t.matches('[data-close]')) { closeSheet(); return; }
  if (t.matches('tr[data-href]')) { location.hash = t.dataset.href.slice(1); return; }
  if (t.matches('[data-cmp]')) {
    e.preventDefault(); const id = t.dataset.cmp;
    if (CMP.includes(id)) CMP = CMP.filter(x => x !== id);
    else { if (CMP.length >= 3) { toast('最多对比 3 条，先去掉一条'); return; } CMP.push(id); }
    $$(`[data-cmp="${id}"]`).forEach(b => b.setAttribute('aria-pressed', CMP.includes(id)));
    drawTray(); return;
  }
  if (t.matches('[data-cmp-open]')) { openCompare(); return; }
  if (t.matches('[data-cmp-clear]')) { CMP = []; $$('[data-cmp]').forEach(b => b.setAttribute('aria-pressed', 'false')); drawTray(); return; }
  if (t.matches('[data-want]')) {
    const id = t.dataset.want;
    MINE.want = MINE.want.includes(id) ? MINE.want.filter(x => x !== id) : [...MINE.want, id];
    LS.set('ym-mine', MINE); toast(MINE.want.includes(id) ? '已加入想领' : '已取消'); render(true); return;
  }
  if (t.matches('[data-got]')) {
    const id = t.dataset.got, month = localMonth();
    if (claimedThisMonth(id)) MINE.claimed = MINE.claimed.filter(x => !(x.id === id && x.month === month));
    else { const o = OMAP[id]; MINE.claimed.push({ id, month, at: new Date().toISOString(), usd: valueNumber(o), ty: o.ty, valuation: valuationOf(o) }); }
    LS.set('ym-mine', MINE); toast(claimedThisMonth(id) ? '已记入本月' : '已撤销本月记录'); render(true); return;
  }
  if (t.matches('[data-remove-legacy]')) {
    MINE.legacyGot = MINE.legacyGot.filter(id => id !== t.dataset.removeLegacy);
    LS.set('ym-mine', MINE); render(true); return;
  }

});
bindSubscriptionEvents();
document.addEventListener('change', e => {
  const t = e.target.closest('[data-c]'); if (!t) return;
  C[t.dataset.c] = t.checked; LS.set('ym-cond', C); RACE = computeRace(); TREND = computeTrend(); drawCondBtn();
  $$(`[data-c="${t.dataset.c}"]`).forEach(x => { x.checked = t.checked; });
  render(true);
});
$('#sheet').addEventListener('click', e => { if (e.target.id === 'sheet') closeSheet(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#sheet').hidden) closeSheet(); });
window.addEventListener('hashchange', () => { closeSheet(); render(false); });
let rsT;
window.addEventListener('resize', () => {
  clearTimeout(rsT);
  rsT = setTimeout(() => {
    CHARTS.forEach(c => c.resize()); SHEET_CHARTS.forEach(c => c.resize());
    const f = $('#flock'); if (f && Math.abs((+f.dataset.w || 0) - f.clientWidth) > 40) buildFlock(f, view(OFFERS.filter(activeLimited)), weatherNow());
  }, 180);
});
let refreshInFlight = false, lastRefreshAt = Date.now();
// 后台、接入说明和正在填表的页面保留操作状态；接入说明不依赖定期加载的活动数据。
const keepPage = () => ['admin', 'agent'].includes(route()[0]) || (route()[0] === 'offer' && (NOTE_DRAFTS.has(route()[1]) || NOTE_SAVES.has(route()[1]) || COMMENT_STATE.get(route()[1])?.removing.size || !!$('[data-comment-delete-confirm]'))) || !!document.activeElement?.closest?.('form, textarea, input, select') || $$('[data-editform]:not([hidden])').length > 0 || !!$('[data-online-edit-box] [data-code]');
async function refreshPage() {
  if (refreshInFlight) return;
  refreshInFlight = true;
  lastRefreshAt = Date.now();
  const previous = { OFFERS, PLATFORMS, META, COVERAGE, NOW, T0 };
  try {
    NOW = new Date(); T0 = new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate());
    await loadData();
    if (keepPage()) {
      ({ OFFERS, PLATFORMS, META, COVERAGE, NOW, T0 } = previous);
      return;
    }
    prepare(); render(true);
  } catch (e) { /* 保留已加载页面；下次周期检查会再试 */ }
  finally { refreshInFlight = false; }
}
setInterval(() => {
  if (document.hidden || keepPage()) return;
  const now = Date.now();
  $$('[data-end]').forEach(el => { el.textContent = cdText(+el.dataset.end - now); });
  $$('[data-estimated-end]').forEach(el => { el.textContent = estimatedCountdown({ end: new Date(+el.dataset.estimatedEnd), earliest: el.dataset.estimatedStart ? new Date(+el.dataset.estimatedStart) : null }, now); });
  $$('[data-since]').forEach(el => { el.textContent = cdText(now - +el.dataset.since); });
  const endedOrStarted = $$('[data-end], [data-estimated-end]').some(el => +(el.dataset.end || el.dataset.estimatedEnd) <= now);
  if (!refreshInFlight && !keepPage() && (ymd(new Date()) !== ymd(T0) || now - lastRefreshAt >= 5 * 60_000 || (endedOrStarted && now - lastRefreshAt >= 10_000))) refreshPage();
}, 1000);
// Recolour charts in place so filters, zoom, dialogs, focus and form drafts survive.
const reTheme = () => {
  const previous = TK;
  TK = tk();
  const colours = new Map();
  Object.keys(TK).forEach(key => {
    const before = [].concat(previous[key]), after = [].concat(TK[key]);
    before.forEach((colour, index) => {
      colours.set(colour.toLowerCase(), after[index]);
      // Gradients and overlays also use rgba() versions of the same tokens.
      const rgb = colour.replace('#', '').match(/.{2}/g)?.map(x => parseInt(x, 16));
      if (rgb) colours.set(rgb.join(','), after[index].replace('#', '').match(/.{2}/g).map(x => parseInt(x, 16)).join(','));
    });
  });
  const recolour = value => {
    if (typeof value === 'string') return value.replace(/#[\da-f]{6}\b|rgba?\([\d.,\s]+\)/gi, colour => {
      if (colour[0] === '#') return colours.get(colour.toLowerCase()) || colour;
      return colour.replace(/\d+\s*,\s*\d+\s*,\s*\d+/, rgb => colours.get(rgb.replace(/\s/g, '')) || rgb);
    });
    if (Array.isArray(value)) return value.map(recolour);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, recolour(item)]));
    return value;
  };
  [...CHARTS, ...SHEET_CHARTS].forEach(c => { if (!c.isDisposed()) c.setOption(recolour(c.getOption())); });
};
new MutationObserver(reTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

(async function boot() {
  drawShell();
  const agentLanding = route()[0] === 'agent';
  if (agentLanding) render(false);
  else main().innerHTML = emptySheep('正在把羊赶进草地…');
  DATA_LOADING = true;
  try { await Promise.all([loadData(), restoreAdminRole()]); }
  catch (e) { DATA_LOADING = false; refreshSubscriptionControls(); if (route()[0] !== 'agent') main().innerHTML = emptySheep('数据没有加载成功，请稍后刷新。'); return; }
  DATA_LOADING = false;
  prepare();
  refreshSubscriptionControls();
  drawShell();
  if (window.echarts) render(false);
  else main().innerHTML = ribbon() + emptySheep('图表库没有加载成功，请检查网络后刷新。');
})();
