#!/bin/sh
# 咕咕 server 一行安装(product spec 第 1 条):
#   curl -fsSL https://download.gugu.nextmind.space/releases/server/install.sh | sh
#   curl -fsSL …/install.sh | sh -s -- --channel beta        # 装 Beta 通道
#   wget -qO- …/install.sh | sh                                # 没有 curl 的机器
#   sh install.sh --package 包.tar.gz --version V --sha256 S   # 用现成的包(那台机器上不了网时,桌面下好经 SSH 传过来)
#   sh install.sh --version V [--keep-current]                 # 装指定的那一版(和某台桌面匹配的);--keep-current 只装不切
#
# 不要 root、不要事先装任何东西:只用 sh + (curl 或 wget) + tar + gzip + sha256 校验工具,busybox 也行。
# 装到 ~/.gugu-server/versions/<版本>,current 软链指向在用的版本,~/.local/bin/gugu-server 启动 current。
# 各通道各占一套名字、同一个用户下可以并存(与 apps/desktop/electron/server/server-names.ts 同一条规则):
# 正式版 ~/.gugu-server、gugu-server;其余通道加 -<通道>,如 Beta 是 ~/.gugu-server-beta、gugu-server-beta。
# 装完注册常驻服务(systemd 用户服务 / launchd / 兜底),然后直接开始登录 —— 终端里会出现链接和短码。
#
# 发布布局(scripts/gugu-server/publish-oss.cjs 写):
#   releases/server/<channel>/<os>-<arch>.txt   一行:「<版本> <sha256> <下载地址>」
#   releases/server/<版本>/<os>-<arch>.txt      同一行,钉在这一版上(--version 读它;更早的版本没有,退回通道清单)
#   releases/server/<版本>/gugu-server-<版本>-<os>-<arch>.tar.gz
set -eu

BASE_URL="${GUGU_SERVER_DOWNLOAD_BASE:-https://download.gugu.nextmind.space/releases/server}"
CHANNEL="stable"
DO_LOGIN=1
DO_SERVICE=1
PACKAGE=""
PKG_VERSION=""
PKG_SHA256=""
KEEP_CURRENT=0

while [ $# -gt 0 ]; do
  case "$1" in
    --channel) CHANNEL="$2"; shift 2 ;;
    --channel=*) CHANNEL="${1#*=}"; shift ;;
    --no-login) DO_LOGIN=0; shift ;;
    --no-service) DO_SERVICE=0; shift ;;
    --package) PACKAGE="$2"; shift 2 ;;
    --version) PKG_VERSION="$2"; shift 2 ;;
    --sha256) PKG_SHA256="$2"; shift 2 ;;
    --keep-current) KEEP_CURRENT=1; shift ;;
    *) echo "不认识的参数:$1" >&2; exit 2 ;;
  esac
done

say() { printf '%s\n' "$*"; }
die() { printf '安装失败:%s\n' "$*" >&2; exit 1; }

[ "$(id -u)" = "0" ] && say "提示:不需要 root,agent 会以安装用户的身份运行。"

case "$(uname -s)" in
  Linux) OS=linux ;;
  Darwin) OS=darwin ;;
  *) die "只支持 Linux 和 macOS(当前是 $(uname -s))" ;;
esac
case "$(uname -m)" in
  x86_64|amd64) ARCH=x64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  *) die "不支持的 CPU 架构:$(uname -m)" ;;
esac

# 连不上下载站时别在黑洞地址上干等:连接 15 秒超时,整体重试 3 次。
# fetch 只在后台子 shell 里调(见下载那段):exec 让后台进程就是 curl / wget 本身,中断时一杀就停。
if command -v curl >/dev/null 2>&1; then
  fetch() { exec curl -fsSL --connect-timeout 15 --retry 3 -o "$2" "$1"; }
  fetch_text() { curl -fsSL --connect-timeout 15 --retry 3 "$1"; }
elif command -v wget >/dev/null 2>&1; then
  fetch() { exec wget -q -T 30 -O "$2" "$1"; }
  fetch_text() { wget -q -T 30 -O - "$1"; }
elif [ -z "$PACKAGE" ]; then
  die "需要 curl 或 wget 其中之一"
fi

if command -v sha256sum >/dev/null 2>&1; then
  sha256_of() { sha256sum "$1" | cut -d' ' -f1; }
elif command -v shasum >/dev/null 2>&1; then
  sha256_of() { shasum -a 256 "$1" | cut -d' ' -f1; }
else
  die "需要 sha256sum 或 shasum 来校验下载的包"
fi

case "$CHANNEL" in
  stable) SUFFIX="" ;;
  *) SUFFIX="-$CHANNEL" ;;
esac
SERVER_HOME="${GUGU_SERVER_HOME:-$HOME/.gugu-server$SUFFIX}"
BIN_DIR="$HOME/.local/bin"
BIN_NAME="gugu-server$SUFFIX"

# 数据目录里会放登录态和密钥:只归本人(0700)。已有的旧安装也收回来(以前可能按 0002 建成了组可写)。
mkdir -p "$SERVER_HOME" || die "建不了 $SERVER_HOME"
chmod 700 "$SERVER_HOME" || die "改不了 $SERVER_HOME 的权限"

if [ -n "$PACKAGE" ]; then
  [ -f "$PACKAGE" ] || die "找不到安装包:$PACKAGE"
  [ -n "$PKG_VERSION" ] && [ -n "$PKG_SHA256" ] || die "用现成的包安装时要同时给出 --version 与 --sha256"
  VERSION="$PKG_VERSION"
  SHA256="$PKG_SHA256"
  URL=""
elif [ -n "$PKG_VERSION" ]; then
  # #6264 装指定的那一版(和某台桌面匹配的):先读钉在这一版上的清单,没有(更早发的版本)再看通道清单是不是正好这一版。
  say "正在查询咕咕 server $PKG_VERSION($OS-$ARCH)…"
  MANIFEST="$(fetch_text "$BASE_URL/$PKG_VERSION/$OS-$ARCH.txt" 2>/dev/null)" || MANIFEST=""
  if [ "$(printf '%s' "$MANIFEST" | awk '{print $1}')" != "$PKG_VERSION" ]; then
    MANIFEST="$(fetch_text "$BASE_URL/$CHANNEL/$OS-$ARCH.txt" 2>/dev/null)" || MANIFEST=""
    [ "$(printf '%s' "$MANIFEST" | awk '{print $1}')" = "$PKG_VERSION" ] || die "下载站上没有 $PKG_VERSION 这一版:$BASE_URL/$PKG_VERSION/$OS-$ARCH.txt"
  fi
  VERSION="$PKG_VERSION"
  SHA256="$(printf '%s' "$MANIFEST" | awk '{print $2}')"
  URL="$(printf '%s' "$MANIFEST" | awk '{print $3}')"
  [ -n "$SHA256" ] && [ -n "$URL" ] || die "版本信息格式不对:$MANIFEST"
else
  say "正在查询最新版本($CHANNEL 通道,$OS-$ARCH)…"
  MANIFEST="$(fetch_text "$BASE_URL/$CHANNEL/$OS-$ARCH.txt")" || die "查不到版本信息:$BASE_URL/$CHANNEL/$OS-$ARCH.txt"
  VERSION="$(printf '%s' "$MANIFEST" | awk '{print $1}')"
  SHA256="$(printf '%s' "$MANIFEST" | awk '{print $2}')"
  URL="$(printf '%s' "$MANIFEST" | awk '{print $3}')"
  [ -n "$VERSION" ] && [ -n "$SHA256" ] && [ -n "$URL" ] || die "版本信息格式不对:$MANIFEST"
fi

TARGET="$SERVER_HOME/versions/$VERSION"
# Hand the prepared target to the supervisor's one lifecycle owner. The lease precedes publication,
# including --keep-current's gap before a desktop reports/adopts this version.
if [ "$KEEP_CURRENT" = 1 ]; then
  mkdir -p "$SERVER_HOME/versions/.prepared"
  : > "$SERVER_HOME/versions/.prepared/$VERSION"
fi
# 切换前在用的那个版本:留着(它可能正在跑,也是回退的去处)。
PREV="$(readlink "$SERVER_HOME/current" 2>/dev/null | sed 's#^versions/##')"
# Bootstrap stages packages only. The running supervisor owns all reclamation and rollback pointers.
if [ -x "$TARGET/bin/gugu-server" ]; then
  say "版本 $VERSION 已经装过了。"
else
  mkdir -p "$SERVER_HOME/versions"
  TMP="$(mktemp -d "$SERVER_HOME/versions/.download.XXXXXX")"
  trap 'rm -rf "$TMP"' EXIT
  # 被中断(Ctrl-C、SSH 断开、桌面上点了取消)也要停下载、走 EXIT 把半截下载清掉。
  # 下载放后台再 wait:sh 要等前台命令结束才处理信号,前台跑着 curl 时收到 TERM 会一直下完才退。
  FETCH_PID=""
  trap '[ -n "$FETCH_PID" ] && kill "$FETCH_PID" 2>/dev/null; exit 130' HUP INT TERM
  if [ -n "$PACKAGE" ]; then
    say "正在安装咕咕 server $VERSION(用传过来的安装包)…"
    cp "$PACKAGE" "$TMP/pkg.tar.gz" || die "复制安装包失败(空间不够?)"
  else
    say "正在下载咕咕 server $VERSION …"
    fetch "$URL" "$TMP/pkg.tar.gz" &
    FETCH_PID=$!
    wait "$FETCH_PID" || die "下载失败:$URL"
    FETCH_PID=""
  fi
  say "正在校验并解包…"
  ACTUAL="$(sha256_of "$TMP/pkg.tar.gz")"
  [ "$ACTUAL" = "$SHA256" ] || die "包校验不通过(期望 $SHA256,实际 $ACTUAL),请重试"
  mkdir "$TMP/x"
  tar -xzf "$TMP/pkg.tar.gz" -C "$TMP/x" || die "解包失败"
  INNER="$(find "$TMP/x" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
  [ -x "$INNER/bin/gugu-server" ] || die "包里没有 bin/gugu-server"
  # 试跑:认 selftest 的包(新包)真加载一遍原生模块和自带的 tmux;老包只能跑 help。
  if "$INNER/bin/gugu-server" help 2>/dev/null | grep -q selftest; then
    "$INNER/bin/gugu-server" selftest >/dev/null 2>&1 || die "这个包在本机跑不起来,执行 $INNER/bin/gugu-server selftest 查看原因"
  else
    "$INNER/bin/gugu-server" help >/dev/null 2>&1 || die "这个包在本机跑不起来(系统太旧或架构不符)"
  fi
  rm -rf "$TARGET"
  mv "$INNER" "$TARGET"
fi
# Retain the existing timestamp fact; reclamation is owned by the supervisor.
touch "$TARGET"

# 切换 current:先建临时软链,再改名覆盖。
# ⚠ 不能只写 `mv -f current.tmp current`:current 是指向目录的软链,GNU / BSD 的 mv 都会把 current.tmp
# **挪进**那个目录(versions/<旧版本>/current.tmp)、退出码却是 0 —— current 纹丝不动,升级白做。
# 所以:GNU 用 -T、BSD/macOS 用 -h(都是「把目标当普通文件、整个替换」,一次 rename 完成);两个都不认的
# (busybox 等)退回「先删再改名」,有一瞬间没有 current,但结果对。最后以 readlink 为准,不对就停。
switch_current() {
  want="versions/$VERSION"
  link="$SERVER_HOME/current"
  rm -f "$link.tmp"
  ln -s "$want" "$link.tmp"
  mv -Tf "$link.tmp" "$link" 2>/dev/null ||
    mv -hf "$link.tmp" "$link" 2>/dev/null ||
    { rm -f "$link" && mv "$link.tmp" "$link"; } ||
    die "切换 $link 失败"
  # 某个 mv 认了选项却照样挪进了目录:收拾掉挪进去的那个,按「先删再改名」重来一次。
  if [ "$(readlink "$link" 2>/dev/null)" != "$want" ]; then
    rm -f "$link/current.tmp" "$link.tmp" 2>/dev/null || true
    rm -f "$link" && ln -s "$want" "$link" || die "切换 $link 失败"
  fi
  [ "$(readlink "$link" 2>/dev/null)" = "$want" ] || die "切换 $link 失败(现在指向 $(readlink "$link" 2>/dev/null))"
}
# --keep-current:只装不切(给某个账号换到和它桌面匹配的那一版,由守护进程只重启那一个账号,见 match-version)。
if [ "$KEEP_CURRENT" = 1 ] && [ -n "$PREV" ] && [ -x "$SERVER_HOME/current/bin/gugu-server" ]; then
  say "已安装咕咕 server $VERSION(不改动在用的 $PREV)"
else
  switch_current
fi
# 旧的安装脚本踩了上面那个坑时留下的:versions/<某版本>/current.tmp(一条软链,删了无害)。
for stray in "$SERVER_HOME"/versions/*/current.tmp; do
  if [ -L "$stray" ]; then rm -f "$stray"; fi
done
[ "$KEEP_CURRENT" = 1 ] && [ -n "$PREV" ] || printf '%s\n' "$CHANNEL" > "$SERVER_HOME/channel"
# 装时指定了别的下载站(开发 / 测试):记下来,后台自动升级也从那里取;用正式站装就清掉。
if [ -n "${GUGU_SERVER_DOWNLOAD_BASE:-}" ]; then printf '%s\n' "$BASE_URL" > "$SERVER_HOME/download-base"; else rm -f "$SERVER_HOME/download-base"; fi

mkdir -p "$BIN_DIR"
# 一行启动脚本而不是软链:它把本通道的数据目录钉死递过去 —— 别的通道的 server 拉起的 agent 环境里带着它自己的
# GUGU_SERVER_HOME,换回不认通道名字的旧版本时也不会去找别的目录(与 server-names.ts binLauncher 同一份内容)。
BIN="$BIN_DIR/$BIN_NAME"
rm -f "$BIN"
printf '#!/bin/sh\nGUGU_SERVER_HOME="%s" exec "%s/current/bin/gugu-server" "$@"\n' "$SERVER_HOME" "$SERVER_HOME" > "$BIN"
chmod 755 "$BIN"
CMD="$BIN"
case ":$PATH:" in
  *":$BIN_DIR:"*) CMD="$BIN_NAME" ;;
  *) say "提示:$BIN_DIR 不在 PATH 里,下面的命令写全路径;想直接敲 $BIN_NAME,把它加进 PATH。" ;;
esac

say "已安装咕咕 server $VERSION → $SERVER_HOME/current"

if [ "$DO_SERVICE" = 1 ]; then
  # service install 负责「现在真在跑的是这个版本」:已经有 server 在跑(重新执行安装命令 = 急着升级)时,
  # 它把在跑的那个换到新版本上,最后报出此刻在跑的版本与进程号;没换成就说清怎么办、以非 0 退出。
  "$BIN" service install ||
    say "server 未能以 $VERSION 启动(见上);处理后执行:$CMD service install"
fi

if [ "$DO_LOGIN" = 1 ]; then
  # `status` 在没有账号登录时打「登录的账号:无(执行 gugu-server login)」(见 server-status.ts)。
  if "$BIN" status 2>/dev/null | grep -q '登录的账号:无'; then
    say ""
    # 退出码 3 = 远程隧道暂未开放,login 自己已经说清该怎么加这台机器(见 server-login.ts),不再补一句「登录没完成」。
    LOGIN_RC=0
    "$BIN" login </dev/null || LOGIN_RC=$?
    if [ "$LOGIN_RC" != 0 ] && [ "$LOGIN_RC" != 3 ]; then say "登录没完成,可以之后再执行:$CMD login"; fi
  else
    say "已登录,跳过登录。"
  fi
fi
