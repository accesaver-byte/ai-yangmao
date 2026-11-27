#!/usr/bin/env bash
# Hermes 定时任务：每小时检查一次。只有"48 小时内截止的新上架"或"采集故障"时才输出 → 才发消息。
# AI_YANGMAO_DIR：本机项目克隆的根目录，由 scripts/install-hermes.sh 安装时写入；未设置时静默退出。
# 配了仓库通知机器人（.prod.secrets 的 YM_TELEGRAM_*）时由 ym send 直接发出、stdout 为空，Hermes 不再转发；
# 机器人发送失败时把告警打印出来，仍由 Hermes 兜底送达。
cd "${AI_YANGMAO_DIR:-/nonexistent}" 2>/dev/null || exit 0
ym() { ./node_modules/.bin/tsx scripts/ym.ts "$@"; }
out="$(ym dispatch urgent 2>&1; ym health 2>&1)"
out="$(printf "%s" "$out" | grep -v "^npm notice" | sed '/^$/d')"
[ -z "$out" ] && exit 0
if ym telegram-status >/dev/null 2>&1; then
  printf "%s" "$out" | ym send >/dev/null 2>&1 && exit 0
fi
printf "%s" "$out"
