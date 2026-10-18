// 采集管线的公共工具：网站写入接口、抓取（含 Jina Reader 兜底）、正文精简、关键词、哈希。
import { createHash } from 'node:crypto';
import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import { assertSafeUrl, fetchPublic, UnsafeTargetError } from './safe-fetch';
import { officialStatusKey, normUrl } from '../src/shared/dedupe';
import {officialTier,type OfficialPlatform,type OfficialSource} from '../src/shared/official-review';
import {platformMentioned} from '../src/shared/lead-scope';

export const UA = 'Mozilla/5.0 (compatible; ai-yangmao-bot/0.1; +https://ai-yangmao.com)';
/**
 * Leads per POST /leads request. The Worker spends ~3 D1 queries per request plus 3 per new lead (6 when a screening
 * rule matches) against a fixed 50-query request budget; larger batches fail whole (linux.do, 2026-10-13).
 * 5 keeps the worst case at ~33 queries.
 */
export const LEAD_POST_CHUNK = 5;

export async function api<T = unknown>(path: string, body?: unknown): Promise<T> {
  // 每次调用时再读环境变量：中继脚本会在启动后才加载密钥
  const base = (process.env.API_BASE ?? 'https://ai-yangmao.com').replace(/\/$/, '');
  const res = await fetch(`${base}/api/ingest${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${process.env.INGEST_TOKEN ?? ''}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`写入接口 ${path} 返回 ${res.status}：${text.slice(0, 300)}`);
  return JSON.parse(text) as T;
}

/** 网络层出错（不是 HTTP 错误码）时隔几秒重试，最多 2 次。 */
export async function fetchRetry(url: string, init: RequestInit, tries = 3): Promise<Response> {
  for (let i = 1; ; i++) {
    try { return await fetchPublic(url, init); }
    catch (e) {
      if (e instanceof UnsafeTargetError) throw e;
      if (i >= tries) throw new Error(`网络错误（已重试 ${tries - 1} 次）：${(e as Error & { cause?: { code?: string } }).cause?.code ?? (e as Error).message}`);
      await new Promise(r => setTimeout(r, 3000 * i));
    }
  }
}

export async function fetchText(url: string, opts: { accept?: string; timeoutMs?: number } = {}): Promise<string> {
  return (await fetchTextWithUrl(url, opts)).text;
}

// 本地中继用 curl 抓社区站时使用的浏览器 UA（见 collectors.ts curlText）
export const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';
async function fetchTextWithUrl(url: string, opts: { accept?: string; timeoutMs?: number; tries?: number } = {}): Promise<{ text: string; finalUrl: string }> {
  const res = await fetchRetry(url, { headers: { 'User-Agent': UA, Accept: opts.accept ?? '*/*', 'Accept-Language': 'en-US,en;q=0.9,zh-CN;q=0.8' }, signal: AbortSignal.timeout(opts.timeoutMs ?? 30000) }, opts.tries ?? 3);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return { text: await res.text(), finalUrl: res.url || url };
}

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg|nav|footer)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article|br)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t\r\f\v]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

/** 用 Readability（Firefox 阅读模式同款）抽正文，参考 AIHOT 的做法。 */
export function readableText(html: string, url: string): string {
  try {
    const { document } = parseHTML(html);
    const article = new Readability(document as unknown as Document, { charThreshold: 200, keepClasses: false }).parse();
    return article?.content ? htmlToText(article.content) : '';
  } catch { return ''; }
}

/** Read a first-party embed only after binding its post ID and author to the requested status. */
export function syndicatedPostText(url:string,payload:unknown):string|null {
  const key=officialStatusKey(url);if(!key||!payload||typeof payload!=='object')return null;
  const [handle,id]=key.slice('x.com/'.length).split('/status/');
  const post=payload as {id_str?:unknown;user?:{screen_name?:unknown};text?:unknown;created_at?:unknown;truncated?:unknown};
  if(post.id_str!==id||typeof post.user?.screen_name!=='string'||post.user.screen_name.toLowerCase()!==handle||typeof post.text!=='string'||!post.text.trim()||post.truncated===true)return null;
  return `@${post.user.screen_name}\n${typeof post.created_at==='string'?post.created_at+'\n':''}${post.text}`;
}

/** Embed previews are navigation metadata, never appended to the quoted post body. */
export interface OutboundLink {url:string;title?:string}
export function syndicatedPostLinks(url:string,payload:unknown):OutboundLink[] {
  if(!syndicatedPostText(url,payload))return [];
  const post=payload as {entities?:{urls?:{expanded_url?:unknown}[]};card?:{binding_values?:Record<string,{string_value?:unknown}>}};
  const values=post.card?.binding_values;
  const title=typeof values?.title?.string_value==='string'?values.title.string_value:undefined;
  const links=[...(Array.isArray(post.entities?.urls)?post.entities.urls:[]).map(link=>link?.expanded_url),values?.card_url?.string_value];
  const result:OutboundLink[]=[];
  for(const value of links){
    if(typeof value!=='string')continue;
    try{const target=assertSafeUrl(value).href;if(!result.some(link=>link.url===target))result.push({url:target});}catch{/* Unsafe preview links are not navigation targets. */}
  }
  if(title&&result.length===1)result[0].title=title;
  return result;
}

/** Only admitted URLs belonging to the originating/identified issuer may be followed. */
export function officialLinkedUrls(originUrl:string,raw:string,page:FetchedPage|undefined,platforms:OfficialPlatform[],sources:OfficialSource[]=[]):string[] {
  const originOwners=platforms.filter(p=>officialTier(originUrl,p,sources.filter(s=>s.platformId===p.id)));
  const owners=originOwners.length?originOwners:platforms.filter(p=>platformMentioned(raw,p));
  const links=[...(page?.outboundLinks??[]).map(link=>link.url),...(raw.match(/https?:\/\/[^\s<>"）)]+/g)??[])];
  const found=new Map<string,string>();
  for(const value of links){
    try{
      const url=assertSafeUrl(value.replace(/[.,;，。；\]]+$/,'')).href,key=normUrl(url);
      if(key===normUrl(originUrl)||!owners.some(p=>officialTier(url,p,sources.filter(s=>s.platformId===p.id))))continue;
      found.set(key,url);
    }catch{/* Invalid/private links cannot inherit the issuer's authority. */}
  }
  return [...found.values()].slice(0,3);
}

/**
 * 抓官方页面正文，三层兜底：
 * 1. 直接抓取，Readability 正文和整页纯文本里，取羊毛相关内容更多的那个（Readability 有时会丢掉定价说明）；
 * 2. 字数仍然太少（多半是脚本渲染的页面），改用 Jina Reader，要 Markdown 格式以保留表格结构。
 */
/** via 表示读取方式类别：jina 指第三方阅读器（含 Exa），一律按间接来源处理；fetchMethod 记录实际读取方。 */
export interface FetchedPage {outboundLinks?:OutboundLink[];sourceVerified?:boolean;text:string;via:'readability'|'direct'|'jina';originalUrl?:string;finalUrl:string;fetchedUrl?:string;fetchMethod?:'direct'|'readability'|'jina'|'exa'|'first_party_embed';truncated?:boolean}
// 微信对自动访问返回的拦截页有多种：“环境异常 / 去验证”验证页，以及只有页面框架的“微信扫一扫可打开此内容，使用完整服务”（2026-10-16 CodeBuddy 公告）。
const WECHAT_BLOCKED = /环境异常|完成验证后即可继续访问|去验证|微信扫一扫可打开此内容|使用完整服务/;
/** 公众号页面是拦截页而不是正文。不按字数判断：补偿公告这类真文章可能只有三百来字。 */
export const wechatBlocked = (text: string) => WECHAT_BLOCKED.test(text);
const isWechat = (url: string) => { try { return new URL(url).hostname === 'mp.weixin.qq.com'; } catch { return false; } };
/** Exa /contents（build-with-exa：contents 端点的 text 是顶层字段）。返回第三方阅读器结果，按间接来源处理；读不到或仍是验证页时返回 null。 */
export async function exaContents(url: string, timeoutMs = 30000): Promise<FetchedPage | null> {
  const key = process.env.EXA_API_KEY;
  if (!key) return null;
  try {
    const r = await fetch('https://api.exa.ai/contents', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': key }, body: JSON.stringify({ urls: [url], text: true }), signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return null;
    const j = await r.json() as { results?: { url?: string; title?: string; author?: string; text?: string }[] };
    const hit = j.results?.[0];
    const body = hit?.text?.trim() ?? '';
    if (!hit || wechatBlocked(body)) return null;
    const text = [hit.title, hit.author ? `公众号：${hit.author}` : '', body].filter(Boolean).join('\n');
    return { text, via: 'jina', originalUrl: url, finalUrl: url, fetchedUrl: 'https://api.exa.ai/contents', fetchMethod: 'exa', truncated: false, sourceVerified: hit.url === url };
  } catch { return null; }
}

export async function fetchPage(url: string, opts: { timeoutMs?: number; tries?: number; minimumTextLength?: number } = {}): Promise<FetchedPage> {
  assertSafeUrl(url);
  const status=officialStatusKey(url);
  if(status){
    const id=status.split('/status/')[1];
    const fetchedUrl=`https://cdn.syndication.twimg.com/tweet-result?id=${id}&lang=en&token=0`;
    try{
      const response=await fetchTextWithUrl(fetchedUrl,{...opts,tries:1,accept:'application/json'});
      if(new URL(response.finalUrl).origin!=='https://cdn.syndication.twimg.com')throw new Error('Unexpected embed host');
      const payload:unknown=JSON.parse(response.text);
      const text=syndicatedPostText(url,payload);
      // finalUrl is the verified canonical post; fetchedUrl records the physical first-party reader.
      if(text)return {text,via:'direct',originalUrl:url,finalUrl:url,fetchedUrl:response.finalUrl,fetchMethod:'first_party_embed',truncated:false,sourceVerified:true,outboundLinks:syndicatedPostLinks(url,payload)};
    }catch{/* Failed/mismatched embed is not evidence; continue through the normal readers. */}
  }
  let text = '', via: 'readability' | 'direct' = 'direct', finalUrl = url;
  try {
    const page = await fetchTextWithUrl(url, { accept: 'text/html', ...opts });
    const html = page.text; finalUrl = page.finalUrl;
    const full = htmlToText(html), read = readableText(html, url);
    // 哪个版本保留的羊毛相关内容多就用哪个；一样多时用更干净的 Readability
    if (read.length >= 800 && relevantText(read).length >= relevantText(full).length) { text = read; via = 'readability'; } else text = full;
  } catch(e) { if(e instanceof UnsafeTargetError)throw e; /* 直接抓失败就走 Jina */ }
  if (text.length >= (opts.minimumTextLength ?? 800) && !(isWechat(url) && wechatBlocked(text))) return { text, via, originalUrl:url,finalUrl,fetchedUrl:finalUrl,fetchMethod:via,truncated:false,sourceVerified:true };
  // 微信公众号文章：云端直读与 Jina 都会遇到验证页（“环境异常”），改用 Exa 从其服务器读取正文（2026-10-16）。
  if (isWechat(url)) { const exa = await exaContents(url, opts.timeoutMs ?? 30000); if (exa) return exa; }
  const headers: Record<string, string> = { 'User-Agent': UA, 'X-Return-Format': 'markdown', Accept: 'text/plain', 'X-Locale': 'en-US' };
  if (process.env.JINA_API_KEY) headers.Authorization = `Bearer ${process.env.JINA_API_KEY}`;
  const res = await fetch(`https://r.jina.ai/${url}`, { headers, signal: AbortSignal.timeout(opts.timeoutMs ?? 60000) });
  if (!res.ok) throw new Error(`直接抓取只有 ${text.length} 字，Jina Reader 返回 ${res.status}`);
  const raw = await res.text();
  const declared = raw.match(/^URL Source:\s*(https?:\/\/\S+)/m)?.[1];
  const sourceVerified = declared === url && !/^Warning:.*(?:error|failed|403|404|captcha)/im.test(raw) && finalUrl === url;
  const body = raw.replace(/^[\s\S]*?Markdown Content:\n/, '');
  return { text: body.replace(/\n\s*\n+/g, '\n').trim(), via:'jina',originalUrl:url,finalUrl,fetchedUrl:res.url||`https://r.jina.ai/${url}`,fetchMethod:'jina',truncated:false,sourceVerified };
}

// 羊毛关键词两档：
// FREEBIE 用于官方页面里挑相关句子，宽一点，单独的 free 也算；
// LEAD 用于第三方线索（AIHOT / HN / Reddit）的标题，要求明确的搭配，避免 credit agreement 这类误判。
// 多模态平台的福利大多用积分、灵感值、点数表述，还有每日登录送、邀请奖励、实名认证礼、首月折扣（2026-10-01 漏抓排查后补充）
export const FREEBIE = /(免费|赠送|额度|限免|重置|体验金|代金券|优惠券|新人|新用户|充值.{0,6}送|福利|积分|灵感值|点数|算力值|登录.{0,4}(送|领|赠)|每[日天].{0,8}(送|领|赠|刷新|重置|补)|邀请|推荐官|实名认证|首月|[1-9]折|折扣|\d+\s*%\s*off|discount|referral|invite|daily\s+(credits?|points?)|points?\s+(per|a|each)\s+day|\bfree\b|credits?\b|bonus|reset|promo|giveaway|unlimited|no\s+(additional\s+)?(cost|charge)|at\s+no\s+charge|allocation|rate\s+limits?|quota|trial)/i;
// 2026-10-15 漏抓：DeepSeek 故障补偿（补偿/返还 7 日消耗）和 Tibo“Day 10/ Reset”（只写重置、没写额度）都被线索关键词滤掉。
export const LEAD = /((故障|宕机|中断|异常|事故|outage|downtime|incident).{0,20}(补偿|赔付|返还|退还|赠金)|全额(补偿|返还|退还)|(补偿|返还|退还).{0,20}(额度|赠金|代金券|积分|消耗|花费|费用|金额|token|credits?)|(消耗|花费|用量).{0,12}(返还|退还|补偿)|(全局|全球|全员|全体|所有人).{0,4}重置|重置.{0,4}(按钮|回归|到账|已完成|完成|落地)|global\s+reset|reset\s+button|\bday\s*\d+\s*\/[^\r\n]{0,24}\breset\b|refund(ed|s|ing)?\b.{0,40}(credits?|usage|spend|tokens?)|(credits?|usage|spend)\b.{0,30}refund|compensat\w*.{0,40}(credits?|usage|spend)|service\s+credits?|credited\s+back|make[-\s]?good|免费|赠送|赠金|每[日天].{0,6}(送|领).{0,6}(积分|额度|灵感值|点数)|邀请.{0,10}(各得|送|得).{0,6}(积分|代金券|额度)|实名认证.{0,10}(送|领|得)|首月.{0,6}(\d折|[\d.]+\s*元)|\d+\s*%\s*off\s+(the\s+)?first\s+month|送\s*[\d一二三四五六七八九十百千万亿¥￥$]|送.{0,6}(额度|token|积分|会员|体验金|代金券|重置卡)|领.{0,6}(额度|赠金|代金券|体验金|会员|token)|限免|限时免费|额度(重置|回满|翻倍|永久)|重置卡|体验金|代金券|羊毛|鸡蛋|充值.{0,6}送|\$\s?\d[\d,]*\s*(美元)?\s*(额度|credits?)|\d+\s*(元|美元|刀)\s*(额度|赠金|代金券|体验金)|free\s+(tier|credits?|tokens?|trial|access|usage|quota|plan|month|week|for\s+(everyone|all|free\s+users))|\$\s?\d[\d,]*\s+(in\s+)?(free\s+)?(api\s+)?credits?|credits?\s+(grant|giveaway|bonus)|rate\s+limits?\s+(reset|doubled|increased)|resets?\s+(rate|usage|limits)|giveaway|promo\s+code|unlimited\s+(usage|generations?|access))/i;
// 综合福利版块（LINUX DO 福利羊毛）整版收录时，奶茶、单车、话费等非 AI 福利占七成，且中转站/号池推广属于明确不收的范围，
// 却会进入研判、复核和身份任务，挤占模型额度与人工审核（2026-10-15 排查：7 天 334 条，仅 18 条形成条目）。
// config.filter = "ai"：标题须涉及 AI 产品或模型，且不是中转站/号池/倍率类推广。
export const AI_TOPIC = /\bai\b|人工智能|大模型|模型|\bllm|\bapi\b|token|gpt|claude|gemini|codex|cursor|copilot|kiro|windsurf|trae|qoder|workbuddy|codebuddy|opencode|agent|智能体|生图|绘图|文生|视频生成|coding|编程|编码|deepseek|\bdp\s*\d|qwen|通义|千问|豆包|doubao|kimi|moonshot|glm|智谱|混元|文心|minimax|海螺|grok|openai|anthropic|chatgpt|midjourney|sora|veo|可灵|即梦|vidu|火山|方舟|硅基|算力|gpu|推理|重置|flash|opus|sonnet|haiku|nano\s*banana|\bmimo\b|stepfun|step-\d|阶跃|讯飞|星火|百川|腾讯云|阿里云|百炼|huggingface|openrouter|groq|mistral|perplexity|suno|elevenlabs|runway|pika|higgsfield|tripo|meshy|krea|genspark|manus|lovable|bolt|\bv0\b|replit|vercel|notion\s*ai|\bima\b|zcode|z\.ai|\bstep\b|step滞销|senseaudio/i;
export const RELAY_PROMO = /富可敌国|中转|公益站|hub\s*站|号池|倍率|转让|出售|代充|\d+(\.\d+)?x\b|共享.{0,6}key|官key|分组/i;
export const isAiFreebieTopic = (title: string) => AI_TOPIC.test(title) && !RELAY_PROMO.test(title);
/**
 * 已批准条目的全部原文摘录仍逐字出现在本次抓到的页面里：说明官方页面仍支持已批准的条款，模型换说法不构成变化，
 * 不再提交成身份候选（2026-10-15：免费模型每 6 小时重读价格页、改写措辞，产生大量人工身份任务）。
 * 至少要有一段 12 字以上的摘录；任何一段摘录消失都按可能有变化处理，照常提交。
 */
export function approvedTermsStillPresent(excerpts: Record<string, string | null | undefined> | null | undefined, page: string): boolean {
  const flat = (s: string) => s.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
  const quotes = Object.values(excerpts ?? {}).filter((q): q is string => typeof q === 'string' && !!q.trim()).map(flat);
  if (!quotes.some(q => q.length >= 12)) return false;
  const text = flat(page);
  return quotes.every(q => text.includes(q));
}
export const isFreebie = (s: string) => FREEBIE.test(s);
export const isLead = (s: string) => LEAD.test(s);
export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** 只保留和羊毛相关的句子（前后各带一行上下文），用来算哈希和喂给模型：页面其他部分变了不会触发。 */
export function relevantText(text: string, max = 12000): string {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const keep = new Set<number>();
  lines.forEach((l, i) => { if (isFreebie(l)) [i - 1, i, i + 1].forEach(j => { if (j >= 0 && j < lines.length) keep.add(j); }); });
  return [...keep].sort((a, b) => a - b).map(i => lines[i]).join('\n').slice(0, max);
}

/** 本次相关文本里上次没有的句子（按空白规整后逐行比较）。 */
export function newRelevantLines(previous: string, current: string): string[] {
  const key = (l: string) => l.normalize('NFKC').replace(/\s+/g, ' ').trim();
  const seen = new Set(previous.split('\n').map(key).filter(Boolean));
  return current.split('\n').map(key).filter(l => l && !seen.has(l));
}

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
export const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();

export function slug(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || sha256(s).slice(0, 10);
}
