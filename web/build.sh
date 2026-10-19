#!/usr/bin/env bash
# 正式网站：把 web/src 拼成 public/index.html（Worker 以静态资源提供；数据运行时从 /api 读取）。
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p public
mkdir -p public/vendor
{
  echo '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">'
  echo '<meta name="description" content="免费大模型 Token、API 额度、会员和生图生视频次数，每天汇总，条条可追官方出处。">'
  cat web/src/head.html
  echo '</head><body>'
  cat web/src/body.html
  echo '<script src="/vendor/echarts.min.js"></script><script src="/membership-core.js"></script><script src="/model-names.js"></script><script src="/app.js"></script></body></html>'
} > public/index.html
node --input-type=module -e 'import { build } from "esbuild"; await build({entryPoints:["src/shared/membership.ts"],bundle:true,format:"iife",globalName:"YMMembership",platform:"browser",outfile:"public/membership-core.js"});'
node --input-type=module -e 'import { build } from "esbuild"; await build({entryPoints:["src/shared/model-names.ts"],bundle:true,format:"iife",globalName:"YMModels",platform:"browser",outfile:"public/model-names.js"});'
cat web/src/data.js web/src/membership.js web/src/app.js > public/app.js
cp node_modules/echarts/dist/echarts.min.js public/vendor/echarts.min.js
cp web/_headers public/_headers
cp web/src/theme.js public/theme.js
node scripts/build-public-skill.mjs
node --check public/theme.js
node --check public/app.js
echo "built public/index.html ($(wc -c < public/index.html) bytes)"
