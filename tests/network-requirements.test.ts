import {describe,it,expect} from 'vitest';
import {applyNetworkRequirements,networkEdition} from '../src/shared/network-requirements';
import {offerIn} from '../src/shared/ingest';
const candidate=(platformId:string,url:string,requirements=['none'],title='免费额度')=>({platformId,title,requirements,evidence:{url}});
describe('administrator network access policy',()=>{
 it('requires overseas network for foreign issuers while preserving other eligibility',()=>{
  expect(applyNetworkRequirements(candidate('openai','https://openai.com',['none','card','student','unknown','member:ChatGPT Plus'])).requirements).toEqual(['card','student','unknown','member:ChatGPT Plus','net']);
 });
 it.each(['workbuddy','volc'])('preserves domestic %s free offers',id=>{
  const url=id==='workbuddy'?'https://www.workbuddy.cn/docs/workbuddy/Pricing':'https://www.volcengine.com/docs/ark/free-inference-quota';
  expect(applyNetworkRequirements(candidate(id,url)).requirements).toEqual(['none']);
 });
 it('separates editions sharing a platform ID and does not infer edition from announcement language',()=>{
  expect(networkEdition(candidate('qoder','https://docs.qoder.cn/events/flashoffer'))).toBe('domestic');
  expect(applyNetworkRequirements(candidate('qoder','https://docs.qoder.com/events/flashoffer')).requirements).toEqual(['net']);
  // 飞书国内版与 Lark 国际版同一平台 ID（2026-10-16）
  expect(networkEdition(candidate('feishu','https://www.feishu.cn/product/feishuai'))).toBe('domestic');
  expect(applyNetworkRequirements(candidate('feishu','https://www.larksuite.com/en_sg/')).requirements).toEqual(['net']);
  expect(networkEdition(candidate('feishu','https://example.com/post'))).toBe('unknown');
  expect(applyNetworkRequirements(candidate('workbuddy','https://x.com/WorkBuddy_AI/status/1',['none'],'WorkBuddy 国际版邀请奖励')).requirements).toEqual(['net']);
  expect(applyNetworkRequirements(candidate('workbuddy','https://x.com/company/status/1')).requirements).toEqual(['unknown']);
 });
 it('does not guess a manufacturer for an unregistered platform',()=>{
  expect(networkEdition(candidate('new-vendor','https://example.com'))).toBe('unknown');
  expect(applyNetworkRequirements(candidate('new-vendor','https://example.com')).requirements).toEqual(['none']);
 });
 it('enforces the same policy when ingesting a direct payload without changing official facts',()=>{
  const payload={id:'openai-new-bonus',platformId:'openai',title:'免费额度',type:'standing',modalities:['text'],claimMethod:'signup',requirements:['none'],valueText:'免费使用',endKind:'standing',sourceTz:'UTC',evidence:{url:'https://openai.com',tier:'site',capturedAt:'2026-10-11',excerpts:{benefit:'Free'}}};
  const parsed=offerIn.parse(payload);expect(parsed.requirements).toEqual(['net']);expect(parsed.evidence).toEqual(payload.evidence);
  expect(applyNetworkRequirements(parsed)).toEqual(parsed);
 });
});
