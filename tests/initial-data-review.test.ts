import { describe, expect, it } from 'vitest';
import { fixture } from './fixtures/frontend';

const catalog = { revision: 7,
  products: [{ id: 'vendor', platformIds: ['vendor'], name: 'Vendor', aliases: [], status: 'verified', sourceUrl: 'https://vendor.example', verifiedAt: '2026-10-21', revision: 1 }],
  plans: [{ id: 'vendor-pro', productId: 'vendor', name: 'Pro', aliases: [], status: 'verified', billing: 'paid', sourceUrl: 'https://vendor.example', verifiedAt: '2026-10-21', revision: 1 }] };
const requirement = { schemaVersion: 'membership-v1', status: 'confirmed', catalogRevision: 7, evidenceUrls: ['https://vendor.example'],
  anyOf: [{ allOf: [{ productId: 'vendor', scope: 'plans', planIds: ['vendor-pro'], excludePlanIds: [] }] }] };

describe('首屏与后台共享目录交错', () => {
  for (const response of ['failure', 'old-success']) {
    it(`后台编辑器取得目录后，迟到的公开目录 ${response} 不影响确认资格的保存`, async () => {
      let finish!: (value: Response) => void;
      const f = fixture(() => ({}));
      f.context.fetch = async (url: string) => {
        if (url === '/api/memberships') return new Promise<Response>(resolve => { finish = resolve; });
        return new Response(JSON.stringify(url === '/api/admin/memberships' ? catalog
          : url.includes('/platforms') ? { platforms: [] } : url.includes('/offers') ? { offers: [] } : {}));
      };
      const { supplements } = await f.run('loadData({deferExtras:true})');
      f.run(`document.querySelector('#admBody').innerHTML='<form id="editor"><div data-membership-editor></div></form>';`);
      await f.run(`mountMembershipEditor(document.querySelector('#editor'),{platformId:'vendor',requirements:['member:Pro'],membershipRequirement:${JSON.stringify(requirement)}})`);
      expect(f.run("document.querySelector('#editor').membershipEditor.catalogAvailable")).toBe(true);
      finish(response === 'failure' ? new Response('{}', { status: 503 })
        : new Response(JSON.stringify({ revision: 1, products: [], plans: [] })));
      await supplements;
      expect(f.run('MEMBERSHIP_CATALOG_OK')).toBe(true);
      expect(f.run('MEMBERSHIP_CATALOG.revision')).toBe(7);
      f.run("document.querySelector('#editor').membershipEditor.touched=true");
      expect(f.run("membershipEditFields({},document.querySelector('#editor').membershipEditor,[],false,'').membershipRequirement.status")).toBe('confirmed');
    });
  }

  it('目录管理与编辑器采用同一代次，旧管理员请求不能回退目录', async () => {
    const f = fixture(() => ({}));
    let finish!: (value: unknown) => void;
    f.context.slowCatalog = () => new Promise(resolve => { finish = resolve; });
    const old = f.run('loadMembershipCatalog(slowCatalog)');
    await f.run(`loadMembershipCatalog(async()=>(${JSON.stringify(catalog)}))`);
    finish({ revision: 1, products: [], plans: [] }); await old;
    expect(f.run('MEMBERSHIP_CATALOG.revision')).toBe(7);
  });

  it('覆盖信息失败后显示默认采集说明', () => {
    const f = fixture(() => ({}), '#coverage');
    f.run('COVERAGE=null;pCoverage()');
    expect(f.document.querySelector('#main')?.textContent).toContain('官方页面监控');
    expect(f.document.querySelector('#main')?.textContent).not.toContain('尚未加载');
  });

  it('更新请求失败时仍可采用已经发出的成功目录响应', async () => {
    const f = fixture(() => ({}));
    let finish!: (value: unknown) => void;
    f.context.slowCatalog = () => new Promise(resolve => { finish = resolve; });
    const pending = f.run('loadMembershipCatalog(slowCatalog)');
    await expect(f.run("loadMembershipCatalog(async()=>{throw new Error('503')})")).rejects.toThrow('503');
    finish(catalog); await pending;
    expect(f.run('MEMBERSHIP_CATALOG_OK')).toBe(true);
    expect(f.run('MEMBERSHIP_CATALOG.revision')).toBe(7);
  });
});
