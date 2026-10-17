// 第二层反馈：每周把管理员的纠正归纳成通用规则，写进 pipeline/learned-rules.md。
// 由 .github/workflows/distill.yml 每周六运行，改动以 PR 提交，管理员合并即生效。
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { api } from './lib';
import { MODEL_OUTPUT_LIMIT, reserveModel, settleModel } from './budget';

const DAYS = Number(process.env.DISTILL_DAYS ?? 7);
const file = new URL('./learned-rules.md', import.meta.url);
const current = readFileSync(file, 'utf8');
const existing = current.split('\n').filter(l => /^\s*-\s+/.test(l));
const { corrections } = await api<{ corrections: string[] }>(`/corrections?limit=80&days=${DAYS}`);
const out = (s: string) => { console.log(s); if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, s + '\n'); };
if (corrections.length < 2) { out(`最近 ${DAYS} 天只有 ${corrections.length} 条人工纠正，不足以归纳规则。`); process.exit(0); }

const prompt = `你在维护"AI 羊毛牧场"信息抽取器的规则。下面是管理员最近 ${DAYS} 天对抽取结果做的纠正（修改字段、拒绝理由），以及已经生效的规则。
请归纳出新的通用规则，要求：
- 只写能从纠正里看出、以后会反复用到的规律；只出现一次且没有普遍性的，不写
- 不要和已有规则重复或矛盾；如果某条已有规则需要修订，给出修订后的完整规则并标明 replaces
- 每条规则一句话，中文，可直接放进抽取提示词
- 每条附上依据（引用哪几条纠正）
- 标着「在入口阶段被拒」的是线索阶段的拒绝：归纳成研判时直接不收的规则（例如与 AI 无关的优惠券/购物券、中转站推广、账号池、个人送码），写清识别特征；不要据此排除官方发放的真实 AI 额度
只输出 JSON：{"rules":[{"rule":"...","basis":["..."],"replaces":null}]}；没有值得新增的就输出 {"rules":[]}。

已有规则：
${existing.join('\n') || '（无）'}

最近的纠正：
${corrections.map(c => '- ' + c).join('\n')}`;

const reserved = await reserveModel('gemini-distill', '', prompt);
const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${process.env.GEMINI_MODEL || 'gemini-flash-lite-latest'}:generateContent`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY ?? '' },
  body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { responseMimeType: 'application/json', temperature: 0.2, maxOutputTokens: MODEL_OUTPUT_LIMIT } }),
});
if (!r.ok) { await settleModel(reserved, 'gemini-distill', 0, 0); out(`模型调用失败：${r.status}`); process.exit(1); }
const j = await r.json() as { candidates?: { content?: { parts?: { text?: string }[] } }[]; usageMetadata?: { totalTokenCount?: number } };
if (Number.isFinite(j.usageMetadata?.totalTokenCount)) await settleModel(reserved, 'gemini-distill', j.usageMetadata!.totalTokenCount!, 0);
else out('模型未返回可靠用量，本次预算预留保留。');
const parsed = JSON.parse((j.candidates?.[0]?.content?.parts?.map(p => p.text ?? '').join('') ?? '{}').replace(/^```(json)?|```$/g, '').trim()) as { rules?: { rule: string; basis?: string[]; replaces?: string | null }[] };
const rules = (parsed.rules ?? []).filter(x => x.rule && !existing.some(e => e.includes(x.rule.slice(0, 20))));
if (!rules.length) { out(`归纳了 ${corrections.length} 条纠正，没有值得新增的规则。`); process.exit(0); }

let text = current;
for (const x of rules) {
  if (x.replaces) text = text.split('\n').filter(l => !(l.trim().startsWith('-') && l.includes(x.replaces!.slice(0, 20)))).join('\n');
  text = text.trimEnd() + `\n- ${x.rule}\n`;
}
writeFileSync(file, text);
out(`## 本周提议的新规则（${rules.length} 条）\n\n合并这个 PR 即批准；不同意的规则，在 PR 里删掉那一行再合并，或者直接关闭 PR。\n`);
for (const x of rules) out(`- **${x.rule}**${x.replaces ? `（替换：${x.replaces}）` : ''}\n  - 依据：${(x.basis ?? []).join('；')}`);
