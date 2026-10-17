import { expect, it } from 'vitest';
import { DAILY_THEMES, dailyTheme } from '../src/worker/admin';

const offer = (id: string, o: Partial<{ type: string; audience: string; requirements: string[]; modalities: string[] }>) => ({ id, o: { type: 'standing', audience: 'all', requirements: ['net'], modalities: ['text'], ...o } });
const pool = [
  ...Array.from({ length: 8 }, (_, i) => offer('std' + i, { type: 'standing' })),
  ...Array.from({ length: 4 }, (_, i) => offer('new' + i, { type: 'new' })),
  ...Array.from({ length: 3 }, (_, i) => offer('perk' + i, { type: 'perk', audience: 'old' })),
  offer('stu', { type: 'gift', requirements: ['student'] }),
];
const at = (day: string) => new Date(day + 'T03:00:00Z');

// 2026-10-16: the 常驻榜 showed the same five standing perks every day; it now rotates by theme.
it('consecutive days feature different themes, skipping themes with too few claimable perks', () => {
  const week = ['2026-10-16', '2026-10-17', '2026-10-18', '2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23'].map(d => dailyTheme(pool, at(d), 5).theme.key);
  expect(new Set(week).size).toBeGreaterThanOrEqual(3);
  expect(week).not.toContain('student'); // only one student perk
  for (let i = 1; i < week.length; i++) expect(week[i]).not.toBe(week[i - 1]); // no theme two days running
  const picked = dailyTheme(pool, at('2026-10-16'), 5);
  expect(picked.items.every(x => DAILY_THEMES.find(t => t.key === picked.theme.key)!.match(x.o))).toBe(true);
});

it('when a theme comes round again, it starts from the next batch', () => {
  const n = 3, first = at('2026-10-16'); // viable themes in this pool: newuser, member, standing
  const again = new Date(first.getTime() + n * 86400_000);
  const a = dailyTheme(pool, first, 5), b = dailyTheme(pool, again, 5);
  expect(b.theme.key).toBe(a.theme.key);
  expect(b.items.map(x => x.id)).not.toEqual(a.items.map(x => x.id));
});
