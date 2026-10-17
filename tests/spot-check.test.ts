import { afterEach, beforeEach, expect, it } from 'vitest';
import worker from '../src/worker/index';
import { identityDb } from './fixtures/identity/db';
import { guessCategory } from '../src/worker/screening/spot-check';

let f: ReturnType<typeof identityDb>;
beforeEach(() => { f = identityDb(); });
afterEach(() => f.sqlite.close());
const env = () => ({ DB: f.db, ADMIN_TOKEN: 'spot-admin-token-0001', INGEST_TOKEN: 'spot-ingest-token-001', REVIEWER_TOKENS: 'rev:spot-reviewer-token-1', IDENTITY_MODE: 'enforce', SCREENING_MODE: 'shadow' }) as any;
async function call(path: string, body?: unknown, token = 'spot-admin-token-0001') {
  const r = await worker.fetch(new Request('https://local.test/api/' + path, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }), env(), {} as any);
  return { status: r.status, body: await r.json() as any };
}
const closed = (id: number, title: string, resolution: Record<string, unknown>) => f.sqlite.prepare("INSERT INTO leads(id,origin,url,status,title,resolution,created_at) VALUES(?,'linuxdo',?,'rejected',?,?,?)")
  .run(id, `https://linux.do/t/topic/${id}`, title, JSON.stringify({ status: 'closed', checkedAt: new Date().toISOString(), ...resolution }), new Date().toISOString());

// 2026-10-16: the owner skims what the system closed by itself; likely misses first; verdicts become calibration labels.
it('lists auto-closed leads the owner has not looked at, likely misses first', async () => {
  closed(9001, '飞牛万兆交换机发布', { reason: '模型判断不是 AI 羊毛' });
  closed(9002, 'Vendor 注册免费送 10 美元额度', { reason: '模型判断不是 AI 羊毛' });
  closed(9003, '外卖红包券天天领', { reason: '入口过滤：标题含「外卖」', ruleId: 'r1' });
  closed(9004, '已经人工处理过的线索', { reason: '中转站' });
  f.sqlite.prepare("INSERT INTO decision_labels(subject_kind,subject_id,category,actor_kind,label_source,labeled_at) VALUES('lead','9004','relay_station','owner','owner',?)").run(new Date().toISOString());
  const { body } = await call('admin/screening/spot-check');
  expect(body.items.map((i: any) => i.id)).toEqual([9002, 9003, 9001]);
  expect(body.items[0]).toMatchObject({ likely: true, closedBy: 'model', category: 'non_ai' });
  expect(body.items[1]).toMatchObject({ closedBy: 'rule', ruleId: 'r1' });
  expect((await call('admin/screening/spot-check', undefined, 'spot-reviewer-token-1')).status).toBe(403);
});

it('confirming records owner labels and removes the leads from the list', async () => {
  closed(9010, '某中转站送余额', { reason: '中转站送额度，不收' });
  const r = await call('admin/screening/spot-check/confirm', { items: [{ id: 9010, category: 'relay_station' }] });
  expect(r.body).toEqual({ confirmed: 1 });
  expect(f.sqlite.prepare("SELECT category, actor_kind FROM decision_labels WHERE subject_kind='lead' AND subject_id='9010'").get()).toEqual({ category: 'relay_station', actor_kind: 'owner' });
  expect((await call('admin/screening/spot-check')).body.items).toEqual([]);
  expect((await call('admin/screening/spot-check/confirm', { items: Array.from({ length: 16 }, (_, i) => ({ id: i + 9100, category: 'non_ai' })) })).status).toBe(400);
});

it('a rule wrong on more than 10% of at least 10 hits retires itself', async () => {
  f.sqlite.exec("INSERT INTO screening_rules(id,kind,scope_kind,category,description,pattern,status,hits,created_at) VALUES('r9','title_pattern','global','non_ai','标题含「月卡」','月卡','active',10,'2026-10-16T00:00:00Z')");
  closed(9020, 'Kimi 会员月卡免费领', { ruleId: 'r9', reason: '入口过滤' });
  closed(9021, '可灵月卡活动', { ruleId: 'r9', reason: '入口过滤' });
  expect((await call('admin/screening/spot-check/9020/wrong', {})).body).toEqual({ ok: true, ruleRetired: false }); // 1/10
  expect((await call('admin/screening/spot-check/9021/wrong', {})).body).toEqual({ ok: true, ruleRetired: true }); // 2/10 > 10%
  expect(f.sqlite.prepare("SELECT status, overrides FROM screening_rules WHERE id='r9'").get()).toEqual({ status: 'retired', overrides: 2 });
});

it('guesses the category from the closing reason', () => {
  expect(guessCategory('river.ai 是中转站送额度，不收。')).toBe('relay_station');
  expect(guessCategory('火山方舟套餐账号分享，不收账号池。')).toBe('account_pool');
  expect(guessCategory('与已上架活动相同')).toBe('duplicate');
  expect(guessCategory('模型判断不是 AI 羊毛')).toBe('non_ai');
});
