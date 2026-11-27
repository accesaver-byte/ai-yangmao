#!/usr/bin/env bash
# 把 AI 羊毛牧场技能和定时任务装进 Hermes Agent。Hermes 只负责调度；配了仓库通知机器人（.prod.secrets 的 YM_TELEGRAM_*）时消息由它发出，否则用 Hermes 的 Telegram 机器人。
# 重复运行会覆盖技能文件、重建定时任务。
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p ~/.hermes/skills/ai-yangmao ~/.hermes/scripts
# 仓库里的模板用 $AI_YANGMAO_DIR 代表项目根目录；安装时写入本机的实际路径，Hermes 不需要另设环境变量。
ESCAPED_DIR="$(printf '%s' "$DIR" | sed 's/[&|\\]/\\&/g')"
sed "s|\$AI_YANGMAO_DIR|$ESCAPED_DIR|g" "$DIR/integrations/hermes/ai-yangmao/SKILL.md" > ~/.hermes/skills/ai-yangmao/SKILL.md
for script in "$DIR/integrations/hermes/scripts/"ai-yangmao-*.sh; do
  sed "1a\\
AI_YANGMAO_DIR=\"\${AI_YANGMAO_DIR:-$ESCAPED_DIR}\"
" "$script" > ~/.hermes/scripts/"$(basename "$script")"
done
chmod +x ~/.hermes/scripts/ai-yangmao-*.sh
for name in ai-yangmao-digest ai-yangmao-watch; do
  # 历史安装可能留下同名的多个任务；全部清除后只创建一个。
  while IFS= read -r id; do
    [ -n "$id" ] && hermes cron remove "$id" >/dev/null
  done < <(hermes cron list 2>/dev/null | awk -v job="$name" '$1 ~ /^[0-9a-f]+$/ && $2 ~ /^\[/ { id=$1 } $1=="Name:" && $2==job { print id }')
done
hermes cron create '0 9 * * *' --name ai-yangmao-digest --no-agent --script ai-yangmao-digest.sh --deliver telegram
hermes cron create '7 * * * *' --name ai-yangmao-watch --no-agent --script ai-yangmao-watch.sh --deliver telegram
echo "已安装：技能 ~/.hermes/skills/ai-yangmao，定时任务 ai-yangmao-digest（每天 9:00）、ai-yangmao-watch（每小时）"
