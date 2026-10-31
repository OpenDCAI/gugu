#!/usr/bin/env bash
# 从当前 Gugu checkout 启动隔离的开发实例，不依赖内部开发插件。
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "dev-app: 请先进入 Gugu checkout。" >&2
  exit 1
}
cd "$repo_root"
node -e 'if (require("./package.json").name !== "gugu") process.exit(1)' || {
  echo "dev-app: 当前 checkout 不是 Gugu。" >&2
  exit 1
}
case "${1:-}" in
  "") command=dev ;;
  --web) command=dev:web ;;
  *) echo "用法: bash scripts/dev/dev-app.sh [--web]" >&2; exit 1 ;;
esac

if command -v shasum >/dev/null 2>&1; then hasher=(shasum -a 256); else hasher=(sha256sum); fi
slot_hash="$(printf '%s' "$repo_root" | "${hasher[@]}" | awk '{print $1}')"
[[ "$slot_hash" =~ ^[0-9a-f]{64}$ ]] || { echo "dev-app: 无法生成 checkout 标识。" >&2; exit 1; }
profile_root="$HOME/.gugu-dev-${slot_hash:0:8}"

# 运行中的 agent 会继承日用实例路径；必须在子进程的最终环境中覆盖两项。
# 如需指定路径，使用开发专用变量，避免误用继承的 GUGU_*。
export GUGU_HOME="${GUGU_DEV_HOME:-$profile_root/home}"
export GUGU_USER_DATA_DIR="${GUGU_DEV_USER_DATA_DIR:-$profile_root/user-data}"
export GUGU_DEBUG_PORT="${GUGU_DEBUG_PORT:-$((9300 + 0x${slot_hash:0:3} % 200))}"
unset ELECTRON_RUN_AS_NODE

if [ -z "${GUGU_DB_TARGET:-}" ]; then
  echo "dev-app: 未指定 GUGU_DB_TARGET；请核对当前 .envs 配置。" >&2
fi
log_path="${GUGU_DEV_LOG:-${TMPDIR:-/tmp}/gugu-dev-${slot_hash:0:8}.log}"
printf 'dev-app: home=%s\nuserData=%s\nCDP=http://127.0.0.1:%s\nlog=%s\n' \
  "$GUGU_HOME" "$GUGU_USER_DATA_DIR" "$GUGU_DEBUG_PORT" "$log_path"
arguments=("$command")
if [ -n "${GUGU_DEV_PORT:-}" ]; then
  [[ "$GUGU_DEV_PORT" =~ ^[0-9]+$ ]] && [ "$GUGU_DEV_PORT" -ge 1024 ] && [ "$GUGU_DEV_PORT" -le 65535 ] || {
    echo "dev-app: GUGU_DEV_PORT 必须是 1024–65535 的端口。" >&2
    exit 1
  }
  arguments+=(--port "$GUGU_DEV_PORT")
fi
pnpm "${arguments[@]}" 2>&1 | tee "$log_path"
