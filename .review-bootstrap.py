"""Temporary branch-only patch runner. Removed before opening the final PR.
No network, deployment, production database, or credential access.
"""
from pathlib import Path
import sys


def replace(path, old, new):
    p = Path(path)
    text = p.read_text()
    if text.count(old) != 1:
        raise RuntimeError(f'{path}: expected exactly one replacement anchor, got {text.count(old)}')
    p.write_text(text.replace(old, new))


def append(path, text):
    p = Path(path)
    if 'phase1 regression' in p.read_text():
        raise RuntimeError(f'{path}: regressions already present')
    p.write_text(p.read_text() + text)


if sys.argv[1] == 'tests':
    replace('tests/pipeline-workflow.test.ts', 'interface HarnessOptions {', 'interface HarnessOptions {\n  ingestResults?: Record<string, unknown>[];')
    replace('tests/pipeline-workflow.test.ts', "if (url.endsWith('/offers')) return json({ results: body.map((o: { id: string }) => ({ id: o.id, created: true, reviewState: 'pending' })) });", "if (url.endsWith('/offers')) return json({ results: options.ingestResults ?? body.map((o: { id: string }) => ({ id: o.id, created: true, reviewState: 'pending' })) });")
    append('tests/pipeline-workflow.test.ts', r'''

// phase1 regression: exercise the real intake caller, not a copied condition.
describe('phase1 duplicate intake', () => {
  it.each(['rejected', 'approved'])('resolves a duplicate of an %s offer without requeueing the lead', async state => {
    const h = harness({ leads: [lead], ingestResults: [
      { id: 'fresh-alias', duplicateId: 'vendor-canonical', skipped: `duplicate ${state}` },
    ] });
    const { runPipeline } = await import('../pipeline/run');
    await runPipeline();
    expect(h.payloads('/status')).toEqual([{ status: 'linked', offerId: 'vendor-canonical' }]);
  });

  it('does not turn an unidentified skip into a resolved lead', async () => {
    const h = harness({ leads: [lead], ingestResults: [{ id: 'fresh-alias', skipped: 'needs identity verification' }] });
    const { runPipeline } = await import('../pipeline/run');
    await runPipeline();
    expect(h.payloads('/status')[0].status).toBe('reviewing');
  });

  it('retains a partially failed lead even when another candidate is a resolved duplicate', async () => {
    const other = { ...candidate, key: 'other-api', title: '另一项 API 赠送', valueText: '另一个独立积分池' };
    const h = harness({ leads: [lead], modelOutput: JSON.stringify({ offers: [candidate, other] }), ingestResults: [
      { id: 'alias', duplicateId: 'vendor-canonical', skipped: 'duplicate rejected' },
      { id: 'other', error: 'write failed' },
    ] });
    const { runPipeline } = await import('../pipeline/run');
    await runPipeline();
    expect(h.payloads('/status')[0].status).toBe('reviewing');
  });
});
''')
    replace('tests/verification.test.ts', 'function d1(memory: DatabaseSync) {\n  return {', '''function d1(memory: DatabaseSync) {
  return {
    async batch(statements: { all(): Promise<unknown> }[]) {
      memory.exec('BEGIN');
      try {
        const results: unknown[] = [];
        for (const statement of statements) results.push(await statement.all());
        memory.exec('COMMIT');
        return results;
      } catch (error) {
        memory.exec('ROLLBACK');
        throw error;
      }
    },''')
    replace('tests/verification.test.ts', 'async run() { return { meta: memory.prepare(sql).run(...args as []), success: true }; },', 'async run() { beforeStatement?.(sql); return { meta: memory.prepare(sql).run(...args as []), success: true }; },')
    append('tests/verification.test.ts', r'''

// phase1 regression: actual Worker routes against the migration-backed SQLite harness.
const phase1Offer = () => ({
  id: 'vendor-phase1-quota', platformId: 'vendor', sourceId: 'source',
  title: '常驻免费积分', type: 'standing', modalities: ['text'], models: [], tags: [],
  claimMethod: 'signup', requirements: ['none'], audience: 'all',
  valueText: '每天 100 积分', usdEstimate: null, usdMax: null,
  claimStart: null, claimEnd: null, endKind: 'standing', creditValidity: null,
  sourceTz: 'UTC', publishedAt: null, steps: [],
  evidence: { url: 'https://vendor.example/free', tier: 'docs', capturedAt: '2026-10-10T00:00:00Z',
    excerpts: { benefit: '100 credits every day.', eligibility: 'All users.', validity: 'No published end date.' } },
});
async function phase1Approved() {
  const o = phase1Offer();
  expect((await call('ingest/offers', [o])).status).toBe(200);
  expect((await call(`admin/offers/${o.id}/approve`, {}, 'admin')).status).toBe(200);
  return o;
}
async function phase1Proposal() {
  const o = await phase1Approved();
  const next = { ...o, valueText: '每天 200 积分', evidence: { ...o.evidence,
    excerpts: { ...o.evidence.excerpts, benefit: '200 credits every day.' } } };
  const result = await call('ingest/offers', [{ ...next, sourceText: Object.values(next.evidence.excerpts).join(' ') }]);
  expect((result.body.results as any[])[0].reviewState).toBe('pending_update');
  return o;
}
const phase1Count = (table: string) => Number((sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as any).n);

describe('phase1 reviewed benefit facts', () => {
  it.each([false, true])('proposes a same-number cadence change (administrator-edited baseline: %s)', async edited => {
    const o = await phase1Approved();
    if (edited) expect((await call(`admin/offers/${o.id}/edit`, { fields: { valueText: '每天 100 积分（已核对）' } }, 'admin')).status).toBe(200);
    const previous = sqlite.prepare('SELECT value_text FROM offers WHERE id=?').get(o.id) as any;
    const next = { ...o, valueText: '每月 100 积分', evidence: { ...o.evidence,
      excerpts: { ...o.evidence.excerpts, benefit: '100 credits every month.' } } };
    const result = await call('ingest/offers', [{ ...next, sourceText: Object.values(next.evidence.excerpts).join(' ') }]);
    expect((result.body.results as any[])[0].reviewState).toBe('pending_update');
    const proposal = sqlite.prepare('SELECT candidate,diff FROM offer_proposals WHERE offer_id=?').get(o.id) as any;
    expect(JSON.parse(proposal.candidate).valueText).toBe('每月 100 积分');
    expect(JSON.parse(proposal.diff)).toContainEqual({ field: 'valueText', from: previous.value_text, to: '每月 100 积分' });
    expect(sqlite.prepare('SELECT value_text,review_state FROM offers WHERE id=?').get(o.id))
      .toMatchObject({ value_text: previous.value_text, review_state: 'approved' });
  });

  it('does not reopen a mere rewrite with unchanged official source terms', async () => {
    const o = await phase1Approved();
    const result = await call('ingest/offers', [{ ...o, valueText: '每日赠予一百个积分', sourceText: Object.values(o.evidence.excerpts).join(' ') }]);
    expect((result.body.results as any[])[0].unchanged).toBe(true);
    expect(phase1Count('offer_proposals')).toBe(0);
  });

  it('keeps an actively edited manual proposal despite a later official benefit change', async () => {
    const o = await phase1Proposal();
    const manual = '管理员正在核对的新额度';
    expect((await call(`admin/offers/${o.id}/edit`, { fields: { valueText: manual } }, 'admin')).status).toBe(200);
    const next = { ...o, valueText: '每月 300 积分', evidence: { ...o.evidence,
      excerpts: { ...o.evidence.excerpts, benefit: '300 credits every month.' } } };
    await call('ingest/offers', [{ ...next, sourceText: Object.values(next.evidence.excerpts).join(' ') }]);
    const proposal = sqlite.prepare('SELECT candidate FROM offer_proposals WHERE offer_id=?').get(o.id) as any;
    expect(JSON.parse(proposal.candidate).valueText).toBe(manual);
  });
});

describe('phase1 rejection transaction', () => {
  it('does not remove a proposal after its approved baseline changes before rejection', async () => {
    const o = await phase1Proposal();
    beforeStatement = sql => {
      if (!/INSERT INTO rejected_offer_updates/i.test(sql)) return;
      beforeStatement = undefined;
      sqlite.prepare('UPDATE offers SET updated_at=? WHERE id=?').run('2031-01-01T00:00:00Z', o.id);
    };
    const result = await call(`admin/offers/${o.id}/reject`, { reason: '不要此更新' }, 'admin');
    expect(result.status).toBe(409);
    expect(phase1Count('offer_proposals')).toBe(1);
    expect(phase1Count('rejected_offer_updates')).toBe(0);
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM reviews WHERE action='reject'").get()).toMatchObject({ n: 0 });
  });

  it('does not reject a replacement proposal with a newer version', async () => {
    const o = await phase1Proposal();
    beforeStatement = sql => {
      if (!/INSERT INTO rejected_offer_updates/i.test(sql)) return;
      beforeStatement = undefined;
      sqlite.prepare('UPDATE offer_proposals SET updated_at=? WHERE offer_id=?').run('2031-01-01T00:00:00Z', o.id);
    };
    expect((await call(`admin/offers/${o.id}/reject`, {}, 'admin')).status).toBe(409);
    expect(phase1Count('offer_proposals')).toBe(1);
    expect(phase1Count('rejected_offer_updates')).toBe(0);
  });

  it('rolls back rejection memory and deletion when audit insertion fails', async () => {
    const o = await phase1Proposal();
    sqlite.exec("CREATE TRIGGER phase1_fail_audit BEFORE INSERT ON reviews WHEN NEW.action='reject' BEGIN SELECT RAISE(ABORT, 'phase1 audit unavailable'); END;");
    expect((await call(`admin/offers/${o.id}/reject`, {}, 'admin')).status).toBe(500);
    expect(phase1Count('offer_proposals')).toBe(1);
    expect(phase1Count('rejected_offer_updates')).toBe(0);
  });

  it('records one rejection and one audit, removes only the proposal, and preserves the approved offer', async () => {
    const o = await phase1Proposal();
    expect((await call(`admin/offers/${o.id}/reject`, { reason: '已核对，拒绝这个版本', reasonCode: 'wrong_field' }, 'admin')).status).toBe(200);
    expect(phase1Count('offer_proposals')).toBe(0);
    expect(phase1Count('rejected_offer_updates')).toBe(1);
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM reviews WHERE action='reject'").get()).toMatchObject({ n: 1 });
    expect(sqlite.prepare('SELECT review_state,value_text FROM offers WHERE id=?').get(o.id)).toMatchObject({ review_state: 'approved', value_text: o.valueText });
    expect((await call(`admin/offers/${o.id}/reject`, {}, 'admin')).status).toBe(409);
    expect(phase1Count('rejected_offer_updates')).toBe(1);
  });
});
''')
elif sys.argv[1] == 'fix':
    replace('pipeline/run.ts', 'id: string; error?: string; skipped?: string; unchanged?: boolean', 'id: string; error?: string; skipped?: string; duplicateId?: string; unchanged?: boolean')
    replace('pipeline/run.ts', "      const saved = res.results.filter(x => !x.error && !('skipped' in x));", """      // A known duplicate is a resolved candidate, not a failed write. Keep unknown skips/errors retryable.
      const saved = res.results.flatMap(x => {
        if (x.error) return [];
        if (x.duplicateId) return [{ ...x, id: x.duplicateId }];
        return 'skipped' in x ? [] : [x];
      });""")
    replace('src/worker/index.ts', 'import { changedOfficialTerms, rejectedTermsStillPresent }', 'import { changedOfficialTerms, changedOfficialBenefit, rejectedTermsStillPresent }')
    replace('src/worker/index.ts', r"""      // 官方条款真变了，由日期、类型、门槛、美元、免费模型或额度数字的变化触发提案，管理员再改。
      const factNumbers = (t: string) => (t.normalize('NFKC').match(/\d[\d,.]*/g) ?? []).map(x => x.replace(/,/g, '')).sort().join('|');
      const excerptChanged = (['benefit', 'eligibility', 'validity'] as const).some(key => {
        const before = prev.evidence.excerpts[key]?.replace(/\s+/g, ' ').trim();
        const after = o.evidence.excerpts[key]?.replace(/\s+/g, ' ').trim();
        return !!before && !!after && before !== after;
      });""", """      // Grounded replacement of benefit facts can update the proposed wording, even when digits stay the same.
      const benefitChanged = changedOfficialBenefit(prev.evidence, o.evidence, o.sourceText);""")
    replace('src/worker/index.ts', "        // 唯一例外：官方原文变了、额度里的数字也变了，额度文字可以进提案（仍不直接覆盖）\n        if (prev.reviewState === 'approved' && field === 'valueText' && excerptChanged && factNumbers(o.valueText) !== factNumbers(prev.valueText) && !existingProposal?.manualFields.includes(field)) continue;", "        // Only proven benefit changes may replace an old edit; an active manual proposal always wins.\n        if (prev.reviewState === 'approved' && field === 'valueText' && benefitChanged && !existingProposal?.manualFields.includes(field)) continue;")
    replace('src/worker/index.ts', r"""      const numbers = (t: string) => (t.normalize('NFKC').match(/\d[\d,.]*/g) ?? []).map(x => x.replace(/,/g, '')).sort().join('|');
      if (numbers(row.valueText) === numbers(prev.valueText)) row.valueText = prev.valueText;""", """      // Equal digits do not mean equal benefits (100/day and 100/month differ).
      if (!changedOfficialBenefit(prev.evidence, o.evidence, o.sourceText)) row.valueText = prev.valueText;""")
    p = Path('src/shared/review-stability.ts')
    p.write_text(p.read_text() + '''\n/** Reuse the grounded source-change gate for benefit facts, excluding unrelated eligibility/date changes. */
export function changedOfficialBenefit(before: Evidence, after: Evidence, sourceText?: string): boolean {
  return changedOfficialTerms(
    { ...before, excerpts: { benefit: before.excerpts.benefit } },
    { ...after, excerpts: { benefit: after.excerpts.benefit } },
    sourceText,
  );
}
''')
    replace('src/db/schema.ts', "export const rejectedOfferUpdates = sqliteTable('rejected_offer_updates', {\n  id: integer('id').primaryKey({ autoIncrement: true }),", "export const rejectedOfferUpdates = sqliteTable('rejected_offer_updates', {\n  id: integer('id').primaryKey({ autoIncrement: true }),\n  // Unique per rejection command; links all statements in the guarded transaction.\n  decisionKey: text('decision_key').unique(),")
    migration = Path('migrations/0016_rejection_decision_key.sql')
    if migration.exists():
        raise RuntimeError('migration number already in use')
    migration.write_text('''-- Additive: deploy before the new Worker; existing rejection rows remain valid.
ALTER TABLE rejected_offer_updates ADD COLUMN decision_key TEXT;
CREATE UNIQUE INDEX rejected_offer_updates_decision_key_unique ON rejected_offer_updates(decision_key);
''')
    replace('src/worker/admin.ts', """    if (action === 'reject') {
      // Save the rejected source terms before removing the queue item, guarded by its exact version.
      await c.env.DB.prepare(`INSERT INTO rejected_offer_updates(offer_id,evidence,diff)
        SELECT offer_id,?,diff FROM offer_proposals WHERE offer_id=? AND updated_at=?
        AND EXISTS(SELECT 1 FROM offers WHERE id=? AND updated_at=? AND review_state='approved')`)
        .bind(JSON.stringify(proposal.candidate.evidence ?? o.evidence),o.id,proposal.updatedAt,o.id,o.updatedAt).run();
    }
    const removed = await d.delete(s.offerProposals).where(and(eq(s.offerProposals.offerId,o.id),eq(s.offerProposals.updatedAt,proposal.updatedAt))).returning({id:s.offerProposals.offerId});
    if (!removed.length && action==='reject') return c.json({error:'提案已更新，请刷新后重试'},409);""", """    if (action === 'reject') {
      // D1 batch is transactional. A zero-row version guard must also make audit/delete no-ops.
      // A fresh decision key ties subsequent writes to THIS successful insertion, not an older rejection.
      const decisionKey = crypto.randomUUID();
      const rejected = await c.env.DB.batch<{ id: number | string }>([
        c.env.DB.prepare(`INSERT INTO rejected_offer_updates(offer_id,evidence,diff,at,decision_key)
          SELECT offer_id,?,diff,?,? FROM offer_proposals WHERE offer_id=? AND updated_at=?
          AND EXISTS(SELECT 1 FROM offers WHERE id=? AND updated_at=? AND review_state='approved')
          RETURNING id`)
          .bind(JSON.stringify(proposal.candidate.evidence ?? o.evidence),nowIso,decisionKey,o.id,proposal.updatedAt,o.id,o.updatedAt),
        c.env.DB.prepare(`INSERT INTO reviews(offer_id,action,reviewer,reason,reason_code,at)
          SELECT ?,'reject',?,?,?,? WHERE EXISTS(SELECT 1 FROM rejected_offer_updates WHERE decision_key=?) RETURNING id`)
          .bind(o.id,c.get('who'),body.reason ?? null,body.reasonCode ?? null,nowIso,decisionKey),
        c.env.DB.prepare(`DELETE FROM offer_proposals WHERE offer_id=? AND updated_at=?
          AND EXISTS(SELECT 1 FROM rejected_offer_updates WHERE decision_key=?) RETURNING offer_id AS id`)
          .bind(o.id,proposal.updatedAt,decisionKey),
      ]);
      if (!rejected[0].results.length || !rejected[2].results.length) return c.json({error:'条目或提案已更新，请刷新后重试'},409);
    } else {
      await d.delete(s.offerProposals).where(and(eq(s.offerProposals.offerId,o.id),eq(s.offerProposals.updatedAt,proposal.updatedAt)));
    }""")
    replace('src/worker/admin.ts', "  await d.insert(s.reviews).values({ offerId: o.id, action, reviewer: c.get('who'), reason: body.reason ?? null, reasonCode: body.reasonCode ?? null });", "  // Proposal rejection already wrote its audit in the same transaction as memory and deletion.\n  if (!(proposal && o.reviewState === 'approved' && action === 'reject')) {\n    await d.insert(s.reviews).values({ offerId: o.id, action, reviewer: c.get('who'), reason: body.reason ?? null, reasonCode: body.reasonCode ?? null });\n  }")
else:
    raise RuntimeError('expected tests or fix')
