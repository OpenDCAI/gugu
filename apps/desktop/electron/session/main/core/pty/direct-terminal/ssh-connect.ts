/**
 * #6264 经 SSH 直连那台机器(端口转发)时,宿主给的「怎么连」与 ssh 问人的通道(askpass)。
 * 实现见 electron/server/ssh-machines.ts(连法)与 electron/server/ssh-prompts.ts(askpass)。
 */
import type { DirectTerminalReason } from '@shared/direct-terminal-link';
import type { SshKeyInstallOutcome, SshPrompt } from '@shared/ssh-prompt';

/** 宿主给的「怎么连」:命令本身,以及连不上/断开时怎么认出原因。 */
export type DirectTerminalCommand = {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  /** 给人看的那台机器(SSH 地址)。 */
  label: string;
  classifyExit(info: { exitCode: number | null; signal: number | string | null; tail: string }): {
    reason: DirectTerminalReason;
    retryable: boolean;
    /** reason = host-key-changed 时:哪台机器、它现在的指纹(界面据此给出删旧记录的命令)。 */
    hostKeyChanged?: { host: string; fingerprint: string | null };
  };
  /** ssh 问人的通道(宿主给;没有 = ssh 照旧自己在终端里问)。会话结束时由会话关掉。 */
  askpass?: DirectTerminalAskpass;
};

export type SshPromptOutcome = 'answered' | 'cancelled' | 'gone';

/** 宿主给的 askpass 通道(实现见 electron/server/ssh-prompts.ts 的 createTerminalAskpass)。 */
export type DirectTerminalAskpass = {
  /** 交给 ssh 子进程的环境变量(SSH_ASKPASS、SSH_ASKPASS_REQUIRE=force …)。 */
  env: Record<string, string>;
  /** 此刻该挂的提问;null = 收起。 */
  onPrompt(listener: (prompt: SshPrompt | null) => void): void;
  /** 每个提问怎么收场的。 */
  onSettled(listener: (prompt: SshPrompt, outcome: SshPromptOutcome) => void): void;
  /** installKey:密码提问上勾了「以后连这台机器不用再输密码」(#6264「下次免密」)。 */
  answer(promptId: string, value: string | null, extra?: { installKey?: boolean }): boolean;
  /** 这次连接登上了(调用方确认):勾过「下次免密」就在这时去装钥匙。 */
  authenticated?(): void;
  /** 「下次免密」做完的结果(装好了 / 没做成),可能在连接关掉之后才来。 */
  onKeyInstall?(listener: (outcome: SshKeyInstallOutcome) => void): void;
  /** 新的一次连接:「又问了一遍 = 上次答错」重新计。 */
  newRound(): void;
  /** 所有待答的一律收掉(这次连接已经没了)。 */
  cancelAll(): void;
  close(): Promise<void>;
};
