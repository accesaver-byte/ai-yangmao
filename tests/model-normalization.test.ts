import { describe, expect, it } from 'vitest';
import { offerIn } from '../src/shared/ingest';
import { agentSearchSchema, searchAgentOffers } from '../src/shared/agent-query';
import { displayOffer } from './fixtures/identity/offer';
import { modelMatches, normalizeModelNames } from '../src/shared/model-names';
import { modelSet } from '../src/shared/identity/perk-anchors';

const now = new Date('2026-10-19T12:00:00Z');
const catalog = { revision: 0, products: [], plans: [] };
const offer = (models: string[]) => ({ ...displayOffer(), models, platform:'Vendor', reviewState:'approved',
  discoveredAt:now.toISOString(),lastVerifiedAt:now.toISOString(),verifyResult:'ok',withdrawnAt:null });

describe('model names across intake and search', () => {
  it('uses model identities in same-source rereads without erasing decimal versions', () => {
    expect([...modelSet(['ZhipuAI/GLM-5.3-Flash','GLM 5.3 Flash','glm-5-3-flash'])]).toEqual(['glm5.3flash']);
    expect(modelSet(['GLM-53-Flash','GLM-5.3-Flash']).size).toBe(2);
  });
  it('stores one official name for punctuation, free and official namespace aliases', () => {
    expect(offerIn.parse(offer(['GLM 5.3 Flash','GLM-5.3-Flash Free','glm-5-3-flash','ZhipuAI/GLM-5.3-Flash'])).models)
      .toEqual(['GLM-5.3-Flash']);
  });
  it('removes providers, products, families and routers without deleting the offer', () => {
    const result=offerIn.parse(offer(['OpenAI','Gemini Advanced','Alibaba Cloud','openrouter/free','Qoder 全系模型','GLM-5.3-Flash']));
    expect(result.models).toEqual(['GLM-5.3-Flash']);
    expect(result.id).toBe('vendor-signup');
  });
  it.each(['GLM 5.3 Flash','glm-5-3-flash','ZhipuAI/GLM-5.3-Flash','ＧＬＭ－５．３－Ｆｌａｓｈ'])('finds a model through alias %s', query => {
    const result=searchAgentOffers([offer(['GLM-5.3-Flash'])] as any,catalog,agentSearchSchema.parse({model:query,status:'all'}),now);
    expect(result.total).toBe(1);
  });
  it('uses the same model matching in general search', () => {
    expect(searchAgentOffers([offer(['DeepSeek-V3.2'])] as any,catalog,agentSearchSchema.parse({q:'DeepSeek 3.2',status:'all'}),now).total).toBe(1);
  });
  it('keeps meaningful versions, sizes, modes and tuning namespaces distinct', () => {
    const models=['GLM-5.3-Flash','GLM-5.3-FlashX','Qwen3.8-27B','Qwen3.8-Flash','Claude Opus 4.8','Claude Opus 4.8 (fast mode) (Preview)','Muse Spark 1.3','Muse Spark 1.3 Contributor','Qwen/Qwen-Image-Edit','MusePublic/Qwen-Image-Edit','Command R','Command R+'];
    expect(offerIn.parse(offer(models)).models).toHaveLength(models.length);
  });
  it('does not merge decimal versions, plus variants, snapshots or preview variants in search', () => {
    expect(modelMatches('GLM-53-Flash','GLM-5.3-Flash')).toBe(false);
    expect(modelMatches('Command R+','Command R')).toBe(false);
    expect(modelMatches('MiniMax-M3.1-Flash-Preview','MiniMax M3.1 Flash')).toBe(false);
    expect(modelMatches('DeepSeek-V4-Pro-0813','DeepSeek V4 Pro')).toBe(false);
  });
  it('folds cross-platform IDs without dropping sizes, dates or third-party derivatives', () => {
    expect(normalizeModelNames(['Qwen/Qwen3.8-27B','qwen/qwen3.8-27b','Qwen3.8 27B','Qwen3.8-Flash',
      'nemotron-3.5-super-vl-120b-a12b','Nemotron 3.5 Super VL Free','convaiinnovations/laya','convaiinnovations/laya-free',
      'Seedance2.5','Dreamina Seedance 2.5','Flux.2 Pro','FLUX.2 Pro']))
      .toEqual(['Qwen3.8-27B','Qwen3.8-Flash','Nemotron 3.5 Super VL','Laya','Seedance 2.5','FLUX.2 [pro]']);
  });
  it('recognizes publisher labels from model APIs while retaining unknown publishers', () => {
    expect(normalizeModelNames(['NVIDIA: Nemotron 3.5 Super VL (free)','nvidia/nemotron-3.5-super-vl',
      'Google: Gemma 4 31B (free)','google/gemma-4-31b-it','ThirdParty/Gemma-4-31B-it']))
      .toEqual(['Nemotron 3.5 Super VL','Gemma 4 31B','ThirdParty/Gemma-4-31B-it']);
  });
  it('rejects qualified product and family names just like bare names', () => {
    expect(normalizeModelNames(['OpenAI: Codex','Codex','Google: Gemini','Gemini','openai/Codex'])).toEqual([]);
  });
  it('does not mistake an SFT promotion label for a separate Muse Glimmer checkpoint', () => {
    expect(normalizeModelNames(['Muse Glimmer 30B SFT','muse-glimmer-30b','meta-models/Muse-Glimmer-30B']))
      .toEqual(['Muse Glimmer 30B']);
  });
});
