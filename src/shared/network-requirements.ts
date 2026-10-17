/** Mainland-recipient display policy confirmed by the administrator on 2026-10-11.
 * This does not assert new official eligibility or alter identityFacts/evidence.
 * Register the actual product edition here when admitting a new platform.
 */
const domestic = new Set(`aliyun baichuan baidu coze deepseek doubao-work huaweicloud jimeng liblibtv lingxi meituan moark modelscope ppio qiniu qwenwork sensenova stepfun tencent tencent-hy tokenrhythm unisound volc xiaomi-mimo zhipu`.split(' '));
const international = new Set(`adobe-firefly anthropic aws azure browser-use cerebras cline cloudflare cohere copilot cursor deepinfra devin dreamina elevenlabs fireworks free-ai gamma gcloud genspark github gmi google groq hf higgsfield hume ideogram inception kilo kiro krea leonardo lovable lovart luma magnific manus meshy meta midjourney mistral n8n niteshift nous novita nvidia oiioii openai opencode openrouter otter pika pixverse poe pollo runway seaart suno tapnow thinking-machines together tripo vercel windsurf worldlabs xai`.split(' '));
const mixed = new Set(['qoder','workbuddy','hailuo','kling','minimax','moonshot','trae','vidu','siliconflow','feishu']);
export interface NetworkCandidate { platformId?: string; title: string; requirements: string[]; evidence?: { url?: string }; }
export function networkEdition(candidate: NetworkCandidate, url?: string): 'domestic'|'international'|'unknown' {
 const id=candidate.platformId;
 if(!id)return 'unknown';
 if(domestic.has(id))return 'domestic';
 if(international.has(id))return 'international';
 if(!mixed.has(id))return 'unknown';
 const title=candidate.title;let host='';try{host=new URL(candidate.evidence?.url??url??'').hostname;}catch{/* Edition can still be explicit in the title. */}
 if(/国际版|全球版|\b(?:international|global)\b/i.test(title))return 'international';
 if(/国内版|大陆版|\bCN\b/i.test(title))return 'domestic';
 const is=(domain:string)=>host===domain||host.endsWith('.'+domain);
 if(id==='qoder')return is('qoder.com')?'international':is('qoder.cn')||/奶茶/.test(title)?'domestic':'unknown';
 if(id==='workbuddy')return is('workbuddy.ai')?'international':is('workbuddy.cn')||is('weixin.qq.com')?'domestic':'unknown';
 if(id==='hailuo')return is('hailuoai.video')?'international':is('hailuoai.com')?'domestic':'unknown';
 if(id==='kling')return is('kuaishou.com')?'domestic':is('klingai.com')||is('kling.ai')?'international':'unknown';
 if(id==='minimax')return is('minimax.io')?'international':is('minimax.cn')||is('minimaxi.com')?'domestic':'unknown';
 if(id==='moonshot')return is('moonshot.ai')?'international':is('moonshot.cn')||is('kimi.com')?'domestic':'unknown';
 if(id==='trae')return is('trae.cn')?'domestic':is('trae.ai')?'international':'unknown';
 if(id==='vidu')return is('vidu.cn')?'domestic':is('vidu.com')?'international':'unknown';
 if(id==='feishu')return is('larksuite.com')||is('larkoffice.com')?'international':is('feishu.cn')?'domestic':'unknown';
 return is('siliconflow.cn')?'domestic':is('siliconflow.com')?'international':'unknown';
}
export function applyNetworkRequirements<T extends NetworkCandidate>(candidate:T,url?:string):T {
 const edition=networkEdition(candidate,url);
 if(edition==='domestic'||(edition==='unknown'&&!mixed.has(candidate.platformId??'')))return candidate;
 const requirements=candidate.requirements.filter(r=>r!=='none');
 if(edition==='international')requirements.push('net');
 else if(candidate.requirements.includes('none'))requirements.push('unknown');
 return {...candidate,requirements:[...new Set(requirements)]};
}
