/**
 * #6264 经 SSH 直连那台机器(照 VS Code Remote-SSH 的端口转发:不走咕咕云的消息额度)的连法注入口。
 * 「这台机器能不能直连、怎么连」只有宿主知道(SSH 一步装好时记下的本机映射,见
 * electron/server/ssh-machines.ts):宿主经桥注入 resolver。没注入(网页形态的会话页)或那台机器
 * 不是用 SSH 装的 ⇒ null,端口转发就说「这台机器只经咕咕云连着」。
 *
 * 终端与会话本身不走这里:别的机器上的会话与本机同一套 rpc.pty,帧走那台机器的设备连接
 * (远程 SSH 的机器那条连接就是 SSH,见 host-ws/device-session-host.ts)。
 */
import type { DirectTerminalCommand } from './ssh-connect';

/** 经 SSH 直连那台机器去干什么:把这台电脑的 localPort 转到那台机器的 remotePort(工作区的「浏览器」打开 localhost 时)。 */
export type DirectSshPurpose = { kind: 'forward'; localPort: number; remotePort: number };

export type DirectTerminalTarget = { deviceId: string; sessionId: string; purpose?: DirectSshPurpose };

/**
 * #6264 端口转发骑在这台机器那条共享连接上时的三条 ssh:确保连接在(要密码就经 askpass 问一次)、
 * 加这条转发(`-O forward`)、撤掉它(`-O cancel`)。没有复用连接(Windows)时不给,转发单开一条连接。
 */
export type SshMuxForward = { ensureArgs: string[]; forwardArgs: string[]; cancelArgs: string[] };

/** 宿主给的:这台机器可以直连就给出连法,否则 null。 */
export type DirectTerminalResolver = (
  target: DirectTerminalTarget
) => Promise<(Omit<DirectTerminalCommand, 'cwd' | 'env'> & { mux?: SshMuxForward }) | null>;

/** 端口转发那边也要问同一个宿主(port-forward.ts)。 */
export function directSshResolver(): DirectTerminalResolver | null {
  return resolver;
}

let resolver: DirectTerminalResolver | null = null;

export function setDirectTerminalResolver(next: DirectTerminalResolver | null): void {
  resolver = next;
}
