import { expect, it } from 'vitest';
import { offerRefFromInput } from '../src/shared/offer-ref';
// 2026-10-15：后台“关联已有活动”只认完整 ID，管理员粘贴的条目链接被拒。
it.each([
  ['https://ai-yangmao.com/#offer-identity-2ba4dde3-5114-4ec5-b6eb-dadb8aad2281', 'identity-2ba4dde3-5114-4ec5-b6eb-dadb8aad2281'],
  ['https://ai-yangmao.com/#admin-offer-vendor-free', 'vendor-free'],
  ['https://ai-yangmao.com/api/agent/offers/vendor-free', 'vendor-free'],
  ['  [2r48] ', '2r48'],
  ['2r48', '2r48'],
  ['identity-2ba4dde3-5114-4ec5-b6eb-dadb8aad2281', 'identity-2ba4dde3-5114-4ec5-b6eb-dadb8aad2281'],
  ['https://example.com/somewhere', 'https://example.com/somewhere'],
])('reads the offer reference from %s', (input, expected) => expect(offerRefFromInput(input)).toBe(expected));
