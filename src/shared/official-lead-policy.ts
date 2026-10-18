import {officialStatusKey} from './dedupe';
/** Missing words on a launch post are a verification task, not a negative fact about the linked product. */
export function openRouterEvidenceGap(url:string,reasonCode:string|undefined,reason:string|undefined,text:string):boolean{
 if(!officialStatusKey(url)?.startsWith('x.com/openrouter/status/'))return false;
 if(['insufficient_evidence','vague','expired'].includes(reasonCode??''))return true;
 const missing=/(?:没有|未(?:有|见|写|给|提供|列|公布|明确)|不含|未能|缺少|缺乏).{0,25}(?:免费|额度|金额|证据|赠额|赠金|数量|调用)|(?:只有|仅(?:有|说|提供|附|发布)?).{0,40}(?:try\s*it|试用链接|尝鲜链接|上线|发布)|\b(?:no|missing|without|not stated|does not (?:state|mention|provide))\b.{0,35}(?:free|credits?|quota|amount|evidence)|only.{0,30}(?:try it|link|launch)/i.test(reason??'');
 if(missing||/模型判断(?:不是|非)|未抽取(?:出)?|模型(?:没有|未)输出|no (?:offers?|benefits?) (?:extracted|found)|model (?:judged|returned)/i.test(reason??''))return true;
 const lines=text.split('\n');if(/^@[A-Za-z0-9_]+$/.test(lines[0]?.trim()??''))lines.shift();if(/^\d{4}-\d{2}-\d{2}T/.test(lines[0]?.trim()??''))lines.shift();const body=lines.join('\n').trim();
 const navigationOnly=/^(?:try (?:it|now)|check (?:it )?out|learn more|details|试用|试试|了解更多)\s*:?\s*https?:\/\/\S+\s*$/i.test(body);
 return navigationOnly&&reasonCode!=='duplicate';
}
