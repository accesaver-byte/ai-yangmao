import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import worker from '../src/worker/index';
import type { Env } from '../src/worker/index';
import { identityDb } from './fixtures/identity/db';
import {quotaCircuitOpen} from '../src/worker/quota-circuit';
const fixtures:ReturnType<typeof identityDb>[]=[];
afterEach(()=>{fixtures.splice(0).forEach(f=>f.sqlite.close());vi.unstubAllGlobals();quotaCircuitOpen(Date.now()+2*86400_000);});
function fixture(){
  const f=identityDb();fixtures.push(f);
  const evidence=JSON.stringify({url:'https://vendor.example',tier:'site',excerpts:{benefit:'Free credits',eligibility:'Everyone',validity:'Every month'}});
  f.sqlite.prepare(`INSERT INTO offers(id,platform_id,title,type,modalities,claim_method,requirements,audience,value_text,end_kind,last_verified_at,evidence,steps,review_state,review_memo)
    VALUES('public','vendor','免费权益','standing','["text"]','signup','["none"]','all','每月免费','standing',?,?,'[]','approved','PRIVATE')`).run(new Date().toISOString(),evidence);
  const env={DB:f.db,INGEST_TOKEN:'fixture',ADMIN_TOKEN:'fixture'} as Env;
  const fetcher=async(input:RequestInfo|URL,init?:RequestInit)=>worker.fetch(new Request(input,init),env);
  return {f,env,fetcher};
}
describe('public agent HTTP and MCP',()=>{
  it('shares canonical model labels between public list, detail, catalog and alias search',async()=>{
    const {f,fetcher}=fixture();
    f.sqlite.prepare('UPDATE offers SET models=? WHERE id=?').run(JSON.stringify(['GLM 5.3 Flash','glm-5-3-flash','OpenAI']),'public');
    const list=await (await fetcher('https://ai-yangmao.com/api/offers?view=all')).json() as any;
    expect(list.offers[0].models).toEqual(['GLM-5.3-Flash']);
    const detail=await (await fetcher('https://ai-yangmao.com/api/agent/offers/public')).json() as any;
    expect(detail.offer.models).toEqual(['GLM-5.3-Flash']);
    const catalog=await (await fetcher('https://ai-yangmao.com/api/agent/catalog')).json() as any;
    expect(catalog.models).toEqual(['GLM-5.3-Flash']);
    const matches=await (await fetcher('https://ai-yangmao.com/api/agent/search?model=GLM-5.3-Flash')).json() as any;
    expect(matches.total).toBe(1);
  });
  it('uses current collection failures rather than an older successful run',async()=>{
    const {f,fetcher}=fixture();
    f.sqlite.prepare("INSERT INTO runs(kind,started_at,finished_at,ok,stats) VALUES('collect','2026-10-10','2026-10-10',1,'{}'),('sweep','2026-10-11','2026-10-11',0,'{\"fetchedSources\":2,\"coverageDegraded\":true}')").run();
    const response=await fetcher('https://ai-yangmao.com/api/agent/search');
    const body=await response.json();expect(body.coverageDegraded).toBe(true);expect(body.lastCollectionAttemptAt).toBe('2026-10-11');
  });
  it('does not return a withdrawn public item from a previous generation cache',async()=>{
    const {f,env}=fixture(); const cached=new Map<string,Response>(),pending:Promise<unknown>[]=[];
    vi.stubGlobal('caches',{default:{match:async(r:Request)=>cached.get(r.url)?.clone(),put:async(r:Request,res:Response)=>{cached.set(r.url,res.clone());}}});
    const get=()=>worker.fetch(new Request('https://ai-yangmao.com/api/agent/search'),env,{waitUntil:p=>pending.push(p)} as any);
    expect((await (await get()).json() as any).total).toBe(1);await Promise.all(pending);
    f.sqlite.exec("UPDATE offers SET review_state='rejected' WHERE id='public'; UPDATE identity_public_state SET generation=generation+1 WHERE id=1");
    expect((await (await get()).json() as any).total).toBe(0);
  });
  it('works when the optional edge cache fails',async()=>{
    const {fetcher}=fixture();vi.stubGlobal('caches',{default:{match:async()=>{throw Error('cache unavailable');},put:async()=>{throw Error('cache unavailable');}}});
    expect((await fetcher('https://ai-yangmao.com/api/agent/search')).status).toBe(200);
  });
  it('shares one cold read across concurrent requests',async()=>{
    const {f,fetcher}=fixture();let reads=0;f.inject(()=>{reads++;});
    const responses=await Promise.all(Array.from({length:20},()=>fetcher('https://ai-yangmao.com/api/agent/search')));
    expect(responses.every(r=>r.status===200)).toBe(true);expect(reads).toBeLessThan(20);
  });
  it('shares cold reads under the production identity query budget wrapper',async()=>{
    const {f,env}=fixture();let reads=0;f.inject(()=>{reads++;});
    const responses=await Promise.all(Array.from({length:20},()=>worker.fetch(new Request('https://ai-yangmao.com/api/agent/search'),{...env,IDENTITY_MODE:'enforce'})));
    expect(responses.every(r=>r.status===200)).toBe(true);expect(reads).toBeLessThan(20);
  });
  it('bounds verbose search pages and paginates all matches without duplicate full records',async()=>{
    const {f,fetcher}=fixture();
    const insert=f.sqlite.prepare(`INSERT INTO offers(id,platform_id,title,type,modalities,claim_method,requirements,audience,value_text,end_kind,last_verified_at,evidence,steps,review_state)
      VALUES(?,'vendor','Long benefit','standing','["text"]','signup','["none"]','all',?,'standing',?,?,'[]','approved')`);
    for(let i=0;i<50;i++)insert.run('long-'+i,'权益'.repeat(900),new Date().toISOString(),JSON.stringify({url:'https://vendor.example/'+('a'.repeat(1600)),tier:'site',excerpts:{benefit:'Full quote '.repeat(350),eligibility:'Official '.repeat(400),validity:'Every month'}}));
    const ids=new Set<string>();let offset:number|null=0;
    while(offset!==null){
      const response=await fetcher(`https://ai-yangmao.com/api/agent/search?limit=50&offset=${offset}`);const text=await response.text();
      expect(Buffer.byteLength(text)).toBeLessThan(64*1024);const result=JSON.parse(text);
      result.offers.forEach((o:any)=>{expect(ids.has(o.id)).toBe(false);ids.add(o.id);expect(o.detailUrl).toContain('/api/agent/offers/');});
      expect(result.groups.eligible.every((id:unknown)=>typeof id==='string')).toBe(true);
      expect(result.nextOffset===null||result.nextOffset>offset).toBe(true);offset=result.nextOffset;
    }
    expect(ids.size).toBe(51);
  });
  it('serves anonymous filtered results and source-language evidence without private fields',async()=>{
    const {fetcher,f}=fixture();
    const before=f.sqlite.prepare('SELECT count(*) n FROM deliveries').get();
    const response=await fetcher('https://ai-yangmao.com/api/agent/search?requirement=zero&format=json');
    expect(response.status).toBe(200);const data=await response.json();
    expect(data.offers[0].id).toBe('public');
    const detail=await (await fetcher(data.offers[0].detailUrl)).json();expect(detail.offer.evidence.excerpts.benefit).toBe('Free credits');
    expect(JSON.stringify(data)).not.toMatch(/PRIVATE|reviewMemo|officialReview|reviewVersion|ADMIN_TOKEN/);
    expect(f.sqlite.prepare('SELECT count(*) n FROM deliveries').get()).toEqual(before);
  });
  it('supports profile POST as a pure read and rejects writes/history/unknown parameters',async()=>{
    const {fetcher,f}=fixture();
    expect((await fetcher('https://ai-yangmao.com/api/agent/search',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({profile:{card:false}})})).status).toBe(200);
    expect((await fetcher('https://ai-yangmao.com/api/agent/search?admin=true')).status).toBe(400);
    expect((await fetcher('https://ai-yangmao.com/api/agent/daily?date=2020-01-01')).status).toBe(400);
    expect((await fetcher('https://ai-yangmao.com/api/agent/daily',{method:'POST'})).status).toBe(405);
    f.sqlite.exec("UPDATE offers SET requirements='[\"student\"]' WHERE id='public'");
    const detail=await fetcher('https://ai-yangmao.com/api/agent/offers/public',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({profile:{student:true}})});
    expect(detail.status).toBe(200);expect((await detail.json() as any).offer.eligibility.status).toBe('eligible');
  });
  it('works end to end with the official SDK client and exposes only read tools',async()=>{
    const {fetcher,f}=fixture(); const client=new Client({name:'test-agent',version:'1.0'});
    const transport=new StreamableHTTPClientTransport(new URL('https://ai-yangmao.com/api/mcp'),{fetch:fetcher as typeof fetch});
    await client.connect(transport);
    const tools=await client.listTools();
    expect(tools.tools.map(t=>t.name)).toEqual(['yangmao_search_offers','yangmao_get_offer','yangmao_get_daily','yangmao_get_catalog']);
    expect(tools.tools.every(t=>t.annotations?.readOnlyHint===true)).toBe(true);
    const result=await client.callTool({name:'yangmao_search_offers',arguments:{requirement:'zero'}});
    expect((result.structuredContent as any).offers[0].id).toBe('public');
    const invalid=await client.callTool({name:'yangmao_search_offers',arguments:{admin:true}});
    expect(invalid.isError).toBe(true);
    const daily=await client.callTool({name:'yangmao_get_daily',arguments:{}});
    expect((daily.structuredContent as any).available).toBe(false);
    expect(f.sqlite.prepare('SELECT count(*) n FROM daily_digest').get()?.n).toBe(0);
    await client.close();
  });
  it('rejects untrusted browser origins and oversized bodies',async()=>{
    const {fetcher}=fixture();
    expect((await fetcher('https://ai-yangmao.com/api/mcp',{method:'POST',headers:{Origin:'https://evil.example','Content-Type':'application/json'},body:'{}'})).status).toBe(403);
    expect((await fetcher('https://ai-yangmao.com/api/mcp',{method:'POST',headers:{'Content-Type':'application/json'},body:'x'.repeat(17000)})).status).toBe(413);
    for(const body of ['not json','[]','null',JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'approve',arguments:{id:'public'}}})]){
      const response=await fetcher('https://ai-yangmao.com/api/mcp',{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream'},body});
      const payload=await response.json();expect(payload.error||payload.result?.isError).toBeTruthy();
    }
    expect((await fetcher('https://ai-yangmao.com/api/mcp',{headers:{Accept:'text/event-stream'}})).status).toBe(405);
  });
  it('marks snapshot matches unknown before filtering eligibility and avoids D1',async()=>{
    const {env}=fixture();const now=new Date().toISOString();
    const snapshot={capturedAt:now,platforms:[{id:'vendor',name:'Vendor',type:'lab',status:'approved'}],offers:[{id:'snap',platformId:'vendor',title:'Snapshot',type:'standing',requirements:['none'],modalities:['text'],audience:'all',claimMethod:'signup',valueText:'free',endKind:'standing',sourceTz:'UTC',claimStart:null,claimEnd:null,reviewState:'approved',evidence:{tier:'site',url:'https://vendor.example',excerpts:{benefit:'Free'}},lastVerifiedAt:now,discoveredAt:now}]};
    const degraded={...env,DB:{prepare(){throw Error('D1 must not be read');}} as unknown as D1Database,D1_PUBLIC_SNAPSHOT_UNTIL:'2099-01-01T00:00:00Z',ASSETS:{fetch:async()=>Response.json(snapshot)} as unknown as Fetcher};
    const get=async(params:string)=>(await worker.fetch(new Request('https://ai-yangmao.com/api/agent/search?'+params),degraded)).json() as Promise<any>;
    const result=await get('');expect(result.degraded).toBe(true);expect(result.groups.unknown[0]).toBe('snap');
    expect((await get('eligibility=eligible')).total).toBe(0);
  });
  it('opens the shared quota circuit and reports a degraded daily error',async()=>{
    const {f,env}=fixture();let reads=0;f.inject(()=>{reads++;throw Error('D1 daily read quota exceeded');});
    const failed={...env,ASSETS:{fetch:async()=>Response.json({capturedAt:new Date().toISOString(),platforms:[],offers:[]})} as unknown as Fetcher};
    const call=(path:string)=>worker.fetch(new Request('https://ai-yangmao.com'+path),failed);
    expect((await call('/api/agent/search')).status).toBe(200);const initialReads=reads;
    expect((await call('/api/agent/search')).status).toBe(200);expect(reads).toBe(initialReads);
    const daily=await call('/api/agent/daily');expect(daily.status).toBe(503);expect((await daily.json() as any).degraded).toBe(true);expect(reads).toBe(initialReads);
    expect(quotaCircuitOpen(Date.now()+2*86400_000)).toBe(false);
  });
});
