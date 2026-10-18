import {openRouterEvidenceGap} from '../shared/official-lead-policy';
import {officialStatusKey} from '../shared/dedupe';
import {officialTier} from '../shared/official-review';
import {IdentityError} from './identity/store';
export async function assertOfficialLeadRejection(db:D1Database,input:{url:string;text:string;reason?:string;reasonCode?:string}){
 if(!openRouterEvidenceGap(input.url,input.reasonCode,input.reason,input.text))return;
 const platform=await db.prepare("SELECT id,name,status,site,x_handles,staff_handles FROM platforms WHERE id='openrouter'").first<{id:string;name:string;status:string;site:string|null;x_handles:string;staff_handles:string}>();
 if(!platform||platform.status!=='approved'||!officialStatusKey(input.url))return;
 const trusted=officialTier(input.url,{id:platform.id,name:platform.name,site:platform.site,xHandles:JSON.parse(platform.x_handles),staffHandles:JSON.parse(platform.staff_handles)},[]);
 if(trusted!=='official'&&trusted!=='staff')return;
 throw new IdentityError(409,'OpenRouter 官方账号线索尚需补读链接中的模型页面或官方模型 API；不能因原帖只有 Try it、未写免费额度或证据不足而拒绝，请保留审核。');
}
