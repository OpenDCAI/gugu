// #6264「会话右侧的工作区跟着会话所在的机器走」(照 VS Code Remote:资源管理器、源代码管理、终端、端口都在那台机器上)。
//
// 这里是**哪几格给、各格问哪台机器、失败了怎么说**的判据 —— 纯函数(翻译函数注入),每条都有单测:
//  · 本机会话:不经这里(本机工作区面板照旧)。
//  · 有直连的路(这台桌面上用 SSH 装上的机器,或经远程隧道的中转连通了的):审阅、终端、浏览器、端口、文件都给;
//    终端、浏览器、端口走那条路(SSH / 中转里的 SSH)。
//  · 此刻只经咕咕云连着:审阅、文件照给(文件与 git 经设备接口走云端,量小);终端、浏览器、端口灰着说原因
//    (directToolsUnavailableText)—— 终端画面与网页流量 ❌ 塞进云端消息通道(owner:❌ 走消息额度)。
//  · 侧边聊天:它在本机分叉一条会话,别的机器上的会话分不出来 —— 这一轮不变(不在远端清单里)。
import type { RemoteHostDevice } from '@/session/shared/remote-hosts';
import { formatAgo, type Translate } from '../connection-status';
import { remoteErrorCode } from '../remote-failure-copy';
import type { SessionMessageKey } from '@renderer/localization/messages';

export type RemoteWorkspaceTool = 'review' | 'terminal' | 'browser' | 'ports' | 'files';

/**
 * 与本机工作区清单同序(getSessionWorkspaceActionOrder 去掉侧边聊天);「端口」照 VS Code 放在浏览器旁边
 * (它只在别的机器上才有意义:本机的端口本来就在这台电脑上)。
 */
const ORDER: readonly RemoteWorkspaceTool[] = ['review', 'terminal', 'browser', 'ports', 'files'];

/** 只有经 SSH 直连才有的几格(网页流量 ❌ 走云端消息通道)。 */
const DIRECT_ONLY: ReadonlySet<RemoteWorkspaceTool> = new Set(['terminal', 'browser', 'ports']);

/** 这台机器上的会话,工作区给哪几格。 */
export function remoteWorkspaceTools(device: Pick<RemoteHostDevice, 'directTerminal'> | null): RemoteWorkspaceTool[] {
  const direct = device?.directTerminal === true;
  return ORDER.filter((tool) => direct || !DIRECT_ONLY.has(tool));
}

/**
 * 终端 / 浏览器 / 端口此刻为什么用不了(只在 directTerminal 为假时问):远程隧道在连 / 连不上 / 那台机器没开,
 * 都照实说;云电脑睡着说「醒来后可用」;其余(手机、另一台咕咕桌面、离线)说要在电脑上经远程 SSH / 远程隧道连上。
 */
export function directToolsUnavailableText(
  device: Pick<RemoteHostDevice, 'tunnel' | 'cloudComputer'> | null | undefined,
  translate: (key: SessionMessageKey) => string
): string {
  switch (device?.tunnel) {
    case 'connecting':
      return translate('remoteWorkspace.tunnel.connecting');
    case 'off':
      return translate(device.cloudComputer ? 'remoteWorkspace.cloudComputerGeneralOnly' : 'remoteWorkspace.tunnel.off');
    case 'unsupported':
      return translate('remoteWorkspace.tunnel.unsupported');
    case 'relayDown':
      return translate('remoteWorkspace.tunnel.relayDown');
    case 'visitorFailed':
      return translate('remoteWorkspace.tunnel.visitorFailed');
    case 'sshFailed':
      return translate('remoteWorkspace.tunnel.sshFailed');
    case 'local':
      return translate('remoteWorkspace.tunnel.local');
    case 'unreachable':
      return translate('remoteWorkspace.tunnel.unreachable');
    default:
      return translate(device?.cloudComputer ? 'remoteWorkspace.cloudComputerGeneralOnly' : 'remoteWorkspace.directOnly');
  }
}

/** 这一格此刻够不够得着:机器离线时文件 / 审阅照样列着,只是说「离线,上次在线 X」(❌ 从清单里消失)。 */
export type RemoteToolReach = { ok: true } | { ok: false; label: string };

export function remoteToolReach(
  device: Pick<RemoteHostDevice, 'isOnline' | 'lastSeenAt' | 'label' | 'cloudComputer'> | null,
  now: number,
  translate: Translate
): RemoteToolReach {
  if (!device) return { ok: false, label: translate('remoteWorkspace.machineGone') };
  if (device.isOnline) return { ok: true };
  // #7199 云电脑没醒着:打开它上面的会话就在叫醒它,说「正在唤醒」,❌ 说离线。
  if (device.cloudComputer === 'asleep' || device.cloudComputer === 'waking') {
    return { ok: false, label: translate('remoteHost.condition.waking', { device: device.label }) };
  }
  const ago = formatAgo(device.lastSeenAt, now, translate);
  return {
    ok: false,
    label: ago
      ? translate('remoteHost.condition.offline', { device: device.label, ago })
      : translate('remoteHost.condition.offlineNever', { device: device.label }),
  };
}

/**
 * 问那台机器失败时,文件树 / 编辑器 / 审阅里那一句。原因码只进悬停与日志,❌ 进这句话。
 * 超时(传输层,没有业务码)当成「那台机器没应答」。
 */
export function remoteWorkspaceFailure(error: unknown, device: string, translate: Translate): string {
  const code = remoteErrorCode(error);
  switch (code) {
    case 'unknown_method':
      return translate('remoteWorkspace.serverTooOld', { device });
    case 'session_not_found':
      return translate('remoteHost.condition.sessionGone', { device });
    case 'not_found':
      return translate('task.fileNotFound');
    case 'not_a_directory':
    case 'not_a_file':
      return translate('remoteWorkspace.notAFile');
    case 'permission_denied':
      return translate('remoteWorkspace.permissionDenied', { device });
    case 'outside_workspace':
      return translate('remoteWorkspace.outsideWorkspace');
    case null:
      return translate('remoteWorkspace.noAnswer', { device });
    default:
      return translate('remoteWorkspace.failed', { device });
  }
}

// ── 浏览器:那台机器上的 localhost ────────────────────────────────────────────

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '[::1]', '::1']);

/**
 * 这个网址是不是「那台机器自己」上的一个端口(localhost / 127.0.0.1 / 0.0.0.0 / [::1])。
 * 是 ⇒ 远端端口号(没写端口就是协议默认端口);不是 ⇒ null(普通网址照常在这台电脑上打开)。
 */
export function remoteLoopbackPort(url: string): number | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (!LOOPBACK_HOSTS.has(parsed.hostname)) return null;
  if (parsed.port) return Number(parsed.port);
  return parsed.protocol === 'https:' ? 443 : 80;
}

/**
 * 转好之后真正加载的网址:主机换成 **127.0.0.1**(ssh 转发只绑在它上面)、端口换成这台电脑上转过去的那个。
 * ❌ 写 `localhost`:浏览器可能把它解析到 ::1,落到这台电脑上另一个只听 IPv6 的服务(2026-09-24 实撞,
 * 在别的机器的会话里看到了这台电脑自己的私人目录)。地址栏照旧显示人要开的 `localhost:<远端端口>`(presentForwardedUrl)。
 */
export function forwardedUrl(url: string, localPort: number): string {
  const parsed = new URL(url);
  parsed.hostname = '127.0.0.1';
  parsed.port = String(localPort);
  return parsed.toString();
}

/**
 * 页签实际加载的 `127.0.0.1:<本机端口>` → 地址栏该显示的 `localhost:<那台机器上的端口>`(照 VS Code:地址栏里是人认识的那个)。
 * `remoteForLocal` 认不出这个本机端口 ⇒ null(原样显示)。
 */
export function presentForwardedUrl(url: string, remoteForLocal: (localPort: number) => number | null): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.hostname !== '127.0.0.1' || !parsed.port) return null;
  const remotePort = remoteForLocal(Number(parsed.port));
  if (remotePort === null) return null;
  parsed.hostname = 'localhost';
  parsed.port = String(remotePort);
  return parsed.toString();
}
