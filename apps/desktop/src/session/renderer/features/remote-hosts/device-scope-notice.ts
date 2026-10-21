// #6264 分机器的模块(资源库、已安排、存储)看的是别的机器,而那台机器此刻给不出东西时,页面上那一句话。
//
// 写给不懂技术的人:哪台机器、出了什么事、接下来会怎样。原因码 ❌ 进句子(老 server 报的 `unknown_method`、
// 超时的错误名都只用来归类)。纯函数(翻译函数注入),每条判据都有单测。
import { TOO_OLD_CODES, cloudWakeFailureText, formatAgo, type Translate } from '@renderer/features/remote-hosts/connection-status';
import type { CloudComputerWakeFailure } from '@/session/shared/remote-hosts';

export type DeviceScopeNoticeKind = 'offline' | 'server-too-old' | 'unreachable' | 'failed' | 'waking';

export type DeviceScopeNotice = {
  kind: DeviceScopeNoticeKind;
  text: string;
  /** 句子里带不带「再试一次」(离线、太旧重试也没用)。 */
  retry: boolean;
  /** 页面照旧画上次读到的那一份,但动作全灰:那台机器此刻做不了任何事。 */
  readOnly: boolean;
};

function errorCode(error: unknown): string | null {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && code ? code : null;
}

export function deviceScopeNotice(
  input: {
    remote: { deviceLabel: string; online: boolean; lastSeenAt: string | null } | null;
    /** 这一页那一问的错误(react-query 的 error)。 */
    error: unknown;
    /** 手上有没有那台机器上一次的读数(有就照旧画,只读)。 */
    hasData: boolean;
    now: number;
    /**
     * #7199 看的是一台没醒着的云电脑(选了它就在叫醒它,见 RemoteHostsStore.cloudScope):说「正在唤醒」或没叫醒的原因,
     * ❌ 说离线。醒着 / 不是云电脑 = 缺席。
     */
    cloud?: { state: 'asleep' | 'waking' | 'wake-failed'; failure: CloudComputerWakeFailure | null } | null;
  },
  translate: Translate
): DeviceScopeNotice | null {
  const { remote } = input;
  if (!remote) return null;
  const device = remote.deviceLabel;
  if (input.cloud && !remote.online) {
    const text = input.cloud.failure
      ? cloudWakeFailureText(input.cloud.failure, device, translate)
      : translate(input.hasData ? 'deviceScope.wakingCached' : 'deviceScope.wakingEmpty', { device });
    return { kind: 'waking', text, retry: false, readOnly: true };
  }
  if (!remote.online) {
    const ago = formatAgo(remote.lastSeenAt, input.now, translate);
    const text = ago
      ? translate(input.hasData ? 'deviceScope.offlineSinceCached' : 'deviceScope.offlineSinceEmpty', { device, ago })
      : translate(input.hasData ? 'deviceScope.offlineCached' : 'deviceScope.offlineEmpty', { device });
    return { kind: 'offline', text, retry: false, readOnly: true };
  }
  if (!input.error) return null;
  const code = errorCode(input.error);
  // 老 server 不认这个动词(`unknown_method`),或不认一套工作台、线根本开不起来(`server_outdated`)。
  if (code && TOO_OLD_CODES.has(code)) {
    return { kind: 'server-too-old', text: translate('deviceScope.serverTooOld', { device }), retry: false, readOnly: true };
  }
  if (input.error instanceof Error && input.error.name === 'DeviceRpcTimeoutError') {
    return { kind: 'unreachable', text: translate('deviceScope.unreachable', { device }), retry: true, readOnly: false };
  }
  return { kind: 'failed', text: translate('deviceScope.failed', { device }), retry: true, readOnly: false };
}
