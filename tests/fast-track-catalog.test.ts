import {expect,it} from 'vitest';
import {fastTrackCatalogBlock,fastTrackCatalogChoices} from '../src/shared/fast-track-membership';
import type {MembershipCatalog} from '../src/shared/membership';
const entry=(id:string,status:'pending'|'verified'|'retired')=>({id,name:id,aliases:[],status,sourceUrl:'https://example.com',verifiedAt:null,revision:1});
const catalog:MembershipCatalog={revision:2,products:[entry('MiniMax','pending'),entry('MiniMax Code','verified'),entry('retired','retired')],plans:[{...entry('Go','verified'),productId:'MiniMax Code',billing:'paid'},{...entry('old','pending'),productId:'MiniMax',billing:'paid'},{...entry('removed','retired'),productId:'MiniMax Code',billing:'paid'}]};
const fields=(id:string,planIds:string[]=[])=>({requirements:['member:'+id],membershipRequirement:{schemaVersion:'membership-v1',status:'confirmed',catalogRevision:1,anyOf:[{allOf:[{productId:id,scope:planIds.length?'plans':'any_paid',planIds,excludePlanIds:[]}]}],evidenceUrls:['https://example.com']}});
it('only supplies verified products and verified child plans to the model',()=>{
 const choices=fastTrackCatalogChoices(catalog);
 expect(choices.products.map(p=>p.id)).toEqual(['MiniMax Code']);expect(choices.plans.map(p=>p.id)).toEqual(['Go']);
});
it('allows a fresh model choice when a specific verified product replaces the old pending directory reference',()=>{
 expect(fastTrackCatalogBlock(fields('MiniMax'),catalog,'MiniMax Code 所有订阅用户免费使用')).toBeNull();
 expect(fastTrackCatalogBlock(fields('MiniMax'),catalog,'MiniMax 订阅用户免费使用')).toMatchObject({catalogRevision:2,entries:[{id:'MiniMax',status:'pending'}]});
});
it('does not hide a selected retired plan behind another verified product',()=>{
 expect(fastTrackCatalogBlock(fields('MiniMax Code',['removed']),catalog,'MiniMax Code 免费使用')).toMatchObject({entries:[{id:'removed',kind:'plan',status:'retired'}]});
});
it('keeps model-invented identifiers in ordinary validation instead of pretending the catalog can verify them',()=>{
 expect(fastTrackCatalogBlock(fields('invented'),catalog,'公开体验')).toBeNull();
});
