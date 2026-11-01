/**
 * 各通道的咕咕 server 在同一台机器、同一个用户下各占一套名字,互不覆盖 —— 与桌面「咕咕 / 咕咕 Beta」并存是同一条规则
 * (main.ts:GUGU_HOME `~/.gugu` / `~/.gugu-<tier>`,tmux 标签 `gugu` / `gugu-<tier>`):正式版不带后缀(已装好的机器
 * 一个字不动),其余通道加 `-<通道>`。数据目录、`~/.local/bin` 里的命令、systemd 单元、launchd 标签、crontab 标记
 * 全从这里取;scripts/gugu-server/install.sh 里同一条规则写成 shell(改这里那边一起改)。
 */
import { tierSuffix } from '@gugu/core/shared/ui/guguLink'

export type ServerNames = {
  /** 家目录下的数据目录名。 */
  homeDir: string
  /** `~/.local/bin` 里的命令名(一行启动脚本,见 binLauncher)。 */
  bin: string
  systemdUnit: string
  launchdLabel: string
  /** crontab 兜底那一行行尾的标记。 */
  cronMark: string
}

/** `channel`:通道名(stable、beta)或 tier(production、beta),同一条规则(linkScheme.mjs tierSuffix)。 */
export function serverNames(channel: string): ServerNames {
  const suffix = tierSuffix(channel)
  return {
    homeDir: `.gugu-server${suffix}`,
    bin: `gugu-server${suffix}`,
    systemdUnit: `gugu-server${suffix}.service`,
    launchdLabel: `space.nextmind.gugu-server${suffix}`,
    cronMark: `# gugu-server${suffix}`,
  }
}

/** vite define 换成字面量;单测里没有这个 define,用 typeof 兜住。 */
declare const __GUGU_TIER__: string | undefined

/**
 * 这一份 server 自己的名字:按构建时烤进包的 tier,❌ 读运行期能改的环境变量。
 * 桌面经 SSH 找的是按连的库定的通道(desktopServerChannel),两边在发布的包里一致:CD 出 Beta 包 tier=beta、连测试库,
 * 正式包 tier=production、连生产库(出厂冒烟 ci-linux-packages.sh 核 Beta 包的数据目录)。自建包要是不一致(tier=production 连测试库),
 * `service install` 写的是 `gugu-server.service` 并立刻重启:同一用户下在跑的正式版会被改指到 `-beta` 目录、停掉,也不再自启。
 */
export function ownServerNames(): ServerNames {
  return serverNames(typeof __GUGU_TIER__ === 'string' ? __GUGU_TIER__ : 'production')
}

/** vite define 换成字面量:这台桌面给别的机器装哪条通道的 server(vite.config.mts serverChannelForDb)。单测里没有,按正式版。 */
declare const __GUGU_SERVER_CHANNEL__: 'stable' | 'beta' | undefined

/** 这台桌面经 SSH 装、找、连的是哪条通道的 server。 */
export function desktopServerChannel(): 'stable' | 'beta' {
  return typeof __GUGU_SERVER_CHANNEL__ === 'string' ? __GUGU_SERVER_CHANNEL__ : 'stable'
}

/** 远端 shell 里的数据目录与命令(桌面经 SSH 拼脚本用):显式 GUGU_SERVER_HOME 最大,否则按通道的默认目录。 */
export function remoteServerPaths(channel: string): { home: string; bin: string; binTilde: string } {
  const names = serverNames(channel)
  return {
    home: `"\${GUGU_SERVER_HOME:-$HOME/${names.homeDir}}"`,
    bin: `"$HOME/.local/bin/${names.bin}"`,
    binTilde: `~/.local/bin/${names.bin}`,
  }
}

/**
 * `~/.local/bin/<命令>` 的内容:一行启动脚本,把本通道的数据目录钉死递过去 —— 别的通道的 server 拉起的 agent 环境里
 * 带着它自己的 GUGU_SERVER_HOME;看门狗退回到不认通道名字的旧版本时,命令也不会去找别的目录。install.sh 写的是同一份。
 */
export function binLauncher(home: string): string {
  return `#!/bin/sh\nGUGU_SERVER_HOME="${home}" exec "${home}/current/bin/gugu-server" "$@"\n`
}
