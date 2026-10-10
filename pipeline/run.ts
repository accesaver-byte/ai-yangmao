import {platformMentioned,leadScopeMismatch} from '../src/shared/lead-scope';
import {runLeadReviews} from './lead-review';
import { toOffer } from './offer-draft';
import { runOfficialReviews } from './official-review';
import { leadPriority } from '../src/shared/leads';
import { officialTier } from '../src/shared/official-review';
// 采集管线入口：GitHub Actions 每 6 小时运行一次，也可以手动触发补跑。
// 流程：取信源 → 抓取 → 只保留和羊毛相关的句子 → 与上次比对 → 有变化才调用模型抽取 → 写入网站（默认进待审）。
import { aihot, feed, hn, parseFeed, reddit, type Source } from './collectors';
import { api, fetchPage, fetchText, isFreebie, norm, relevantText, sha256 } from './lib';
import { DeferError, extract, llmAvailable, modelAvailable, paidAvailable, type Extracted } from './llm';
import { BudgetExhaustedError, BudgetLedgerError, modelBudget } from './budget';
import { offerIn, type LeadIn, type OfferIn } from '../src/shared/ingest';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const DAILY_TOKEN_CAP = Number(process.env.DAILY_TOKEN_CAP ?? 0); // 0 = 调试阶段不设每日 token 总上限
const MONTHLY_COST_CAP = Number(process.env.MONTHLY_COST_CAP_CNY ?? 10);
let costLeft = MONTHLY_COST_CAP;
const DRY = process.env.DRY_RUN === '1';
const FAST = process.env.FAST_LEADS === '1';
const FORCE = process.env.FORCE === '1'; // 忽略上次的哈希，强制重新抽取（提示词改进后补跑）
const LEAD_LIMIT = Number(process.env.LEAD_LIMIT ?? 50);
const onlyList = (process.env.ONLY_SOURCES ?? '').split(',').map(s => s.trim()).filter(Boolean);
const only = onlyList.length ? onlyList : null; // 留空 = 全部信源
const stats = { leadsTriaged: 0, leadOffers: 0, costCny: 0, deferred: 0, sources: 0, ok: 0, failed: 0, changed: 0, leads: 0, offers: 0, pending: 0, extractSkipped: 0, verificationChecked: 0, verificationFailed: 0, verificationDeferred: 0, tokens: 0, coverageDegraded: false, errors: [] as string[] };
let tokensLeft = DAILY_TOKEN_CAP > 0 ? DAILY_TOKEN_CAP : Infinity;
let budgetBlocked = false;
let deadline = Infinity;
const needsWrapUp = () => budgetBlocked || Date.now() >= deadline;
const budgetFailure = (error: unknown) => error instanceof BudgetExhaustedError || error instanceof BudgetLedgerError;

const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function report(src: Source, ok: boolean, extra: { hash?: string; text?: string; error?: string; deferred?: boolean } = {}) {
  if (DRY) return { changed: extra.hash ? extra.hash !== src.lastHash : false };
  return api<{ changed?: boolean }>('/snapshots', { sourceId: src.id, url: src.url, ok, ...extra });
}

async function postLeads(leads: LeadIn[]) {
  if (!leads.length) return;
  if (DRY) { stats.leads += leads.length; leads.slice(0, 5).forEach(l => log('  线索', l.title)); return; }
  for (let i = 0; i < leads.length; i += 100) {
    const r = await api<{ created: number }>('/leads', leads.slice(i, i + 100));
    stats.leads += r.created;
  }
}


/**
 * 官方文本 → 模型抽取 → 写入。返回 false 表示这一轮没处理（不记快照，下次再试）。
 * 付费的 DeepSeek 只在这个信源已经被推迟过至少一次（卡了 12 小时以上）、且本月费用没到上限时才用。
 */
let extractionQueue: Promise<void> = Promise.resolve();
async function extractAndPost(src: Source, url: string, text: string, sourceText?: string): Promise<boolean> {
  const prior = extractionQueue;
  let release!: () => void;
  extractionQueue = new Promise<void>(resolve => { release = resolve; });
  await prior;
  try { return await extractAndPostUnlocked(src, url, text, sourceText); }
  finally { release(); }
}

async function extractAndPostUnlocked(src: Source, url: string, text: string, sourceText?: string): Promise<boolean> {
  if (needsWrapUp()) { stats.deferred++; src.deferThisRun = true; return false; }
  if (!llmAvailable()) { stats.extractSkipped++; log('  没有配置模型 key，跳过抽取'); return false; }
  const estimate = Math.ceil(text.length / 2) + 1500;
  if (estimate > tokensLeft) { stats.extractSkipped++; log(`  今日模型预算不足（剩 ${tokensLeft}），留到下次`); return false; }
  const deferCount = Number((src.config as { deferCount?: number } | undefined)?.deferCount ?? 0);
  const allowPaid = paidAvailable() && deferCount >= 1 && costLeft > 0.05;
  if (!modelAvailable(allowPaid)) { stats.deferred++; src.deferThisRun = true; return false; }
  let r: Awaited<ReturnType<typeof extract>>;
  try {
    const idx = (await offerIndex()).filter(k => k.platformId === src.platformId);
    r = await extract(src.platform?.name ?? src.platformId ?? '', url, text, log, { allowPaid, deadlineAt: deadline, platformIds: [src.platformId], corrections: await correctionsFor(src.platformId, src.id), existing: formatOfferIndex(idx) || undefined, budget: modelBudget });
    // 同一个权益沿用已有 id，避免模型换个说法就生成重复条目
    for (const e of r.offers as (Extracted & { sameAs?: string | null; fixedId?: string })[]) { const hit = idx.find(k => k.id === e.sameAs); if (hit) e.fixedId = hit.id; }
  }
  catch (e) {
    if (!(e instanceof DeferError) && !budgetFailure(e)) throw e;
    if (budgetFailure(e)) budgetBlocked = true;
    stats.deferred++; log(`  ${(e as Error).message}`);
    src.deferThisRun = true; return false;
  }
  tokensLeft -= r.tokens; stats.tokens += r.tokens; costLeft -= r.costCny; stats.costCny += r.costCny;
  if (r.costCny) log(`  动用付费兜底，花费 ¥${r.costCny.toFixed(4)}（本月剩 ¥${costLeft.toFixed(2)}）`);
  log(`  ${r.provider} 抽出 ${r.offers.length} 条，用 ${r.tokens} tokens`);
  if (!r.offers.length) return true;
  // 逐条校验：不合格的只丢这一条，并记下原因
  const offers: OfferIn[] = [];
  const seenInPage = new Map<string, number>();
  let invalidCount = 0;
  for (const e of r.offers) {
    const v = offerIn.safeParse({...toOffer(src, e, url, text), sourceText:sourceText && sourceText.length<=250000 ? sourceText : undefined});
    if (v.success) {
      const candidate = v.data;
      const identity = [candidate.platformId, candidate.type, candidate.claimMethod, norm(candidate.title), norm(candidate.valueText), candidate.claimStart, candidate.claimEnd].join('|');
      const previous = seenInPage.get(identity);
      if (previous == null) { seenInPage.set(identity, offers.length); offers.push(candidate); }
      else offers[previous].modalities = [...new Set([...offers[previous].modalities, ...candidate.modalities])];
    }
    else { invalidCount++; const why = v.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('；'); stats.errors.push(`${src.id}/${e.key}: ${why}`); log(`  丢弃「${e.title}」：${why}`); }
  }
  if (!offers.length) return false; // 原文里有候选但全部校验失败，不能把页面标记为已处理
  if (DRY) { offers.forEach(o => log('  羊毛', o.id, o.title, `类型=${o.type} 对象=${o.audience} 门槛=${o.requirements.join(',')} 额度=${o.valueText}`)); stats.offers += offers.length; return true; }
  const res = await api<{ results: { id: string; error?: string; reviewState?: string; unchanged?: boolean }[] }>('/offers', offers);
  let hasWriteError = false;
  for (const x of res.results) {
    if (x.error) stats.errors.push(`${x.id}: ${x.error}`);
    else if (!x.unchanged) { stats.offers++; if (x.reviewState === 'pending') stats.pending++; }
    if (x.error) hasWriteError = true;
    if (!x.error && !x.unchanged && idxCache) {
      const accepted = offers.find(o => o.id === x.id);
      if (accepted) {
        const entry = indexEntry(accepted);
        const index = idxCache.findIndex(item => item.id === x.id);
        if (index < 0) idxCache.push(entry); else idxCache[index] = entry;
      }
    }
  }
  return !hasWriteError && invalidCount === 0;
}

async function officialPage(src: Source) {
  const { text, via, finalUrl } = await fetchPage(src.url);
  const rel = relevantText(text);
  const hash = sha256(rel);
  if (hash === src.lastHash && !FORCE) { await report(src, true); log(`  无变化（${via}）`); return; }
  stats.changed++;
  log(`  有变化（${via}，相关文本 ${rel.length} 字）`);
  const extractionSource = via === 'jina' ? { ...src, tier: 'media', autoPublish: false } : src;
  const done = rel.length ? await extractAndPost(extractionSource, finalUrl, rel, text) : true;
  if (!done) src.deferThisRun = true;
  if (!DRY) {
    const { offers } = await api<{ offers: { id: string; url: string }[] }>(`/verification-queue?sourceId=${encodeURIComponent(src.id)}&force=1`);
    for (const offer of offers.filter(o => o.url === src.url)) {
      stats.verificationChecked++;
      try {
        const result = await api<{ verified: boolean }>('/verify', { offerId: offer.id, url: offer.url, finalUrl, text, trustedDirect: via !== 'jina', pageHash: sha256(rel), processedChange: done });
        if (!result.verified) { stats.verificationFailed++; stats.errors.push(`${offer.id}: 当前官方证据无法再次确认`); }
      } catch (error) {
        stats.verificationFailed++;
        stats.errors.push(`${offer.id}: 复核失败：${(error as Error).message}`);
      }
    }
  }
  await report(src, true, done ? { hash, text: rel } : { deferred: !!src.deferThisRun });
}

/** 官方 RSS：只处理这次新出现、且标题或摘要命中关键词的文章；逐篇抓正文抽取。 */
async function officialFeed(src: Source) {
  // RSS 里的文章链接可能是相对路径（如 Sakana 的 /sail/），用 RSS 地址补全
  const abs = (link: string) => { try { return new URL(link, src.url).href; } catch { return ''; } };
  const items = parseFeed(await fetchText(src.url, { accept: 'application/rss+xml' })).map(i => ({ ...i, link: abs(i.link) })).filter(i => i.link && isFreebie(`${i.title} ${i.summary}`));
  const links = [...new Set(items.map(i => i.link))].sort();
  const hash = sha256(links.join('\n'));
  if (hash === src.lastHash && !FORCE) { await report(src, true); log('  无新文章'); return; }
  // 强制模式重新建立完成清单；一次超过处理名额的剩余文章由后续常规运行继续。
  const prev = new Set(FORCE ? [] : (src.lastText ?? '').split('\n').filter(Boolean));
  let completedThisRun = 0;
  const failures: string[] = [];
  for (const it of items) {
    if (prev.has(it.link)) continue;
    if (completedThisRun >= 5 || needsWrapUp()) break;
    stats.changed++;
    try {
      const { text, via, finalUrl } = await fetchPage(it.link, { timeoutMs: 10000, tries: 1 });
      const rel = relevantText(text);
      log(`  新文章：${it.title}（相关文本 ${rel.length} 字）`);
      if (!rel.length || await extractAndPost(via === 'jina' ? { ...src, tier: 'media', autoPublish: false } : src, finalUrl, rel, text)) {
        prev.add(it.link); completedThisRun++;
      }
    } catch (error) {
      failures.push(`${it.link}: ${(error as Error).message}`);
      log(`  文章失败，继续后续文章：${failures.at(-1)}`);
    }
  }
  const completed = links.filter(link => prev.has(link)).join('\n');
  if (completed.split('\n').filter(Boolean).length < links.length) src.deferThisRun = true;
  // 即使某篇失败，已经完成的文章也落检查点；完全没有新进展时保留信源连续失败次数。
  const completedHash = sha256(completed);
  if (!failures.length || completedHash !== src.lastHash) await report(src, true, { hash: completedHash, text: completed, deferred: !!src.deferThisRun });
  if (failures.length) throw new Error(`${failures.length} 篇 RSS 文章未处理：${failures.join('；').slice(0, 400)}`);
}

async function runSource(src: Source) {
  stats.sources++;
  log(`[${src.id}] ${src.kind} ${src.url}`);
  try {
    if (src.kind === 'aihot') { await postLeads(await aihot(src)); await report(src, true); }
    else if (src.kind === 'hn') { await postLeads(await hn(src)); await report(src, true); }
    else if (src.kind === 'reddit') { await postLeads(await reddit(src)); await report(src, true); }
    else if (src.kind === 'feed') { await postLeads(await feed(src)); await report(src, true); }
    else if (src.kind === 'rss' && src.platformId) await officialFeed(src);
    else if ((src.kind === 'web_list' || src.kind === 'json') && src.platformId) await officialPage(src);
    else { log('  暂不支持这种信源，跳过'); return; }
    stats.ok++;
  } catch (e) {
    stats.failed++;
    const msg = e instanceof Error ? e.message : String(e);
    stats.errors.push(`${src.id}: ${msg}`);
    log(`  失败：${msg}`);
    await report(src, false, { error: msg.slice(0, 500) }).catch(() => undefined);
  }
}

async function verifyExistingOffers(sources: Source[]) {
  const { offers } = await api<{ offers: { id: string; url: string; tier: string; pageHash: string | null; proposalHash: string | null; sourceId: string | null; platformId: string }[] }>('/verification-queue');
  for (const offer of offers) {
    if (needsWrapUp()) { stats.verificationDeferred += offers.length - offers.indexOf(offer); break; }
    stats.verificationChecked++;
    try {
      const { text, via, finalUrl } = await fetchPage(offer.url);
      const relevant = relevantText(text), currentHash = sha256(relevant);
      let processedChange = offer.pageHash === currentHash || offer.proposalHash === currentHash;
      if (!processedChange && relevant) {
        const source = sources.find(s => s.id === offer.sourceId) ?? {
          id: '', kind: 'manual', url: offer.url, tier: offer.tier, platformId: offer.platformId, lastHash: null,
          platform: { id: offer.platformId, name: offer.platformId, status: 'approved' }, autoPublish: false,
        } as Source;
        processedChange = await extractAndPost(via === 'jina' ? { ...source, tier: 'media', autoPublish: false } : source, finalUrl, relevant, text);
      }
      const result = DRY ? { verified: false } : await api<{ verified: boolean }>('/verify', { offerId: offer.id, url: offer.url, finalUrl, text, trustedDirect: via !== 'jina', pageHash: currentHash, processedChange });
      if (!result.verified && !DRY) { stats.verificationFailed++; stats.errors.push(`${offer.id}: 当前官方证据无法再次确认`); }
    } catch (e) {
      stats.verificationFailed++;
      stats.errors.push(`${offer.id}: 复核失败：${(e as Error).message}`);
    }
  }
}

interface IndexedOffer { id: string; platformId: string; title: string; valueText: string; claimStart?: string | null; publishedAt?: string | null; tags?: string[]; evidenceUrl?: string }
const indexEntry = (offer: OfferIn): IndexedOffer => ({ id: offer.id, platformId: offer.platformId, title: offer.title, valueText: offer.valueText,
  claimStart: offer.claimStart, publishedAt: offer.publishedAt, tags: offer.tags, evidenceUrl: offer.evidence.url });
const formatOfferIndex = (offers: IndexedOffer[]) => offers.map(offer => `${offer.id}｜${offer.title}｜${offer.valueText.slice(0, 40)}｜开始:${offer.claimStart ?? '未知'}${offer.tags?.includes('reset') ? `｜发布:${offer.publishedAt ?? '未知'}｜证据:${offer.evidenceUrl ?? '未知'}` : ''}`).join('\n');
let idxCache: IndexedOffer[] | null = null;
async function offerIndex() {
  if (!idxCache) { try { idxCache = (await api<{ offers: IndexedOffer[] }>('/offers-index')).offers; } catch { idxCache = []; } }
  return idxCache;
}

/* ---------- 第一层反馈：抽取时附上管理员最近的纠正 ---------- */
const corrCache = new Map<string, string[]>();
async function correctionsFor(platform: string | null, source: string | null): Promise<string[]> {
  const key = `${platform ?? ''}|${source ?? ''}`;
  if (!corrCache.has(key)) {
    try { corrCache.set(key, (await api<{ corrections: string[] }>(`/corrections?limit=10&platform=${encodeURIComponent(platform ?? '')}&source=${encodeURIComponent(source ?? '')}`)).corrections); }
    catch { corrCache.set(key, []); }
  }
  return corrCache.get(key)!;
}

/* ---------- 线索研判：把线索变成待审羊毛 ---------- */
interface Plat { id: string; name: string; site: string | null; xHandles: string[]; staffHandles: string[] }
interface Lead { id: number; origin: string; url: string; title: string | null; raw: string | null; createdAt?: string }
const host = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
/** 证据级别：平台官网域名 → site；白名单里的官方 X 账号 → official；员工账号 → staff；其余（媒体、社区、公众号转载）→ media。 */
function tierOf(url: string, p: Plat | undefined): OfferIn['evidence']['tier'] {
  return p ? officialTier(url,p,[])??'media':'media';
}
async function triageLeads(plats: Plat[]) {
  if (!llmAvailable()) { stats.deferred++; stats.errors.push('线索研判：没有可用模型'); return; }
  const { leads } = await api<{ leads: Lead[] }>(`/leads?limit=${LEAD_LIMIT}`);
  if (!leads.length) return;
  const list = plats.map(p => `${p.id}=${p.name}`).join('；');
  // 线索原文提到了哪些白名单平台（按名称里的各个部分或 id 匹配），就附上这些平台的抽取要点
  const mentionedPlatforms = (text: string) => {
    const t = text.toLowerCase();
    return plats.filter(p => platformMentioned(t,p)).map(p => p.id).slice(0, 6);
  };
  const { offers: known } = await api<{ offers: IndexedOffer[] }>('/offers-index');
  const knownIds = new Set(known.map(k => k.id));
  let existing = formatOfferIndex(known);
  const pmap = new Map(plats.map(p => [p.id, p]));
  log(`研判线索 ${leads.length} 条`);
  // 每轮给官方补证保留执行时间，初抽不能独占整个40分钟工作窗口。
  const triageDeadline=Math.min(deadline-10*60_000,Date.now()+15*60_000);
  for (const l of leads) {
    if (needsWrapUp() || Date.now()>=triageDeadline || tokensLeft < 8000) { stats.deferred++; log('  预算不足或初抽时间已用完，剩余线索留到下次，继续官方补证'); break; }
    const aged = !!l.createdAt && Date.now() - Date.parse(l.createdAt) >= 2 * 3600_000;
    const allowPaid = paidAvailable() && costLeft > 0.05 && (aged || leadPriority(l) <= 1);
    if (!modelAvailable(allowPaid)) { stats.deferred++; continue; }
    stats.leadsTriaged++;
    let evidenceText = l.raw ?? '';
    let text = `线索标题（转述，仅用于定位）：${l.title ?? ''}\n${evidenceText}`;
    let fetched = false;
    let effectiveUrl = l.url, indirect = false;
    try {
      const pg = await fetchPage(l.url, { timeoutMs: 10000, tries: 1 });
      evidenceText = pg.text.slice(0, 14000);
      text = `线索标题（转述，仅用于定位）：${l.title ?? ''}\n${evidenceText}`;
      effectiveUrl = pg.finalUrl; indirect = pg.via === 'jina'; fetched = true;
    }
    catch { /* 补录失败也研判已有备注为媒体级草稿；不能让失效链接永远占据 new 队首。 */ }
    let r;
    try { r = await extract('（见平台白名单）', l.url, text, log, { allowPaid, evidenceText, deadlineAt: triageDeadline, platformList: list, platformIds: mentionedPlatforms(`${l.title ?? ''}\n${text}`), existing, corrections: await correctionsFor(null, null), budget: modelBudget }); }
    catch (e) {
      log(`  #${l.id} 抽取失败：${(e as Error).message.slice(0, 80)}`);
      if (budgetFailure(e)) { budgetBlocked = true; stats.deferred++; break; }
      if (!(e instanceof DeferError)) {
        stats.errors.push(`线索 #${l.id} 抽取失败：${(e as Error).message.slice(0, 160)}`);
        if (!DRY) await api(`/leads/${l.id}/status`, { status: 'reviewing', note: `抽取失败，需人工确认后重试：${(e as Error).message.slice(0, 160)}` });
      } else stats.deferred++;
      continue;
    }
    tokensLeft -= r.tokens; stats.tokens += r.tokens; costLeft -= r.costCny; stats.costCny += r.costCny;
    const valid: OfferIn[] = [];
    let invalidCount = 0;
    const unknown: string[] = [];
    const findPlat = (x: string | undefined) => {
      if (!x) return undefined;
      const k = x.trim().toLowerCase();
      return pmap.get(k) ?? plats.find(p => p.name.toLowerCase() === k); // 只认完全一致，宁可判白名单外也不归错平台
    };
    for (const e of r.offers) {
      const p = findPlat(e.platformId);
      if (!p) { unknown.push(e.title); continue; }
      const tier = !fetched || indirect ? 'media' : tierOf(effectiveUrl, p);
      const o = toOffer({ id: `lead-${l.origin}`, kind: l.origin, platformId: p.id, tier } as unknown as Source, e, effectiveUrl, relevantText(evidenceText));
      o.sourceText = !indirect && fetched && evidenceText.length<=250000 ? evidenceText : undefined;
      o.evidence.tier = tier; o.leadId = l.id; o.sourceId = undefined; o.firstChannel = l.origin;
      // 同一个活动：沿用已有条目的 id（写入接口会按修订处理，不会新开一条）
      if (e.sameAs && knownIds.has(e.sameAs)) {
        const prev = known.find(k => k.id === e.sameAs)!;
        if (prev.platformId === p.id) { o.id = prev.id; o.sameOccurrenceAs=prev.id; log(`  #${l.id} 与已有条目 ${prev.id} 是同一活动，合并`); }
      }
      if (e.officialUrl && tier === 'media') o.steps = [...(o.steps ?? []), `官方出处：${e.officialUrl}`].slice(0, 6);
      const scopeError=p&&leadScopeMismatch(l,{...p,staffHandles:[]},[],o);
      if(scopeError){invalidCount++;log(`  #${l.id} ${scopeError}`);continue;}
      const v = offerIn.safeParse(o);
      if (v.success) valid.push(v.data); else { invalidCount++; log(`  #${l.id} 字段不合规「${e.title}」：${v.error.issues.map(i => i.path.join('.') + ' ' + i.message).join('；').slice(0, 120)}`); }
    }
    if (DRY) { log(`  #${l.id} ${l.title?.slice(0, 40)} → ${valid.map(v => `${v.platformId}:${v.title}`).join('、') || '无'}${unknown.length ? `；白名单外：${unknown.join('、')}` : ''}`); continue; }
    if (valid.length) {
      let res;
      try { res = await api<{ results: { id: string; error?: string; skipped?: string; duplicateId?: string; unchanged?: boolean }[] }>('/offers', valid); }
      catch (e) {
        stats.errors.push(`线索 #${l.id} 入库失败`);
        await api(`/leads/${l.id}/status`, { status: 'reviewing', note: `入库失败，需人工处理：${(e as Error).message.slice(0,350)}` });
        continue;
      }
      stats.leadOffers += res.results.filter(x => !x.error && !('skipped' in x) && !x.unchanged).length;
      for (const saved of res.results.filter(x => !x.error && !('skipped' in x))) {
        const record = valid.find(v => v.id === saved.id);
        if (!record) continue;
        const entry = indexEntry(record);
        const index = known.findIndex(k => k.id === saved.id);
        if (index < 0) known.push(entry); else known[index] = entry;
        knownIds.add(saved.id);
        if (idxCache) {
          const cached = idxCache.findIndex(k => k.id === saved.id);
          if (cached < 0) idxCache.push(entry); else idxCache[cached] = entry;
        }
      }
      existing = formatOfferIndex(known);
      log(`  #${l.id} → ${valid.map(v => v.title).join('、')}`);
      // A known duplicate is a resolved candidate, not a failed write. Keep unknown skips/errors retryable.
      const saved = res.results.flatMap(x => {
        if (x.error) return [];
        if (x.duplicateId) return [{ ...x, id: x.duplicateId }];
        return 'skipped' in x ? [] : [x];
      });
      if (!saved.length || saved.length < valid.length || invalidCount || unknown.length) {
        await api(`/leads/${l.id}/status`, { status: 'reviewing', note: '部分或全部条目未成功入库，需人工处理：' + res.results.map(x => x.error ?? ('skipped' in x ? String(x.skipped) : x.id)).join('；').slice(0, 350) });
      } else {
        await api(`/leads/${l.id}/status`, { status: 'linked', offerId: saved[0].id });
      }
    } else {
      await api(`/leads/${l.id}/status`, { status: invalidCount || unknown.length || !fetched || leadPriority(l) <= 1 ? 'reviewing' : 'rejected', note: invalidCount ? '抽取字段不合规，保留线索等待人工补齐' : unknown.length ? `白名单外的平台：${unknown.join('、')}` : !fetched ? '原文抓取失败，仅有转述，等待人工核验' : leadPriority(l) <= 1 ? '重要福利线索未抽取出条目，等待人工核验，不能仅因模型漏抽拒绝' : '模型判断不是 AI 羊毛' });
    }
  }
}

export async function runPipeline() {
  const startedAt = new Date().toISOString();
  // Actions 总限时 45 分钟，保留 5 分钟给在途请求和持久化运行结果。
  deadline = Date.now() + 40 * 60_000;
  if (!DRY) {
    const b = await api<{ tokensToday: number; costMonthCny: number }>('/budget');
    tokensLeft = DAILY_TOKEN_CAP > 0 ? Math.max(0, DAILY_TOKEN_CAP - b.tokensToday) : Infinity;
    costLeft = Math.max(0, MONTHLY_COST_CAP - b.costMonthCny);
  }
  const { sources } = await api<{ sources: Source[] }>('/sources');
  // config.relay 表示由别的机器负责（例如 Reddit 由常开 Mac 中继），云端跳过
  const list = sources.filter(s => (!only || only.includes(s.id)) && !(s.config as { relay?: string } | undefined)?.relay);
  log(`共 ${list.length} 个信源；今日 token ${Number.isFinite(tokensLeft) ? `剩 ${tokensLeft}` : '不设总上限'}，本月付费兜底剩 ¥${costLeft.toFixed(2)}${DRY ? '；演练模式，不写入权益' : ''}`);
  // 先采集线索，再研判；全站官方页面抽取与复核不能抢走重要线索的模型预算。
  const leadSources = list.filter(s => s.kind === 'aihot' || s.tier === 'lead');
  const selected = FAST ? leadSources.filter(s => s.kind === 'aihot' || s.kind === 'feed') : leadSources;
  for (const source of selected) {
    if (needsWrapUp()) { stats.deferred++; break; }
    await runSource(source);
  }
  try {
    const { platforms } = await fetch(`${(process.env.API_BASE ?? 'https://ai-yangmao.com').replace(/\/$/, '')}/api/platforms`, { signal: AbortSignal.timeout(30000) }).then(r => r.json()) as { platforms: Plat[] };
    await triageLeads(platforms);
  } catch (e) { stats.errors.push(`线索研判：${(e as Error).message}`); stats.deferred++; log('线索研判出错', (e as Error).message); }
  try {
    const leadReview=await runLeadReviews({limit:Number(process.env.LEAD_REVIEW_LIMIT??4),ids:(process.env.LEAD_REVIEW_IDS??'').split(',').filter(Boolean).map(Number),deadlineAt:Math.min(deadline,Date.now()+12*60_000),dry:DRY,
      allowPaid:paidAvailable()&&costLeft>0.05,canContinue:()=>!needsWrapUp()&&tokensLeft>=8000,
      account:(tokens,cost)=>{tokensLeft-=tokens;costLeft-=cost;stats.tokens+=tokens;stats.costCny+=cost;},log});
    Object.assign(stats,{leadReview});if(leadReview.retry||leadReview.deferred)stats.deferred++;
  }catch(e){stats.deferred++;stats.errors.push('受阻线索复核：'+(e as Error).message);}
  try {
  const officialReview = await runOfficialReviews({limit:Number(process.env.OFFICIAL_REVIEW_LIMIT ?? 8),deadlineAt:deadline,dry:DRY,
    allowPaid:paidAvailable()&&costLeft>0.05,canContinue:()=>!needsWrapUp()&&tokensLeft>=8000,
    account:(tokens,cost)=>{tokensLeft-=tokens;costLeft-=cost;stats.tokens+=tokens;stats.costCny+=cost;},log});
  Object.assign(stats,{officialReview});
  if(officialReview.failed||officialReview.deferred)stats.deferred++;
  } catch(error) { stats.deferred++; stats.errors.push(`官方复核：${(error as Error).message}`); }
  if (!FAST) {
    const queue = list.filter(s => !leadSources.includes(s));
    await Promise.all(Array.from({ length: 4 }, async () => {
      while (queue.length && !needsWrapUp()) await runSource(queue.shift()!);
    }));
    stats.deferred += queue.length;
    try { await verifyExistingOffers(sources); }
    catch (error) {
      stats.verificationFailed++;
      stats.errors.push(`读取复核队列失败：${(error as Error).message}`);
    }
  }
  stats.coverageDegraded = stats.deferred > 0 || stats.extractSkipped > 0 || stats.failed > 0 || stats.verificationFailed > 0
    || stats.verificationDeferred > 0 || stats.errors.length > 0 || list.some(source => source.deferThisRun);
  const ok = (FAST || !only) && stats.sources > 0 && stats.ok === stats.sources && !stats.coverageDegraded;
  log('完成', JSON.stringify(stats));
  // 模型调用逐次在 runs(kind=model) 预留并结算；汇总行不能再次计费。
  if (!DRY) await api('/runs', { kind: FAST ? 'sweep' : 'collect', startedAt, finishedAt: new Date().toISOString(), ok, stats, tokens: 0, costCny: 0 });
  return { ok, stats };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runPipeline().then(({ ok }) => { if (!ok && !only) process.exitCode = 1; })
    .catch(e => { console.error(e); process.exitCode = 1; });
}
