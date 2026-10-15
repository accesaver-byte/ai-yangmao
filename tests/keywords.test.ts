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
  it('Windows 换行符不丢失平台规则', () => {
    const notes = parsePlatformNotes('## workbuddy\r\n- 第一条\r\n- 第二条\r\n');
    expect(notes.get('workbuddy')).toEqual(['第一条', '第二条']);
  });
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
