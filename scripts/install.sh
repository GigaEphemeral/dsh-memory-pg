#!/usr/bin/env bash
# 一键安装 @GigaEphemeral/dsh-memory-pg 到指定 DSH profile（macOS / Linux / Windows Git Bash）。
# 用法：./scripts/install.sh [-p <profile>] [-v <version>]
#   -p profile 默认 web；-v version 默认 latest
set -euo pipefail

PROFILE="web"
VERSION="latest"
while getopts "p:v:h" opt; do
  case "$opt" in
    p) PROFILE="$OPTARG" ;;
    v) VERSION="$OPTARG" ;;
    h)
      echo "用法: $0 [-p <profile>] [-v <version>]"
      echo "  -p  目标 profile（默认 web）"
      echo "  -v  安装版本（默认 latest）"
      exit 0
      ;;
    *) exit 1 ;;
  esac
done

if ! command -v dsh >/dev/null 2>&1; then
  echo "错误: 未找到 dsh 命令。请先安装 DSH 并确保 dsh 在 PATH 中；" >&2
  echo "或改用 npx 一次性执行:" >&2
  echo "  npx -y --package @deepseek-ai/dsh dsh plugin --profile web add @GigaEphemeral/dsh-memory-pg@latest" >&2
  exit 1
fi

PKG="@GigaEphemeral/dsh-memory-pg@${VERSION}"
echo "==> dsh plugin --profile ${PROFILE} add ${PKG}"
dsh plugin --profile "${PROFILE}" add "${PKG}"

echo
echo "已安装。bundle 插件 host half 需重启 DSH web 才生效（非 HMR）。"
echo "重启后在设置面板配置数据库连接，即可使用 /memory-pg-* 命令。"
