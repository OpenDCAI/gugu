import type { SessionBootFailure } from '../sessionBootTasks'
// #6264 心跳随行报的「这是台什么机器」(见 packages/core/src/cloud/deviceHostInfo.ts);
// 设备行上以 DeviceCapabilities 的可选字段出现:老宿主不报 = 不知道(界面退回平台名),❌ 补默认值。

/**
 * 桌面版(有界面)、咕咕 server(不带界面、常驻),还是手机(#7199:安卓上的咕咕,只被云端的助理调单个动作 ——
 * 日历、定位这些;不跑 agent,❌ 出现在「在哪跑」里,见 listDevices)。
 */
export type DeviceHostKind = 'desktop' | 'server' | 'phone'

/**
 * 这个账号是怎么登上这台 server 的:ssh = 从桌面经远程 SSH 装上(添加它的那台桌面与它之间走 SSH,
 * 别的端经咕咕云);tunnel = 远程隧道(一切走咕咕云)。老宿主不报 = 远程隧道(与机器上限同一个保守口径)。
 */
export type DeviceConnectVia = 'ssh' | 'tunnel'

/**
 * #7199 云电脑在界面上是哪一种样子(设备行、「在哪跑」、会话页都按它说):
 *  · asleep = 「休眠中，有事会自动醒」—— ❌ 按离线处理、❌ 灰掉、❌ 拒收;
 *  · waking = 「正在唤醒」;管家说醒了、它的 server 还没上线这几秒也算;
 *  · awake  = 「运行中」:管家说醒了,设备行也在线。
 */
export type CloudComputerPresence = 'asleep' | 'waking' | 'awake'

/** 那台 server 数据目录所在磁盘的余量。 */
export interface DeviceServerDisk {
  free_bytes: number
  total_bytes: number
}

/** 新版本在那台机器上没站稳、已自动退回上一版(最近一次,7 天内)。 */
export interface DeviceServerRollback {
  /** 没站稳的那个版本。 */
  version: string
  /** 退回到的版本。 */
  restored: string
}

/**
 * 咕咕 server 自己的升级走到哪了(product spec 第 5 条「升级悄悄完成」)。
 * downloading = 后台正在下新版本;ready = 新版本已下好,等这台机器上没有 agent 在干活时切过去。
 */
export interface DeviceServerUpdate {
  /** Only an account update can be restarted by that account's confirmed RPC. Missing on old hosts. */
  scope?: 'account' | 'supervisor'
  /** failed:#6264 换成和桌面匹配的那一版没成(下载 / 试跑失败、换过去起不来),设备行给「更新没成功 · 重试」。 */
  state: 'downloading' | 'ready' | 'failed'
  version: string
  /** Fresh count of this account's agents whose work a restart would interrupt. Absent = unknown. */
  busy_agents?: number
}

export interface DeviceHostInfo {
  host_kind: DeviceHostKind
  os_name?: string
  arch?: string
  /**
   * #113 这台机器的主目录($HOME)。别的端据此认出它上面的「~」项目(路径就是主目录的那个),这台机器离线、
   * 那一端又从没连上过它时也认得出。老宿主不报 = 缺席。
   */
  home_dir?: string
  /** Supervisor explicitly supports target-bound, one-shot confirmed account restarts. */
  server_confirmed_restart?: true
  server_boot_failures?: SessionBootFailure[]
  server_update?: DeviceServerUpdate
  /** 这台咕咕 server 以 root 身份运行(智能体能改整台机器);不是 = 缺席。 */
  runs_as_root?: true
  server_disk?: DeviceServerDisk
  server_rollback?: DeviceServerRollback
  /** 那台机器说的桌面↔server 协议版本,以及它要求桌面至少是哪一版。 */
  remote_protocol?: number
  min_client_protocol?: number
  connect_via?: DeviceConnectVia
  /**
   * 远程隧道的中转此刻通着(这台 server 的 frpc 已把它的 SSH 端点挂上中转,见 cloud/remoteTunnel.ts)。
   * 别的电脑据此去开终端 / 浏览器 / 端口那条路;不通 / 老宿主 = 缺席。
   */
  tunnel_relay?: 'frp'
  /**
   * 隧道 / 直连上最近一次有真流量的时刻(ISO,UTC):端口转发(浏览器 / 端口)上任何字节,设备连接上除会话页宿主
   * 心跳帧以外的一切(终端、文件、会话……)。云电脑的管家据此判「在用」(最近 10 分钟有 = 在用,光连着不算)。
   * 账号进程起来之后还没有过 / 老宿主 = 缺席。
   */
  tunnel_active_at?: string
  /**
   * #7199 这台是个人助理住的云端宿主(管家启动 server 时设 `GUGU_CLOUD_COMPUTER=1`)。各端认它不必先问到管家:
   * 设备行一出现就知道,任何时候都 ❌ 把它当一台机器给人看(owner 10-15「用户只知道个人助理」)。不是 / 老宿主 = 缺席。
   */
  assistant_home?: true
}
