import { MODEL_NAME_GROUPS, NON_MODEL_NAMES } from './model-catalog-data';

export const MODEL_NAMES_VERSION = 'models-v1-2026-10-19';
const text = (s: string) => s.normalize('NFKC').replace(/[‐‑‒–—−]/g, '-').replace(/\s+/gu, ' ').trim();
// Decimal points, plus signs, slashes and qualifier text distinguish real versions/variants.
const key = (s: string) => text(s).toLowerCase().replace(/(\d)[\s_-]+(?=\d)/g, '$1~').replace(/[\s_\-()[\]{}]/g, '');
const withoutFree = (s: string) => text(s).replace(/(?:[\s:-]+free|\s*\(free\))$/i, '').trim();
const aliases = new Map<string, string>();
const names = new Map<string, readonly string[]>();
for (const [canonical, ...variants] of MODEL_NAME_GROUPS) {
  names.set(canonical, [canonical, ...variants]);
  for (const alias of [canonical, ...variants]) {
    const k = key(withoutFree(alias)), previous = aliases.get(k);
    if (previous && previous !== canonical) throw new Error(`Conflicting model alias: ${alias}`);
    aliases.set(k, canonical);
  }
}
const excluded = new Set(NON_MODEL_NAMES.map(key));
// Strip only official publisher namespaces; third-party derivatives retain their identity.
const officialOwner = /^(?:deepseek-ai|zhipuai|z-ai|zai-org|qwen|minimax|mistralai|nex-agi|opencompass|opengvlab|paddlepaddle|shanghai_ai_laboratory|stepfun-ai|xgenerationlab|meta-llama|meta-models|openai|meituan-longcat|canopylabs|convaiinnovations|nvidia|google|cohere|poolside|liquid|thinkingmachines|xingchen-agi|dots-studio|black-forest-labs)\//i;
const publisherLabel = /^(?:nvidia|google|openai|anthropic|qwen|deepseek|z\.ai|minimax|cohere|poolside|liquidai|thinking machines|xingchen|dots studio|black forest labs):\s*/i;
const unqualified = (s:string) => s.replace(publisherLabel,'').replace(officialOwner,'');

/** A display label, never a claim that a model is free or that a dynamic API alias is a fixed checkpoint. */
export function canonicalModelName(input: string): string | null {
  const cleaned = withoutFree(input);
  if (!cleaned || excluded.has(key(cleaned)) || /(?:全系|全部|所有|\d+\+).*(?:模型|models)|^(?:all|free) models$/i.test(cleaned)) return null;
  const direct = aliases.get(key(cleaned));
  if (direct) return direct;
  const bare = unqualified(cleaned);
  if (excluded.has(key(bare))) return null;
  return aliases.get(key(bare)) ?? cleaned;
}

export function modelIdentityKey(input: string): string {
  const name = canonicalModelName(input);
  return name ? key(name) : '';
}

export function normalizeModelNames(input: readonly string[] = []): string[] {
  const result = new Map<string, string>();
  for (const value of input) {
    const name = canonicalModelName(value);
    if (name && !result.has(key(name))) result.set(key(name), name);
  }
  return [...result.values()];
}

/** Full known aliases select one model; partial family queries search all its labels. */
export function modelMatches(name: string, query: string): boolean {
  const canonical = canonicalModelName(name);
  if (!canonical) return false;
  const q = withoutFree(query), known = aliases.get(key(q)) ?? aliases.get(key(unqualified(q)));
  if (known) return canonical === known;
  const searchKey = key(q);
  return !!searchKey && (names.get(canonical) ?? [canonical]).some(alias => key(withoutFree(alias)).includes(searchKey));
}
