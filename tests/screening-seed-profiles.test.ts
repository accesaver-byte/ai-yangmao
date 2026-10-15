import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe('profile seed', () => {
  it('prints registered source channels for a platform that has notes', () => {
    const sql = execFileSync(process.execPath, ['--import', 'tsx', 'scripts/screening/seed-profiles.ts'], { encoding: 'utf8' });
    const row = sql.split('\n').find(line => line.includes("'openai'"));
    expect(row).toContain('https://openai.com/news/rss.xml');
  });
});
