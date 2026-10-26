// 羊毛审核辅助脚本：读条目、试算修改后的上架前检查、在管理员确认后写入。
// 用法（在项目根目录）：npx tsx .claude/skills/yangmao-review/scripts/offer.ts <命令> ...
//   queue [条数]                       待审列表（拦截项多的排前面）
//   show <短码或ID>                    全部字段、上架前检查、修订、平台要点、信源
//   plan <短码或ID> <patch.json>       试算：把修改套上去，列出改后的检查结果（不写入）
//   apply <短码或ID> <patch.json> --version <reviewVersion> --reason "理由" [--code wrong_field] [--approve] [--dry-run]
//   memo <短码或ID> <memo.txt> [--dry-run]       写内部核验记录（仅管理员可见）
//   approve <短码或ID> --version <reviewVersion> [--dry-run]
//   reject <短码或ID> --version <reviewVersion> --code <理由代码> --reason "理由" [--dry-run]
//   retest <短码或ID> [--dry-run]                管理员核对仍有效（更新核验时间）
//   unpublish <短码或ID> --version <visibilityVersion> --code <代码> --reason "理由"   把已上架但不该收的条目撤下（仅管理员）
//   suggest <短码或ID> approve|history|reject|judge|clear [--code 理由代码] --reason "理由"   给审批卡片标审核建议（不改状态）
// 管理员密钥从 .prod.secrets 读取，不会打印。写入命令加 --dry-run 只打印请求内容。
import { readFileSync, existsSync } from 'node:fs';

// skill 目录可能是链接到项目外的软链接，所以按当前目录（项目根目录）找文件
const ROOT = new URL(`file://${process.cwd()}/`);
const API = process.env.YM_API ?? 'https://ai-yangmao.com/api/admin';
const args = process.argv.slice(2);
const cmd = args[0];
const flag = (name: string) => args.includes(name);
const opt = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const positional = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && ['--reason', '--code', '--version'].includes(args[i - 1])));
const DRY = flag('--dry-run');
function reviewedVersion(): string {
  const version = opt('--version');
  if (!version || version.startsWith('--')) throw new Error('edit/approve/reject/unpublish 必须传 --version <show 中已核对的版本；下架用 visibilityVersion>；版本变化后重新核对差异，不要原样重放');
  return version;
}

const TYPE_CODE: Record<string, string> = { 注册新人礼: 'new', 应用尝鲜: 'trial', 限时免费开放: 'free', 会员福利: 'perk', 充值赠送: 'topup', 会员免费送: 'gift', 常驻免费额度: 'standing', 申请制: 'apply' };
const EDITABLE = ['title', 'type', 'valueText', 'usdEstimate', 'usdMax', 'models', 'tags', 'claimStart', 'claimEnd', 'endKind', 'creditValidity',
  'audience', 'requirements', 'membershipRequirement', 'modalities', 'platformId', 'sourceTz', 'claimMethod', 'steps', 'evidence', 'publishedAt'];
const REASON_CODES = ['paid_bundle', 'not_ai', 'wrong_platform', 'duplicate', 'expired', 'vague', 'insufficient_evidence', 'wrong_type', 'wrong_field', 'other'];

function token(): string {
  if (process.env.ADMIN_TOKEN) return process.env.ADMIN_TOKEN;
  const f = new URL('.prod.secrets', ROOT);
  if (!existsSync(f)) throw new Error('找不到 .prod.secrets（需要 ADMIN_TOKEN）');
  const m = readFileSync(f, 'utf8').match(/^ADMIN_TOKEN=(.+)$/m);
  if (!m) throw new Error('.prod.secrets 里没有 ADMIN_TOKEN');
  return m[1].trim();
}
async function call<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(API + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0 (yangmao-review skill)' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({})) as T & { error?: string; issues?: unknown };
  if (!r.ok) throw new Error(`${r.status} ${j.error ?? ''}${j.issues ? ' ' + JSON.stringify(j.issues).slice(0, 400) : ''}`);
  return j;
}
async function write(path: string, body: unknown) {
  if (DRY) { console.log(`[dry-run] POST ${path}\n${JSON.stringify(body, null, 2)}`); return; }
  console.log(JSON.stringify(await call(path, body), null, 2));
}

type View = Record<string, unknown> & { code: string; id: string; platformId: string; platform: string; title: string; type: string; value: string; checks?: Check[];
  excerpts: Record<string, string>; evidenceUrl: string; evidenceTier: string; requirements: string[]; models?: string[]; tags?: string[]; steps?: string[]; modalities?: string[] };
type Check = { field: string; label: string; level: string; problem: string; sections: string[] };

/** 把后台返回的条目转成规格检查需要的原始字段。 */
function raw(v: View) {
  return {
    type: TYPE_CODE[v.type] ?? v.type, title: v.title, valueText: v.value, usdEstimate: v.usdEstimate ?? null, usdMax: v.usdMax ?? null,
    claimStart: v.claimStart ?? null, claimEnd: v.claimEnd ?? null, membershipRequirement:v.membershipRequirement??null, endKind: v.endKind, sourceTz: v.sourceTz ?? 'UTC', requirements: v.requirements,
    audience: v.audience, creditValidity: v.creditValidity ?? null, models: v.models ?? [], tags: v.tags ?? [], steps: v.steps ?? [], publishedAt: v.publishedAt ?? null,
    claimMethod: v.claimMethod, modalities: v.modalities ?? [], platformId: v.platformId,
    evidence: { url: v.evidenceUrl, tier: v.evidenceTier, excerpts: v.excerpts ?? {} },
  } as Record<string, unknown> & { evidence: { url: string; tier: string; excerpts: Record<string, string> } };
}
function printChecks(checks: Check[], title = '上架前检查') {
  const main = checks.filter(c => c.level !== 'info');
  console.log(`\n## ${title}：拦截 ${checks.filter(c => c.level === 'block').length} · 提醒 ${checks.filter(c => c.level === 'warn').length}`);
  for (const c of main) console.log(`- [${c.level === 'block' ? '必须补' : '建议补'}] ${c.label}：${c.problem}\n    影响：${c.sections.join('、')}`);
  const info = checks.filter(c => c.level === 'info');
  if (info.length) console.log(`- 可选：${info.map(c => c.label).join('、')}`);
}
function platformNotes(id: string): string {
  const f = new URL('pipeline/platform-notes.md', ROOT);
  if (!existsSync(f)) return '';
  const lines = readFileSync(f, 'utf8').split('\n');
  const i = lines.findIndex(l => l.trim() === `## ${id}`);
  if (i < 0) return '';
  const out: string[] = [];
  for (const l of lines.slice(i + 1)) { if (l.startsWith('## ')) break; if (l.trim()) out.push(l); }
  return out.join('\n');
}
function platformSources(id: string): string[] {
  const f = new URL('seed/platforms.json', ROOT);
  if (!existsSync(f)) return [];
  const d = JSON.parse(readFileSync(f, 'utf8')) as { platforms: { id: string; name: string; site: string | null; x: string[] }[]; sources: { id: string; platform: string | null; url: string; kind: string; tier: string }[] };
  const p = d.platforms.find(x => x.id === id);
  return [`官网：${p?.site ?? '未登记'}；X：${(p?.x ?? []).join(' ') || '未登记'}`, ...d.sources.filter(s => s.platform === id).map(s => `${s.id}（${s.kind}/${s.tier}）${s.url}`)];
}
/** patch 里的 evidence 可以只写要改的部分（如只改 tier 或补一段 excerpts），这里和现有证据合并。 */
function mergePatch(v: View, patch: Record<string, unknown>) {
  const bad = Object.keys(patch).filter(k => !EDITABLE.includes(k));
  if (bad.length) throw new Error(`这些字段不能改：${bad.join('、')}（可改：${EDITABLE.join('、')}）`);
  const out = { ...patch };
  if (patch.evidence) {
    const e = patch.evidence as { url?: string; tier?: string; excerpts?: Record<string, string> };
    // Other evidence keys in the patch (cautions, apiAccess…) pass through; the server keeps stored keys not sent.
    out.evidence = { ...e, url: e.url ?? v.evidenceUrl, tier: e.tier ?? v.evidenceTier, capturedAt: new Date().toISOString(), excerpts: { ...(v.excerpts ?? {}), ...(e.excerpts ?? {}) } };
  }
  return out;
}

async function main() {
  const ref = positional[1];
  if (cmd === 'queue') {
    const q = await call<{ pending: View[]; incomplete?: View[] }>('/queue');
    const n = Number(positional[1] ?? 30);
    const rank = (v: View) => (v.checks ?? []).filter(c => c.level === 'block').length * 100 + (v.checks ?? []).filter(c => c.level === 'warn').length;
    console.log(`待审 ${q.pending.length} 条；已上架字段待补 ${q.incomplete?.length ?? 0} 条`);
    for (const v of q.pending.slice().sort((a, b) => rank(b) - rank(a)).slice(0, n)) {
      const c = v.checks ?? [];
      console.log(`[${v.code}] ${v.platform}｜${v.title}  拦截 ${c.filter(x => x.level === 'block').length} · 提醒 ${c.filter(x => x.level === 'warn').length} · 证据 ${v.evidenceTier}`);
    }
    return;
  }
  if (!ref) throw new Error('缺少短码或 ID');
  if (cmd === 'show') {
    const { offer: v, revisions, pendingUpdate } = await call<{ offer: View; revisions: { at: string; author?: string; diff: { field: string }[] }[]; pendingUpdate: boolean }>(`/offers/${encodeURIComponent(ref)}`);
    const r = raw(v);
    console.log(`reviewVersion：${v.reviewVersion}`);
    if(v.visibilityVersion)console.log(`visibilityVersion（下架）：${v.visibilityVersion}`);
    if (pendingUpdate) console.log('注意：下列字段是候选；批准基线差异（from → to）：\n' + JSON.stringify(v.updateDiff ?? [], null, 2));
    console.log(`# [${v.code}] ${v.title}\nID：${v.id}｜平台：${v.platform}（${v.platformId}）｜审核：${v.reviewState}｜状态：${v.status}${pendingUpdate ? '｜有条款更新待审' : ''}`);
    for (const k of ['type', 'valueText', 'usdEstimate', 'usdMax', 'claimMethod', 'requirements', 'membershipRequirement', 'audience', 'claimStart', 'claimEnd', 'endKind', 'sourceTz', 'creditValidity', 'modalities', 'models', 'tags', 'publishedAt', 'steps']) console.log(`- ${k}：${JSON.stringify(r[k])}`);
    console.log(`- 证据：${r.evidence.tier} ${r.evidence.url}`);
    for (const [k, t] of Object.entries(r.evidence.excerpts)) if (t) console.log(`    ${k}：「${t}」`);
    if (v.adminNote) console.log(`- 牧场心得：${v.adminNote}`);
    if (v.reviewMemo) console.log(`- 核验记录：${String(v.reviewMemo).replace(/\n/g, ' / ')}`);
    printChecks(v.checks ?? []);
    if (revisions.length) console.log(`\n## 修订 ${revisions.length} 次：${revisions.slice(0, 5).map(x => `${x.at.slice(0, 10)}${x.author === 'admin' ? '（人工）' : ''} ${x.diff.map(d => d.field).join('、')}`).join('；')}`);
    const notes = platformNotes(v.platformId);
    console.log(`\n## 平台要点（pipeline/platform-notes.md）\n${notes || '（这个平台还没有要点）'}`);
    console.log(`\n## 平台信源（seed/platforms.json）\n${platformSources(v.platformId).join('\n')}`);
    return;
  }
  if (cmd === 'plan') {
    const { offer: v } = await call<{ offer: View }>(`/offers/${encodeURIComponent(ref)}`);
    const patch = mergePatch(v, JSON.parse(readFileSync(positional[2], 'utf8')));
    const { checkOffer, SECTIONS } = await import(new URL('src/shared/spec.ts', ROOT).href) as typeof import('../../../../src/shared/spec');
    const before = raw(v), after = { ...before, ...patch };
    console.log(`# 试算 [${v.code}] ${v.title}（不写入）`);
    for (const k of Object.keys(patch)) console.log(`- ${k}：${JSON.stringify(before[k])}\n    → ${JSON.stringify(after[k])}`);
    const label = (cs: ReturnType<typeof checkOffer>) => cs.map(c => ({ ...c, sections: c.sections.map(s => SECTIONS[s]) }));
    printChecks(label(checkOffer(after as never)), '改后的上架前检查');
    // 服务器通过时还会查这些（不在规格检查里）
    const ev = after.evidence as { tier: string; url: string };
    if (ev.tier === 'media') console.log('- [必须补] 证据级别：媒体 / 社区转述不能上架，要换成平台官方出处；官方没有文字公告但管理员亲测过的，改成 tested（管理员实测）');
    console.log(`- 提交时服务器还会检查：平台已准入；证据链接属于该平台官网或已登记的官方信源（tested 除外）。当前证据：${ev.tier} ${ev.url}`);
    return;
  }
  if (cmd === 'apply') {
    const version = reviewedVersion();
    const reason = opt('--reason');
    if (!reason) throw new Error('要写 --reason（模型会从修改理由里学习）');
    const code = opt('--code') ?? 'wrong_field';
    if (!REASON_CODES.includes(code)) throw new Error(`--code 只能是：${REASON_CODES.join('、')}`);
    const { offer: v } = await call<{ offer: View }>(`/offers/${encodeURIComponent(ref)}`);
    if (v.reviewVersion !== version) throw new Error('内容已更新，请重新 show 并核对差异；不提交旧补丁');
    const fields = mergePatch(v, JSON.parse(readFileSync(positional[2], 'utf8')));
    await write(`/offers/${encodeURIComponent(ref)}/edit`, { fields, approve: flag('--approve'), reason, reasonCode: code, expectedReviewVersion: version });
    return;
  }
  if(cmd==='reopen'){
    const version=reviewedVersion(),reason=opt('--reason');if(!reason||reason.length<8)throw new Error('reopen 需要明确的重开依据；重开仍保持待审');
    await write(`/offers/${encodeURIComponent(ref)}/reopen-visibility`,{expectedReviewVersion:version,reason});return;
  }
  if (cmd === 'unpublish') {
    const version=reviewedVersion();
    const reason = opt('--reason'); if (!reason) throw new Error('unpublish <短码> --code <理由代码> --reason "理由"');
    await write(`/offers/${encodeURIComponent(ref)}/unpublish`, { reasonCode: opt('--code') ?? 'other', reason,expectedReviewVersion:version });
    return;
  }
  if (cmd === 'suggest') {
    const verdict = positional[2];
    if (!['approve', 'history', 'reject', 'judge', 'clear'].includes(verdict)) throw new Error('suggest <短码> approve|history|reject|judge|clear [--code 理由代码] --reason "理由"');
    await write(`/offers/${encodeURIComponent(ref)}/suggest`, verdict === 'clear' ? { verdict: null } : { verdict, code: opt('--code') ?? null, reason: opt('--reason') ?? '' });
    return;
  }
  if (cmd === 'memo') { await write(`/offers/${encodeURIComponent(ref)}/memo`, { memo: readFileSync(positional[2], 'utf8') }); return; }
  if (cmd === 'approve') { await write(`/offers/${encodeURIComponent(ref)}/approve`, { expectedReviewVersion: reviewedVersion() }); return; }
  if (cmd === 'retest') { await write(`/offers/${encodeURIComponent(ref)}/retested`, {}); return; }
  if (cmd === 'reject') {
    const version = reviewedVersion();
    const code = opt('--code'), reason = opt('--reason');
    if (!code || !REASON_CODES.includes(code) || !reason) throw new Error(`reject 需要 --code（${REASON_CODES.join('、')}）和 --reason`);
    await write(`/offers/${encodeURIComponent(ref)}/reject`, { reasonCode: code, reason, expectedReviewVersion: version });
    return;
  }
  throw new Error('未知命令。可用：queue、show、plan、apply、memo、approve、reject、retest');
}
main().catch(e => { console.error('出错：' + (e as Error).message); process.exit(1); });
