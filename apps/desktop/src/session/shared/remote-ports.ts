// #6264 别的机器上的端口(照 VS Code 的 Ports 视图 + 自动发现):主进程报给渲染层的「这台机器有哪些端口」。
// 与转发状态(remote-port-link.ts)分开放:那一份是「某一条转发此刻在哪一步」,这一份是整张表。
import { defineEvent } from '@shared/lib/ipc/events';
import type { RemotePortLink } from '@shared/remote-port-link';

/**
 * 这个端口是怎么进这张表的(「来源」一列,照 VS Code 的 Origin):
 *  · terminal / agent —— 终端或 agent 的输出里提到了它(VS Code 的 output 自动发现);
 *  · listening       —— 在那台机器上查到有程序在听(打开「端口」页签 / 刷新时查一次);
 *  · browser         —— 浏览器页签里打开过它(含页面里顺带请求的别的端口);
 *  · manual          —— 人在「端口」页签里手动转的;
 *  · login           —— 那台机器上的程序打开登录页时,网址里的回调端口(VS Code 1.88 起同样自动转)。
 */
export type RemotePortSource = 'terminal' | 'agent' | 'listening' | 'browser' | 'manual' | 'login';

/** 持有者前缀:人手动转的、登录回调转的;其余持有者都是浏览器页签。 */
export const MANUAL_PORT_HOLDER = 'manual';
export const LOGIN_PORT_HOLDER_PREFIX = 'login:';

export function holderSource(holder: string): RemotePortSource {
  if (holder === MANUAL_PORT_HOLDER) return 'manual';
  if (holder.startsWith(LOGIN_PORT_HOLDER_PREFIX)) return 'login';
  return 'browser';
}

export type DetectedRemotePort = {
  remotePort: number;
  /** 在哪条会话里发现的(打开时开进那条会话的浏览器格)。 */
  sessionId: string;
  source: 'terminal' | 'agent';
  at: number;
};

export type RemotePortsSnapshot = {
  forwards: Array<RemotePortLink & { holders: string[] }>;
  detected: DetectedRemotePort[];
};

/** 这台机器的端口表变了(topic = deviceId)。 */
export const remotePortsChangedChannel = defineEvent<{ deviceId: string }>('remote-port:changed');

/** 发现了一个新端口(只在第一次发现时报一次;渲染层据此弹「可以打开了」)。 */
export const remotePortDetectedChannel = defineEvent<DetectedRemotePort & { deviceId: string }>('remote-port:detected');
