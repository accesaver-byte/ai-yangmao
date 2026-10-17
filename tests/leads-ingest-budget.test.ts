import { afterEach, beforeEach, expect, it } from 'vitest';
import worker from '../src/worker/index';
import { identityDb } from './fixtures/identity/db';
import { LEAD_POST_CHUNK } from '../pipeline/lib';

let f: ReturnType<typeof identityDb>;
beforeEach(() => { f = identityDb(); });
afterEach(() => f.sqlite.close());

const post = async (leads: unknown[], identityMode = 'enforce') => {
  const r = await worker.fetch(new Request('https://local.test/api/ingest/leads', { method: 'POST', headers: { Authorization: 'Bearer leads-ingest-token-01', 'Content-Type': 'application/json' }, body: JSON.stringify(leads) }),
    { DB: f.db, INGEST_TOKEN: 'leads-ingest-token-01', IDENTITY_MODE: identityMode, IDENTITY_CANARY_PLATFORMS: '*', SCREENING_MODE: 'shadow' } as any, {} as any);
  return { status: r.status, body: await r.json() as any };
};
/** As the relay and the pipeline send them. */
const postChunked = async (leads: unknown[]) => {
  let created = 0;
  for (let i = 0; i < leads.length; i += LEAD_POST_CHUNK) { const r = await post(leads.slice(i, i + LEAD_POST_CHUNK)); expect(r.status).toBe(200); created += r.body.created; }
  return created;
};
// linux.do's welfare RSS returns the same ~25 recent topics every run, with updated text.
const batch = (round: number, title = (i: number) => `福利帖 ${i}`) => Array.from({ length: 25 }, (_, i) => ({ origin: 'linuxdo', url: `https://linux.do/t/topic/${1000 + i}`, title: title(i), raw: `第 ${round} 次抓取的正文 ${i}` }));

it('more than 16 new leads in one request stay under the 100-parameter insert limit', async () => {
  // Query budget off: isolates the per-statement binding limit (6 bound columns per lead row).
  expect(await post(batch(1).slice(0, 20), 'off')).toMatchObject({ status: 200, body: { created: 20 } });
});

it('a full linux.do batch is accepted in client-sized chunks and every lead gets a screening item', async () => {
  expect(await postChunked(batch(1))).toBe(25);
  expect(f.sqlite.prepare("SELECT count(*) n FROM screening_items WHERE subject_kind='lead'").get()).toEqual({ n: 25 });
});

it('re-sending the same topics with updated text is accepted', async () => {
  await postChunked(batch(1));
  expect(await postChunked(batch(2))).toBe(0);
  expect(f.sqlite.prepare("SELECT raw FROM leads WHERE url='https://linux.do/t/topic/1024'").get()).toEqual({ raw: '第 2 次抓取的正文 24' });
});

it('a chunk where every lead matches an active title rule still fits the request budget', async () => {
  f.sqlite.exec("INSERT INTO screening_rules(id,kind,scope_kind,scope_value,category,description,pattern,status,created_at) VALUES('r1','title_pattern','global',NULL,'not_benefit','测试规则','抽奖','active','2026-10-14T00:00:00Z')");
  expect(await postChunked(batch(1, i => `抽奖帖 ${i}`))).toBe(25);
  expect(f.sqlite.prepare("SELECT count(*) n FROM leads WHERE status='rejected'").get()).toEqual({ n: 25 });
  expect(f.sqlite.prepare("SELECT hits FROM screening_rules WHERE id='r1'").get()).toEqual({ hits: 25 });
});
