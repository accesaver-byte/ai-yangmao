// 飞书群日报与加急提醒（Cloudflare Worker 定时任务发送，不依赖本地机器），以及每 6 小时触发一次 GitHub 采集。
// 发送沿用通知台账：先占位（claimNotice），飞书返回成功后才记为已发送（ackDelivery）。
import { eq, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { Hono, type Context, type Next } from 'hono';
import * as s from '../db/schema';
import { zonedTime } from '../shared/lifecycle';
import { valuationSummary } from '../shared/valuation';
import { ackDelivery, buildNotice, claimNotice, type ClaimedNotice } from './admin';
import type { Env } from './index';
import { generateDaily } from './daily';
import {z} from 'zod';

export const CRON = { digest: '0 0 * * *', urgent: '7 * * * *', collect: '17 */6 * * *', leads: '27 * * * *' } as const; // UTC；日报 = 东京 09:00
type Item = ClaimedNotice['items']['new'][number];
type Kind = 'digest' | 'urgent';
const db = (env: Env) => drizzle(env.DB, { schema: s });
const SITE = 'https://ai-yangmao.com';

/* ---------- 中文标签 ---------- */
const REQ: Record<string, string> = {
  none: '零门槛', unknown: '条件官方未写明', phone: '需海外手机号', card: '需海外信用卡 / PayPal', net: '需海外网络',
  realname: '需实名认证', biz: '需企业认证', student: '需学生认证', invite: '需邀请码', targeted: '定向发放（仅部分账号）',
};
const reqText = (r: string) => (r.startsWith('pay:') ? `需充值（${r.slice(4)}）` : r.startsWith('member:') ? `需会员（${r.slice(7)}）` : REQ[r] ?? r);
const AUD: Record<string, string> = { new: '新用户', old: '老用户', all: '所有用户', unclear: '官方未写明适用对象' };
const CLAIM: Record<string, string> = { auto: '自动到账，无需操作', signup: '注册即送', app: '下载应用并登录（App / 桌面端 / 命令行工具）', form: '邮件或表单申请', topup: '充值后赠送', member: '会员自动生效', code: '兑换码 / 邀请链接' };
const MODAL: Record<string, string> = { text: '文本·编程', code: '文本·编程', image: '图像', video: '视频', audio: '音乐·语音' };
const TIER: Record<string, string> = { site: '官网', docs: '官方文档', official: '官方账号', staff: '官方员工账号', media: '媒体 / 社区转述，请以官方为准', tested: '管理员亲测可领（官方未公开发布文字公告）' };
const TZ: Record<string, string> = { 'Asia/Shanghai': '北京时间', 'America/Los_Angeles': '美西时间', 'America/New_York': '美东时间', UTC: 'UTC', 'Asia/Tokyo': '东京时间' };

/* ---------- 翻译：英文 → 中文，结果缓存在 D1 ---------- */
const CJK = /[㐀-鿿]/;
export const needsZh = (t?: string | null): t is string => !!t && /[a-zA-Z]{3,}/.test(t) && !CJK.test(t);
async function sha256hex(t: string) {
  const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t));
  return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, '0')).join('');
}
export async function translateAll(env: Env, texts: (string | null | undefined)[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const todo = [...new Set(texts.filter(needsZh).map(t => t.trim()))];
  if (!todo.length) return out;
  const hashes = await Promise.all(todo.map(sha256hex));
  for (let i = 0; i < hashes.length; i += 80) { // D1 单条语句最多 100 个参数
    const rows = await db(env).select().from(s.translations).where(inArray(s.translations.hash, hashes.slice(i, i + 80)));
    for (const r of rows) out.set(r.source, r.zh);
  }
  const misses = todo.filter(t => !out.has(t));
  if (!misses.length || !env.GEMINI_API_KEY) return out;
  try {
    const prompt = `把下面 JSON 数组里的每一项翻译成简体中文，用于中文用户阅读 AI 免费额度信息。要求：
- 数组长度和顺序保持不变，每项只输出译文
- 只有产品名、模型名、数字和金额保持原样（例如 Kiro、Gemini 2.5 Flash、$20、100 万）
- 其余英文都要翻成中文，包括时间单位（month → 个月、day → 天）和整句短语（例如 credited toward your subscription → 抵扣订阅费用）；tokens / credits / requests 可以写成"tokens / 积分 / 次请求"
- 意思准确，不增不减；已经是中文的原样返回
只输出 JSON 数组。

${JSON.stringify(misses)}`;
    const model = env.GEMINI_MODEL || 'gemini-flash-lite-latest';
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { responseMimeType: 'application/json', temperature: 0.1 } }),
    });
    if (!r.ok) throw new Error(`Gemini ${r.status}`);
    const j = await r.json() as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
    const arr = JSON.parse((j.candidates?.[0]?.content?.parts?.map(p => p.text ?? '').join('') ?? '[]').replace(/^```(json)?|```$/g, '').trim()) as unknown[];
    if (!Array.isArray(arr) || arr.length !== misses.length) throw new Error('译文数量不一致');
    const rows = await Promise.all(misses.map(async (src, i) => ({ hash: await sha256hex(src), source: src, zh: String(arr[i] ?? '').trim() || src })));
    for (const row of rows) out.set(row.source, row.zh);
    for (let i = 0; i < rows.length; i += 30) await db(env).insert(s.translations).values(rows.slice(i, i + 30)).onConflictDoNothing();
  } catch (e) {
    console.warn('翻译失败，飞书日报先用原文：', (e as Error).message); // 翻译失败不阻塞发送
  }
  return out;
}

/* ---------- 时间 ---------- */
const fmt = (d: Date, tz: string) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d).map(x => [x.type, x.value]));
  return `${p.month}月${p.day}日 ${p.hour}:${p.minute}`;
};
function deadline(it: Item): string {
  if (it.endKind === 'standing') return '长期可领';
  if (it.endKind !== 'date' || !it.claimEnd) return '官方未注明截止日期';
  const end = zonedTime(it.claimEnd, '23:59:59', it.sourceTz);
  const official = `${Number(it.claimEnd.slice(5, 7))}月${Number(it.claimEnd.slice(8, 10))}日 23:59（${TZ[it.sourceTz] ?? it.sourceTz}）`;
  return it.sourceTz === 'Asia/Shanghai' ? official : `${official}，即北京时间 ${fmt(end, 'Asia/Shanghai')}`;
}
function startText(it: Item): string {
  if (!it.claimStart) return '';
  const start = zonedTime(it.claimStart, '00:00:00', it.sourceTz);
  return start.getTime() > Date.now() ? `${Number(it.claimStart.slice(5, 7))}月${Number(it.claimStart.slice(8, 10))}日开始；` : '';
}

/* ---------- 卡片 ---------- */
const md = (content: string) => ({ tag: 'div', text: { tag: 'lark_md', content } });
const safe = (t: string) => t.replace(/[[\]]/g, m => (m === '[' ? '【' : '】')).replace(/\*/g, '＊');
const zh = (tr: Map<string, string>, t?: string | null) => (t ? (tr.get(t.trim()) ?? t).replace(/\s*\n+\s*/g, ' ').replace(/\s{2,}/g, ' ').trim() : ''); // 原文里的表格换行合并成一行

function itemBlock(it: Item, n: number, tr: Map<string, string>, section: string, compact = false) {
  const lines: string[] = [];
  lines.push(`**${n}. ${safe(zh(tr, it.title))}**`);
  if (!compact) lines.push(`<font color='grey'>${it.score != null ? `薅度分 ${it.score} · ` : ''}${safe(it.platform)} · ${it.type}${it.modalities?.length ? ` · ${it.modalities.map(m => MODAL[m] ?? m).join(' / ')}` : ''}</font>`);
  if (section === 'changed') lines.push(`🔄 **有变化**：${safe(zh(tr, it.value))}`);
  else {
    const valuation = valuationSummary(it);
    lines.push(`🎁 **福利**：${safe(zh(tr, it.value))}${valuation ? `（${safe(valuation)}）` : ''}`);
  }
  const benefit = it.excerpts?.benefit;
  // 管理员实测、媒体转述的摘录不是官方原话，不能标成“官方原文”
  const official = !['media', 'tested'].includes(it.evidenceTier);
  if (!compact && benefit && section !== 'changed') {
    lines.push(`📄 **${official ? '官方原文' : '原文（媒体 / 社区转述）'}**：“${safe(benefit)}”`);
    if (tr.has(benefit.trim())) lines.push(`　译文：“${safe(zh(tr, benefit))}”`);
  }
  if (!compact && it.adminNote) lines.push(`💬 **牧场心得**：${safe(it.adminNote.replace(/\s*\n+\s*/g, ' '))}`);
  if (!compact) {
    lines.push(`📥 **怎么领**：${CLAIM[it.claimMethod] ?? it.claimMethod}`);
    (it.steps ?? []).filter(x => !/^官方出处：/.test(x)).slice(0, 8).forEach((st, i) => lines.push(`　${i + 1}. ${safe(zh(tr, st))}`));
  }
  const eligibility = it.excerpts?.eligibility;
  lines.push(`✅ **条件**：${it.requirements.map(reqText).join('、')}；适用：${AUD[it.audience] ?? it.audience}`);
  if (!compact && eligibility) {
    lines.push(`　${official ? '官方说明' : '转述说明'}：“${safe(eligibility)}”`);
    if (tr.has(eligibility.trim())) lines.push(`　译文：“${safe(zh(tr, eligibility))}”`);
  }
  lines.push(`⏰ **截止**：${startText(it)}${deadline(it)}`);
  lines.push(`⌛ **额度有效期**：${it.creditValidity ? safe(zh(tr, it.creditValidity)) : '官方未写明'}`);
  lines.push(`🔎 **信源**：${TIER[it.evidenceTier] ?? it.evidenceTier}`);
  if (!compact) lines.push(`🕒 **核验时间**：${it.lastVerifiedAt??'原通知未保存核验时间，请查当前详情'}`);
  return [
    md(lines.join('\n')),
    { tag: 'action', actions: [
      { tag: 'button', text: { tag: 'plain_text', content: '打开官方页面' }, type: 'primary', url: it.evidenceUrl },
      { tag: 'button', text: { tag: 'plain_text', content: '在牧场看详情' }, type: 'default', url: it.link },
    ] },
    { tag: 'hr' },
  ];
}

const SECTIONS: [keyof ClaimedNotice['items'], string][] = [['urgent', '⚡ 48 小时内截止'], ['new', '🆕 新上架'], ['ending', '⏰ 3 天内结束'], ['changed', '🔄 条款变化'], ['ended', '❌ 已结束']];

const PER_CARD = 6; // 每张卡片最多几条，避免超过飞书卡片大小上限

/** 把一次通知排成若干张飞书卡片（每张最多 PER_CARD 条羊毛）。 */
export async function buildCards(env: Env, notice: Pick<ClaimedNotice, 'kind' | 'items'>, now = new Date()) {
  // 飞书日报：常驻榜、新星榜、末班车榜（admin.ts buildNotice 已按薅度分挑好）
  const theme = (notice as { theme?: { title: string; short: string } | null }).theme ?? { title: '🏆 常驻榜 · 一直能薅的', short: '常驻榜' };
  const BOARDS: [string, string][] = [['standing', theme.title], ['rising', '🌟 新星榜 · 新上架'], ['lastcall', '🚌 末班车榜 · 3 天内结束']];
  const ranked = notice.kind === 'digest' && BOARDS.some(([k]) => (notice.items[k as keyof typeof notice.items] ?? []).length);
  const all = ranked
    ? BOARDS.flatMap(([k, label]) => (notice.items[k as keyof typeof notice.items] ?? []).map(it => ({ it, k, label })))
    : SECTIONS.flatMap(([k, label]) => (notice.items[k] ?? []).map(it => ({ it, k, label })));
  if (!all.length) return [];
  const compact = notice.kind === 'digest';
  const texts = all.flatMap(({ it }) => [it.title, it.value, it.creditValidity, ...(!compact ? [it.excerpts?.benefit, it.excerpts?.eligibility, ...(it.steps ?? [])] : [])]);
  const tr = await translateAll(env, texts);
  const day = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Tokyo', month: 'long', day: 'numeric', weekday: 'short' }).format(now);
  const pages = Math.ceil(all.length / PER_CARD);
  const cards = [];
  for (let p = 0; p < pages; p++) {
    const slice = all.slice(p * PER_CARD, (p + 1) * PER_CARD);
    const elements: unknown[] = [];
    if (p === 0) {
      const counts = SECTIONS.map(([k, label]) => [label, (notice.items[k] ?? []).length] as const).filter(([, c]) => c).map(([l, c]) => `${l} ${c} 条`).join('　');
      const more = (notice as { moreCount?: number }).moreCount ?? 0;
      elements.push(md(`${ranked ? `今日专题「${theme.short}」${notice.items.standing?.length ?? 0} 条 · 新星榜 ${notice.items.rising?.length ?? 0} 条 · 末班车榜 ${notice.items.lastcall?.length ?? 0} 条${more ? `\n另有 ${more} 条新上架没进榜，在网站上看` : ''}` : counts}\n<font color='grey'>${compact ? '完整条款与领取步骤请点击每条的详情链接。' : '英文内容已翻译成中文，以官方页面为准。'}</font>`), { tag: 'hr' });
    }
    let current = '';
    slice.forEach(({ it, k, label }, i) => {
      if (label !== current) { elements.push(md(`**${label}**`)); current = label; }
      elements.push(...itemBlock(it, p * PER_CARD + i + 1, tr, k, compact));
    });
    if (p === pages - 1) elements.push({ tag: 'action', actions: [{ tag: 'button', text: { tag: 'plain_text', content: '打开 AI 羊毛牧场，看全部可领羊毛' }, type: 'primary', url: SITE }] });
    const title = notice.kind === 'urgent' ? '⚡ 羊毛加急：48 小时内截止' : `🐑 AI 羊毛牧场日报 · ${day}`;
    cards.push({
      config: { wide_screen_mode: true },
      header: { template: notice.kind === 'urgent' ? 'orange' : 'green', title: { tag: 'plain_text', content: pages > 1 ? `${title}（${p + 1}/${pages}）` : title } },
      elements,
    });
  }
  return cards;
}

/* ---------- 发送 ---------- */
async function sign(secret: string, ts: number) {
  // 飞书自定义机器人签名：以 "时间戳\n密钥" 为 key，对空字符串做 HmacSHA256，再 Base64
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(`${ts}\n${secret}`), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new Uint8Array());
  return btoa(String.fromCharCode(...new Uint8Array(mac)));
}
export async function postCard(env: Env, card: unknown): Promise<{ ok: boolean; definitelyNotSent: boolean; error?: string }> {
  if (!env.FEISHU_WEBHOOK) return { ok: false, definitelyNotSent: true, error: '未配置 FEISHU_WEBHOOK' };
  const ts = Math.floor(Date.now() / 1000);
  const body: Record<string, unknown> = { msg_type: 'interactive', card };
  if (env.FEISHU_SECRET) Object.assign(body, { timestamp: String(ts), sign: await sign(env.FEISHU_SECRET, ts) });
  let res: Response;
  try { res = await fetch(env.FEISHU_WEBHOOK, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); }
  catch (e) { return { ok: false, definitelyNotSent: false, error: `网络错误：${(e as Error).message}` }; }
  const j = await res.json().catch(() => ({})) as { code?: number; StatusCode?: number; msg?: string };
  if (res.ok && (j.code === 0 || j.StatusCode === 0)) return { ok: true, definitelyNotSent: false };
  // 飞书明确返回错误码（签名错、格式错、频率限制等）时消息没有发出去
  return { ok: false, definitelyNotSent: res.status < 500 && j.code != null, error: `飞书返回 ${res.status} ${j.code ?? ''} ${j.msg ?? ''}`.trim() };
}

/** 占位 → 排卡片 → 逐张发送 → 回报结果。飞书明确拒收时释放占位，下次重试；结果不明时留待人工核对。 */
export async function sendFeishu(env: Env, kind: Kind, editionRetries=1, now=new Date()): Promise<{ sent: number; cards: number; skipped?: string; error?: string }> {
  const daily = kind === 'digest' ? await generateDaily(env, now) : null;
  if (!env.FEISHU_WEBHOOK) return { sent: 0, cards: 0, skipped: '未配置 FEISHU_WEBHOOK' };
  if(daily?.sourceDeliveryId)return {sent:0,cards:0,skipped:'没有新内容'};
  if (daily && await env.DB.prepare("SELECT id FROM deliveries WHERE channel='feishu' AND kind='digest' AND status='sent' AND json_extract(payload,'$.digestDay')=? LIMIT 1").bind(daily.public.day).first()) return {sent:0,cards:0,skipped:'没有新内容'};
  const notice = await claimNotice(env, kind, 'feishu', daily?.notice);
  if(notice.editionChanged)return editionRetries>0?sendFeishu(env,kind,editionRetries-1,now):{sent:0,cards:0,error:'日报版本正在更新，请稍后重试'};
  if(notice.staleContent)return {sent:0,cards:0,error:'日报条目版本已变化；管理员可重新准备尚未发送的日报，查询不会自动改写。'};
  if (notice.empty || !notice.deliveryId) return { sent: 0, cards: 0, skipped: notice.alreadyClaimed ? '已有同样内容在发送或待核对' : '没有新内容' };
  const cards = daily?.cards ?? await buildCards(env, notice, now);
  let sent = 0;
  for (const card of cards) {
    const r = await postCard(env, card);
    if (r.ok) { sent++; continue; }
    if (sent === 0 && r.definitelyNotSent) {
      await db(env).update(s.deliveries).set({ status: 'released', fingerprint: `released:${notice.deliveryId}`, error: r.error ?? '飞书拒收', updatedAt: new Date().toISOString() }).where(eq(s.deliveries.id, notice.deliveryId));
      return { sent, cards: cards.length, error: r.error };
    }
    await ackDelivery(env, notice.deliveryId, 'unknown', `第 ${sent + 1}/${cards.length} 张卡片失败：${r.error ?? ''}`.slice(0, 500));
    return { sent, cards: cards.length, error: r.error };
  }
  await ackDelivery(env, notice.deliveryId, 'sent');
  return { sent, cards: cards.length };
}

/* ---------- 定时采集：由 Worker 准点触发 GitHub Actions ---------- */
export async function dispatchCollect(env: Env, fast = false): Promise<{ ok: boolean; error?: string }> {
  if (!env.GH_DISPATCH_TOKEN) return { ok: false, error: '未配置 GH_DISPATCH_TOKEN' };
  const r = await fetch(`https://api.github.com/repos/${env.GH_REPO || 'accesaver-byte/ai-yangmao'}/actions/workflows/collect.yml/dispatches`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.GH_DISPATCH_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'ai-yangmao-worker', 'Content-Type': 'application/json' },
    body: JSON.stringify({ ref: 'main', inputs: { fast_leads: String(fast), lead_limit: '50' } }),
  });
  return r.status === 204 ? { ok: true } : { ok: false, error: `GitHub 返回 ${r.status}：${(await r.text()).slice(0, 200)}` };
}

/**
 * 定时触发采集：失败隔 20 秒重试一次，仍失败就写一条失败的采集记录，后台“采集健康”能看到原因。
 * （2026-09-30 12:17 UTC 那次触发失败只写了日志，没有任何人察觉。）
 */
export async function scheduledCollect(env: Env, wait = (ms: number) => new Promise(r => setTimeout(r, ms)), fast = false) {
  const once = () => dispatchCollect(env, fast).catch(e => ({ ok: false, error: `请求 GitHub 出错：${String(e).slice(0, 200)}` }));
  let r = await once();
  if (!r.ok) { await wait(20_000); r = await once(); }
  if (!r.ok) {
    const at = new Date().toISOString();
    await env.DB.prepare("INSERT INTO runs (kind, started_at, finished_at, ok, stats) VALUES (?1, ?2, ?2, 0, ?3)")
      .bind(fast ? 'sweep' : 'collect', at, JSON.stringify({ stage: 'dispatch', error: r.error })).run();
  }
  return r;
}

export async function runScheduled(cron: string, env: Env, now = new Date()) {
  if (cron === CRON.digest) console.log('飞书日报', JSON.stringify(await sendFeishu(env, 'digest', 1, now)));
  if (cron === CRON.urgent) {
    console.log('飞书加急', JSON.stringify(await sendFeishu(env, 'urgent', 1, now)));
    // 日报可能被只读保护窗口或临时故障跳过；恢复后补跑，沿用送达台账防重。
    // 东京日期在 UTC 15:00 切换，必须等到 09:00，不能提前生成次日日报。
    const hour = Number(new Intl.DateTimeFormat('en-US', {timeZone:'Asia/Tokyo',hour:'2-digit',hourCycle:'h23'}).format(now));
    if (hour >= 9) {
      try {
        const daily = await generateDaily(env, now);
        // 冻结日报拒收后，活动可能已由加急送达；只重建确定未发送的版本。
        // 常驻榜是每日栏目，不因以前的加急或新上架通知而移除。
        const ids = [...daily.notice.items.rising, ...daily.notice.items.lastcall].map(it => it.id);
        if (ids.length && await env.DB.prepare("SELECT offer_id FROM notifications WHERE channel='feishu' AND stage='urgent' AND offer_id IN (SELECT value FROM json_each(?)) LIMIT 1").bind(JSON.stringify(ids)).first()) {
          await generateDaily(env, now, true);
        }
        console.log('飞书日报补跑检查', JSON.stringify(await sendFeishu(env, 'digest', 1, now)));
      }
      catch (error) { console.warn('飞书日报补跑失败', String(error)); }
    }
  }
  if (cron === CRON.leads) console.log('触发快速线索研判', JSON.stringify(await scheduledCollect(env, undefined, true)));
  if (cron === CRON.collect) console.log('触发采集', JSON.stringify(await scheduledCollect(env)));
}

/* ---------- 管理接口：预览 / 手动发送 / 手动触发采集（ADMIN_TOKEN） ---------- */
export const feishuAdmin = new Hono<{ Bindings: Env }>();
// 只管自己的路径；其余 /api/admin/* 交给 admin.ts（那里区分管理员和审核员）
const adminOnly = async (c: Context<{ Bindings: Env }>, next: Next) => {
  const token = c.req.header('Authorization')?.replace(/^Bearer\s+/i, '');
  if (!c.env.ADMIN_TOKEN || c.env.ADMIN_TOKEN.length < 16 || token !== c.env.ADMIN_TOKEN) return c.json({ error: '管理员密钥不正确' }, 401);
  c.header('Cache-Control', 'no-store');
  await next();
};
feishuAdmin.use('/feishu/*', adminOnly);
feishuAdmin.use('/collect/*', adminOnly);
/** 预览：只读，不占位、不发送。all=1 时把所有已上架羊毛当作新上架来排版，方便看效果。 */
feishuAdmin.get('/feishu/preview', async c => {
  const kind = c.req.query('kind') === 'urgent' ? 'urgent' : 'digest';
  const notice = await buildNotice(c.env, kind, c.req.query('all') === '1' ? 'feishu-preview' as 'feishu' : 'feishu');
  return c.json({ empty: notice.empty, cards: await buildCards(c.env, notice) });
});
feishuAdmin.post('/feishu/send', async c => c.json(await sendFeishu(c.env, c.req.query('kind') === 'urgent' ? 'urgent' : 'digest')));
/** Prepare/adopt the public edition without sending. Repair is restricted to definitely-unsent editions. */
feishuAdmin.post('/feishu/digest/prepare',async c=>{
  const parsed=z.object({refreshUnsent:z.boolean().default(false)}).strict().safeParse(await c.req.json().catch(()=>null));
  if(!parsed.success)return c.json({error:'请求体须为 {"refreshUnsent":false} 或 true'},400);
  try{const daily=await generateDaily(c.env,new Date(),parsed.data.refreshUnsent);return c.json({report:daily.public,sent:0,adoptedDelivery:!!daily.sourceDeliveryId});}
  catch{return c.json({error:'日报准备未完成或本期已有发送/待核对记录；请检查状态后重试'},409);}
});
feishuAdmin.post('/collect/dispatch', async c => c.json(await dispatchCollect(c.env)));
