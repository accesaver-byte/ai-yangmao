import { expect, it } from 'vitest';
import { botConfig, chunks, sendViaBot } from '../scripts/telegram-send';

// 2026-11-26（管理员）：仓库通知改用独立机器人，与 Hermes 对话分开；台账语义不变。
const config = { token: '123:abc', chatId: '-1001' };
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

it('only configures the dedicated bot when both token and chat are set', () => {
  expect(botConfig({ YM_TELEGRAM_BOT_TOKEN: '123:abc', YM_TELEGRAM_CHAT_ID: '-1001' })).toEqual(config);
  expect(botConfig({ YM_TELEGRAM_BOT_TOKEN: '123:abc' })).toBeNull();
  expect(botConfig({ YM_TELEGRAM_CHAT_ID: ' ' })).toBeNull();
});

it('splits long messages on line boundaries under the Telegram limit', () => {
  const text = Array.from({ length: 300 }, (_, i) => `line ${i} ${'x'.repeat(30)}`).join('\n');
  const parts = chunks(text);
  expect(parts.length).toBeGreaterThan(1);
  expect(parts.every(p => p.length <= 4000)).toBe(true);
  expect(parts.join('\n')).toBe(text);
  expect(chunks('y'.repeat(9000)).map(p => p.length)).toEqual([4000, 4000, 1000]);
});

it('reports sent only when Telegram returns ok for every part', async () => {
  const calls: { url: string; body: any }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => { calls.push({ url, body: JSON.parse(String(init.body)) }); return reply({ ok: true }); }) as typeof fetch;
  expect(await sendViaBot(config, 'hello\nworld', fetchImpl)).toEqual({ status: 'sent', via: 'bot' });
  expect(calls).toEqual([{ url: 'https://api.telegram.org/bot123:abc/sendMessage', body: { chat_id: '-1001', text: 'hello\nworld', disable_web_page_preview: true } }]);
});

it('a rejected first part is a definite failure; anything after a delivered part or without a reply is unknown', async () => {
  const rejected = (async () => reply({ ok: false, description: 'Unauthorized' }, 401)) as typeof fetch;
  expect(await sendViaBot(config, 'x', rejected)).toMatchObject({ status: 'failed', error: expect.stringContaining('Unauthorized') });
  const offline = (async () => { throw new TypeError('fetch failed'); }) as typeof fetch;
  expect((await sendViaBot(config, 'x', offline)).status).toBe('unknown');
  let n = 0;
  const partial = (async () => (n++ === 0 ? reply({ ok: true }) : reply({ ok: false, description: 'Too Many Requests' }, 429))) as typeof fetch;
  expect((await sendViaBot(config, 'z'.repeat(5000), partial)).status).toBe('unknown');
});
