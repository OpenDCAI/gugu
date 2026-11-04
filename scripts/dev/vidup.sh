#!/usr/bin/env bash
# vidup — 上传录屏到 gugu OSS，打印并复制公网播放链接
# 用法: vidup [-p 项目] <视频文件> [slug]
#   vidup demo.mp4                  -> videos/misc/<时间戳>-demo.mp4
#   vidup -p gugu-desktop demo.mp4 登录卡顿
set -euo pipefail

BUCKET="gugu-downloads-prod"
BASE_URL="https://download.gugu.nextmind.space"
PROJECT="misc"

usage() { echo "用法: vidup [-p 项目] <视频文件> [slug]" >&2; exit 1; }

while getopts "p:h" opt; do
  case "$opt" in
    p) PROJECT="$OPTARG" ;;
    *) usage ;;
  esac
done
shift $((OPTIND - 1))

FILE="${1:-}"
[ -f "$FILE" ] || { echo "找不到文件: ${FILE:-（未指定）}" >&2; usage; }

ext="$(echo "${FILE##*.}" | tr 'A-Z' 'a-z')"
case "$ext" in
  mp4)  ct="video/mp4" ;;
  webm) ct="video/webm" ;;
  mov)  ct="video/quicktime" ;;
  *) echo "只支持 mp4/webm/mov，收到 .$ext" >&2; exit 1 ;;
esac

raw="${2:-$(basename "$FILE" ".$ext")}"
slug="$(echo "$raw" | tr ' /' '--' | tr -d '?#&')"     # 保留中文，去掉会破坏 URL 的字符
key="videos/${PROJECT}/$(date +%Y%m%d-%H%M%S)-${slug}.${ext}"

echo "↑ 上传 oss://${BUCKET}/${key}" >&2
# ossutil v2：用 --content-type 设 MIME（v1 的 --meta 在 v2 已移除）
ossutil cp "$FILE" "oss://${BUCKET}/${key}" --content-type "${ct}" --force >/dev/null

url="${BASE_URL}/${key}"

# 复制到剪贴板（按平台尽力，没有工具就如实提示）
clip=""
for t in pbcopy wl-copy "xclip -selection clipboard" "xsel -ib" clip.exe; do
  command -v "${t%% *}" >/dev/null 2>&1 && { clip="$t"; break; }
done

echo "$url"
if [ -n "$clip" ] && printf '%s' "$url" | $clip 2>/dev/null; then
  echo "✓ 已复制到剪贴板，直接粘进 issue/PR" >&2
else
  echo "（无剪贴板工具，手动复制上面的链接粘进 issue/PR）" >&2
fi
