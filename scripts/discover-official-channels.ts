// 只读：盘点每个平台及其子品牌官网上公开链接的官方 X 账号、RSS/Atom 与站点，和已登记的官方渠道对比，输出差异报告。
// 官方账号的判定依据是“平台自己的官网链接到它”，不凭名字猜。不写数据库；结果交人工核对后再登记。
// 用法：npx tsx scripts/discover-official-channels.ts [--extra extra.json] > report.json
//   extra.json：{"平台ID":["子品牌官网URL", ...]}，用于平台主站不链接子品牌站点的情况。
import { readFileSync } from 'node:fs';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';
const SOCIAL_SKIP = new Set(['home', 'intent', 'share', 'search', 'explore', 'i', 'hashtag', 'login', 'signup', 'settings', 'privacy', 'tos', 'compose']);
interface Platform { id: string; name: string; site: string | null; xHandles?: string[]; staffHandles?: string[]; aliases?: string[] }
interface Found { pages: { url: string; status: number | string; visibleText?: number; readable?: boolean }[]; xHandles: string[]; feeds: string[]; domains: string[] }

const registrable = (host: string) => host.replace(/^www\./, '').split('.').slice(-2).join('.');
async function fetchHtml(url: string): Promise<{ status: number | string; html: string; finalUrl: string }> {
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html,*/*' }, redirect: 'follow', signal: AbortSignal.timeout(15000) });
    return { status: r.status, html: r.ok ? (await r.text()).slice(0, 2_000_000) : '', finalUrl: r.url || url };
  } catch (error) { return { status: (error as Error).name, html: '', finalUrl: url }; }
}

function extract(html: string, base: string): Omit<Found, 'pages'> {
  const xHandles = new Set<string>(), feeds = new Set<string>(), domains = new Set<string>();
  for (const m of html.matchAll(/https?:\/\/(?:www\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})(?=[/"'?#\s<]|$)/g)) {
    if (!SOCIAL_SKIP.has(m[1].toLowerCase())) xHandles.add('@' + m[1]);
  }
  for (const m of html.matchAll(/<link[^>]+type=["']application\/(?:rss|atom)\+xml["'][^>]*>/gi)) {
    const href = /href=["']([^"']+)["']/i.exec(m[0])?.[1];
    if (href) try { feeds.add(new URL(href, base).href); } catch { /* ignore */ }
  }
  const root = registrable(new URL(base).hostname);
  for (const m of html.matchAll(/href=["'](https?:\/\/[^"'#?]+)/gi)) {
    try { const h = new URL(m[1]).hostname.replace(/^www\./, ''); if (registrable(h) === root) domains.add(h); } catch { /* ignore */ }
  }
  return { xHandles: [...xHandles], feeds: [...feeds], domains: [...domains] };
}

async function discover(urls: string[]): Promise<Found> {
  const found: Found = { pages: [], xHandles: [], feeds: [], domains: [] };
  for (const url of urls) {
    const page = await fetchHtml(url);
    // 只靠 JavaScript 渲染的页面（如聊天应用首页）直抓几乎没有正文，不适合作为抓取信源，只适合登记域名（2026-10-16 z.ai、trae.cn）。
    const visibleText = page.html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().length;
    found.pages.push({ url, status: page.status, visibleText, readable: visibleText >= 800 });
    if (!page.html) continue;
    const e = extract(page.html, page.finalUrl);
    found.xHandles.push(...e.xHandles); found.feeds.push(...e.feeds); found.domains.push(...e.domains);
  }
  const uniq = (list: string[]) => [...new Map(list.map(v => [v.toLowerCase(), v])).values()];
  // 页面声明的 RSS 不一定存在：只保留真的返回 RSS/Atom 的地址（2026-10-16 trae.ai/rss.xml 返回的是网页外壳）。
  const feeds: string[] = [];
  for (const feed of uniq(found.feeds)) { const r = await fetchHtml(feed); if (/<(rss|feed)[\s>]/i.test(r.html.slice(0, 2000))) feeds.push(feed); }
  return { pages: found.pages, xHandles: uniq(found.xHandles), feeds, domains: uniq(found.domains) };
}

const extraIndex = process.argv.indexOf('--extra');
const extra: Record<string, string[]> = extraIndex > 0 ? JSON.parse(readFileSync(process.argv[extraIndex + 1], 'utf8')) : {};
const { platforms } = await (await fetch('https://ai-yangmao.com/api/platforms', { headers: { 'User-Agent': UA } })).json() as { platforms: Platform[] };
const report: Record<string, unknown>[] = [];
const queue = [...platforms];
await Promise.all(Array.from({ length: 6 }, async () => {
  for (let p = queue.shift(); p; p = queue.shift()) {
    const urls = [...new Set([p.site, ...(extra[p.id] ?? [])].filter((u): u is string => !!u))];
    const found = await discover(urls);
    const known = new Set([...(p.xHandles ?? []), ...(p.staffHandles ?? [])].map(h => h.toLowerCase()));
    report.push({ id: p.id, name: p.name, pages: found.pages, newXHandles: found.xHandles.filter(h => !known.has(h.toLowerCase())), knownXHandles: p.xHandles ?? [], feeds: found.feeds, domains: found.domains });
  }
}));
console.log(JSON.stringify(report.sort((a, b) => String(a.id).localeCompare(String(b.id))), null, 1));
