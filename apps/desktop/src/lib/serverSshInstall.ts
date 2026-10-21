// #6264「从桌面用 SSH 一步装好」(product spec):渲染层 ↔ 主进程之间的契约,只此一份。
//
// 主进程(electron/server/ssh-install)负责连 SSH、装、注册常驻、登录;渲染层(设置 → 设备)只画状态、
// 回答 SSH 的提问(密码 / 密钥口令 / 验证码 / 新主机指纹)。状态每变一次主进程推一份**完整快照**,渲染层不做增量合并。

import type { MachineLimitRefusal } from '@gugu/core/cloud/machineLimit'
import type { SshKeyInstallOutcome, SshPrompt } from '../session/shared/ssh-prompt'

export const SERVER_SSH_INSTALL_CHANNELS = {
  /** 一行安装命令(连不上 SSH 的机器照旧用它),按桌面自己的通道拼好(invoke)。 */
  info: 'server-ssh-install:info',
  /** 读本机 ~/.ssh/config 里配好的主机(invoke)。 */
  listHosts: 'server-ssh-install:list-hosts',
  /** 开始一次安装(invoke,回 { runId })。 */
  start: 'server-ssh-install:start',
  /** 中途取消(invoke)。 */
  cancel: 'server-ssh-install:cancel',
  /** 回答 SSH 的提问(invoke)。 */
  answer: 'server-ssh-install:answer',
  /** 主进程 → 渲染层:状态快照(event)。 */
  state: 'server-ssh-install:state',
} as const

/** ~/.ssh/config 里一个具体的 Host 别名(通配的不列)。 */
export type SshConfigHost = {
  alias: string
  hostname?: string
  user?: string
  port?: number
}

/**
 * 五步,照 Zed / JetBrains 的「逐步说清在做什么」:
 * 连接(SSH 握手、认证)→ 识别系统(系统、架构、C 库、空间)→ 下载(或本机下载后传过去)→ 注册常驻 → 登录。
 */
export const SERVER_SSH_INSTALL_STEPS = ['connect', 'detect', 'download', 'service', 'login'] as const
export type ServerSshInstallStepId = (typeof SERVER_SSH_INSTALL_STEPS)[number]
export type ServerSshInstallStepStatus = 'pending' | 'running' | 'done' | 'skipped' | 'failed'

/**
 * 失败原因。每个都对应一句人话(settings.devices.addServer.reasons.*),说清卡在哪、为什么、下一步怎么办。
 * `detail` 是那台机器 / ssh 自己吐出来的最后几行原文,只进「查看详情」,不当正文。
 */
export type ServerSshInstallFailureReason =
  | 'sshMissing'
  | 'authFailed'
  | 'hostUnresolved'
  | 'connectionRefused'
  | 'unreachable'
  | 'timeout'
  | 'connectTimeout'
  | 'hostKeyRejected'
  | 'hostKeyChanged'
  | 'shellStartup'
  | 'unsupportedOs'
  | 'unsupportedArch'
  | 'unsupportedLibc'
  | 'diskFull'
  | 'noPermission'
  | 'noExec'
  | 'desktopDownloadFailed'
  | 'uploadFailed'
  | 'installFailed'
  | 'serviceFailed'
  | 'notSignedIn'
  | 'grantFailed'
  | 'serverTooOld'
  /** 装着一份咕咕 server,却问不出它说哪一版协议(那条命令崩溃 / 超时 / 没权限;❌ 当太旧去重装)。 */
  | 'versionCheckFailed'
  | 'loginFailed'
  | 'cloudUnreachable'
  /** #6264 这个账号的咕咕 server 数到上限了(哪条上限、用了几台在 failure.machineLimit)。 */
  | 'machineLimit'
  | 'cancelled'
  | 'unknown'

/** 常驻那一步做成了,但还差一步要管理员做(behavior 第 4 条:❌ 假装已经常驻)。 */
export type ServerSshInstallWarning =
  | { kind: 'lingerMissing'; user: string }
  | { kind: 'noReboot' }
  /** #6264 用 root 连上的:装好后那台机器上的智能体以管理员身份运行(识别系统那一步就说,装之前人能停下)。 */
  | { kind: 'runsAsRoot' }

/** 识别出来的那台机器(识别系统那一步的结果,界面上照原样摆出来)。 */
export type ServerSshInstallMachine = {
  os: string
  arch: string
  /** 发行版全名(Ubuntu 22.04.4 LTS);macOS 是 `macOS 14.5`;读不到为空。 */
  distro: string
  /** `glibc 2.35` / `musl` / 空(macOS 或读不到)。 */
  libc: string
  hostname: string
  user: string
  installedVersion: string | null
  /** 这台机器上已经登着的账号(邮箱,没有邮箱就是账号 id);不含桌面此刻登着的这个人。 */
  others: string[]
  /** 桌面此刻登着的这个人是不是已经登在这台机器上了。 */
  alreadySignedIn: boolean
}

export type ServerSshInstallStep = {
  id: ServerSshInstallStepId
  status: ServerSshInstallStepStatus
  /** 这一步此刻在做什么(那台机器上安装脚本最新打出的一行),只在 running 时有。 */
  live?: string
  /** skipped 的原因:已装过 / 已在后台运行 / 已登着(后台升级不登录)。 */
  skippedBecause?: 'alreadyInstalled' | 'alreadyRunning' | 'alreadySignedIn'
  /** 下载那一步:装的是哪个版本。 */
  version?: string
  /** 下载那一步:装着的版本太旧、这台桌面连不上它,这次是从它升级上来(当场切换)。 */
  upgradeFrom?: string
  /** 注册常驻那一步:要当场换下来的那个在跑的旧版本。 */
  replaces?: string
  /** 下载那一步:在那台机器上下(remote),还是本机下好经 SSH 传过去(desktop,那台机器连不上外网时)。 */
  via?: 'remote' | 'desktop'
  /** 下载 / 上传的真实字节进度;total 为 null 表示总量未知。 */
  progress?: { phase: 'download' | 'upload'; done: number; total: number | null }
}

/**
 * SSH 在问的一个问题。
 *  - hostKey:第一次连这台机器,要确认指纹(yes / no)。
 *  - password:SSH 登录密码。
 *  - passphrase:私钥口令(`key` 是哪把钥匙)。
 *  - otp:服务器自己的提问(二次验证码、键盘交互),`label` 是它的原话。
 *  - notice:只要人去做一件事(碰一下安全密钥),不用输入,做完自己消失。
 * 形状与卸载、直连终端共用,定义在 session/shared/ssh-prompt.ts。
 */
export type ServerSshInstallPrompt = SshPrompt

export type ServerSshInstallResult = {
  /** 登上的是谁(桌面此刻登着的那个人)。 */
  email: string | null
  /** 这台机器上本来就登着的别人 —— 加一个账号,不顶掉他们(behavior 第 7 条)。 */
  others: string[]
  hostname: string
  /** 登上的账号 id(与桌面此刻登着的是同一个人)。 */
  userId: string
  /**
   * 这台机器在云端「在哪跑」里的设备 id。桌面据此记下「这台设备是用 SSH 装上的」,
   * 它上面的「编程」会话才能经 SSH 直连出终端(behavior「别的机器上的编程只给用 SSH 装上的机器」)。
   * 老 server 不报 = null。
   */
  deviceId: string | null
  /** 这个人原本就登在这台机器上(这次只是重新接上)。 */
  alreadySignedIn: boolean
}

/**
 * 失败 / 取消时那台机器上留下了什么(behavior「取消不留半截东西而不说」):
 *  - installed:咕咕 server 已经装上,但没注册常驻、没登录;
 *  - running:已经装上并在后台运行,但还没登录你的账号。
 * 两种情况重新装一次都会接着做完,❌ 重下一遍。
 */
export type ServerSshInstallLeftover = 'installed' | 'running' | null

export type ServerSshInstallFailure = {
  step: ServerSshInstallStepId
  reason: ServerSshInstallFailureReason
  detail?: string
  /** hostKeyChanged:要删掉旧记录的那台主机(`ssh-keygen -R` 的参数)与它现在报的新指纹。 */
  hostKey?: { host: string; fingerprint: string | null }
  /** machineLimit:哪条上限(总数 / 远程隧道)、除这台外已经连着几台、上限几台。 */
  machineLimit?: MachineLimitRefusal
  leftover?: ServerSshInstallLeftover
}

export type ServerSshInstallState = {
  runId: string
  target: string
  steps: ServerSshInstallStep[]
  machine: ServerSshInstallMachine | null
  prompt: ServerSshInstallPrompt | null
  warnings: ServerSshInstallWarning[]
  failure: ServerSshInstallFailure | null
  result: ServerSshInstallResult | null
  finished: boolean
  /**
   * #6264「下次免密」:装好之后替人把咕咕的钥匙装到那台机器上(人答密码时勾了才有)。
   * working = 正在装;其余是结果。没勾 = 没有这一项。
   */
  keyInstall?: ServerSshKeyInstall | null
  /**
   * #6264 后台替它换成和这台桌面匹配的那一版时(upgrade 模式,那台机器认得 match-version):这个账号该跑的目标版本、
   * 当时在跑的版本。两者相同 = 什么也不用换(这台桌面比同账号另一台旧 —— 它自己去显示「请更新这台电脑上的咕咕」)。
   */
  match?: { target: string; running: string | null } | null
  /** 连接与安装的原始日志(ssh 的详细输出 + 那台机器上脚本的输出),给「查看详情」。只留最后若干行。 */
  log: string[]
}

export type ServerSshInstallInfo = {
  /** curl 版的一行命令。 */
  installCommand: string
  /** 没有 curl 的机器用的 wget 版。 */
  installCommandWget: string
}
/**
 * target = 人填的地址 / 整条 ssh 命令;deviceId = #6264「重新登录」:这台桌面记着怎么 SSH 过去的那台机器
 * (目的地只在主进程里,渲染层 ❌ 拿到原串),同一套装机流程在已装好的机器上就是「只登录」。
 */
export type ServerSshInstallStartRequest = { target: string } | { deviceId: string }
export type ServerSshInstallStartResponse =
  | { runId: string; state: ServerSshInstallState }
  | {
      error: 'invalidTarget'
      /** invalid = 看不懂;unsupportedOption = 整条 ssh 命令里有这里不接的选项(`option`);command = 带了要执行的命令。 */
      problem: 'invalid' | 'unsupportedOption' | 'command'
      option?: string
    }
export type ServerSshKeyInstall = { status: 'working' } | SshKeyInstallOutcome

/** installKey:密码提问上勾了「以后连这台机器不用再输密码」。 */
export type ServerSshInstallAnswer = { runId: string; promptId: string; value: string | null; installKey?: boolean }

/** 「查看详情」里最多留多少行。 */
export const SERVER_SSH_INSTALL_LOG_LINES = 400
