import { expect, it } from 'vitest';
import { auditFixture } from './fixtures/identity/audit';
import { displayOffer } from './fixtures/identity/offer';

// 2026-10-26: an edit that sends only url/tier/excerpts must not erase other stored evidence keys.
it('keeps stored evidence keys the edit does not send', async () => {
  const f = auditFixture(); try {
    const offer = { ...displayOffer(), evidence: { ...displayOffer().evidence, cautions: ['免费模型可能记录提示词'] } };
    await f.call('ingest/offers', [offer], false, { IDENTITY_MODE: 'off' });
    const v = (await f.call(`admin/offers/${offer.id}`, undefined, true, { IDENTITY_MODE: 'off' })).body.reviewVersion;
    const r = await f.call(`admin/offers/${offer.id}/edit`, { fields: { evidence: { url: offer.evidence.url, tier: 'site', excerpts: { benefit: offer.evidence.excerpts.benefit } } }, expectedReviewVersion: v, reason: '只改证据级别' }, true, { IDENTITY_MODE: 'off' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const stored = JSON.parse((f.sqlite.prepare('SELECT evidence FROM offers WHERE id=?').get(offer.id) as { evidence: string }).evidence);
    expect(stored.cautions).toEqual(['免费模型可能记录提示词']);
    expect(stored.excerpts).toEqual({ benefit: offer.evidence.excerpts.benefit });
  } finally { f.sqlite.close(); }
});
