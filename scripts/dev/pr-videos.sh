#!/usr/bin/env bash
# pr-videos — 把 Playwright 测试录像传到 OSS，生成一段 markdown（整段贴进 PR/issue 的一个 comment）
# 自动：按内容去重（Playwright 会把同一段录像复制 3 份）、转 mp4（Safari 友好，需 ffmpeg）、上传、列表。
# 用法: pr-videos [-p 项目] [-t 标题] [test-results目录]
set -euo pipefail

BUCKET="gugu-downloads-prod"
BASE="https://download.gugu.nextmind.space"
PROJECT="gugu-desktop"
TITLE="测试录像"

while getopts "p:t:h" o; do
  case "$o" in
    p) PROJECT="$OPTARG" ;;
    t) TITLE="$OPTARG" ;;
    *) echo "用法: pr-videos [-p 项目] [-t 标题] [test-results目录]" >&2; exit 1 ;;
  esac
done
shift $((OPTIND - 1))
DIR="${1:-test-results}"
[ -d "$DIR" ] || { echo "目录不存在: $DIR" >&2; exit 1; }

FF="$(command -v ffmpeg || true)"   # 有 ffmpeg 转 mp4；没有就直接传 webm（Safari 不一定能播）
day="$(date +%Y%m%d-%H%M%S)"
[ -z "$FF" ] && echo "⚠️ 未装 ffmpeg，将直接传 webm（Safari 可能播不了）" >&2

dur() { [ -n "$FF" ] && "$FF" -i "$1" </dev/null 2>&1 | grep -oE 'Duration: [0-9:.]+' | head -1 | sed 's/Duration: //; s/\.[0-9]*$//' || true; }
label() {
  case "$1" in
    *A-left*B-right*) echo "A↔B 并排全程" ;;
    page@*)           echo "单视角录像" ;;
    *)                echo "$1" ;;
  esac
}

declare -A seen
{
  echo "### 🎬 ${TITLE}"
  echo
  echo "| 测试 | 片段 | 时长 | 录像 |"
  echo "|---|---|---|---|"
  # 只扫 test-results，跳过 attachments 副本，再按内容 sha 去重（漏掉 report/data 的重复份）
  while IFS= read -r f; do
    h="$(sha256sum "$f" | cut -c1-16)"
    [ -n "${seen[$h]:-}" ] && continue
    seen[$h]=1
    test="$(basename "$(dirname "$f")" | sed 's/-chromium$//')"
    name="$(basename "$f")"; name="${name%.*}"
    if [ -n "$FF" ]; then
      tmp="${TMPDIR:-/tmp}/prvid-${h}.mp4"
      "$FF" -y -i "$f" -c:v libx264 -pix_fmt yuv420p -crf 28 -movflags +faststart -an "$tmp" </dev/null >/dev/null 2>&1
      key="videos/${PROJECT}/tests/${day}/${h}.mp4"; ct="video/mp4"; src="$tmp"
    else
      key="videos/${PROJECT}/tests/${day}/${h}.webm"; ct="video/webm"; src="$f"
    fi
    ossutil cp "$src" "oss://${BUCKET}/${key}" --content-type "$ct" --force >/dev/null
    [ -n "$FF" ] && rm -f "$tmp"
    echo "| ${test} | $(label "$name") | $(dur "$f") | [▶ 播放](${BASE}/${key}) |"
  done < <(find "$DIR" -path '*/attachments/*' -prune -o -type f -name '*.webm' -print | sort)
}
