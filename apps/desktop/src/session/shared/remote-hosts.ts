// #6264「会话页里的别的机器」:会话页侧栏里混排别的机器上的项目,打开那边的会话。
//
// 会话页是另一个 bundle(EmdashSessionFrame 按 manifest 单独加载),拿不到 gugu 侧的账号、云连接与
// 设备表 —— 那些都在 gugu 侧(Supabase 会话、Realtime 设备通道、devices store)。所以由 gugu 侧把
// 「我名下还有哪些机器」和「到那台机器会话页宿主的线」挂在 window 上,会话页只经这里读。
// 契约只在这一份(两个 bundle 都从 session/shared 取),❌ 两侧各写一份结构副本。
//
// 会话本身走那台机器的整套会话页宿主(`openSessionHost`,一套工作台),与本机同一套界面。
import type { DeviceSessionSummary } from '@gugu/core/shared/types/chat';
import type { ServerMachineNotice } from '@gugu/core/cloud/serverMachineHealth';
import type { CloudComputerPresence } from '@gugu/core/shared/types/deviceHost';
import type { SessionHostPipeOpener } from './lib/ipc/session-host-client';

export const REMOTE_HOSTS_BRIDGE_KEY = '__GUGU_REMOTE_HOSTS__';

/** 名下的一台别的机器(本机与云设备行不在其中)。 */
export type RemoteHostDevice = {
  id: string;
  /** 「在哪跑」里的名字(用户可改)。 */
  label: string;
  isOnline: boolean;
  /** 那台机器报的系统(`linux` / `darwin` / `win32`…),选择器里标一句「Linux」「macOS」让人认得出是哪台。 */
  platform: string;
  /** 最后一次心跳的时间(ISO);离线时显示「上次在线 X」。 */
  lastSeenAt: string | null;
  /** 离线时那台机器最后一次心跳带上来的会话摘要;在线时 ❌ 不读它(那时有实时的那一份)。 */
  sessionDigest: readonly DeviceSessionSummary[] | null;
  /**
   * 这台电脑与它之间有直连的路:在**这台桌面上**用 SSH 一步装上的,或经远程隧道的中转连通了的。
   * 有了它「编程」(终端)、浏览器、端口才给;false = 此刻只经咕咕云连着,只有「通用」。
   */
  directTerminal: boolean;
  /**
   * 远程隧道此刻怎样(只在这台电脑没有它的 SSH 映射、而它在线时报):connecting = 正在连;off = 那台机器没开远程隧道
   * (咕咕 server 太旧 / 没配中转 / 不是咕咕 server);其余 = 连不上的原因(见 src/lib/tunnelMachines.ts)。
   * 连通了 / 远程 SSH 的机器 / 手机上 = 缺席。
   */
  tunnel?: 'connecting' | 'off' | 'unsupported' | 'relayDown' | 'visitorFailed' | 'sshFailed' | 'local' | 'unreachable';
  /** directTerminal 来自远程隧道(❌ 这台电脑用远程 SSH 添加的):标连法时不当成远程 SSH。 */
  viaTunnel?: true;
  /** 那台机器是咕咕 server(不带界面)还是另一台咕咕桌面;老宿主不报 = undefined(不知道)。 */
  hostKind?: 'desktop' | 'server';
  /** 咕咕 server 是怎么添加的(远程 SSH / 远程隧道);不报 = undefined。别的电脑用远程 SSH 加的,这里 directTerminal 为 false。 */
  connectVia?: 'ssh' | 'tunnel';
  /** 那台机器最后一拍心跳报的咕咕版本(`capabilities.app_version`);不报 = null。 */
  version?: string | null;
  /**
   * #6264 离线的原因是「这个账号在那台机器上的登录没了」(经 SSH 问到的):值是那一刻(ISO),登出时间不明 = null;
   * 没问过 / 还登着 / 问不到 = undefined(照旧只说离线)。只有用 SSH 装上的机器问得到。
   */
  signInExpiredAt?: string | null;
  /** #6264 那台 server 有件事要人知道(磁盘快满、两边版本对不上、升级被退回);按要紧程度排。 */
  notices?: readonly ServerMachineNotice[];
  /**
   * #6264 远程 SSH 的机器:这台电脑到它的 SSH 设备连接此刻怎样(在线与否只看它,❌ 看咕咕云心跳)。
   * signInRequired = 要人回答(密码 / 口令 / 新主机指纹)才连得上;unreachable = 连不上、会自己再试;
   * outdated = 那台机器的咕咕 server 太旧(替它升级没成);updating = 太旧,正在替它升级(升完自动连上);
   * 缺席 / null = 连着(或还没连过)。远程隧道的机器没有这一格。
   */
  sshLink?: 'signInRequired' | 'unreachable' | 'outdated' | 'updating' | null;
  /**
   * #7403 那台咕咕 server 换版本走到哪了(心跳的 `capabilities.server_update`):downloading / ready = 正在换,
   * failed = 换成和桌面匹配的那一版没成。不是 server / 没在换 = 缺席。
   */
  serverUpdate?: 'downloading' | 'ready' | 'failed';
  /**
   * #7199 这台是这个账号的云电脑时,它此刻的样子:asleep = 休眠中(有事会自动醒),waking = 正在唤醒,awake = 运行中。
   * 睡着时 `isOnline` 照实为 false,但 ❌ 按离线处理(❌ 灰掉、❌ 拒收):在它上面开会话 / 打开它上面的会话先叫醒它
   * (`wakeCloudComputer`)。不是云电脑 = 缺席。
   */
  cloudComputer?: CloudComputerPresence;
  /**
   * #7199 这台是个人助理住的那台(云端宿主)。owner 10-15:用户看不到它住在哪 —— 选机器的地方(新建任务、导入会话、
   * 资源库 / 已安排 / 设置的「哪台」)都不列它;侧栏里它上面的会话就是「它派出的任务」那一组(组名 = `label` = 它的名字,
   * 宿主那一侧换好)。不是 = 缺席。
   */
  assistantHome?: true;
};

/**
 * #7199 叫醒云电脑没成:`code` 是管家的码(credits_exhausted = 积分用完),`reason` 说是哪一种
 * (refused = 管家拒绝 / failed = 管家报错 / timeout = 等满了还没上线),`message` 是管家那句原话。
 */
export type CloudComputerWakeFailure = {
  reason: 'refused' | 'failed' | 'timeout';
  code: string | null;
  message: string;
};

/** 宿主抛给会话页的那个错误(两个 bundle 各有一份类,会话页按字段读 —— 见 `cloudComputerWakeFailureOf`)。 */
export class CloudComputerWakeFailed extends Error implements CloudComputerWakeFailure {
  constructor(
    readonly reason: CloudComputerWakeFailure['reason'],
    readonly code: string | null,
    message: string
  ) {
    super(message);
    this.name = 'CloudComputerWakeFailed';
  }
}

/** 任意错误 → 叫醒失败的三格;不是这种形状的(桥自己出了岔子)记成 failed + 原文。 */
export function cloudComputerWakeFailureOf(error: unknown): CloudComputerWakeFailure {
  const value = error as Partial<CloudComputerWakeFailure> | null;
  const reason = value?.reason === 'refused' || value?.reason === 'timeout' || value?.reason === 'failed' ? value.reason : 'failed';
  const code = typeof value?.code === 'string' ? value.code : null;
  const message = typeof value?.message === 'string' && value.message ? value.message : String(error);
  return { reason, code, message };
}

export type RemoteHostsBridge = {
  /**
   * #6264 开一条到那台机器会话页宿主的帧线(一套工作台:那台机器的整张路由表,与本机同一套界面走它)。
   * 远程 SSH 的机器走 SSH,远程隧道的机器走咕咕云。老宿主没有这一格。
   */
  openSessionHost?(deviceId: string): SessionHostPipeOpener;
  listDevices(): readonly RemoteHostDevice[];
  /** 名下机器变了(上线/离线/改名/新登录一台)时回调;返回退订。 */
  subscribeDevices(listener: () => void): () => void;
  /**
   * 浏览那台机器上的文件夹(目录选择器由 gugu 侧画:会话页在 shadow root 里,gugu 的组件进不去)。
   * 返回选中的路径;取消 = null。
   */
  pickFolder(deviceId: string, initialPath: string): Promise<string | null>;
  /**
   * 去「设置 → 设备」添加一台机器(直接打开添加那一步)。会话页里名下还没有别的机器时,
   * 机器选择器的空状态从这里把人带过去。老的宿主没有这一项 —— 缺席就不摆那个入口。
   */
  openAddMachine?(): void;
  /**
   * #6264 远程 SSH 的机器要先登录(SSH 密码 / 口令 / 新主机指纹):在窗口顶上那张卡片里问一次。
   * 登上了 = true。老宿主没有这一格。
   */
  signInSsh?(deviceId: string): Promise<boolean>;
  /**
   * #7199 叫醒这台云电脑,等到它真的在线(会话页宿主的线随之自己连上)。醒不来时以 `CloudComputerWakeFailure`
   * 形状的错误失败(❌ 一直「正在唤醒」)。老宿主没有这一格。
   */
  wakeCloudComputer?(deviceId: string): Promise<void>;
  /**
   * #7403 那台的咕咕比这台桌面旧、不认会话页发过去的那一问(product spec 第 5 条例外):请它当场换成和这台桌面
   * 匹配的版本 —— 远程 SSH 由这台桌面替它升级,远程隧道 / 云电脑请它自己换。`retry` = 人点了「重试」(不看冷却)。
   * 请到了 = true。老宿主没有这一格。
   */
  matchServerVersion?(deviceId: string, options?: { retry?: boolean }): Promise<boolean>;
};

type RemoteHostsWindow = Window & { [REMOTE_HOSTS_BRIDGE_KEY]?: RemoteHostsBridge };

/**
 * 心跳说它在;远程 SSH 的机器只看 SSH 这一条(要先登录 / 正在替它升级都不去连,升完那一刻再连)。到它的线只在这时开 ——
 * 够不着时开一次就是一次发到它那里、没人应答的报到。SSH 映射着的照旧算够得着:SSH 那条通着时云端心跳可能是断的。
 */
export function remoteHostReachable(device: Pick<RemoteHostDevice, 'isOnline' | 'directTerminal' | 'sshLink'>): boolean {
  if (device.sshLink === 'signInRequired' || device.sshLink === 'updating') return false;
  return device.isOnline || device.directTerminal;
}

export function findRemoteHostsBridge(): RemoteHostsBridge | null {
  if (typeof window === 'undefined') return null;
  return (window as RemoteHostsWindow)[REMOTE_HOSTS_BRIDGE_KEY] ?? null;
}

export function installRemoteHostsBridge(bridge: RemoteHostsBridge): () => void {
  const w = window as RemoteHostsWindow;
  w[REMOTE_HOSTS_BRIDGE_KEY] = bridge;
  window.dispatchEvent(new Event(REMOTE_HOSTS_BRIDGE_KEY));
  return () => {
    if (w[REMOTE_HOSTS_BRIDGE_KEY] === bridge) {
      delete w[REMOTE_HOSTS_BRIDGE_KEY];
      window.dispatchEvent(new Event(REMOTE_HOSTS_BRIDGE_KEY));
    }
  };
}

/** 桥装上/拆掉时回调(会话页可能先于宿主挂好,也可能宿主登出后桥被拆)。 */
export function onRemoteHostsBridgeChange(listener: () => void): () => void {
  window.addEventListener(REMOTE_HOSTS_BRIDGE_KEY, listener);
  return () => window.removeEventListener(REMOTE_HOSTS_BRIDGE_KEY, listener);
}
