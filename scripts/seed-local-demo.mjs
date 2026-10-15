// 固定本地模式，不转发参数，防止演示数据误写远端。
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
if (process.argv.length > 2) throw new Error('本地演示数据命令不接受额外参数。');
process.chdir(fileURLToPath(new URL('../', import.meta.url)));
execFileSync(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'd1', 'execute', 'ai-yangmao', '--local', '--file', 'seed/local-demo.sql'], { stdio: 'inherit' });
