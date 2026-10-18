import { afterEach, describe, expect, it, vi } from 'vitest';
import { hn, type Source } from '../pipeline/collectors';

afterEach(() => vi.unstubAllGlobals());

describe('Hacker News backfill', () => {
  it('uses the previous successful run and reads every result page before advancing', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      urls.push(String(input));
      const page = Number(new URL(String(input)).searchParams.get('page'));
      return new Response(JSON.stringify({ nbPages: 2, hits: [{ objectID: `id-${urls.length}`, title: 'Free credits for new AI users', url: `https://vendor.example/offer-${urls.length}` }] }));
    }));
    const previous = new Date(Date.now() - 20 * 3600_000).toISOString();
    const source = { id: 'hn', kind: 'hn', url: 'https://hn.algolia.com/', tier: 'lead', platformId: null, lastHash: null, lastOkAt: previous, platform: null, autoPublish: false } as Source;
    const leads = await hn(source);
    expect(leads).toHaveLength(12); // 6 queries, 2 pages each
    expect(urls).toHaveLength(12);
    const first = new URL(urls[0]);
    const since = Number(first.searchParams.get('numericFilters')?.split('>')[1]);
    expect(Math.floor(Date.now() / 1000) - since).toBeGreaterThan(20 * 3600);
  });
});

import { aihot, parseFeed } from '../pipeline/collectors';
const aihotSource = (url: string) => ({ id: 'aihot', kind: 'aihot', url, tier: 'lead', platformId: null, lastHash: null, platform: null, autoPublish: false } as Source);

// 2026-10-15：AIHOT 重置事件按新到旧列帖，原先取第一条只拿到“2 小时内到账”的回复，没有日期，被并入旧轮次。
describe('AIHOT Codex 重置事件', () => {
  it('从同作者 reply context 找回 Day 13 主帖，并保留完整正文与到账回复', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ events: [{
      title: 'Tibo 确认重置', createdAt: new Date().toISOString(), posts: [{
        url: 'https://x.com/thsottiaux/status/2111492738025959922',
        originalText: 'Landing sometime today', fullOriginalText: 'Landing sometime today by EOD PST',
        context: [{ id: '2111492673890824348', author: 'thsottiaux', relation: 'reply',
          url: 'https://x.com/i/status/2111492673890824348', originalText: 'Day 13/ Le limit reset' }],
      }],
    }] })));
    const leads = await aihot(aihotSource('https://aihot.news/api/v1/codex-resets'));
    expect(leads).toHaveLength(1);
    expect(leads[0].url).toBe('https://x.com/thsottiaux/status/2111492673890824348');
    expect(leads[0].title).toContain('2026-10-17T16:20Z');
    expect(leads[0].raw).toMatch(/Day 13\/ Le limit reset[\s\S]*Landing sometime today by EOD PST/);
  });
  it('不把引用的旧重置、其他作者或 ID 不符的上下文当作本次主帖', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ events: [{
      createdAt: new Date().toISOString(), posts: [{
        url: 'https://x.com/thsottiaux/status/2111492738025959922', originalText: 'Landing sometime today by EOD PST',
        context: [
          { id: '2110595484180214059', author: 'thsottiaux', relation: 'quote', url: 'https://x.com/i/status/2110595484180214059', originalText: 'Day 10/ Reset' },
          { id: '2111492673890824348', author: 'someone_else', relation: 'reply', url: 'https://x.com/i/status/2111492673890824348', originalText: 'Day 13/ Le limit reset' },
          { id: '2111492673890824348', author: 'thsottiaux', relation: 'reply', url: 'https://x.com/i/status/2110595484180214059', originalText: 'Day 13/ Le limit reset' },
        ],
      }],
    }] })));
    const [lead] = await aihot(aihotSource('https://aihot.news/api/v1/codex-resets'));
    expect(lead.url).toBe('https://x.com/thsottiaux/status/2111492738025959922');
  });
  it('主帖同时出现在 posts 和 context 时只保留一次，优先完整原帖', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ events: [{
      createdAt: new Date().toISOString(), posts: [
        { url: 'https://x.com/thsottiaux/status/2111492738025959922', originalText: 'Landing sometime today by EOD PST',
          context: [{ id: '2111492673890824348', author: '@thsottiaux', relation: 'reply',
            url: 'https://x.com/i/status/2111492673890824348', originalText: 'Day 13/ Le limit reset' }] },
        { url: 'https://x.com/thsottiaux/status/2111492673890824348', originalText: 'Day 13/', fullOriginalText: 'Day 13/ Le limit reset. Main post full text.' },
      ],
    }] })));
    const [lead] = await aihot(aihotSource('https://aihot.news/api/v1/codex-resets'));
    expect(lead.url).toBe('https://x.com/thsottiaux/status/2111492673890824348');
    expect(lead.raw?.match(/Day 13/g)).toHaveLength(1);
    expect(lead.raw).toContain('Main post full text.');
  });
  it('每个事件一条线索：用最早的主公告，标题带事件时间，原文带全部帖子', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ events: [{
      title: 'Tibo 确认重置', displayLabel: '重置（形式未明确）', occurredOn: null, createdAt: new Date().toISOString(),
      posts: [
        { url: 'https://x.com/thsottiaux/status/2110618732666257557', text: '搞定收工', originalText: 'Done and dusted' },
        { url: 'https://x.com/thsottiaux/status/2110595554036400151', text: '将在接下来 2 小时内落地', originalText: 'Landing within the next 2 hours' },
        { url: 'https://x.com/thsottiaux/status/2110595484180214059', text: '第 10 天/ 重置', originalText: 'Day 10/ Reset' },
      ] }] })));
    const leads = await aihot(aihotSource('https://aihot.news/api/v1/codex-resets'));
    expect(leads).toHaveLength(1);
    expect(leads[0].url).toBe('https://x.com/thsottiaux/status/2110595484180214059');
    expect(leads[0].title).toContain('2026-10-15T04:55Z');
    expect(leads[0].raw).toMatch(/Day 10\/ Reset[\s\S]*Landing within the next 2 hours[\s\S]*Done and dusted/);
  });
  it('动态条目按标题和摘要一起判断，故障补偿不再被过滤', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ items: [
      { title: 'DeepSeek 就 10 月 15 日 API 故障致歉', summary: '将按账号 10.8-10.14 的消耗金额以赠金形式全额返还', links: { original: 'https://x.com/tianyi/status/2110663080246132855' } },
      { title: 'Apple 发布折叠屏 iPhone Duo', summary: '搭载 A20 Pro', links: { original: 'https://www.apple.com/newsroom/x' } },
    ] })));
    const leads = await aihot(aihotSource('https://aihot.news/api/v1/items?mode=all'));
    expect(leads.map(l => l.url)).toEqual(['https://x.com/tianyi/status/2110663080246132855']);
  });
});

describe('RSS 摘要', () => {
  it('还原被转义的 HTML 再去标签（IT之家 description）', () => {
    const body = '<rss><channel><item><title>DeepSeek 服务故障</title><link>https://www.ithome.com/1/013/533.htm</link><description>&lt;p data-vmark="6649"&gt;对此，DeepSeek 将补偿所有 API 用户 7 天内的消耗金额&amp;nbsp;&lt;/p&gt;</description></item></channel></rss>';
    expect(parseFeed(body)[0].summary).toBe('对此，DeepSeek 将补偿所有 API 用户 7 天内的消耗金额');
  });
});

import { linuxdoFirstPost } from '../pipeline/collectors';
describe('LINUX DO 首帖正文', () => {
  it('取出首帖文字、外链和图片说明，去掉站内头像与上传链接', () => {
    const json = JSON.stringify({ post_stream: { posts: [{ cooked: '<p>现在登录zcode，可领 3 亿额度&amp;今晚生效</p><p><a href="https://zcode.z.ai/cn">官网</a> <a href="https://linux.do/u/someone">@someone</a></p><p><img src="https://linux.do/uploads/x.png" alt="活动卡片截图"></p>' }, { cooked: '<p>回帖不要</p>' }] } });
    const text = linuxdoFirstPost(json);
    expect(text).toContain('现在登录zcode，可领 3 亿额度&今晚生效');
    expect(text).toContain('[图片：活动卡片截图]');
    expect(text).toContain('https://zcode.z.ai/cn');
    expect(text).not.toContain('linux.do/u/');
    expect(text).not.toContain('回帖不要');
  });
});
