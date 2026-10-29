import { expect, it } from 'vitest';
import { isLead, isStrictLead } from '../pipeline/lib';

// 2026-10-29: general feeds no longer take a bare 免费 as a perk signal.
it('drops a bare 免费 in general feeds but keeps quota-bound 免费 and other perk patterns', () => {
  const noise = ['苹果 Apple 创作坊新增 AI 功能和更多创意工具，11 月免费更新上线', 'Meta 悄然上线 AI 宠物日记应用，该应用免费'];
  for (const t of noise) { expect(isLead(t)).toBe(true); expect(isStrictLead(t)).toBe(false); }
  const perks = ['讯飞星火新用户免费领 10 亿 tokens', 'OpenAI 推出 Rosalind：高校实验室可免费试用 12 个月', '模型 API 限时免费开放', 'Vendor 注册送 10 美元', 'Codex 全员重置已完成'];
  for (const t of perks) expect(isStrictLead(t)).toBe(true);
});
