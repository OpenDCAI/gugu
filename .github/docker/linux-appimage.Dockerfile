# @@@linux-appimage-image — AppImage 必须**原生 x86-64 Linux** 构建(见 electron-builder.cjs 的
# @@@linux-target:vendored tmux 是平台相关的,macOS 宿主会把 Mach-O tmux 打进 Linux 包 ——
# 构建全绿、产物是坏的)。gugu-vps 退租后 fleet 里已经没有这样一台机器,这个镜像就是那台机器。
#
# 三件事决定了它的内容,❌ 别随手精简:
#  ① glibc 基底(❌ alpine/musl):锁文件里的原生 optional dep 是 @parcel/watcher-linux-x64-glibc
#     与 @rollup/rollup-linux-x64-gnu —— musl 基底装到的是另一组包,任务页后端出厂即死(#2299 同型)。
#  ② tmux:build:tmux 靠 `which tmux` 把宿主 tmux 打进包;镜像里没有它就 warn + skip,
#     electron-builder 的 existsSync 守卫随即静默不带 —— 构建全绿、产物少一整个功能。
#     实测线上已发布的 0.2.30 AppImage 里 resources/tmux-bundle/tmux 确实存在(971KB),
#     所以「构建机要有 tmux」是既有事实,不是新要求。
#  ③ 构建原生模块要的工具链(python3/make/g++):node-pty 与 better-sqlite3 会真编译。
#
# ⚠️ glibc 地板:本镜像是 Debian 12(glibc 2.36),而**线上已发布包的原生模块要求 GLIBC_2.34**
#    (实测:下载 0.2.30 AppImage → --appimage-extract → objdump -T | grep GLIBC_ | sort -Vu)。
#    换更新的基底会抬高地板,把 Ubuntu 22.04(2.35)这类存量用户挡在门外,而**冒烟抓不到**
#    (验证者和被验证者在同一个容器里)。换基底前必须重跑这个比对。
#    当前状态:本镜像产出的两个 .node 实测仍是 GLIBC_2.34 → 零回归。
#
# ❌ 不放 xvfb:出厂启动冒烟不在这里跑(容器没有 FUSE,AppImage 无法自挂载),
#    见 cd-release.yml 的 linux-boot-smoke job。
#
# ✅ 但**要放 Electron 的共享库依赖**(下面第二组 apt 包)。这条 2026-08-18 才成立,起因是
#    #3788 把 `verify-dev-native.mjs` 开头那句 `if (process.platform !== 'darwin') exit 0`
#    删掉了 —— 那道 ABI 闸从此在 Linux 上也真跑,而它是靠 `execFileSync(electron, …)`
#    **真启动 Electron 二进制**来验的(ELECTRON_RUN_AS_NODE=1)。`build:app` → `rebuild:native`
#    → 这个脚本,于是链条接进了本镜像。#3788 的说明写着「d15(Linux) 实测过」,但 d15 是台
#    完整开发机、不是这个精简容器,所以照不出来;CD 上的症状是
#    `electron: error while loading shared libraries: libnss3.so`。
#
#    包集**不是猜的**:在本镜像的包集下取 electron@28.3.3,`ldd dist/electron | grep 'not found'`
#    列出 18 个缺失 .so,下面这组就是它们对应的 Debian 12 包。装完复验:ldd 缺失为空,
#    `ELECTRON_RUN_AS_NODE=1 electron -e …` 打出 modules=119 electron=28.3.3(mac1 实测)。
#    ⚠️ 这些库只在**构建期**被用来跑那道闸,不进 AppImage 产物,也不改原生模块的 glibc 地板。
ARG NODE_VERSION=24.14.0
FROM node:${NODE_VERSION}-bookworm
ARG PNPM_VERSION

SHELL ["/bin/bash", "-euo", "pipefail", "-c"]

# 墙内:deb.debian.org 在这台机器上是分钟级/超时,换阿里云源。
RUN sed -i 's|deb.debian.org|mirrors.aliyun.com|g; s|security.debian.org|mirrors.aliyun.com|g' \
      /etc/apt/sources.list /etc/apt/sources.list.d/*.sources /etc/apt/sources.list.d/*.list 2>/dev/null || true; \
    apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ pkg-config git ca-certificates curl file xz-utils procps binutils \
      tmux \
    && apt-get install -y --no-install-recommends \
      libnss3 libnspr4 libgtk-3-0 libgbm1 libdrm2 libasound2 libcups2 libdbus-1-3 \
      libatk1.0-0 libatk-bridge2.0-0 libatspi2.0-0 \
      libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libxkbcommon0 \
    && rm -rf /var/lib/apt/lists/*

# node 由基础镜像按 .node-version 钉;pnpm 由 --build-arg 按 package.json 的 packageManager 钉。
# ❌ corepack 自动写 packageManager(会污染 tracked 的 package.json),显式装。
ENV COREPACK_ENABLE_AUTO_PIN=0
RUN npm install -g "pnpm@${PNPM_VERSION}" && pnpm -v

WORKDIR /work
