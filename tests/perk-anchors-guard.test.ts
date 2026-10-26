import { expect, it } from 'vitest';
import { introducesNothingNew } from '../src/shared/identity/perk-anchors';

// 2026-10-26: display rules and incidental durations/multipliers no longer count as "something new".
const listed = { texts: ['Tripo 免费版每月 200 积分', '免费版每月 200 积分，官方估计可生成约 13 个 3D 模型'], models: [], requirements: [] };
const view = (valueText: string, extra: Record<string, unknown> = {}) => ({ platformId: 'tripo', title: 'Tripo 免费版每月 200 积分', valueText, models: [], requirements: [], ...extra });
it('ignores the net display rule, durations and rate multipliers', () => {
  expect(introducesNothingNew(view('免费版每月 200 积分，约 13 个模型；7天模型编辑历史', { requirements: ['net'] }), listed)).toBe(true);
  expect(introducesNothingNew(view('每月 200 积分，费率从 0.1× 降至 0.0×，12 个月内有效'), listed)).toBe(true);
});
it('still catches a new amount, a new model and a new real requirement', () => {
  expect(introducesNothingNew(view('每月 200 积分，另送 120 次图像资源包'), listed)).toBe(false);
  expect(introducesNothingNew(view('每月 200 积分', { models: ['GLM-5.3'] }), listed)).toBe(false);
  expect(introducesNothingNew(view('每月 200 积分', { requirements: ['realname'] }), listed)).toBe(false);
});
