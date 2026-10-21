// 独立演示库与静态资源，只监听本机；不读取现有数据库或生产凭据。
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

if (process.argv.length > 2) throw new Error('演示脚本不接受参数或远端模式');
const root = fileURLToPath(new URL('../', import.meta.url));
process.chdir(root);
const demo = resolve(root, '.wrangler', `urgent-preview-${Date.now()}`);
const state = join(demo, 'state');
const assets = join(demo, 'public');
mkdirSync(demo, { recursive: true });
execFileSync('bash', ['web/build.sh'], { stdio: 'inherit' });
cpSync(resolve(root, 'public'), assets, { recursive: true });
const token = 'local-urgent-demo-only'; // 演示环境的非秘密凭据；未用于原开发库或生产。
writeFileSync(join(assets, 'demo-login.js'), `sessionStorage.setItem('ym-admin-token','${token}');`);
const html = readFileSync(join(assets, 'index.html'), 'utf8').replace('<body>', `<body><script src="/demo-login.js"></script><aside style="position:fixed;right:16px;bottom:16px;z-index:9999;padding:10px 16px;border-radius:12px;background:#ffe4a3;color:#352400;border:1px solid #b59037;font:14px sans-serif">独立模拟环境 · 所有福利均为虚构 · 不影响原数据库</aside>`);
writeFileSync(join(assets, 'index.html'), html);
writeFileSync(join(demo, '.dev.vars'), `ADMIN_TOKEN=${token}\nINGEST_TOKEN=local-demo-ingest-only\n`);
const config = join(demo, 'wrangler.json');
writeFileSync(config, JSON.stringify({ name: 'ai-yangmao-urgent-demo', main: resolve(root, 'src/worker/index.ts'), compatibility_date: '2026-09-01', compatibility_flags: ['nodejs_compat'],
  assets: { directory: assets, binding: 'ASSETS', not_found_handling: 'single-page-application', run_worker_first: ['/api/*', '/rss.xml'] },
  d1_databases: [{ binding: 'DB', database_name: 'ai-yangmao-urgent-demo', database_id: '00000000-0000-4000-8000-000000000049', migrations_dir: resolve(root, 'migrations') }],
  vars: { DAILY_TOKEN_CAP: '0', MONTHLY_COST_CAP_CNY: '0', IDENTITY_MODE: 'off', SCREENING_MODE: 'shadow' },
}, null, 2));
const wrangler = resolve(root, 'node_modules/wrangler/bin/wrangler.js');
execFileSync(process.execPath, [wrangler, 'd1', 'migrations', 'apply', 'ai-yangmao-urgent-demo', '--local', '--config', config, '--persist-to', state], { cwd: demo, stdio: 'inherit' });
function files(dir) { return readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]); }
const candidates = files(state).filter(path => path.endsWith('.sqlite') && !path.endsWith('metadata.sqlite'));
if (candidates.length !== 1) throw new Error('演示数据库定位不唯一，停止写入');
const db = new DatabaseSync(candidates[0]);
const now = new Date();
const iso = now.toISOString();
const day = offset => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now.getTime() + offset * 86400_000));
db.exec('PRAGMA foreign_keys=ON');
db.prepare("INSERT INTO platforms(id,name,type,status,site) VALUES('urgent-demo','模拟福利实验室（虚构）','tool','approved','https://example.invalid')").run();
const examples = [
  ['today', '【模拟·马上处理】今日截止的图像体验', 0, 'image'],
  ['priority', '【模拟·优先处理】两天后截止的编程额度', 2, 'text'],
  ['normal', '【模拟·普通待审】七天后的音频体验', 7, 'audio'],
  ['expired', '【模拟·已过期】昨天结束的视频体验', -1, 'video'],
];
const insert = db.prepare(`INSERT INTO offers(id,platform_id,title,type,modalities,claim_method,requirements,audience,value_text,claim_start,claim_end,end_kind,source_tz,review_state,evidence,steps,discovered_at,published_at,review_memo)
  VALUES(?,'urgent-demo',?,'trial',?,'signup','["none"]','all','演示额度：100 次体验，不可实际领取',?,?,'date','Asia/Shanghai','pending',?,?,?,?,?)`);
for (const [id, title, offset, modality] of examples) {
  insert.run('urgent-demo-' + id, title, JSON.stringify([modality]), day(-3), day(offset), JSON.stringify({ url: 'https://example.invalid/' + id, tier: 'site', capturedAt: iso, excerpts: {
    benefit: '此处为本地合成测试原文：演示账号可领取 100 次体验额度，没有真实福利。', eligibility: '模拟条件：所有演示用户均可体验。', claim: '仅用于检查界面，请勿实际领取。', validity: '模拟领取截止日：' + day(offset),
  } }), JSON.stringify(['模拟步骤：查看本地审核界面，不执行真实领取。']), iso, iso, '合成模拟数据，仅存在独立预览数据库。');
}
db.prepare("INSERT INTO leads(id,origin,url,title,raw,status,created_at) VALUES(900001,'manual','https://example.invalid/urgent-lead','【模拟·2小时后截止】限量兑换码待核实','此条是合成线索，模拟需要先核实官方出处的紧急福利。','reviewing',?)").run(iso);
db.prepare(`INSERT INTO screening_items(id,subject_kind,subject_id,state,tier,tier_by,deadline,urgency_quote,signals_json,discovered_at,due_at,updated_at)
  VALUES('lead:900001','lead','900001','awaiting_verify','P0','gate0',?,'模拟线索：两小时后截止','["deadline"]',?,?,?)`).run(new Date(now.getTime() + 2 * 3600_000).toISOString(), iso, iso, iso);
db.close();
console.log(`独立预览：http://127.0.0.1:8788/#admin\n数据目录：${demo}\n样本：4 条待审活动 + 1 条两小时后截止的待核实线索。`);
execFileSync(process.execPath, [wrangler, 'dev', '--local', '--config', config, '--persist-to', state, '--ip', '127.0.0.1', '--port', '8788', '--inspector-port', '9230'], { cwd: demo, stdio: 'inherit' });
