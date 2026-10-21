// #6264 会话右侧工作区的「浏览器」打开那台机器上的 localhost:<端口> 时,这台电脑经 SSH 把一个本机端口转过去
// (照 VS Code 的端口转发)。这里是主进程报给渲染层的「这条转发此刻在哪一步」—— 与直连终端同一条纪律:
// 主进程只报步骤与原因代号,文案由渲染层按界面语言写(见 direct-terminal-link.ts 抬头)。
import { defineEvent } from '@shared/lib/ipc/events';
import type { DirectTerminalReason } from '@shared/direct-terminal-link';
import type { SshPrompt } from '@shared/ssh-prompt';

/** 端口转发失败的原因:SSH 那些原因之外,多两条转发自己的。 */
export type RemotePortReason =
  | DirectTerminalReason
  /** 那台机器不是在这台电脑上用 SSH 装上的(或换了账号):没有直连通道可转。 */
  | 'not-direct'
  /** 那台机器拒绝了这个端口的转发(sshd 关了 AllowTcpForwarding 之类)。 */
  | 'forward-refused'
  /** 要同号转(登录回跳),可这台电脑上同号端口被别的程序占着。 */
  | 'local-port-busy';

export type RemotePortLink = {
  deviceId: string;
  remotePort: number;
  phase: 'connecting' | 'ready' | 'failed' | 'closed';
  /** 转到了这台电脑的哪个端口(ready 之后才有)。 */
  localPort: number | null;
  /** ssh 此刻在等人回答的问题(密码 / 口令 / 新主机指纹);画成浏览器上方的提问卡片。 */
  prompt: SshPrompt | null;
  reason: RemotePortReason | null;
  /** 给人看的那台机器(SSH 地址)。 */
  label: string;
};

/** 同一台机器的同一个远端端口只转一条:这是它的键。 */
export function remotePortKey(deviceId: string, remotePort: number): string {
  return `${deviceId}:${remotePort}`;
}

/** 主进程推给渲染层的转发状态变化(topic = remotePortKey)。 */
export const remotePortLinkChannel = defineEvent<RemotePortLink>('remote-port:link');
