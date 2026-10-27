// #6264「会话页里的别的机器」:和别的机器的连接此刻处在哪一步,以及每一步给人看的那句话。
// 侧栏机器名旁那颗点、聊天界面消息列表末尾那一行、真终端最后一行状态,都从这里取判据与措辞 ——
// 三处说同一件事,❌ 各写一套。纯函数(翻译函数注入),每条判据都有单测。
import { formatBytes, type ServerMachineNotice } from '@gugu/core/cloud/serverMachineHealth';
import { cloudComputerFailureKindOf } from '@gugu/core/cloud/cloudComputer';
import type { CloudComputerPresence } from '@gugu/core/shared/types/deviceHost';
import type { DirectTerminalReason } from '@shared/direct-terminal-link';
import { secondsUntilRetry, type ReconnectPhase } from '@shared/remote-reconnect';
import type { SessionMessageValues } from '@renderer/localization/locale-store';
import type { SessionMessageLookupKey } from '@renderer/localization/messages';

export type Translate = (key: SessionMessageLookupKey, values?: SessionMessageValues) => string;

// ── 「上次在线 X 前」 ──────────────────────────────────────────────────────────

/** 上次在线距今多久(人话);没有记录 / 解析不了 = null。 */
export function formatAgo(lastSeenAt: string | null | undefined, now: number, translate: Translate): string | null {
  if (!lastSeenAt) return null;
  const at = Date.parse(lastSeenAt);
  if (Number.isNaN(at)) return null;
  const minutes = Math.max(0, Math.floor((now - at) / 60_000));
  if (minutes < 1) return translate('remoteHost.agoNow');
  if (minutes < 60) return translate('remoteHost.agoMinutes', { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return translate('remoteHost.agoHours', { count: hours });
  return translate('remoteHost.agoDays', { count: Math.floor(hours / 24) });
}

// ── 侧栏:机器名旁那颗点 ─────────────────────────────────────────────────────

/**
 * 一台机器此刻的连接状态(照 Zed 标题栏那颗点:连接中 / 已连接 / 重连中 / 离线)。
 *  · 离线 = 云端的心跳说它不在(那台机器自己每隔一阵报一次到);
 *  · 重连中 = 心跳说在,但我们问它问不通(会话列表那条订阅的保活连着没回话、或列不出来);
 *  · 连接中 = 在线,第一份会话列表还没到手。
 */
export type HostConnectionState =
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'offline'
  | 'sign-in'
  | 'outdated'
  /** 远程 SSH 的机器太旧,这台桌面正在替它升级(升完自动连上)。 */
  | 'updating'
  /** 远程 SSH 的机器太旧,替它升级没成(说真实状态,❌ 永远「重连中」)。 */
  | 'update-failed'
  /** #7199 云电脑休眠中:有事会自动醒(❌ 说离线、❌ 灰掉)。 */
  | 'asleep'
  /** #7199 云电脑正在唤醒(管家在开机 / 它的 server 还没上线)。 */
  | 'waking'
  /** #7199 叫醒云电脑没成(原因由叫醒的那一处说)。 */
  | 'wake-failed';

export function hostConnectionState(input: {
  online: boolean;
  /** 第一份会话列表还没到手。 */
  loading: boolean;
  /** 问它问不通(列表读不出来 / 保活连着没回话)。 */
  unreachable: boolean;
  /** #6264 远程 SSH 的机器:设备连接的状况(见 RemoteHostDevice.sshLink)。 */
  sshLink?: 'signInRequired' | 'unreachable' | 'outdated' | 'updating' | null;
  /** #7199 云电脑此刻的样子(见 RemoteHostDevice.cloudComputer);不是云电脑 = 缺席。 */
  cloudComputer?: CloudComputerPresence | null;
  /** #7199 这一端正在叫醒它 / 叫醒没成。 */
  wake?: 'waking' | 'failed' | null;
}): HostConnectionState {
  // 远程 SSH 的机器只看 SSH 这一条:要先登录就说要先登录,❌ 与顶上那张卡片各说各的(「重连中」vs「要先登录」)。
  if (input.sshLink === 'signInRequired') return 'sign-in';
  if (input.sshLink === 'updating') return 'updating';
  if (input.sshLink === 'outdated') return 'update-failed';
  if (input.sshLink === 'unreachable') return 'reconnecting';
  // 云电脑:管家说的睡 / 醒压过库里的在线与否(睡下后租约还要 2 分钟才过期)。
  // 管家说正在醒压过这一端旧的「没叫醒」(它在别处被叫醒了)。
  if (input.cloudComputer === 'waking') return 'waking';
  if (input.wake === 'failed' && input.cloudComputer !== 'awake') return 'wake-failed';
  if (input.wake === 'waking' && input.cloudComputer !== 'awake') return 'waking';
  if (input.cloudComputer === 'asleep') return 'asleep';
  if (!input.online) return 'offline';
  if (input.unreachable) return 'reconnecting';
  if (input.loading) return 'connecting';
  return 'connected';
}

export function hostStatusLabel(
  state: HostConnectionState,
  device: string,
  lastSeenAt: string | null | undefined,
  now: number,
  translate: Translate,
  /** 离线的原因是登录没了(见 RemoteHostDevice.signInExpiredAt)。 */
  signInExpiredAt?: string | null
): string {
  // 照 VS Code Tunnels / Tailscale「Expired」:离线 ≠ 登录没了,后者说清下一步。
  if (state === 'offline' && signInExpiredAt !== undefined) return translate('remoteHost.status.signedOut', { device });
  switch (state) {
    case 'sign-in':
      return translate('remoteHost.status.signInRequired', { device });
    // 那台机器上的咕咕 server 太旧、还不会一套工作台:它空闲时自己会升级,升级后自己连上。
    case 'outdated':
      return translate('remoteHost.notice.serverTooOld', { device });
    // 远程 SSH 的机器:这台桌面够得着,当场替它升级(照 VS Code Remote-SSH),❌ 说「空闲时」。
    case 'updating':
      return translate('remoteHost.status.updating', { device });
    case 'update-failed':
      return translate('remoteHost.status.updateFailed', { device });
    case 'asleep':
      return translate('remoteHost.status.asleep', { device });
    case 'waking':
      return translate('remoteHost.status.waking', { device });
    case 'wake-failed':
      return translate('remoteHost.status.wakeFailed', { device });
    case 'connecting':
      return translate('remoteHost.status.connecting', { device });
    case 'connected':
      return translate('remoteHost.status.connected', { device });
    case 'reconnecting':
      return translate('remoteHost.status.reconnecting', { device });
    case 'offline': {
      const ago = formatAgo(lastSeenAt, now, translate);
      return ago
        ? translate('remoteHost.status.offline', { device, ago })
        : translate('remoteHost.status.offlineNever', { device });
    }
  }
}

// ── 新建框:选着的那台此刻用不了 ─────────────────────────────────────────────

/**
 * 那句「用不了」只是在说那台机器此刻的状态:照样挡住发送,但画成说明(与私聊里那句同一个样子),❌ 画成报错的红字。
 *  · #7199 云电脑休眠中 / 正在唤醒;
 *  · 离线、正在连 / 重连:离线只是那台此刻用不了、不是出错(product spec「在哪跑」,owner 2026-10-22)。
 * 叫醒没成、要先登录、离线是因为那台机器上的登录没了、版本太旧(正在更新 / 没更新成)照旧是报错:
 * 那是要人知道、可能要人去做点什么的事。
 */
export function machineBlockIsStatus(
  connection: HostConnectionState | null,
  /** 离线的原因是登录没了(见 RemoteHostDevice.signInExpiredAt)。 */
  signInExpiredAt?: string | null
): boolean {
  if (connection === 'offline' && signInExpiredAt !== undefined) return false;
  return (
    connection === 'asleep' ||
    connection === 'waking' ||
    connection === 'offline' ||
    connection === 'connecting' ||
    connection === 'reconnecting'
  );
}

/**
 * 选着的那台此刻用不了:说真实原因(与侧栏那颗点同一个判据)—— 版本太旧正在更新 / 没更新成 / 空闲时自己更新、
 * 要先登录、那台机器上的登录没了、正在连 / 重连,其余说离线。❌ 版本太旧、登录没了、正在连时说「离线」。
 */
export function machineUnavailableReason(
  connection: HostConnectionState | null,
  label: string | null,
  translate: Translate,
  /** #7199 叫醒云电脑没成时那句原因(管家的原话 / 积分用完 / 等满了)。 */
  wakeFailure?: string | null,
  /** 离线的原因是登录没了(见 RemoteHostDevice.signInExpiredAt)。 */
  signInExpiredAt?: string | null
): string {
  const device = label ?? translate('task.deviceOffline');
  if (connection === 'offline' && signInExpiredAt !== undefined) return translate('remoteHost.status.signedOut', { device });
  switch (connection) {
    // 云电脑:休眠中 = 开始输入就叫醒它(看一眼不叫);正在醒 = 醒了发送键自己亮;❌ 说「离线」。
    case 'asleep':
      return translate('task.remoteDeviceAsleep', { device });
    case 'waking':
      return translate('task.remoteDeviceWaking', { device });
    case 'wake-failed':
      return wakeFailure ?? translate('remoteHost.status.wakeFailed', { device });
    case 'sign-in':
      return translate('task.remoteDeviceSignIn', { device });
    case 'updating':
      return translate('task.remoteDeviceUpdating', { device });
    case 'update-failed':
      return translate('task.remoteDeviceUpdateFailed', { device });
    case 'outdated':
      return translate('task.remoteDeviceTooOld', { device });
    case 'connecting':
      return translate('remoteHost.status.connecting', { device });
    case 'reconnecting':
      return translate('remoteHost.status.reconnecting', { device });
    default:
      return translate('task.remoteDeviceOffline', { device });
  }
}

/**
 * #7199 叫醒云电脑没成,说给人听:只说是哪一类(积分用完 / 两分钟没醒 / 连不上 / 登录失效 / 不在了 / 那边出了问题),
 * 管家原话与异常原文进日志(remote-hosts-store 记过)—— 仓库「文案泄漏」闸。
 */
export function cloudWakeFailureText(
  failure: { reason: 'refused' | 'failed' | 'timeout'; code: string | null },
  device: string,
  translate: Translate
): string {
  switch (cloudComputerFailureKindOf(failure)) {
    case 'credits_exhausted':
      return translate('remoteHost.wake.creditsExhausted', { device });
    case 'membership_expired':
      return translate('remoteHost.wake.membershipExpired', { device });
    case 'timeout':
      return translate('remoteHost.wake.timeout', { device });
    case 'network':
      return translate('remoteHost.wake.network', { device });
    case 'signed_out':
      return translate('remoteHost.wake.signedOut');
    case 'gone':
      return translate('remoteHost.wake.gone', { device });
    case 'plan_required':
    case 'failed':
      return translate('remoteHost.wake.failed', { device });
  }
}

// ── 聊天界面:消息列表末尾那一行 ──────────────────────────────────────────────

/** 设备接口报的错误码里,「那台机器上的咕咕 server 太旧、不认这个接口」那一个。 */
// server_outdated:远程 SSH 的机器上咕咕 server 太旧、还不认设备连接(src/lib/sshLink.ts)。
export const TOO_OLD_CODES = new Set(['unknown_method', 'server_outdated']);
/** 「那台机器上已经没有这条会话」。 */
export const GONE_CODES = new Set(['record_not_found', 'not_found', 'conversation_not_found']);

/** 一次失败会不会自己好:太旧、会话没了都不会(重试只是把同一句错话说很多遍)。 */
export function isRetryableRemoteError(code: string | null): boolean {
  return !(code && (TOO_OLD_CODES.has(code) || GONE_CODES.has(code)));
}

export type ChatLinkRow = {
  label: string;
  /** 行里那段可点的字:立即重连 / 重新连接 / 登录(远程 SSH 要先登录);没有就只说事实。 */
  action: { label: string; kind: 'reconnect-now' | 'reconnect' | 'sign-in' } | null;
} | null;

/**
 * 聊天界面末尾那一行说什么。
 * @param phase 重连节奏(在线时才有意义)
 * @param errorCode 最近一次失败的错误码(决定「太旧」「会话没了」这类专门的说法)
 */
export function chatLinkRow(input: {
  device: string;
  online: boolean;
  lastSeenAt: string | null | undefined;
  /** 离线的原因是登录没了(见 RemoteHostDevice.signInExpiredAt)。 */
  signInExpiredAt?: string | null;
  phase: ReconnectPhase;
  errorCode: string | null;
  now: number;
  translate: Translate;
  /** #6264 远程 SSH 的机器要先登录(与侧栏、顶上那张卡片同一个判据)。 */
  signInRequired?: boolean;
}): ChatLinkRow {
  const { device, translate } = input;
  if (input.signInRequired) {
    return {
      label: translate('remoteHost.condition.signInRequired', { device }),
      action: { label: translate('remoteHost.signIn'), kind: 'sign-in' },
    };
  }
  if (!input.online && input.signInExpiredAt !== undefined) {
    return { label: translate('remoteHost.condition.signedOut', { device }), action: null };
  }
  if (!input.online) {
    const ago = formatAgo(input.lastSeenAt, input.now, translate);
    return {
      label: ago
        ? translate('remoteHost.condition.offline', { device, ago })
        : translate('remoteHost.condition.offlineNever', { device }),
      action: null,
    };
  }
  switch (input.phase.kind) {
    case 'connected':
      return null;
    case 'connecting':
      // 第一次连:界面上是普通加载态,❌ 在这里再说一遍。
      return input.phase.attempt > 0
        ? { label: translate('remoteHost.condition.reconnecting', { device }), action: null }
        : null;
    case 'waiting':
      return {
        label: translate('remoteHost.condition.waiting', {
          device,
          seconds: secondsUntilRetry(input.phase, input.now) ?? 0,
        }),
        action: { label: translate('remoteHost.reconnectNow'), kind: 'reconnect-now' },
      };
    case 'gave-up': {
      const code = input.errorCode;
      const label =
        code && TOO_OLD_CODES.has(code)
          ? translate('remoteHost.condition.tooOld', { device })
          : code && GONE_CODES.has(code)
            ? translate('remoteHost.condition.sessionGone', { device })
            : translate('remoteHost.condition.gaveUp', { device });
      return { label, action: { label: translate('remoteHost.reconnect'), kind: 'reconnect' } };
    }
  }
}

// ── 聊天界面:那台机器有件事要人知道 ─────────────────────────────────────────────

/**
 * #6264 那台机器连得上,但有件事会让这条会话里的操作失败(磁盘快满、两边版本对不上):消息列表末尾说一句。
 * 判据与设备行上的标签是同一份(serverMachineNotices);「升级被退回」已经自愈,只在设备行告知,❌ 在会话里打扰。
 * 排在断线、agent 没开起来之后 —— 那两件事更要紧,一次只说一件。
 */
export function machineNoticeLabel(
  notices: readonly ServerMachineNotice[] | undefined,
  device: string,
  translate: Translate,
  options: { protocolOnly?: boolean } = {}
): string | null {
  for (const notice of notices ?? []) {
    if (options.protocolOnly && (notice.kind === 'disk-low' || notice.kind === 'rolled-back')) continue;
    switch (notice.kind) {
      case 'desktop-too-old':
        return translate('remoteHost.notice.desktopTooOld', { device });
      case 'server-too-old':
        return translate('remoteHost.notice.serverTooOld', { device });
      case 'disk-low':
        return translate('remoteHost.notice.diskLow', { device, free: formatBytes(notice.freeBytes) });
      case 'rolled-back':
        continue;
    }
  }
  return null;
}

// ── 真终端:最后一行状态 ───────────────────────────────────────────────────────

const REASON_KEYS: Record<DirectTerminalReason, SessionMessageLookupKey> = {
  network: 'remoteHost.reason.network',
  timeout: 'remoteHost.reason.timeout',
  unreachable: 'remoteHost.reason.unreachable',
  'host-unresolved': 'remoteHost.reason.hostUnresolved',
  refused: 'remoteHost.reason.refused',
  auth: 'remoteHost.reason.auth',
  'host-key-rejected': 'remoteHost.reason.hostKeyRejected',
  'host-key-changed': 'remoteHost.reason.hostKeyChanged',
  cancelled: 'remoteHost.reason.cancelled',
  'prompt-unanswered': 'remoteHost.reason.promptUnanswered',
  ended: 'remoteHost.reason.ended',
  unknown: 'remoteHost.reason.unknown',
};

/** 一次 SSH 直连断开 / 连不上的原因,写成人话(浏览器端口转发用)。 */
export function directReasonText(reason: DirectTerminalReason, device: string, translate: Translate): string {
  return translate(REASON_KEYS[reason], { device });
}
