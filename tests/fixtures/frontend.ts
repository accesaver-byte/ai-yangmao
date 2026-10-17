import * as YMModels from '../../src/shared/model-names';
import * as YMMembership from '../../src/shared/membership';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { parseHTML } from 'linkedom';

/** Runs the real web/src scripts (minus boot) in a VM over the real body.html. */
export function fixture(handle: (url: string, init?: RequestInit) => unknown | Promise<unknown>, hash = '#admin', catalog: unknown = {revision:0,products:[],plans:[]}) {
  const { window, document } = parseHTML(`<html><body>${readFileSync('web/src/body.html', 'utf8')}</body></html>`);
  document.querySelector('#main')!.innerHTML = '<div id="admBody"></div>';
  window.scrollTo = () => {};
  const charts = new Map<string, any>();
  const storage = { getItem: () => null, setItem() {}, removeItem() {} };
  const context = createContext({YMModels,YMMembership, structuredClone, crypto, window, document, console, Intl, Date, Map, Set, URL, URLSearchParams, Response, FormData,
    location: { hash }, navigator: {}, getComputedStyle: () => ({ getPropertyValue: () => '#123456' }),
    matchMedia: () => ({ matches: false, addEventListener() {} }), MutationObserver: class { observe() {} },
    localStorage: storage, sessionStorage: storage, setTimeout, clearTimeout, setInterval() {},
    echarts: { getInstanceByDom: () => null, init: (element: HTMLElement) => ({ setOption: (options: any) => charts.set(element.id, options), on() {}, dispose() {}, isDisposed: () => false }) },
    fetch: async (url: string, init?: RequestInit) => new Response(JSON.stringify(url.endsWith('/memberships') ? catalog : await handle(url, init))),
  });
  const app = readFileSync('web/src/app.js', 'utf8');
  runInContext('window.echarts = echarts;', context);
  runInContext(readFileSync('web/src/urgent-review.js', 'utf8'), context);
  runInContext(readFileSync('web/src/data.js', 'utf8') + '\n' + readFileSync('web/src/membership.js', 'utf8') + '\n' + app.slice(0, app.indexOf('(async function boot()')), context);
  const run = (code: string) => runInContext(code, context);
  run("PLATFORMS=[{id:'vendor',name:'Vendor',type:'lab'}];ADM.token='fixture';ADM.role='admin';");
  return { document, window, context, run, charts };
}

export function publicOffer(run: (code: string) => any, extra: Record<string, unknown> = {}) {
  run(`OFFERS=[{id:'public-offer',p:'vendor',t:'常驻免费额度',ty:'standing',m:['text'],c:'auto',r:['none'],v:'每月 10 美元',usd:10,noUsd:false,s:null,e:null,ek:'standing',vf:0,vfDay:0,fs:-10,since:-10,discoveredAt:new Date(Date.now()-10*DAY).toISOString(),verifiedAt:new Date().toISOString(),withdrawnAt:null,st:'docs',tz:'UTC',val:'每月',aud:'all',cn:true,early:'官方页面',why:'',steps:[],models:[],tags:[],evidence:{url:'https://vendor.example',excerpts:{}},note:'原文',verify:'ok',...${JSON.stringify(extra)}}];prepare();location.hash='#offer-public-offer';`);
}
