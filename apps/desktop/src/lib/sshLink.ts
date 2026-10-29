// #6264 远程 SSH 的机器:这台桌面与它之间的一切只走 SSH(product spec「两种连法，处处能用」)。
//
// 渲染层 ↔ 主进程之间「设备连接」的契约,只此一份。设备连接 = 主进程里每台机器一个常驻的 ssh 子进程
// (electron/server/ssh-link.ts),上面跑的是与咕咕云设备 RPC 逐字相同的信封;渲染层的设备 RPC 客户端
// (deviceRpc.ts)对远程 SSH 的机器把「频道」换成它。主进程只搬字节,请求 / 应答配对、推送分发都在渲染层那一份里。

import type { SshPrompt } from '../session/shared/ssh-prompt'

export const SSH_LINK_CHANNELS = {
  /** 开(或复用)这台机器的设备连接(invoke,设备 id → SshLinkOpenResult)。 */
  open: 'ssh-link:open',
  /** 写一条信封(invoke,{ deviceId, message } → boolean;false = 连接没开着)。 */
  send: 'ssh-link:send',
  /** 收掉这台的设备连接(invoke,设备 id)。 */
  close: 'ssh-link:close',
  /** 主进程 → 渲染层:那台机器发来一条信封(event,{ deviceId, message })。 */
  message: 'ssh-link:message',
  /** 主进程 → 渲染层:接上之后断了(event,{ deviceId, reason })。 */
  closed: 'ssh-link:closed',
  /**
   * 人点了「登录」:经提问卡片问一次密码 / 口令 / 新主机指纹,登上后留着共享连接、接着开设备连接
   * (invoke,设备 id → SshLinkOpenResult)。
   */
  signIn: 'ssh-link:sign-in',
  /** 回答那张提问卡片(invoke,{ deviceId, promptId, value, installKey? })。 */
  answer: 'ssh-link:answer',
  /** 主进程 → 渲染层:登录过程中此刻该挂的提问(event,{ deviceId, prompt | null })。 */
  prompt: 'ssh-link:prompt',
  /**
   * 那台机器的咕咕 server 太旧:替它升级(invoke,{ deviceId, force? } → boolean;true = 正在升)。
   * 设备连接开出 outdated 时主进程自己就会发起;渲染层在会话页宿主说「太旧」时、人点「重试」时调它。
   */
  upgrade: 'ssh-link:upgrade',
  /** 主进程 → 渲染层:替它升级走到哪了(event,SshUpgradeEvent)。 */
  upgradeState: 'ssh-link:upgrade-state',
  /** #6264 这台桌面报给咕咕 server 的版本(invoke → string | null;测试可覆盖,见 core reportedDesktopVersion)。 */
  desktopVersion: 'ssh-link:desktop-version',
} as const

/**
 * 设备连接开不起来 / 断了的原因(❌ 退回咕咕云,如实说):
 *  · unmapped:这台桌面上没有它的 SSH 映射(不是在这台电脑上用远程 SSH 添加的);
 *  · unreachable:ssh 连不上(网络、机器关着、超时);
 *  · signInRequired:要人回答(密码、口令、新主机指纹)才连得上 —— 点「登录」;
 *  · hostKeyChanged:那台机器的指纹变了(ssh 拒绝连接);
 *  · outdated:那台机器上的咕咕 server 太旧 —— 只由明确的版本信号得出(老版本不认 link 命令、账号进程说协议对不上、
 *    报的协议号低于这台桌面要求的);这台桌面够得着它,当场替它升级,升不成才停在这里。
 *    owner 2026-09-25:「升级只能是因为版本问题,而不是因为连不上」—— 连不上 / 被拒绝 / 超时一律 ❌ 归到这里;
 *  · refused:那台机器上的咕咕 server 拒绝了设备连接(原因任意,照实说,❌ 当太旧去升级);
 *  · updating:太旧,正在替它升级(升完自动连上,照 VS Code Remote-SSH 连上发现 server 对不上就装一份对得上的);
 *  · notRunning:咕咕 server 没在跑(常驻服务会把它拉起来);
 *  · notSignedIn:那台机器上没登着这个账号;
 *  · notInstalled:那台机器上找不到咕咕 server。
 */
export type SshLinkFailure =
  | 'unmapped'
  | 'unreachable'
  | 'signInRequired'
  | 'hostKeyChanged'
  | 'outdated'
  | 'refused'
  | 'updating'
  /** 版本对不上,那台机器在等 agent 空闲再换(见 SshUpgradeEvent.waitingIdle)。 */
  | 'waitingIdle'
  | 'notRunning'
  | 'notSignedIn'
  | 'notInstalled'

/** 界面上一台远程 SSH 机器的设备连接状况(设备行、侧栏、新建页同一个说法;缺席 / null = 连着)。 */
export type SshLinkState = 'signInRequired' | 'unreachable' | 'outdated' | 'updating'

/**
 * via = 'tunnel':这条设备连接开在远程隧道上(这台电脑没有它的 SSH 映射)。连不上的原因由远程隧道自己报
 * (tunnelMachines.ts),❌ 记成远程 SSH 的「要先登录」;主进程当场标,渲染层 ❌ 靠清单加载先后去猜。
 */
export type SshLinkOpenResult = { ok: true } | { ok: false; reason: SshLinkFailure; detail?: string; via?: 'tunnel' }

export type SshLinkMessageEvent = { deviceId: string; message: unknown }
export type SshLinkClosedEvent = { deviceId: string; reason: SshLinkFailure; via?: 'tunnel' }
export type SshLinkPromptEvent = { deviceId: string; prompt: SshPrompt | null }
export type SshLinkAnswer = { deviceId: string; promptId: string; value: string | null; installKey?: boolean }
/**
 * 替它升级:updating(percent = 下载/上传进度,不知道为 null)→ done(自动重连)/ failed(停在 outdated)/
 * desktopTooOld(#6264 那边已经是同账号另一台更新的桌面要的那一版:什么也不换,这台电脑显示「请更新这台电脑上的咕咕」)。
 */
export type SshUpgradeEvent = {
  deviceId: string
  /** waitingIdle:那台机器上这个账号有 agent 在跑,装好了、等它空闲再换(人可以点「现在重启更新」)。 */
  phase: 'updating' | 'done' | 'failed' | 'desktopTooOld' | 'waitingIdle'
  percent?: number | null
  /** 没升成,因为那台机器上的 server 老到没法自动更新:请人在那台机器上跑的安装命令。 */
  reinstall?: string
}

/** 设备 RPC 调用在设备连接上失败时抛的错误码(调用方按码说人话,见 remoteFailureKind)。 */
export const SSH_LINK_ERROR_CODE: Record<SshLinkFailure, string> = {
  unmapped: 'ssh_unmapped',
  unreachable: 'ssh_unreachable',
  signInRequired: 'ssh_sign_in_required',
  hostKeyChanged: 'ssh_host_key_changed',
  outdated: 'server_outdated',
  refused: 'ssh_link_refused',
  updating: 'server_updating',
  waitingIdle: 'server_outdated',
  notRunning: 'device_offline',
  notSignedIn: 'ssh_not_signed_in',
  notInstalled: 'ssh_not_installed',
}

export class SshLinkError extends Error {
  readonly code: string
  readonly reason: SshLinkFailure
  constructor(reason: SshLinkFailure, deviceId: string) {
    super(`ssh link to ${deviceId}: ${reason}`)
    this.name = 'SshLinkError'
    this.reason = reason
    this.code = SSH_LINK_ERROR_CODE[reason]
  }
}
