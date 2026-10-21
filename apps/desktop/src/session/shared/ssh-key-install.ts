// #6264「下次免密」:人用密码登上一台机器并勾了「以后连这台机器不用再输密码」,咕咕替他装好钥匙之后,
// 主进程把结果报给渲染层(弹一条提示)。与连接状态同一条纪律:主进程只报结果代号,文案由渲染层按界面语言写。
import { defineEvent } from '@shared/lib/ipc/events';
import type { SshKeyInstallOutcome } from '@shared/ssh-prompt';

export type SshKeyInstallReport = {
  /** 给人看的那台机器(SSH 地址)。 */
  label: string;
  outcome: SshKeyInstallOutcome;
};

/** 主进程 → 渲染层:「下次免密」做完了(不分会话,全局一条)。 */
export const sshKeyInstallChannel = defineEvent<SshKeyInstallReport>('ssh-key-install:done');
