#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
export PATH="$HOME/.bun/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
if command -v bun >/dev/null 2>&1; then
  runner=(bun)
elif command -v npx >/dev/null 2>&1; then
  echo '首次启动：正在准备 Bun 运行环境…'
  runner=(npx --yes --package=bun@1.4.2 bun)
else
  echo '请先安装 Bun：https://bun.sh，然后再次双击此文件。'
  read -r -p '按回车关闭窗口。' _
  exit 1
fi
"${runner[@]}" install --frozen-lockfile
exec "${runner[@]}" run start
