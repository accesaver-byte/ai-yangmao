// 只导入已下载的公开快照；无网络、无线上连接、无凭据读取。
import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { resolve, relative, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync, backup } from 'node:sqlite';
import { getTableColumns } from 'drizzle-orm';
import { offers, platforms } from '../src/db/schema';

const root = fileURLToPath(new URL('../', import.meta.url));
process.chdir(root);
if (process.argv.length !== 3) throw new Error('用法：node --import tsx scripts/import-public-local.ts .wrangler/public-import/<快照目录>');
const snapshot = resolve(process.argv[2]);
const within = relative(resolve('.wrangler/public-import'), snapshot);
if (within.startsWith('..') || resolve(snapshot) === resolve('.wrangler/public-import')) throw new Error('快照须位于本项目 .wrangler/public-import 的子目录。');
const load = (name: string) => JSON.parse(readFileSync(join(snapshot, name + '.json'), 'utf8').replace(/^\uFEFF/, ''));
const offerData = load('offers'), platformData = load('platforms'), catalog = load('memberships');
const publicOffers = offerData.offers as Record<string, any>[];
const publicPlatforms = platformData.platforms as Record<string, any>[];
if (!Array.isArray(publicOffers) || !publicOffers.length || offerData.count !== publicOffers.length) throw new Error('活动快照不完整。');
if (!Array.isArray(publicPlatforms) || platformData.count !== publicPlatforms.length) throw new Error('平台快照不完整。');
if (!Number.isInteger(catalog.revision) || !Array.isArray(catalog.products) || !Array.isArray(catalog.plans)) throw new Error('会员目录不完整。');
const platformIds = new Set(publicPlatforms.map(p => p.id));
if (new Set(publicOffers.map(o => o.id)).size !== publicOffers.length || platformIds.size !== publicPlatforms.length) throw new Error('快照包含重复 ID。');
for (const p of publicPlatforms) if (!p.id || p.status !== 'approved') throw new Error('只接受公开已准入平台。');
for (const o of publicOffers) {
  if (!o.id || o.reviewState !== 'approved' || !platformIds.has(o.platformId) || !o.evidence || !Array.isArray(o.requirements)) throw new Error('只接受具有已准入平台和公开证据的已批准活动。');
}

const state = resolve('.wrangler/state/v3/d1/miniflare-D1DatabaseObject');
const candidates = readdirSync(state).filter(n => n.endsWith('.sqlite')).filter(n => {
  const db = new DatabaseSync(join(state, n), { readOnly: true });
  try { return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='offers'").get(); }
  finally { db.close(); }
});
if (candidates.length !== 1) throw new Error('无法唯一确定本项目本地 D1 数据库，停止导入。');
const db = new DatabaseSync(join(state, candidates[0]));
db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
try {
  const existing = db.prepare("SELECT count(*) n FROM offers WHERE id NOT IN ('local-demo-limited','local-demo-standing','local-demo-pending')").get();
  if (existing?.n !== 0) throw new Error('本地已有非演示活动。为保留后续开发修改，不自动覆盖；请另建本地数据库后导入。');
  const backupPath = join(snapshot, 'before-import.sqlite');
  if (existsSync(backupPath)) throw new Error('备份已存在，使用新的快照目录，避免覆盖。');
  await backup(db, backupPath);
  const upsert = (table: typeof offers | typeof platforms, tableName: string, row: Record<string, any>, excluded: string[] = []) => {
    const cols = getTableColumns(table);
    const entries = Object.entries(cols).filter(([key]) => Object.hasOwn(row, key) && !excluded.includes(key));
    const names = entries.map(([, col]) => '"' + col.name + '"');
    const values = entries.map(([key]) => row[key] == null ? null : typeof row[key] === 'object' ? JSON.stringify(row[key]) : row[key]);
    db.prepare(`INSERT INTO ${tableName} (${names.join(',')}) VALUES (${names.map(() => '?').join(',')}) ON CONFLICT(id) DO UPDATE SET ${names.filter(n => n !== '"id"').map(n => `${n}=excluded.${n}`).join(',')}`).run(...values);
  };
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const p of publicPlatforms) upsert(platforms, 'platforms', p);
    let placeholders = 0;
    for (const o of publicOffers) {
      if (o.sourceId && !db.prepare('SELECT id FROM sources WHERE id=?').get(o.sourceId)) {
        // 公开记录只暴露 sourceId，没有完整采集配置。只补禁用的关联行，不伪造采集历史。
        db.prepare("INSERT INTO sources(id,platform_id,kind,url,tier,enabled,auto_publish,config) VALUES (?,?,'manual',?,'lead',0,0,?)")
          .run(o.sourceId, o.platformId, o.evidence.url, JSON.stringify({ localPublicImport: true }));
        placeholders++;
      }
      upsert(offers, 'offers', o, ['reviewMemo', 'reviewSuggestion', 'officialReview', 'withdrawnReason']);
    }
    db.prepare('UPDATE membership_catalog SET revision=?,data_json=? WHERE id=1').run(catalog.revision, JSON.stringify({ products: catalog.products, plans: catalog.plans }));
    // 仅替换本次初始化创建的三个虚构条目；任何关联冲突都会回滚。
    db.exec("DELETE FROM offers WHERE id IN ('local-demo-limited','local-demo-standing','local-demo-pending'); DELETE FROM platforms WHERE id='local-demo';");
    const count = db.prepare('SELECT count(*) n FROM offers').get()?.n;
    if (count !== publicOffers.length || db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('数量或关联完整性检查失败。');
    db.exec('COMMIT');
    const report = { importedAt: new Date().toISOString(), source: load('provenance'), offers: count, platforms: publicPlatforms.length, membershipProducts: catalog.products.length, membershipPlans: catalog.plans.length, disabledSourcePlaceholders: placeholders, backup: relative(root, backupPath), omitted: ['private review history', 'production jobs and credentials', 'visitor comments', 'collection run history', 'daily delivery state'] };
    writeFileSync(join(snapshot, 'import-report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } catch (error) { db.exec('ROLLBACK'); throw error; }
} finally { db.close(); }
