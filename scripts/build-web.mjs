// 使用 Node 构建，Windows 与 CI 共用同一入口。
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';

process.chdir(fileURLToPath(new URL('../', import.meta.url)));
await mkdir('public/vendor', { recursive: true });
const html = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n'
  + '<meta name="description" content="免费大模型 Token、API 额度、会员和生图生视频次数，每天汇总，条条可追官方出处。">\n'
  + await readFile('web/src/head.html', 'utf8') + '</head><body>\n'
  + await readFile('web/src/body.html', 'utf8')
  + '<script src="/initial-data.js"></script><script src="/vendor/echarts.min.js"></script><script src="/membership-core.js"></script><script src="/app.js"></script></body></html>\n';
await writeFile('public/index.html', html);
await build({ entryPoints: ['src/shared/membership.ts'], bundle: true, format: 'iife', globalName: 'YMMembership', platform: 'browser', outfile: 'public/membership-core.js' });
await writeFile('public/app.js', (await Promise.all(['data', 'membership', 'urgent-review', 'app'].map(name => readFile(`web/src/${name}.js`, 'utf8')))).join('\n'));
await Promise.all([
  copyFile('node_modules/echarts/dist/echarts.min.js', 'public/vendor/echarts.min.js'),
  copyFile('web/_headers', 'public/_headers'),
  copyFile('web/src/theme.js', 'public/theme.js'),
  copyFile('web/src/initial-data.js', 'public/initial-data.js'),
]);
await import('./build-public-skill.mjs');
for (const file of ['public/theme.js', 'public/initial-data.js', 'public/app.js']) execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });
console.log(`built public/index.html (${Buffer.byteLength(html)} bytes)`);
