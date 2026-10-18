import { describe, expect, it } from 'vitest';
import { isFreebie, isLead } from '../pipeline/lib';

// 2026-10-01 漏抓排查：这些都是官方页或社区里真实出现过的福利说法，之前因为关键词表缺“积分、灵感值、邀请、实名、首月”等被过滤掉
describe('羊毛关键词', () => {
  it('官方页面里多模态平台的积分类福利能被识别', () => {
    for (const s of ['免费账号每日登录20积分', '每日补至50积分，不累计', '每月128免费灵感值', 'Free套餐每日免费积分70',
      '完成有效实名认证可领取16元全平台通用代金券', '连续包月首月90% off', 'Create using 50 credits that renew daily',
      '每邀请1位用户完成注册认证，邀请人可得16元', '每天3小时免费体验']) expect(isFreebie(s), s).toBe(true);
    expect(isFreebie('Our company was founded in 2020')).toBe(false);
  });
  it('社区线索里的同类说法能被识别', () => {
    for (const s of ['即梦每日登录送66积分', '硅基流动实名认证送16元代金券', 'Dreamina 90% off first month', '邀请好友双方各得250积分']) expect(isLead(s), s).toBe(true);
  });
  it('保留 Day N 公告中带简短修饰词的重置，不跨行拼接无关文字', () => {
    expect(isLead('Day 13/ Le limit reset')).toBe(true);
    expect(isLead('Day 14/ Usage limit reset')).toBe(true);
    expect(isLead('Day 13/ Product news\nFactory reset your phone')).toBe(false);
  });
  // 2026-10-15 漏抓：故障补偿和只写“重置”的员工公告
  it('故障补偿、消耗返还和全局重置能被识别', () => {
    for (const s of ['DeepSeek 服务故障近 5 小时，官方补偿所有 API 用户 7 天内消耗金额', 'DeepSeek 就 10 月 15 日 API 故障致歉并全额补偿 7 日消耗金额',
      'DeepSeek 要发钱了，过去七天内的花费都会返还', 'DeepSeek API outage: full refund of 7 days of spend as credits', 'Vendor will compensate affected users with API credits',
      'The reports of my reset button being lost are greatly exaggerated\n\nDay 10/ Reset', 'OpenAI 重置按钮回归', 'Codex 全局重置已完成', 'Global reset landing by EOD PST time']) expect(isLead(s), s).toBe(true);
    for (const s of ['京东 7999 元苹果 iPhone Duo 早鸟权益包下架，部分消费者投诉无法退款', 'Grok Bot 订票出错 SpaceX 全额赔付', '性能最高提升 35%：非官方英伟达 DLSS 预设 C 登场']) expect(isLead(s), s).toBe(false);
  });
});

import { parseModelJson } from '../pipeline/llm';
describe('模型输出的 JSON', () => {
  it('后面多吐内容、末尾多逗号、带代码块标记都能解析', () => {
    expect(parseModelJson('{"offers":[]}\n以上是结果')).toEqual({ offers: [] });
    expect(parseModelJson('```json\n{"offers":[{"a":1,},]}\n```')).toEqual({ offers: [{ a: 1 }] });
    expect(parseModelJson('{"offers":[{"t":"含 } 括号"}]}{"extra":1}')).toEqual({ offers: [{ t: '含 } 括号' }] });
  });
});

describe('模型输出的 JSON（jsonrepair 兜底）', () => {
  it('注释、单引号、缺引号的键都能修好', () => {
    expect(parseModelJson("{\n  // 结果\n  'offers': [\n  {title: '免费额度'}\n]}")).toEqual({ offers: [{ title: '免费额度' }] });
  });
});

import { tidy } from '../pipeline/llm';
describe('模型字段取值不合规时不丢整条', () => {
  it('不认识的领取方式、类型、时区、日期都会被规整成合法值', () => {
    const o = tidy({ type: 'Free API program', claimMethod: 'apply via website', audience: 'everyone', sourceTz: 'Beijing', endKind: 'date', claimEnd: '10月7日', claimStart: '2026-09-28', modalities: ['3D', 'text'], requirements: [], steps: [], excerpts: {} } as never);
    expect(o).toMatchObject({ type: 'apply', claimMethod: 'form', audience: 'unclear', sourceTz: 'UTC', endKind: 'standing', claimEnd: null, claimStart: '2026-09-28', modalities: ['image', 'text'] });
    expect(tidy({ type: 'signup bonus', claimMethod: 'download the desktop client', endKind: 'date', claimEnd: '2026-10-06', sourceTz: 'Asia/Shanghai', modalities: [], requirements: [], steps: [], excerpts: {} } as never))
      .toMatchObject({ type: 'new', claimMethod: 'app', endKind: 'date', claimEnd: '2026-10-06', sourceTz: 'Asia/Shanghai', modalities: ['text'] });
  });
});

import { readFileSync } from 'node:fs';
import { parsePlatformNotes, platformNotesFor } from '../pipeline/llm';
describe('平台抽取要点', () => {
  it('按平台 id 解析，只附上相关平台的要点', () => {
    const notes = parsePlatformNotes('# 标题\n说明\n## hf\n- 免费 $0.10 仅限 Inference Providers\n## opencode\n- 分三条\n- Go 价值 $10–60\n');
    expect(notes.get('opencode')).toEqual(['分三条', 'Go 价值 $10–60']);
    const p = platformNotesFor(['hf', 'unknown', null], notes);
    expect(p).toContain('【hf】');
    expect(p).not.toContain('opencode');
    expect(platformNotesFor([], notes)).toBe('');
  });
  it('仓库里的要点文件每个平台 id 都在白名单里', () => {
    const notes = parsePlatformNotes(readFileSync(new URL('../pipeline/platform-notes.md', import.meta.url), 'utf8'));
    const ids = new Set((JSON.parse(readFileSync(new URL('../seed/platforms.json', import.meta.url), 'utf8')) as { platforms: { id: string }[] }).platforms.map(p => p.id));
    expect([...notes.keys()].filter(id => !ids.has(id))).toEqual([]);
    expect(notes.size).toBeGreaterThan(20);
  });
});

import { isAiFreebieTopic } from '../pipeline/lib';
// 2026-10-15：LINUX DO 福利版块整版收录，七成是非 AI 福利，中转站推广还被误关联到 Google 条目。
describe('综合福利版块的 AI 主题筛选', () => {
  it('保留 AI 产品与模型福利', () => {
    for (const t of ['DeepSeek 要发钱了，过去七天内的花费都会返还', 'U2 flash 官网免费用，免费到10.30号', 'qoder领18元奶茶免单卡', 'claude重置卡别忘了用',
      '国际版workbuddy的deepseek免费时间又延长了（到10月31号）', 'gmi cloud 免费一周qwen 3.8max ,flash ,wan 3.0', 'Gemini Plus免费一年订阅 国内学生也可以领', '领 ZCode 3 亿臭鸡蛋啦！', 'Step滞销，帮帮我们', '【已无】SenseAudio速蹬，16号到期']) expect(isAiFreebieTopic(t), t).toBe(true);
  });
  it('排除非 AI 福利和中转站、号池推广', () => {
    for (const t of ['霸王茶姬后续，再赠送买一送一', '（已领完）美团单车7天66次卡，需要的速领吧', '20261015移动领1-9元话费', '[已蹬完]🪜订阅快到期了，留给有缘人',
      '【富可敌国｜NodeAI API 中转站】给佬友送 $10 体验额度｜GPT、Claude、国模，一把 Key 接入', '国模福利(kimi-k3 glm-5.3 glm-5.3-flashx)hub站免费调用，随时拉闸',
      '【富可敌国】海外企业团队支持｜GPT Plus 0.1x、Kiro 0.125x', '想转让一个gpt pro25x的号']) expect(isAiFreebieTopic(t), t).toBe(false);
  });
});

import { approvedTermsStillPresent } from '../pipeline/lib';
// 2026-10-15：已批准价格页每轮被免费模型改写措辞重新提交，生成人工身份任务。
describe('已批准条款原文仍在页面上', () => {
  const excerpts = { benefit: 'Free plan includes 10,000 credits per month.', eligibility: 'Available to all new accounts.' };
  it('全部摘录逐字仍在（忽略空白和大小写）时视为未变化', () => {
    expect(approvedTermsStillPresent(excerpts, 'Pricing\nFREE plan includes 10,000   credits per month.\nAvailable to all new accounts.\nFAQ')).toBe(true);
  });
  it('任一摘录消失、数值变化或只有过短摘录时照常提交', () => {
    expect(approvedTermsStillPresent(excerpts, 'Free plan includes 5,000 credits per month. Available to all new accounts.')).toBe(false);
    expect(approvedTermsStillPresent(excerpts, 'Free plan includes 10,000 credits per month.')).toBe(false);
    expect(approvedTermsStillPresent({ benefit: 'Free' }, 'Free')).toBe(false);
    expect(approvedTermsStillPresent(null, 'anything')).toBe(false);
  });
});

import { newRelevantLines } from '../pipeline/lib';
// 2026-10-15：已收录的官方页面每 6 小时因删句、换序或空白变化被判“有变化”，整页重新交给模型抽取。
describe('官方页面的新增句子', () => {
  it('只有删减、换序或空白变化时没有新增', () => {
    expect(newRelevantLines('免费 100 积分\n每日登录送 10 积分\n限时活动', '每日登录送  10 积分\n免费 100 积分')).toEqual([]);
  });
  it('出现新句子或数值变化时返回新增的句子', () => {
    expect(newRelevantLines('免费 100 积分', '免费 200 积分\n新用户送 5 美元')).toEqual(['免费 200 积分', '新用户送 5 美元']);
  });
});
