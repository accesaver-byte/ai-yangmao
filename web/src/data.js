/* ============================================================
 * AI 羊毛牧场 · 正式网站的数据层
 * 从 /api 读取真实数据，转换成页面代码使用的格式（和原型一致，便于复用全部图表）。
 * 日期统一换算为"相对今天的天数"：s 开始、e 截止、fs 系统发现、vf 最近核验（负数 = 几天前）。
 * ============================================================ */

const TYPES = {
  new:      { l: '注册新人礼',   slot: 1 },
  trial:    { l: '应用尝鲜',     slot: 8 },
  free:     { l: '限时免费开放', slot: 2 },
  perk:     { l: '会员福利',     slot: 3 },
  topup:    { l: '充值赠送',     slot: 4 },
  gift:     { l: '会员免费送',   slot: 5 },
  standing: { l: '常驻免费额度', slot: 6 },
  apply:    { l: '申请制',       slot: 7 },
};
const MODAL = { text: '文本·编程', image: '图像', video: '视频', audio: '音乐·语音' };
const CLAIM = { auto: '自动到账', signup: '注册即送', app: '下载应用并登录', form: '邮件或表单申请', topup: '充值触发', member: '会员自动生效', code: '兑换码' };
const REQ = {
  none: '零门槛', unknown: '领取条件待确认', pay: '需充值', member: '需会员', phone: '需海外手机号', card: '需海外信用卡', net: '需海外网络',
  realname: '需实名', biz: '需企业认证', student: '需学生认证', invite: '需邀请码', targeted: '定向发放',
};
const SRC = { site: '官网公告', docs: '帮助文档', official: '官方账号', staff: '员工账号', media: '媒体转述（人工审核）', tested: '管理员亲测可领' };
const PTYPE = { lab: { l: '模型厂商', slot: 1 }, cloud: { l: '云厂商', slot: 2 }, infra: { l: '推理平台', slot: 3 }, tool: { l: 'AI 工具', slot: 4 }, new: { l: '新玩家', slot: 5 } };
const TZ = { 'Asia/Shanghai': '北京时间', 'America/Los_Angeles': '美西时间（PT）', 'America/New_York': '美东时间（ET）', 'UTC': 'UTC' };
const AUD = { new: '新用户', old: '老用户', all: '全部用户', unclear: '资格未明确' };
const CHANNEL = { web_list: '官网页面', rss: '官方 RSS', json: '官方接口', aihot: 'AIHOT', hn: 'Hacker News', reddit: 'Reddit', email: '订阅邮件', manual: '补录', sweep: '周六扫描', telegram: '补录', discord: 'Discord' };

// 节日与购物节（叠加在日历上）。past：往年同期发过羊毛的平台，数据积累后由真实记录替换。
const HOLIDAYS = [
  { d: '2026-10-01', n: '国庆', past: '' },
  { d: '2026-11-11', n: '双 11', past: '' },
  { d: '2026-11-27', n: '黑五', past: '' },
  { d: '2026-12-12', n: '双 12', past: '' },
  { d: '2026-12-25', n: '圣诞', past: '' },
  { d: '2027-01-01', n: '元旦', past: '' },
  { d: '2027-02-06', n: '春节', past: '' },
];

let PLATFORMS = [];
let OFFERS = [];
let META = { lastSuccessfulCollect: null };
let COVERAGE = null;
let MEMBERSHIP_CATALOG = { revision: 0, products: [], plans: [] };
let MEMBERSHIP_CATALOG_OK = false;

async function loadData({ fresh = false } = {}) {
  const stamp = Date.now();
  const get = async p => { const url = fresh ? `${p}${p.includes('?') ? '&' : '?'}fresh=${stamp}` : p; const r = await fetch(url, { ...(fresh ? { cache: 'no-store' } : {}), headers: { Accept: 'application/json' } }); if (!r.ok) throw new Error(`${p} ${r.status}`); return r.json(); };
  // A new response contract must not reuse a browser/CDN entry without valuation metadata.
  const [pl, of, meta, cov, memberships] = await Promise.all([get('/api/platforms'), get('/api/offers?view=all&valuation=v2&schema=valuation-v2-public-inputs&lifecycle=approved-contract-v1'), get('/api/meta?schema=partial-fetch-v1'), get('/api/coverage?schema=partial-fetch-v1').catch(() => null), get('/api/memberships').catch(() => null)]);
  MEMBERSHIP_CATALOG_OK = !!memberships && Number.isInteger(memberships.revision) && Array.isArray(memberships.products) && Array.isArray(memberships.plans);
  if (MEMBERSHIP_CATALOG_OK) MEMBERSHIP_CATALOG = memberships;
  const now = Date.now(), DAYMS = 864e5;
  const t0 = new Date(); t0.setHours(0, 0, 0, 0);
  const rel = d => (d ? Math.round((new Date(d + 'T00:00:00') - t0) / DAYMS) : null);
  PLATFORMS = pl.platforms.map(p => ({ id: p.id, name: p.name, type: p.type, site: p.site || '', x: (p.xHandles || []).join(' · '), company: p.company || '', aliases: p.aliases || [] }));
  OFFERS = of.offers.map(o => {
    const overseas = o.requirements.some(r => ['phone', 'card', 'net'].includes(r.split(':')[0]));
    return {
      id: o.id, p: o.platformId, t: o.title, ty: o.type, m: [...new Set(o.modalities.map(x => x === 'code' ? 'text' : x))], c: o.claimMethod, r: o.requirements.length ? o.requirements : ['none'],
      v: o.valueText, usd: o.usdEstimate ?? null, usdMax: o.usdMax ?? null, noUsd: o.usdEstimate == null,
      valuation: o.valuation || null, membershipRequirement: o.membershipRequirement || null,
      s: rel(o.claimStart), e: o.endKind === 'date' ? rel(o.claimEnd) : null, ek: o.endKind,
      vf: o.lastVerifiedAt ? -(now - Date.parse(o.lastVerifiedAt)) / DAYMS : -99,
      vfDay: o.lastVerifiedAt ? dayIdx(new Date(o.lastVerifiedAt)) : null,
      fs: dayIdx(new Date(o.discoveredAt)), discoveredAt: o.discoveredAt,
      // 活动出现的日子：官方开始日 → 官方发布日 → 系统发现日。“新增”类统计都按它算，补录的历史活动不会算成本周新增
      pub: o.publishedAt ? dayIdx(new Date(o.publishedAt)) : null, publishedAt: o.publishedAt || null,
      since: o.claimStart ? rel(o.claimStart) : o.publishedAt ? dayIdx(new Date(o.publishedAt)) : dayIdx(new Date(o.discoveredAt)),
      verifiedAt: o.lastVerifiedAt, withdrawnAt: o.withdrawnAt,
      st: o.evidence.tier, tz: o.sourceTz, val: o.creditValidity || '官方未写明', aud: o.audience,
      cn: !overseas, early: CHANNEL[o.firstChannel] || o.firstChannel || '官方页面', why: o.withdrawnReason || '',
      steps: o.steps || [], models: o.models || [], tags: o.tags || [], evidence: o.evidence, note: o.adminNote || '', verify: o.verifyResult || '', apiStatus: o.status,
    };
  });
  META = meta;
  COVERAGE = cov;
}
