#!/usr/bin/env bash
# @@@2302 产物启动冒烟(#2299「出厂即死」类的最宽网):真启动打包出的 AppImage,等主进程
# [sessionpage] boot OK 正向日志——不关心根因(缺依赖/ABI/协议/env 烘焙),只问出厂的东西活没活。
# 首发实弹(PR #2303)战果:当场逮住 linux 产物缺 @parcel/watcher-linux-x64-glibc(linux 任务页
# 出厂即死,静态闭包校验按设计逮不到 optional 平台包——冒烟正是它的兜底)。
#
# 两个实测踩坑(ci-device 真机复现定型,别回退):
#  1. ❌ --appimage-extract-and-run + Chromium 参数:electron-builder 的 AppRun 在 APPDIR 未设时
#     拿 $1(我们的 --ozone-platform=…)当文件名向上找目录 → APPDIR 空 → exec "/gugu" → 127。
#     → 手动 --appimage-extract 后显式设 APPDIR 再跑。
#  2. ❌ --ozone-platform=headless:electron 28 在 ci-device 上 Chromium 初始化段 segfault。
#     → xvfb-run 虚拟显示(ci-device 已装;缺失 fail-loud)。
# 日志契约:main.ts 的 boot OK / FAILED 文案改动须同步本脚本 grep。
#  ⚠ 打包版默认不写 stdout(#2382 起按 app.isPackaged 静音)→ 本脚本显式 GUGU_LOG_STDOUT=1,并同时接受
#    落盘文件里的同一行。改这两处任一,先想清楚这条断言还找不找得到那行。
# 用法: bash scripts/appimage-boot-smoke.sh <AppImage> [timeout-sec=120]
set -euo pipefail
APPIMAGE="${1:?用法: appimage-boot-smoke.sh <path-to-AppImage> [timeout-sec]}"
TIMEOUT="${2:-120}"
[ -f "$APPIMAGE" ] || { echo "::error::AppImage 不存在: $APPIMAGE"; exit 1; }
command -v xvfb-run >/dev/null || { echo "::error::runner 缺 xvfb-run(apt install xvfb)——冒烟无法跑"; exit 1; }
APPIMAGE="$(readlink -f "$APPIMAGE")"
SMOKE_HOME="$(mktemp -d)"
LOG="$SMOKE_HOME/boot.log"
APP_PID=""
# 清理绝不许改写成败:trap 内关 errexit——rm 与将死未死的 Electron 子进程赛跑时
# (kill -9 只到 xvfb-run 包装层,孤儿 renderer 还在写 profile)ENOTEMPTY 会把
# exit 0 翻成 1(实翻车:冒烟 OK 却步骤红)。失败重试一把,再不行留给 runner 临时区。
cleanup() {
  set +e
  if [ -n "$APP_PID" ]; then
    kill "$APP_PID" 2>/dev/null
    sleep 1
    kill -9 "$APP_PID" 2>/dev/null
  fi
  rm -rf "$SMOKE_HOME" 2>/dev/null
  [ -d "$SMOKE_HOME" ] && { sleep 1; rm -rf "$SMOKE_HOME" 2>/dev/null; }
  return 0
}
trap cleanup EXIT
chmod +x "$APPIMAGE"
# 解压失败必须响亮:此前输出全吞,失败=零日志 exit 1,CI 上无从诊断(bcaa3918 实翻车)。
ls -l "$APPIMAGE"
(cd "$SMOKE_HOME" && "$APPIMAGE" --appimage-extract >"$SMOKE_HOME/extract.log" 2>&1) || {
  echo "::error::AppImage 解压失败(产物损坏/截断?)——extract.log 尾:"
  tail -20 "$SMOKE_HOME/extract.log" || true
  exit 1
}
APPDIR="$SMOKE_HOME/squashfs-root"
[ -x "$APPDIR/AppRun" ] || { echo "::error::AppImage 解压后无 AppRun"; exit 1; }
# root 下 Chromium 强制 --no-sandbox;HOME 隔离防污染;boot OK 在登录前打出(boot lane 在 whenReady 即跑),无需账号。
# @@@2382 GUGU_LOG_STDOUT=1:打包版默认**不写 stdout**(生产按 app.isPackaged 静音),而本脚本的启动断言
# 正是 grep stdout 里的 `[sessionpage] boot OK` —— 不显式打开就必然 120s 超时(实测踩过一次)。这条 env 就是
# 为这种「我要看输出」的场景存在的。下面的等待循环同时也认落盘文件里的同一行,双保险。
HOME="$SMOKE_HOME" XDG_CONFIG_HOME="$SMOKE_HOME/.config" APPDIR="$APPDIR" GUGU_LOG_STDOUT=1 \
  xvfb-run -a "$APPDIR/AppRun" --no-sandbox --disable-gpu --disable-dev-shm-usage \
  >"$LOG" 2>&1 &
APP_PID=$!
for i in $(seq 1 "$TIMEOUT"); do
  if grep -qE '\[sessionpage\] (FAILED|boot failed)' "$LOG" 2>/dev/null; then
    echo "::error::任务页后端启动失败(出厂即死,#2299 同类)——主进程日志尾:"
    tail -40 "$LOG"
    exit 1
  fi
  LOGFILE="$(find "$SMOKE_HOME" -name gugu-main.log -size +0c -print -quit 2>/dev/null || true)"
  if grep -q '\[sessionpage\] boot OK' "$LOG" 2>/dev/null \
     || { [ -n "$LOGFILE" ] && grep -q 'boot OK' "$LOGFILE" 2>/dev/null; }; then
    echo "[boot-smoke] OK(${i}s)— $(grep -h '\[sessionpage\] boot OK' "$LOG" ${LOGFILE:+"$LOGFILE"} 2>/dev/null | head -1)"
    # @@@2382 - 顺便验「日志真落盘了」。为什么值得在这儿多问一句:日志的初始化顺序坏掉时(模块级
    # createLogger 早于 main.ts 给目录),app 照样活、boot OK 照样打,只是**一行都不落盘、一声不响**
    # —— 单测照不出来(它们都先调 initLogging),只有真启动的产物能。实翻车一次,别再回退。
    if [ -z "$LOGFILE" ]; then
      echo "::error::app 起来了但没有日志文件(userData/logs/gugu-main.log 不存在或为空)——日志基座的初始化顺序坏了,见 docs/logging.md 纪律③。主进程输出尾:"
      tail -40 "$LOG"
      exit 1
    fi
    echo "[boot-smoke] 日志落盘 OK — $LOGFILE($(wc -c <"$LOGFILE") 字节)"
    exit 0
  fi
  if ! kill -0 "$APP_PID" 2>/dev/null; then
    echo "::error::app 进程提前退出(早于 boot OK)——日志尾:"
    tail -40 "$LOG"
    exit 1
  fi
  sleep 1
done
echo "::error::${TIMEOUT}s 内未见 [sessionpage] boot OK——日志尾:"
tail -60 "$LOG"
exit 1
