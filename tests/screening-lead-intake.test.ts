import { beforeEach, describe, expect, it } from 'vitest';
import worker from '../src/worker/index';
import { identityDb } from './fixtures/identity/db';

let f: ReturnType<typeof identityDb>;
beforeEach(() => { f = identityDb(); });

function seedActiveRule(db: ReturnType<typeof identityDb>, rule: { id: string; pattern: string; scopeKind: string; scopeValue: string; category: string }) {
  db.sqlite.prepare(`INSERT INTO screening_rules(id, kind, scope_kind, scope_value, category, description, pattern, status, created_at) VALUES (?, 'title_pattern', ?, ?, ?, ?, ?, 'active', '2026-10-12T00:00:00.000Z')`).run(rule.id, rule.scopeKind, rule.scopeValue, rule.category, rule.pattern, rule.pattern);
}

async function postLeads(body: unknown, env: { SCREENING_MODE?: string } = {}) {
  return worker.fetch(new Request('https://local.test/api/ingest/leads', { method: 'POST', headers: { Authorization: 'Bearer ingest-test-token-123', 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), { DB: f.db, INGEST_TOKEN: 'ingest-test-token-123', ADMIN_TOKEN: 'admin-test-token-123', ...env } as never, {} as ExecutionContext);
}

describe('screened lead intake', () => {
  // 2026-10-16: owner-approved rules close on arrival in every mode except off; shadow only holds back model verdicts.
  it('records and closes an owner-approved rule match even in shadow mode', async () => {
    seedActiveRule(f, { id: 'r1', pattern: '【富可敌国】', scopeKind: 'origin', scopeValue: 'linuxdo', category: 'relay_station' });
    await postLeads([{ origin: 'linuxdo', url: 'https://linux.do/t/x/1', title: '【富可敌国】某 API 送余额' }], { SCREENING_MODE: 'shadow' });
    expect(f.sqlite.prepare("SELECT status FROM leads WHERE url='https://linux.do/t/x/1'").get()).toEqual({ status: 'rejected' });
    expect(f.sqlite.prepare('SELECT verdict, model FROM screening_decisions').get()).toEqual({ verdict: 'rejected_by_rule', model: 'gate0' });
    expect(f.sqlite.prepare('SELECT applied_at FROM screening_decisions').get()).not.toEqual({ applied_at: null });
  });
  it('skips a repost whose url_key already exists', async () => {
    await postLeads([{ origin: 'linuxdo', url: 'https://linux.do/t/a/9' }], { SCREENING_MODE: 'shadow' });
    const r = await postLeads([{ origin: 'linuxdo', url: 'https://linux.do/t/b/9/3' }], { SCREENING_MODE: 'shadow' });
    expect(await r.json()).toEqual({ created: 0, skipped: 1, filtered: 0 });
  });
});
