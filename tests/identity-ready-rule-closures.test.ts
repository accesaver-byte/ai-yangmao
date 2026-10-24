import { afterEach, beforeEach, expect, it } from 'vitest';
import { identityDb } from './fixtures/identity/db';
import { requireIdentityReady } from '../src/worker/identity/adapters';

// 2026-10-24: lead #7907, closed by an intake title rule, blocked identity intake for every platform.
let f: ReturnType<typeof identityDb>;
beforeEach(() => { f = identityDb(); });
afterEach(() => f.sqlite.close());
const rejected = (id: number, resolution: Record<string, unknown>) => f.sqlite.prepare("INSERT INTO leads(id,origin,url,status,resolution) VALUES(?,'linuxdo',?,'rejected',?)").run(id, `https://linux.do/t/topic/${id}`, JSON.stringify(resolution));
it('does not wait on intake-rule or gate0 closures', async () => {
  rejected(9907, { status: 'closed', reason: '入口过滤：标题含「公益」', ruleId: 'rule-x', reasonCode: 'other' });
  rejected(9908, { status: 'closed', reason: '入口查重：转帖', gate0: true });
  await expect(requireIdentityReady(f.db, 'vendor')).resolves.toBeUndefined();
});
it('still waits on an ordinary unreconciled rejection', async () => {
  rejected(9909, { status: 'closed', reason: '模型判断不是 AI 羊毛' });
  await expect(requireIdentityReady(f.db, 'vendor')).rejects.toMatchObject({ status: 409 });
});
