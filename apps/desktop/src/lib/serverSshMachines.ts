// #6264「别的机器上的编程只给用 SSH 装上的机器」:渲染层 ↔ 主进程之间的契约,只此一份。
//
// 「用 SSH 装上的机器」= 这台桌面上「设置 → 设备 → 添加一台机器」用 SSH 一步装好、并记下了它在云端的
// 设备 id 的那些机器(映射只存在这台桌面本机,不上云;不含任何凭据)。只有它们的「编程」会话能经
// SSH 直连出终端;只经云端连着的机器(一行命令装的、或在别的电脑上用 SSH 装的)只有「通用」。
//
// 「设置 → 设备」另要三件事:每行写明「经 SSH:alice@host」并能复制地址(describe)、移除时把这条映射一并
// 忘掉(forget)、以及「从这台机器上卸载咕咕 server」(uninstall*,经同一条 SSH 连过去停服务、删安装)。

import type { ServerSshInstallFailureReason, ServerSshInstallPrompt } from './serverSshInstall'

export const SERVER_SSH_MACHINES_CHANNELS = {
  /** 这台桌面上用 SSH 装上的机器的设备 id(invoke,回 string[])。 */
  list: 'server-ssh-machines:list',
  /** 同上,带给人看的地址(invoke,回 SshMachineSummary[])。 */
  describe: 'server-ssh-machines:describe',
  /** 忘掉一台(invoke,设备 id → boolean)。移除这台机器时调用。 */
  forget: 'server-ssh-machines:forget',
  /**
   * 对账(invoke,{ owner, present: string[] } → 忘掉了几台):账号名下已经没有的机器(在别的电脑上被移除了)从这里忘掉。
   * present = 渲染层刚成功读到的账号设备 id 全集。刚装上、还没上线的几分钟宽限,❌ 误删。
   */
  reconcile: 'server-ssh-machines:reconcile',
  /** 主进程 → 渲染层:清单变了(装上了一台 / 忘掉了一台)(event,带新清单 string[])。 */
  changed: 'server-ssh-machines:changed',
  /** 开始卸载:先连上去看看装了什么、谁登着(invoke,{ deviceId } → ServerUninstallStartResponse)。 */
  uninstallStart: 'server-ssh-machines:uninstall-start',
  /** 人看过清单、确认卸载(invoke,runId)。 */
  uninstallConfirm: 'server-ssh-machines:uninstall-confirm',
  /** 回答 SSH 的提问(invoke,ServerUninstallAnswer)。 */
  uninstallAnswer: 'server-ssh-machines:uninstall-answer',
  /** 中途不卸了(invoke,runId)。 */
  uninstallCancel: 'server-ssh-machines:uninstall-cancel',
  /** 主进程 → 渲染层:卸载状态快照(event)。 */
  uninstallState: 'server-ssh-machines:uninstall-state',
  /**
   * #6264 一台用 SSH 装上的机器显示离线时,问清是没开机/连不上,还是这个账号在那台机器上的登录没了
   * (invoke,设备 id → `SshSignInState`)。只在它变成离线、或打开「设置 → 设备」时问一次,❌ 轮询。
   */
  signInState: 'server-ssh-machines:sign-in-state',
} as const

/**
 * 这个账号在那台机器上登着没有(经 SSH 读 `gugu-server status --json`):
 * signedIn = 登着(离线只是它的 server 没在跑 / 连不上云);expired = 登录失效了;removed = 这台机器被从账号里移除了;
 * signedOut = 登出了(有人在那台机器上 logout);unknown = 问不到(连不上、那边太旧、没映射)。
 */
export type SshSignInState =
  | { state: 'signedIn' | 'signedOut' | 'unknown' }
  | { state: 'expired' | 'removed'; at: string }

export type SshMachineSummary = {
  deviceId: string
  /** `用户@主机:端口`(或本机 SSH 配置里的别名)。 */
  display: string
}

/** 那台机器上登着咕咕 server 的一个账号(从它的数据目录读,只有邮箱)。 */
export type ServerUninstallAccount = {
  email: string | null
  signedIn: boolean
  /** 就是桌面此刻登着的这个人。 */
  you: boolean
}

export type ServerUninstallInspection = {
  /** 那台机器上还能找到咕咕 server(程序或数据目录)。 */
  installed: boolean
  version: string | null
  accounts: ServerUninstallAccount[]
}

/**
 * inspecting:连上去看一眼(可能要先回答 SSH 的提问);confirm:把看到的摆给人、等确认;
 * uninstalling:停服务、删安装;done / failed / cancelled:结束。
 */
export type ServerUninstallPhase = 'inspecting' | 'confirm' | 'uninstalling' | 'done' | 'failed' | 'cancelled'

export type ServerUninstallFailureReason = ServerSshInstallFailureReason | 'uninstallFailed'

export type ServerUninstallState = {
  runId: string
  deviceId: string
  target: string
  phase: ServerUninstallPhase
  prompt: ServerSshInstallPrompt | null
  inspection: ServerUninstallInspection | null
  failure: { reason: ServerUninstallFailureReason; detail?: string } | null
}

export type ServerUninstallStartResponse =
  | { runId: string; state: ServerUninstallState }
  | { error: 'unknownMachine' }

export type ServerUninstallAnswer = { runId: string; promptId: string; value: string | null }
