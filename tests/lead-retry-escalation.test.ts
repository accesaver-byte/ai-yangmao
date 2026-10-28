import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import worker from '../src/worker/index';
import { identityDb } from './fixtures/identity/db';
import { verifyFetchProvenance } from '../src/worker/identity/fetch-provenance';
import { sha256 } from '../src/shared/identity/normalize';

let f: ReturnType<typeof identityDb>;
beforeEach(() => { f = identityDb(); });
afterEach(() => { f.sqlite.close(); });
async function call(path: string, body: unknown) {
  const r = await worker.fetch(new Request(`https://local.test/api/${path}`, { method: 'POST', headers: { Authorization: 'Bearer ingest-test-token-123', 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    { DB: f.db, ADMIN_TOKEN: 'admin-test-token-123456', INGEST_TOKEN: 'ingest-test-token-123' } as never, {} as ExecutionContext);
  return r.json() as Promise<any>;
}
function lead(attempts: number) {
  const resolution = { status: 'retry', jobId: crypto.randomUUID(), attempts, inconclusive: 0, checkedAt: new Date(Date.now() - 7200_000).toISOString(),
    nextAttemptAt: new Date(Date.now() - 60_000).toISOString(), reason: '复核受阻', queries: [], candidates: [] };
  f.sqlite.prepare("INSERT INTO leads(id,origin,url,title,status,created_at,resolution) VALUES(901,'linuxdo','https://community.example/901','某福利','reviewing',?,?)")
    .run(new Date().toISOString(), JSON.stringify(resolution));
}
const result = (jobId: string, extra = {}) => call('ingest/lead-reviews/901/result', { jobId, outcome: 'retry', reason: '官方正文暂不可读', queries: [], candidates: [], offerIds: [], ...extra });

describe('技术性受阻的线索复核', () => {
  it('未达上限时继续重试', async () => {
    lead(2);
    const { jobId } = await call('ingest/lead-reviews/901/claim', {});
    expect((await result(jobId)).status).toBe('retry');
  });
  it('连续受阻达到上限即交人工，不再空耗额度', async () => {
    lead(3);
    const { jobId } = await call('ingest/lead-reviews/901/claim', {});
    expect((await result(jobId)).status).toBe('manual');
    const row = JSON.parse((f.sqlite.prepare('SELECT resolution FROM leads WHERE id=901').get() as any).resolution);
    expect(row.reason).toContain('自动复核连续 4 次受阻');
  });
  it('因模型额度耗尽推迟的轮次不计次', async () => {
    lead(9);
    const { jobId } = await call('ingest/lead-reviews/901/claim', {});
    expect((await result(jobId, { deferred: true })).status).toBe('retry');
  });
});

describe('阅读器读取的官方页面', () => {
  const url = 'https://vendor.example/pricing', text = 'Pricing page text';
  const proof = async (finalUrl = url) => ({ originalUrl: url, finalUrl, fetchedUrl: 'https://r.jina.ai/' + url, method: 'jina' as const, sourceVerified: true, truncated: false, contentHash: await sha256(text) });
  it('同一页面视同直读', async () => {
    expect(await verifyFetchProvenance(await proof(), url, url, text)).toEqual({ valid: true, direct: true });
  });
  it('跳转到其他页面不算直读', async () => {
    const other = 'https://vendor.example/other';
    expect((await verifyFetchProvenance(await proof(other), url, other, text)).direct).toBe(false);
  });
  it('阅读器未确认来源时不算直读', async () => {
    expect((await verifyFetchProvenance({ ...(await proof()), sourceVerified: false }, url, url, text)).direct).toBe(false);
  });
});
