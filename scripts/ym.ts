import { adminHttp } from './admin-http';
// ym：AI 羊毛牧场的命令行工具，给 Hermes Agent 的技能调用（也可以自己在终端用）。
// 密钥从项目根目录的 .prod.secrets 读取（ADMIN_TOKEN）。输出为适合直接发到 Telegram 的中文纯文本。
import { readFileSync } from 'node:fs';

const env: Record<string, string> = {};
for (const line of readFileSync(new URL('../.prod.secrets', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].replace(/#.*$/, '').trim();
}
const BASE = (process.env.API_BASE ?? env.API_BASE ?? 'https://ai-yangmao.com').replace(/\/$/, '');

async function call<T = any>(path: string, body?: unknown, admin = true): Promise<T> {
  const { status, data: j } = adminHttp(`${BASE}/api${admin ? '/admin' : ''}${path}`, env.ADMIN_TOKEN ?? '', body);
  if (status < 200 || status >= 300) { console.error(`出错（${status}）：${j.error ?? ''}${j.issues ? ' ' + JSON.stringify(j.issues).slice(0, 300) : ''}`); process.exit(1); }
  return j as T;
}

const REQ: Record<string, string> = { none: '零门槛', unknown: '领取条件待确认', phone: '海外手机号', card: '海外信用卡', net: '海外网络', realname: '实名', biz: '企业认证', student: '学生认证', invite: '邀请码', targeted: '定向发放' };
const req = (r: string[]) => r.map(x => x.startsWith('pay:') ? `充值 ${x.slice(4)}` : x.startsWith('member:') ? `会员 ${x.slice(7)}` : REQ[x] ?? x).join('、');
const AUD: Record<string, string> = { new: '新用户', old: '老用户', all: '全部用户', unclear: '资格未明确' };
const line = (o: any) => `[${o.code}] ${o.platform}｜${o.title}\n     ${o.value} · ${o.end}`;
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());

const HELP = `用法：ym <命令>
  queue                 看待审（羊毛、新平台、可放开自动上架的信源）
  show <短码>           看一条羊毛的全部字段和官方证据
  approve <短码> --version <审核版本> 通过
  reject <短码> [理由]  拒绝。理由开头可加快捷分类：付费套餐 / 非AI / 平台错 / 重复 / 过期 / 额度不明 / 证据不足 / 分类错
  edit <短码> 字段=值 … [--approve] [--reason 理由]  修改字段（可同时通过）；写上理由，模型以后学得更快。字段：title type valueText usdEstimate claimStart claimEnd endKind creditValidity audience requirements membershipRequirement(JSON) modalities platformId sourceTz claimMethod
  leads [数量]          看最新线索
  dismiss <线索id>      忽略线索（需 --version <reviewVersion>）
  add <链接> [备注]     补录链接（下一轮采集抓取并抽取，进待审）
  today                 今天能领的羊毛
  on <YYYY-MM-DD>       某一天有效的限时羊毛
  digest                只预览日报，不写通知台账
  urgent                只预览加急，不写通知台账
  dispatch digest|urgent 通过 Hermes 发送，成功后才确认通知台账
  health                采集健康状况（有问题才输出，--verbose 总是输出）
  platform-approve <平台id> / platform-reject <平台id>
  auto-publish <信源id> on|off
  withdraw <短码> <官方撤回链接> <具体理由>  核实后结束活动
  delivery-delivered <发送ID> <理由> / delivery-unsent <发送ID> <理由>  人工核对结果不明的推送`;

const [cmd, ...args] = process.argv.slice(2);
const flag = (f: string) => args.includes(f);
const vi=args.indexOf('--version');
const reviewVersion=vi>=0?args[vi+1]:undefined;
const rest = args.filter((a,i) => !a.startsWith('--')&&(vi<0||i!==vi+1));
const requireVersion=()=>{if(!reviewVersion){console.error('请先 show 查看审核版本，再传 --version <审核版本>；不自动刷新旧版本');process.exit(2);}return reviewVersion;};

switch (cmd) {
  case 'queue': {
    const q = await call('/queue');
    const identity=await call('/identity/tasks');
    for(const task of identity.tasks??[])console.log(`身份任务 ${task.id}｜${task.display?.title??task.kind}\n     审核版本：identity:${task.id}:${task.revision}\n     ${task.entity?.canonical_offer_id?'活动 ID：'+task.entity.canonical_offer_id:'请到后台确认身份与事实'}\n     https://ai-yangmao.com/#admin`);
    if(identity.nextCursor)console.log('仍有更多身份任务，请在后台加载下一页。');
    if (!(identity.tasks??[]).length && !q.pending.length && !q.pendingPlatforms.length && !q.suggestAutoPublish.length && !q.needsVerification?.length && !q.leadTasks?.length) { console.log(`待审队列是空的。新线索 ${q.newLeads} 条。`); break; }
    console.log(`身份任务 ${(identity.tasks??[]).length} 条 · 旧待审 ${q.pending.length} 条 · 线索复核 ${q.leadTasks?.length??0} 条（新线索 ${q.newLeads} 条）`);
    for(const l of q.leadTasks??[])console.log(`#${l.id} ${l.title} · ${l.resolution?.status??'等待自动复核'}${l.resolution?.nextAttemptAt?' · 下次 '+l.resolution.nextAttemptAt:''}\n${l.note??''}\nhttps://ai-yangmao.com/#admin`);
    const TIER: Record<string, string> = { site: '官网', docs: '官方文档', official: '官方账号', staff: '员工账号', media: '媒体/社区转述，需核对官方', tested: '管理员实测' };
    for (const o of q.pending) console.log(`${line(o)}
     门槛：${req(o.requirements)} · 证据：${TIER[o.evidenceTier] ?? o.evidenceTier}${o.missingEvidence.length ? `（缺 ${o.missingEvidence.join('、')}）` : ''}
     原文：${o.excerpts.benefit ? `「${o.excerpts.benefit.slice(0, 80)}」` : '—'}
     来源：${o.evidenceUrl}`);
    if (q.pendingPlatforms.length) console.log(`\n新平台待准入：${q.pendingPlatforms.map((p: any) => `${p.name}（${p.id}）`).join('、')}`);
    for (const o of q.needsVerification ?? []) console.log(`\n待核验：[${o.code}] ${o.title}｜${o.evidenceUrl}。如官方确认撤回：ym withdraw ${o.code} <官方撤回链接> <理由>`);
    for (const s of q.suggestAutoPublish) console.log(`\n建议放开自动上架：${s.id}（已连续原样通过 ${s.cleanStreak} 条）→ ym auto-publish ${s.id} on`);
    break;
  }
  case 'show': {
    const { offer: o, revisions } = await call(`/offers/${rest[0]}`);
    console.log(`[${o.code}] ${o.title}（${o.platform}）
审核版本：${o.reviewVersion}\n上下架版本：${o.visibilityVersion??o.reviewVersion}\n类型：${o.type}　状态：${o.status}　审核：${o.reviewState}
额度：${o.value}${o.usd != null ? `（约 $${o.usd}）` : ''}
领取：${o.claimMethod}　${o.claimStart ?? '已开放'} → ${o.end}（官方时区 ${o.sourceTz}）　额度有效期：${o.creditValidity ?? '未写'}
资格：${AUD[o.audience]}；${req(o.requirements)}
证据（${o.evidenceTier}）：${o.evidenceUrl}
  权益：${o.excerpts.benefit ?? '—'}
  资格：${o.excerpts.eligibility ?? '—'}
  领取：${o.excerpts.claim ?? '—'}
  有效期：${o.excerpts.validity ?? '—'}
${revisions.length ? `修订：${revisions.map((r: any) => r.diff.map((x: any) => `${x.field} ${x.from}→${x.to}`).join('；')).join(' / ')}\n` : ''}网页：${o.link}`);
    break;
  }
  case 'approve': case 'reject': {
    const version=requireVersion();
    const text = rest.slice(1).join(' ');
    const CODES: [RegExp, string][] = [[/证据不足|缺少官方证据/, 'insufficient_evidence'], [/付费套餐|套餐自带/, 'paid_bundle'], [/非\s*AI|不是\s*AI/, 'not_ai'], [/平台(错|归属)/, 'wrong_platform'], [/重复/, 'duplicate'], [/过期|已结束/, 'expired'], [/额度不明|没写额度/, 'vague'], [/分类错|类型错/, 'wrong_type']];
    const reasonCode = cmd === 'reject' ? (CODES.find(([re]) => re.test(text))?.[1] ?? (text ? 'other' : undefined)) : undefined;
    const r = await call(`/offers/${rest[0]}/${cmd}`, { reason: text || undefined, reasonCode,expectedReviewVersion:version });
    console.log(`${cmd === 'approve' ? '已通过' : '已拒绝'}：[${r.code}] ${r.title}${r.sourceCleanStreak != null ? `（该信源连续原样通过 ${r.sourceCleanStreak} 条）` : ''}${r.urgent ? '\n⚠️ 48 小时内截止，下一次整点检查会发加急提醒' : ''}`);
    break;
  }
  case 'withdraw': {
    const [ref, evidenceUrl, ...reason] = rest;const version=requireVersion();
    if (!ref || !evidenceUrl || !reason.length) { console.error('需要短码、官方撤回链接和具体理由'); process.exitCode = 2; break; }
    const result = await call(`/offers/${ref}/withdraw`, { evidenceUrl, reason: reason.join(' '),expectedReviewVersion:version });
    console.log(`已结束活动 [${result.code}]；结束提醒会在下一次日报中处理。`);
    break;
  }
  case 'edit': {
    const version=requireVersion();
    if(version.startsWith('identity:')&&flag('--approve')){console.error('身份草稿请先保存，再按新审核版本批准');process.exitCode=2;break;}
    const fields: Record<string, unknown> = {};
    const ri = args.indexOf('--reason');
    const reason = ri >= 0 ? args.slice(ri + 1).filter(a => !a.startsWith('--')).join(' ') : undefined;
    for (const kv of rest.slice(1).filter(a => !(reason && reason.split(' ').includes(a)))) {
      const i = kv.indexOf('='); if (i < 0) continue;
      const k = kv.slice(0, i), v = kv.slice(i + 1);
      fields[k] = k === 'membershipRequirement' ? JSON.parse(v) : ['requirements', 'modalities'].includes(k) ? v.split(',') : k === 'usdEstimate' ? (v === 'null' ? null : Number(v)) : v === 'null' ? null : v;
    }
    const r = await call(`/offers/${rest[0]}/edit`, { fields, approve: flag('--approve'), expectedReviewVersion:version, reason, reasonCode: Object.keys(fields).includes('type') ? 'wrong_type' : 'wrong_field' });
    console.log(`已修改 [${r.code}]：${(r.changed??Object.keys(fields)).join('、')}${r.approved ? '，并已通过' : ''}${r.reviewVersion?' · 新审核版本：'+r.reviewVersion:''}`);
    break;
  }
  case 'leads': {
    const { leads } = await call(`/leads?limit=${rest[0] ?? 15}`);
    console.log(leads.length ? leads.map((l: any) => `#${l.id} ${l.origin}｜${l.title}\n     ${l.url}\n     版本：${l.reviewVersion} · ${l.resolution?.reason??l.note??l.status}`).join('\n') : '没有新线索。');
    break;
  }
  case 'dismiss': { const versionIndex=args.indexOf('--version');if(versionIndex<0||!args[versionIndex+1]){console.error('请先查看线索并使用 dismiss <ID> --version <reviewVersion>');process.exitCode=2;break;} await call(`/leads/${rest[0]}/dismiss`, {expectedVersion:args[versionIndex+1]}); console.log(`已忽略线索 #${rest[0]}`); break; }
  case 'add': {
    const r = await call('/manual', { url: rest[0], note: rest.slice(1).join(' ') || undefined });
    console.log(`已补录（线索 #${r.leadId}），下一轮采集会抓取并抽取，结果进待审。`);
    break;
  }
  case 'today': case 'on': {
    const date = cmd === 'today' ? today() : rest[0];
    const r = await call(`/offers?${cmd === 'today' ? 'view=claimable' : `on=${date}`}`, undefined, false);
    if (!r.offers.length) { console.log(`${date} 没有收录到可领的羊毛。`); break; }
    console.log(`${cmd === 'today' ? '今天' : date} 可领 ${r.count} 条：`);
    for (const o of r.offers) console.log(`• ${o.title}｜${o.valueText}${o.endKind === 'date' ? ` · ${o.claimEnd} 截止` : o.endKind === 'unknown' ? ' · 截止未知' : ''}\n  https://ai-yangmao.com/#offer-${o.id}`);
    break;
  }
  case 'digest': case 'urgent': case 'dispatch': {
    const kind = cmd === 'dispatch' ? rest[0] : cmd;
    if (kind !== 'digest' && kind !== 'urgent') { console.error('dispatch 只接受 digest 或 urgent'); process.exitCode = 2; break; }
    const r = cmd === 'dispatch'
      ? await call('/notify/claim', { kind, channel: 'telegram' })
      : await call(`/notify?kind=${kind}&channel=telegram`);
    if (r.empty) break; // 没有变化不输出 → Hermes 定时任务不发空消息
    const d = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric' }).format(new Date());
    const sec = (t: string, a: any[]) => a.length ? `\n${t}（${a.length}）\n${a.map(line).join('\n')}\n` : '';
    const alert = r.d1Alert ? `🚨 数据库读取已用 ${Math.round(r.d1Alert.rowsRead / 10000)} 万 / ${r.d1Alert.limit / 10000} 万行（免费额度 ${Math.round(r.d1Alert.rowsRead / r.d1Alert.limit * 100)}%）。用满后全站无法加载，到东京 9 点才恢复。先停手动采集和批量操作，或在 Cloudflare 升级 Workers 付费版。\n` : '';
    const review = r.reviewAlerts?.length ? `\n📝 审核提醒（${r.reviewAlerts.length} 条）\n${r.reviewAlerts.map((a: any)=>`${a.state}｜${a.title}\n${a.url}`).join('\n')}\n请在后台“待审 / 线索”核验；这些内容尚未批准上架。\n` : '';
    const message = review + alert + (kind === 'urgent'
      ? (r.items.urgent.length ? `⚡ 加急：48 小时内截止\n${r.items.urgent.map(line).join('\n')}` : '')
      : `🐑 AI 羊毛牧场日报 · ${d}\n${sec('🆕 新上架', r.items.new)}${sec('⏰ 3 天内结束', r.items.ending)}${sec('🔄 条款变化', r.items.changed)}${sec('❌ 已结束', r.items.ended)}${r.pendingCount ? `\n📝 待审 ${r.pendingCount} 条，回复"看待审"处理` : ''}${r.needsVerificationCount ? `\n⚠️ ${r.needsVerificationCount} 条权益证据待核验，回复"看待审"处理` : ''}${r.coverageDegraded ? '\n⚠️ 部分抓取、抽取或官方核验未完成；请查看采集健康，自动任务会继续重试' : ''}${r.suggestAutoPublish?.length ? `\n🔓 建议审核自动上架信源：${r.suggestAutoPublish.join('、')}` : ''}\n\n网页：https://ai-yangmao.com`);
    if (cmd !== 'dispatch') { console.log(message); break; }
    const { spawnSync } = await import('node:child_process');
    const sent = spawnSync('hermes', ['send', '--to', 'telegram', '--quiet', '--file', '-'], { input: message, encoding: 'utf8', timeout: 30000 });
    if (sent.error || sent.status !== 0) {
      await call(`/notify/${r.deliveryId}/ack`, { status: 'unknown', error: String(sent.error?.message ?? sent.stderr ?? `Hermes exit ${sent.status}`).slice(0, 500) });
      console.error('Telegram 投递结果不明，已留待人工核对，未自动重发。');
      process.exitCode = 1;
      break;
    }
    await call(`/notify/${r.deliveryId}/ack`, { status: 'sent' });
    break;
  }
  case 'health': {
    const h = await call('/health');
    const uncertain = (h.uncertainDeliveries ?? []).filter((d: any) => d.status === 'unknown' || Date.now() - Date.parse(d.createdAt) > 10 * 60_000);
    const leadStalled = h.leadWorkflow?.oldestImportantNewAt && Date.now()-Date.parse(h.leadWorkflow.oldestImportantNewAt)>2*3600_000;
    const bad = h.officialReviewCounts?.stalled || h.officialReviewCounts?.exhausted || h.coverageDegraded || leadStalled || h.leadWorkflow?.lastRun?.ok === false || h.collectStale || h.failingSources.length || uncertain.length;
    if (!bad && !flag('--verbose')) break;
    console.log(`${bad ? '🚨 采集或投递告警' : '✅ 采集正常'}：最近一次完整成功采集 ${h.lastSuccessfulCollect ? `${h.hoursSince.toFixed(1)} 小时前` : '从未成功'}${h.coverageDegraded ? `\n⚠️ 最近采集覆盖不完整：核验失败 ${h.lastCollectAttempt?.stats?.verificationFailed ?? '未记录'}、核验延期 ${h.lastCollectAttempt?.stats?.verificationDeferred ?? '未记录'}，其余失败见采集健康页` : ''}${h.officialReviewCounts ? `\n官方出处复核：待处理 ${h.officialReviewCounts.waiting ?? 0} · 重试中 ${h.officialReviewCounts.retrying ?? 0} · 耗尽待人工 ${h.officialReviewCounts.exhausted ?? 0} · 占位超时 ${h.officialReviewCounts.stalled ?? 0} · 进行中 ${h.officialReviewCounts.checking} · 已匹配 ${h.officialReviewCounts.matched} · 待补证 ${h.officialReviewCounts.unresolved} · 受阻 ${h.officialReviewCounts.failed}` : ''}${h.leadWorkflow ? `\n线索：新 ${h.leadWorkflow.new} · 线索复核 ${h.leadWorkflow.reviewing} · 需人工判断 ${h.leadWorkflow.rescueManual??0} · 定时重试 ${h.leadWorkflow.rescueRetrying??0} · 重要 ${h.leadWorkflow.important}${leadStalled ? '；重要线索已积压超过 2 小时' : ''}${h.leadWorkflow.lastRun?.ok === false ? '；快速研判最近一次失败' : ''}` : ''}${h.failingSources.length ? `\n失效或连续失败的信源：\n${h.failingSources.map((s: any) => `• ${s.id}：${s.reason ?? s.lastError ?? '超过 12 小时未成功'}`).join('\n')}` : ''}${uncertain.length ? `\n需人工核对的推送：\n${uncertain.map((d: any) => `• ${d.id}（${d.kind} / ${d.status}）：ym delivery-delivered ${d.id} <理由> 或 ym delivery-unsent ${d.id} <理由>`).join('\n')}` : ''}`);
    break;
  }
  case 'delivery-delivered': case 'delivery-unsent': {
    const [id, ...reason] = rest;
    if (!id || !reason.length) { console.error('请提供发送 ID 和人工核对依据'); process.exitCode = 2; break; }
    const outcome = cmd === 'delivery-delivered' ? 'delivered' : 'not_delivered';
    await call(`/notify/${id}/resolve`, { outcome, reason: reason.join(' ') });
    console.log(outcome === 'delivered' ? '已确认送达，通知台账已更新。' : '已确认未送达，可在下一轮重新领取发送。');
    break;
  }
  case 'platform-approve': case 'platform-reject': { await call(`/platforms/${rest[0]}/${cmd.slice(9)}`, {}); console.log(`平台 ${rest[0]} 已${cmd.endsWith('approve') ? '准入' : '拒绝'}`); break; }
  case 'auto-publish': { const r = await call(`/sources/${rest[0]}/auto-publish`, { on: rest[1] !== 'off' }); console.log(`信源 ${rest[0]} 自动上架：${r.autoPublish ? '已放开' : '已关闭'}`); break; }
  default: console.log(HELP);
}
