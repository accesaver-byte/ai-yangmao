// 仓库通知专用的 Telegram 机器人（2026-11-26 管理员要求与 Hermes 对话分开）。
// .prod.secrets 配了 YM_TELEGRAM_BOT_TOKEN 与 YM_TELEGRAM_CHAT_ID 时直接调用 Bot API；没配时沿用 `hermes send`（Hermes 的机器人）。
// 结果只分三种：sent（Telegram 返回 ok:true）、failed（确定没发出）、unknown（可能已送达），由调用方写通知台账，unknown 不自动重发。
import { spawnSync } from 'node:child_process';

export type SendResult = { status: 'sent' | 'failed' | 'unknown'; via: 'bot' | 'hermes'; error?: string };
export type BotConfig = { token: string; chatId: string };

const LIMIT = 4000; // Telegram 单条上限 4096 字符，留余量

/** 按行切分，单行过长时硬切。 */
export function chunks(text: string, limit = LIMIT): string[] {
  const out: string[] = [];
  let cur = '';
  for (const line of text.split('\n')) {
    for (let piece = line; ; ) {
      const room = limit - (cur ? cur.length + 1 : 0);
      if (piece.length <= room) { cur = cur ? `${cur}\n${piece}` : piece; break; }
      if (cur) { out.push(cur); cur = ''; continue; }
      out.push(piece.slice(0, limit)); piece = piece.slice(limit);
      if (!piece) break;
    }
  }
  if (cur) out.push(cur);
  return out;
}

export function botConfig(env: Record<string, string | undefined>): BotConfig | null {
  const token = env.YM_TELEGRAM_BOT_TOKEN?.trim(), chatId = env.YM_TELEGRAM_CHAT_ID?.trim();
  return token && chatId ? { token, chatId } : null;
}

export async function sendViaBot(config: BotConfig, text: string, fetchImpl: typeof fetch = fetch): Promise<SendResult> {
  const parts = chunks(text);
  for (const [i, part] of parts.entries()) {
    let res: Response;
    try {
      res = await fetchImpl(`https://api.telegram.org/bot${config.token}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: config.chatId, text: part, disable_web_page_preview: true }),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (error) {
      // 请求可能已到达 Telegram；第一段之后也可能部分送达。
      return { status: 'unknown', via: 'bot', error: `第 ${i + 1}/${parts.length} 段请求无回执：${String(error).slice(0, 200)}` };
    }
    const body = await res.json().catch(() => null) as { ok?: boolean; description?: string } | null;
    if (body?.ok === true) continue;
    // Telegram 明确拒绝（令牌、chat_id、格式）时这一段没发出；若前面已有段发出则整体不明。
    const error = `第 ${i + 1}/${parts.length} 段 Telegram ${res.status}：${body?.description ?? '无响应体'}`.slice(0, 300);
    return { status: i === 0 && body?.ok === false ? 'failed' : 'unknown', via: 'bot', error };
  }
  return { status: 'sent', via: 'bot' };
}

export function sendViaHermes(text: string): SendResult {
  const sent = spawnSync('hermes', ['send', '--to', 'telegram', '--quiet', '--file', '-'], { input: text, encoding: 'utf8', timeout: 30000 });
  if (sent.error || sent.status !== 0) return { status: 'unknown', via: 'hermes', error: String(sent.error?.message ?? sent.stderr ?? `Hermes exit ${sent.status}`).slice(0, 500) };
  return { status: 'sent', via: 'hermes' };
}

export async function sendTelegram(env: Record<string, string | undefined>, text: string): Promise<SendResult> {
  const config = botConfig(env);
  return config ? sendViaBot(config, text) : sendViaHermes(text);
}
