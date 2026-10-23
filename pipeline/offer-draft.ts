import {fillCampaignDeadline} from '../src/shared/campaign-deadline';
import {fetchedSource} from './fetch-evidence';
import type {FetchedPage} from './lib';
import { canonicalTermsSchema } from '../src/shared/identity/types';
import type { Source } from './collectors';
import type { Extracted } from './llm';
import type { OfferIn } from '../src/shared/ingest';
import { sha256, slug } from './lib';

const clip = (v: string, n: number) => (v && v.length > n ? v.slice(0, n - 1) + '…' : v);

export function toOffer(src: Source, e: Extracted & { fixedId?: string; sameAs?:string|null }, url: string, text: string, page?:FetchedPage): OfferIn {
  const facts=canonicalTermsSchema.safeParse(e.identityFacts);
  // Keep whole authenticated pages; omitting an oversized price page leaves the recipe unresolved.
  let priceBytes=0;
  const valuationSources=(e.valuationSources??[]).filter(source=>{const size=JSON.stringify(source).length;if(priceBytes+size>340000)return false;priceBytes+=size;return true;});
  return fillCampaignDeadline({
    ...fetchedSource(page),
    ...(facts.success?{identityFacts:facts.data}:{}),
    id: e.fixedId ?? `${src.platformId}-${slug(e.key)}`.slice(0, 80), platformId: src.platformId!, sourceId: src.id || undefined,
    ...(e.sameAs && e.sameAs===e.fixedId?{sameOccurrenceAs:e.sameAs}:{}),
    title: clip(e.title, 120), type: e.type, modalities: e.modalities as OfferIn['modalities'], models: e.models ?? [], tags: (e.tags ?? []) as OfferIn['tags'], publishedAt: e.publishedAt ?? null, claimMethod: e.claimMethod as OfferIn['claimMethod'],
    // 超过长度上限的字段截短保留，不再让整条羊毛因校验失败被丢弃（2026-10-01 批量抓取时 AWS、硅基流动两条因额度描述超长被丢）
    requirements: e.requirements?.length ? e.requirements : ['unknown'], audience: e.audience ?? 'unclear', valueText: clip(e.valueText, 200),
    // Final amounts never come from model output. Private factors are recomputed at intake.
    ...(valuationSources.length?{valuationSources}:{}),
    ...(e.valuationFactors?{valuationFactors:e.valuationFactors}:{}),
    usdEstimate: null, usdMax: null, claimStart: e.claimStart ?? null, claimEnd: e.claimEnd ?? null,
    // 模型说有截止日期却给不出具体日期（如“免费 7 天”但没写从哪天起）：按截止未知保留，交给人工审核，而不是整条丢弃
    endKind: e.endKind === 'date' && !e.claimEnd ? 'unknown' : e.endKind,
    creditValidity: e.creditValidity ? clip(e.creditValidity, 100) : null, sourceTz: e.sourceTz || 'UTC', steps: (e.steps ?? []).slice(0, 4).map(x => clip(x, 200)), firstChannel: src.kind,
    evidence: { url, tier: (src.tier === 'lead' ? 'site' : src.tier) as OfferIn['evidence']['tier'], capturedAt: new Date().toISOString(), pageHash: sha256(text), excerpts: e.excerpts,
      ...(e.notYetLive ? { upcoming: { announcedAt: e.publishedAt ?? new Date().toISOString(), ...(e.liveBy ? { by: e.liveBy } : {}) } } : {}) },
  });
}
