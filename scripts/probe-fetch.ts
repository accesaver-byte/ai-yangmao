// 诊断：用生产采集同样的读取逻辑抓取指定网址，打印读取方式与正文开头。不写任何数据，不输出密钥。
// 用法（GitHub Actions）：collect.yml 的 probe_urls 输入；本机：PROBE_URLS=url1,url2 npx tsx scripts/probe-fetch.ts
import { fetchPage } from '../pipeline/lib';
const urls = (process.env.PROBE_URLS ?? '').split(',').map(u => u.trim()).filter(Boolean);
console.log(`EXA_API_KEY ${process.env.EXA_API_KEY ? 'present' : 'missing'} · JINA_API_KEY ${process.env.JINA_API_KEY ? 'present' : 'missing'}`);
for (const url of urls) {
  if (process.env.EXA_API_KEY && /mp\.weixin\.qq\.com/.test(url)) {
    // Exa 原始响应：状态码与正文开头（不含密钥），用于判断 Exa 能否读到公众号文章。
    try {
      const r = await fetch('https://api.exa.ai/contents', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.EXA_API_KEY }, body: JSON.stringify({ urls: [url], text: true }), signal: AbortSignal.timeout(60000) });
      const raw = await r.text();
      let summary = raw.slice(0, 300);
      try { const j = JSON.parse(raw); summary = JSON.stringify({ statuses: j.statuses, results: (j.results ?? []).map((x: { url?: string; title?: string; author?: string; text?: string }) => ({ url: x.url, title: x.title, author: x.author, text: (x.text ?? '').slice(0, 300) })) }); } catch { /* 非 JSON 原样输出 */ }
      console.log(`\nEXA ${r.status} ${url}\n  ${summary.slice(0, 900)}`);
    } catch (error) { console.log(`\nEXA ERROR ${url} ${(error as Error).message}`); }
  }
  try {
    const page = await fetchPage(url, { timeoutMs: 30000, tries: 1, minimumTextLength: 50 });
    console.log(`\n${url}\n  method=${page.fetchMethod} via=${page.via} sourceVerified=${page.sourceVerified} length=${page.text.length}\n  ${page.text.replace(/\s+/g, ' ').slice(0, 400)}`);
  } catch (error) { console.log(`\n${url}\n  ERROR ${(error as Error).message.slice(0, 300)}`); }
}
