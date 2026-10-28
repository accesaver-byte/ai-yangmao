import {sha256} from '../../shared/identity/normalize';
import {officialStatusKey} from '../../shared/dedupe';
import type {SourceFetch} from '../../shared/identity/fetch-evidence';
export async function verifyFetchProvenance(proof:SourceFetch,originalUrl:string,finalUrl:string,text:string):Promise<{valid:boolean;direct:boolean}> {
 if(new URL(proof.originalUrl).href!==new URL(originalUrl).href||new URL(proof.finalUrl).href!==new URL(finalUrl).href||await sha256(text)!==proof.contentHash)return {valid:false,direct:false};
 if(!proof.sourceVerified||proof.truncated)return {valid:true,direct:false};
 // 2026-10-28 管理员授权：阅读器（Jina）读到的同一页面视同直读；是否为已登记官方地址仍由 officialTier 判定，跨页跳转不算。
 if(proof.method==='jina')return {valid:true,direct:new URL(proof.originalUrl).href===new URL(finalUrl).href&&new URL(originalUrl).href===new URL(finalUrl).href};
 const physical=new URL(proof.fetchedUrl),logical=new URL(finalUrl);
 if(proof.method==='first_party_embed'){
  const key=officialStatusKey(originalUrl),finalKey=officialStatusKey(finalUrl),parts=key?.slice('x.com/'.length).split('/status/');
  const author=text.match(/^@([A-Za-z0-9_]+)\r?\n/)?.[1]?.toLowerCase();
  return {valid:true,direct:!!parts&&key===finalKey&&author===parts[0]&&physical.origin==='https://cdn.syndication.twimg.com'&&physical.pathname==='/tweet-result'&&physical.searchParams.get('id')===parts[1]};
 }
 return {valid:true,direct:physical.href===logical.href&&new URL(originalUrl).hostname===logical.hostname};
}
