import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { endedBeforeThisMonth } from '../src/shared/collection-window';

// 2026-10-22 (admin): collect perks that run now, start later, or ended this month; older endings stay out.
describe('endedBeforeThisMonth', () => {
  const now = new Date('2026-10-22T12:00:00Z');
  const offer = (claimEnd: string | null, extra: Record<string, unknown> = {}) => ({ claimEnd, endKind: 'date', sourceTz: 'Asia/Shanghai', tags: [], ...extra });
  it('keeps a perk that ended earlier this month and drops one that ended last month', () => {
    expect(endedBeforeThisMonth(offer('2026-10-05'), now)).toBeNull();
    expect(endedBeforeThisMonth(offer('2026-10-01'), now)).toBeNull();
    expect(endedBeforeThisMonth(offer('2026-09-30'), now)).toBe('2026-09-30');
    expect(endedBeforeThisMonth(offer('2026-09-17', { endKind: 'unknown' }), now)).toBe('2026-09-17');
  });
  it('never judges an older post that is still running, a standing perk, or a reset', () => {
    expect(endedBeforeThisMonth(offer(null), now)).toBeNull();
    expect(endedBeforeThisMonth(offer('2026-11-30'), now)).toBeNull();
    expect(endedBeforeThisMonth(offer('2026-01-31', { endKind: 'standing' }), now)).toBeNull();
    expect(endedBeforeThisMonth(offer('2026-09-01', { tags: ['reset'] }), now)).toBeNull();
  });
  it('reads the month in the source timezone and accepts timestamps', () => {
    const lateOct31 = new Date('2026-10-31T20:00:00Z'); // 11-01 04:00 in Shanghai, still 10-31 in Los Angeles
    expect(endedBeforeThisMonth(offer('2026-10-31'), lateOct31)).toBe('2026-10-31');
    expect(endedBeforeThisMonth(offer('2026-10-31', { sourceTz: 'America/Los_Angeles' }), lateOct31)).toBeNull();
    expect(endedBeforeThisMonth(offer('2026-09-30T23:59:59+08:00'), now)).toBe('2026-09-30');
    expect(endedBeforeThisMonth(offer('2026-09-30', { sourceTz: 'Not/AZone' }), now)).toBe('2026-09-30');
    expect(endedBeforeThisMonth(offer('soon'), now)).toBeNull();
  });
});

const mocks = vi.hoisted(() => ({ api: vi.fn(), fetchPage: vi.fn(), extract: vi.fn(), save: vi.fn(), search: vi.fn() }));
vi.mock('../pipeline/lib', async original => ({ ...await original<typeof import('../pipeline/lib')>(), api: mocks.api, fetchPage: mocks.fetchPage }));
vi.mock('../pipeline/llm', () => ({ extract: mocks.extract, modelAvailable: () => true, DeferError: class extends Error {} }));
vi.mock('../pipeline/identity-client', () => ({ postIdentityOffers: mocks.save }));
vi.mock('../pipeline/official-review', () => ({ searchOfficial: mocks.search }));
import { runLeadReviews } from '../pipeline/lead-review';

describe('lead rescue closes a lead whose official perk ended before this month', () => {
  const url = 'https://vendor.example/events/summer';
  const body = 'Summer credits event\nThe event ran from June 1 to June 30, 2026. New users received 500 credits.';
  const platform = { id: 'vendor', name: 'Vendor', site: 'https://vendor.example', xHandles: [], staffHandles: [] };
  const candidate = { key: 'summer', platformId: 'vendor', title: 'Vendor 夏季注册送 500 积分', type: 'free', modalities: ['text'], models: [], claimMethod: 'signup', requirements: ['net'], audience: 'new', valueText: '新用户注册送 500 积分', claimStart: '2026-06-01', claimEnd: '2026-06-30', endKind: 'date', sourceTz: 'UTC', steps: [], excerpts: { benefit: 'New users received 500 credits.', validity: 'The event ran from June 1 to June 30, 2026.' } };
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.api.mockImplementation(async (path: string, request?: unknown) => path.includes('/queue') ? { jobs: [{ id: 9001 }] } : path.endsWith('/claim') ? { claimed: true, jobId: '12345678-1234-4234-8234-123456789012', lead: { id: 9001, title: 'Vendor 夏季送积分', url, raw: 'Vendor summer credits', origin: 'linuxdo' }, platforms: [platform], sources: [{ url: 'https://vendor.example', tier: 'site', platformId: 'vendor' }], existing: [] } : path.startsWith('/corrections') ? { corrections: [] } : { status: (request as { outcome: string }).outcome });
    mocks.fetchPage.mockResolvedValue({ text: body, via: 'direct', originalUrl: url, finalUrl: url, fetchedUrl: url, fetchMethod: 'direct', sourceVerified: true, truncated: false });
    mocks.extract.mockResolvedValue({ offers: [candidate], tokens: 1, costCny: 0 });
    mocks.search.mockResolvedValue([]);
  });
  afterEach(() => vi.restoreAllMocks());
  const run = () => runLeadReviews({ limit: 1, deadlineAt: Date.now() + 60000, dry: false, allowPaid: false, canContinue: () => true, account: () => {}, log: () => {} });
  const receipt = () => mocks.api.mock.calls.find(([path]) => path.endsWith('/result'))?.[1] as Record<string, unknown>;
  it('does not submit the ended perk and closes the lead on the official end date', async () => {
    await run();
    expect(mocks.save).not.toHaveBeenCalled();
    expect(receipt()).toMatchObject({ outcome: 'closed', evidenceUrl: url, quote: 'The event ran from June 1 to June 30, 2026.', reason: expect.stringContaining('2026-06-30 结束（早于本月）') });
  });
  it('still submits a perk from an older post that is running now', async () => {
    mocks.extract.mockResolvedValue({ offers: [{ ...candidate, claimEnd: null, endKind: 'unknown' }], tokens: 1, costCny: 0 });
    mocks.save.mockResolvedValue({ results: [{ id: 'vendor-summer' }] });
    await run();
    expect(mocks.save).toHaveBeenCalledTimes(1);
    expect(receipt()).toMatchObject({ outcome: 'linked' });
  });
});
