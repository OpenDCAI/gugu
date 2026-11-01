#!/usr/bin/env bash
# @@@gugu-server (#6264) — 咕咕 server 的 linux 安装包:打 x64 + arm64,再在干净的 Ubuntu 上冒烟。
# 正式版(cd-release.yml)与 Beta(beta-dogfood.yml)共用这一份 —— ❌ 两条流水线各抄一份,出厂闸一改就漂。
#
# 前提:构建容器 $GUGU_LINUX_CONTAINER(linux/amd64)的 /work 里已经构建好主进程(apps/desktop/dist-electron/server.js,
# 库地址已烘焙、过了 bake gate)。x64 就在这个容器里打;arm64 另起一个 arm64 容器,只喂它产物和打包脚本 ——
# 原生模块必须在目标架构上装,node_modules 不能借。两个架构用同一组锁定版本(externals.json,由 x64 这一趟写下;
# 含 ACP 适配器)。pnpm-workspace.yaml 也喂过去:打包脚本从里面读 patchedDependencies。#6394 起一份依赖补丁都没有了,
# patches/ 目录随之删掉 —— ❌ 再把它列进下面的 tar,不存在的路径会让 tar 报错、整条出包失败。
#
# 环境:DOCKER、GUGU_LINUX_CONTAINER、RUNNER_TEMP、GUGU_MISE_CACHE_DIR(setup-ci-slot 导出);GUGU_SERVER_VERSION 可选
# (Beta 的版本号是构建参数,不在 package.json 里)。
# 产物留在容器的 /work/release/server/ 里,由调用方决定传去哪。
#
# @@@server-no-container-downloads — 两个容器里 ❌ 现下任何东西。容器直连墙外是涓流:2026-10-09 run 37945135302
# 这一步 29 分钟,其中 tmux + node 归档两架构各 ~9 分钟,arm64 的 npm install 9 分钟。
#  · node:两个容器都是官方 node:<.node-version>-bookworm 镜像,包里的 node 直接取镜像 /usr/local 那份
#    (GUGU_SERVER_NODE_PREFIX;build-gugu-server.mjs 核它的版本等于 .node-version,不等就停)。
#  · tmux:与 mise 同一个内容寻址缓存,宿主预取(--pin tmux-release.json)、只读挂载。
#  · npm install:npm 缓存放在专用卷里(构建容器挂在 /npm-cache 的那个卷;卷名只在工作流的 docker run 里写一次,
#    这里从容器读出来给 arm64 那一趟挂同一个),两个架构、跨 run 共用;better-sqlite3 的预编译件
#    (prebuild-install 存在 <npm 缓存>/_prebuilds)随之复用。❌ 与 pnpm store 卷或槽缓存混用。
#    并发:npm 缓存(cacache)按内容哈希寻址,先写临时文件再原子 rename,索引只追加、每行自带校验和、读时丢弃坏行
#    ⇒ 两个 job 同时读写同一个卷,最坏是各下一份同样的内容,不会读到半截文件。
#  · node-gyp(node-pty 在 linux 上从源码编):npm_config_nodedir 指向镜像自带的头文件,❌ 再去 nodejs.org 拉 headers。
set -euo pipefail
: "${DOCKER:?}" "${GUGU_LINUX_CONTAINER:?}" "${RUNNER_TEMP:?}" "${GUGU_MISE_CACHE_DIR:?}"
VERSION_ENV="GUGU_SERVER_VERSION=${GUGU_SERVER_VERSION:-}"
here="$(dirname "$0")"
bash "$here/../seed-mise-cache.sh" linux-arm64
bash "$here/../seed-mise-cache.sh" --pin "$here/tmux-release.json" --base https://github.com/tmux/tmux-builds/releases/download \
  linux-x64 linux-arm64
# 远程隧道的中转客户端 frpc(scripts/build/build-frpc-bundle.mjs),同一个缓存、同一条「容器里不联网」的规矩。
bash "$here/../seed-mise-cache.sh" --pin "$here/../frpc-release.json" --base https://github.com/fatedier/frp/releases/download \
  linux-x64 linux-arm64
NODE_PIN="$(tr -d '[:space:]' < "$here/../../.node-version")"
NPM_CACHE_VOLUME=$("$DOCKER" inspect -f '{{range .Mounts}}{{if eq .Destination "/npm-cache"}}{{.Name}}{{end}}{{end}}' "$GUGU_LINUX_CONTAINER")
[ -n "$NPM_CACHE_VOLUME" ] || { echo "::error::构建容器没有在 /npm-cache 挂 npm 缓存卷(工作流的 docker run 漏了 -v)" >&2; exit 1; }
NO_DOWNLOAD_ENV=(-e npm_config_cache=/npm-cache -e npm_config_nodedir=/usr/local -e GUGU_SERVER_NODE_PREFIX=/usr/local)

"$DOCKER" exec -e "$VERSION_ENV" "${NO_DOWNLOAD_ENV[@]}" "$GUGU_LINUX_CONTAINER" \
  bash -lc 'rm -rf release/server && node scripts/build/build-gugu-server.mjs'
# arm64 那一趟:产物与打包脚本用 tar 流送进 arm64 容器,打完的包再用 tar 流送回构建容器 —— ❌ 经宿主目录 bind-mount:
# mac1 上 colima 的共享目录里,node 24 的 fs.cpSync 报 EACCES(同样的拷贝 cp -r 没事;2026-09-25 实测),
# 打包脚本拷 dist-electron 用的正是 cpSync。容器自己的文件系统里没有这个问题(x64 那一趟就是)。
# 打包日志走 stderr,stdout 只留回程的 tar 流。
# 唯一的例外是 mise 归档缓存(seed-mise-cache.sh 预取,含 tmux):只读挂载、只被校验与 tar 读取,不经 cpSync;
# 只读 ⇒ 未命中时当场报错,❌ 在容器里直连 GitHub 涓流。npm 缓存是 docker 命名卷(在 VM 里),不是宿主目录。
"$DOCKER" exec "$GUGU_LINUX_CONTAINER" tar -C /work -cf - \
  package.json .node-version pnpm-workspace.yaml scripts apps/desktop/dist-electron apps/desktop/preinstalled-apps \
  apps/desktop/src/session/shared/core/agents/mise-release.json release/server/externals.json \
  | "$DOCKER" run -i --rm --platform linux/arm64 -w /work \
      -v "$GUGU_MISE_CACHE_DIR:/mise-cache:ro" -e GUGU_MISE_CACHE_DIR=/mise-cache \
      -v "$NPM_CACHE_VOLUME:/npm-cache" "${NO_DOWNLOAD_ENV[@]}" \
      -e NODE_OPTIONS=--dns-result-order=ipv4first -e "$VERSION_ENV" "node:$NODE_PIN-bookworm" \
      bash -lc 'set -euo pipefail
                [ "$(uname -m)" = aarch64 ] || { echo "::error::不是 aarch64 容器" >&2; exit 1; }
                tar -xf -
                GUGU_SERVER_EXTERNALS=release/server/externals.json node scripts/build/build-gugu-server.mjs 1>&2
                cd release/server && tar -cf - gugu-server-*-linux-arm64.tar.gz*' \
  | "$DOCKER" exec -i "$GUGU_LINUX_CONTAINER" tar -C /work/release/server -xf -
"$DOCKER" exec "$GUGU_LINUX_CONTAINER" bash -lc 'ls -lh release/server/*.tar.gz'

# 出厂闸:在**干净的** Ubuntu 22.04(glibc 2.35,我们承诺的最低一档)里以普通用户解包、跑起来。
# 验证者和被验证者不同环境,这一步才抓得住「包里少了东西 / 依赖了构建机上才有的库」。
# 原生模块的 glibc 地板与桌面 Linux 包同一条红线(GLIBC_2.34)。
out="$RUNNER_TEMP/gugu-server-smoke"
rm -rf "$out" && mkdir -p "$out"
"$DOCKER" cp "$GUGU_LINUX_CONTAINER:/work/release/server/." "$out/"
cp "$here/smoke-app-tools.mts" "$out/"   # 预装 App 的 tools/list(见下)
chmod -R a+rX "$out"   # 同上:冒烟容器以只读挂载读这些包
for arch in x64 arm64; do
  platform=$([ "$arch" = x64 ] && echo linux/amd64 || echo linux/arm64)
  pkg=$(ls "$out"/gugu-server-*-linux-$arch.tar.gz)
  "$DOCKER" run --rm --platform "$platform" -v "$out:/pkg:ro" -e PKG="$(basename "$pkg")" ubuntu:22.04 bash -c '
    set -euo pipefail
    mkdir -p /opt && tar -xzf "/pkg/$PKG" -C /opt
    d=$(ls -d /opt/gugu-server-*)
    useradd -m smoke
    for f in better-sqlite3/build/Release/better_sqlite3.node node-pty/build/Release/pty.node; do
      got=$(grep -ao "GLIBC_2\.[0-9]*" "$d/app/node_modules/$f" | sort -Vu | tail -1)
      top=$(printf "%s\nGLIBC_2.34\n" "$got" | sort -V | tail -1)
      [ "$top" = GLIBC_2.34 ] || { echo "::error::$PKG 里 $f 要求 $got,高于 GLIBC_2.34"; exit 1; }
      echo "glibc ok: $f -> $got"
    done
    # 数据目录按包的通道定(正式版 ~/.gugu-server,Beta ~/.gugu-server-beta):问它自己,❌ 写死。
    home=$(su smoke -c "$d/bin/gugu-server status" | sed -n "s/^数据目录:\(.*\)\$/\1/p")
    [ -n "$home" ] || { echo "::error::$PKG 的 status 没报数据目录"; exit 1; }
    # Beta 包必须带 GUGU_TIER=beta 出厂,否则目录、单元名、tmux 标签都按正式版走。
    case "$PKG:$home" in *-beta.*:*.gugu-server-beta) ;; *-beta.*:*) echo "::error::$PKG 是 Beta 包,数据目录却是 $home(没带 GUGU_TIER=beta?)"; exit 1 ;; esac
    su smoke -c "$d/bin/gugu-server run > /tmp/run.log 2>&1 &"
    for i in $(seq 1 60); do grep -qs "咕咕 server 已启动" /tmp/run.log && break; sleep 1; done
    grep -q "咕咕 server 已启动" /tmp/run.log || { cat /tmp/run.log; echo "::error::$PKG 起不来"; exit 1; }
    # 守护进程不加载主进程;原生模块(任务库 better-sqlite3、终端 node-pty)是在账号进程里加载的。
    # 造一个没登录的空账号,直接起它的进程,看任务页后端起没起来 —— 这才证明原生模块在这台机器上能加载。
    acct=00000000-0000-4000-8000-000000000000
    su smoke -c "mkdir -p $home/accounts/$acct && echo {} > $home/accounts/$acct/account.json"
    su smoke -c "$d/bin/gugu-server run-account $acct > /tmp/acct.log 2>&1 &"
    for i in $(seq 1 90); do grep -qs "session page backend serving" /tmp/acct.log && break; sleep 1; done
    grep -q "session page backend serving" /tmp/acct.log || { cat /tmp/acct.log; echo "::error::$PKG 账号进程起不来(原生模块?)"; exit 1; }
    # 替身缺成员:server-entry 对 electron.X 缺了的会在 stderr 喊一句(这里两份日志都收了 stderr)。
    if grep -h "未在 server-electron-shim.ts 覆盖" /tmp/run.log /tmp/acct.log; then echo "::error::$PKG 用到了替身没有的 electron 成员(上面那几行)"; exit 1; fi
    # 预装 App 的程序照咕咕起程序的样子起一次、问 tools/list —— 程序在 server 的 node 上能不能起来。
    su smoke -c "$d/node/bin/node /pkg/smoke-app-tools.mts $d" || { echo "::error::$PKG 预装 App 的程序起不来(上面那几行)"; exit 1; }
    echo "smoke ok: $PKG"
  '
done
