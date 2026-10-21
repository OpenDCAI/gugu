#!/usr/bin/env bash
# @@@mise-seed (#6661) — 宿主把 linux 容器要内置的 mise 归档放进 $GUGU_MISE_CACHE_DIR,容器只读挂载它、命中即不联网。
# 布局必须与 mise-archive-cache.mjs 一致(<sha256>/<asset>)。由宿主取:runner 的代理只听宿主回环,容器里只能直连 GitHub。
# 整个 gugu-ci 池共用这个目录:先落 .part、核过入库的 sha256 再 mv,别的 job 只会看到完整文件。
# 用法:bash scripts/seed-mise-cache.sh linux-x64 [linux-arm64 …]
# 同一个缓存也放别的「版本 + sha256 入库」的归档(布局内容寻址,互不冲突;读的一侧同为 mise-archive-cache.mjs):
#      bash scripts/seed-mise-cache.sh --pin <同形 json> --base <下载根> <target> …   (如 server 包的 tmux)
set -euo pipefail
: "${GUGU_MISE_CACHE_DIR:?}"
pin="$(dirname "$0")/../apps/desktop/src/session/shared/core/agents/mise-release.json"
base=https://github.com/jdx/mise/releases/download
while [ "${1:-}" = --pin ] || [ "${1:-}" = --base ]; do
  case "$1" in --pin) pin="$2" ;; --base) base="$2" ;; esac
  shift 2
done
version=$(jq -er .version "$pin")
for target in "$@"; do
  asset=$(jq -er --arg t "$target" '.assets[$t].asset' "$pin") || { echo "::error::$pin 里没有 $target" >&2; exit 1; }
  sha=$(jq -er --arg t "$target" '.assets[$t].sha256' "$pin")
  dest="$GUGU_MISE_CACHE_DIR/$sha/$asset"
  if [ -f "$dest" ] && [ "$(shasum -a 256 "$dest" | cut -d' ' -f1)" = "$sha" ]; then
    echo "[seed-mise] cache hit $dest"
    continue
  fi
  mkdir -p "$(dirname "$dest")"
  part="$dest.$$.part"
  trap 'rm -f "$part"' EXIT
  # 速度地板抓涓流(慢而不断时什么重试都不会触发)。重试要换新进程:curl 自带的 --retry 会把已写的字节截回起点
  # (即使带 -C -,mac1 的 curl 8.7.1 实测),新进程带 -C - 才从 .part 续传;.part 只在最终失败时由 trap 删。
  for try in 1 2 3 4; do
    curl --fail --location --silent --show-error --connect-timeout 15 --speed-limit 51200 --speed-time 60 -C - \
      -o "$part" "$base/v$version/$asset" && break
    [ "$try" -lt 4 ] || { echo "::error::$asset 试了 4 次都没下完(速度地板 50KB/s)" >&2; exit 1; }
    sleep $((try * 5))
  done
  got=$(shasum -a 256 "$part" | cut -d' ' -f1)
  [ "$got" = "$sha" ] || { echo "::error::$asset 的 sha256 是 $got,入库的是 $sha" >&2; exit 1; }
  mv -f "$part" "$dest"
  echo "[seed-mise] downloaded $asset → $dest"
done
