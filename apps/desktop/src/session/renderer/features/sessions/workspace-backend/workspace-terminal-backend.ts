// 终端页签背后按机器不同的那一半(界面只有一个:terminal-tab-provider + TerminalPtyContent + PtyPane)。
// 这台电脑:本机 pty(按任务存下来的几条终端,重启后接着用)。别的机器(照 VS Code 远程终端:
// https://code.visualstudio.com/docs/remote/ssh 的「Terminal」一节 —— 终端跑在那台机器上,画面还是同一个终端视图):
// 经 SSH 在会话目录里开一个 shell;连接状态写成终端最后一行、ssh 要问人时画提问卡片、拖进来的文件先传过去。
import type { ReactNode } from 'react';
import type { SessionTabContext } from '@renderer/features/tabs/core/session-tab-context';
import type { PtySession } from '@renderer/lib/pty/pty-session';
import type { RemoteTerminalFiles } from '@renderer/lib/pty/pty-pane';

/** 一条终端的数据(名字是人看的那一行)。 */
export type WorkspaceTerminalRecord = { readonly data: { readonly name: string } };

/** 按机器不同的终端外观:给 PtyPane 的那几项 + 盖在终端上的那一层(连接状态 / 提问卡片 / 传文件那一行)。 */
export type WorkspaceTerminalChrome = {
  /** 本机路径在那台机器上不存在:拖进 / 粘贴进来的文件改成先传过去,写那边的路径。 */
  remoteFiles?: RemoteTerminalFiles;
  /** 盖在终端上的那一层;`focusTerminal` 把键盘还给终端(提问卡片收起之后)。 */
  overlay?: (session: PtySession, focusTerminal: () => void) => ReactNode;
};

/** 一条会话的那几条终端(本机 = TerminalManagerStore;别的机器 = 那台机器上开的 shell)。 */
export interface WorkspaceTerminals {
  readonly isLoaded: boolean;
  readonly terminals: { get(id: string): WorkspaceTerminalRecord | undefined; has(id: string): boolean };
  readonly sessions: { get(id: string): PtySession | undefined };
  /** 新开一条(名字「终端 N」由它起)。 */
  createDefaultTerminal(): Promise<{ id: string }>;
  /** 这条终端没了(那头 exit、页签关掉):本机留着记录由终端抽屉管;别的机器上的就此断开。 */
  closeTerminal?(id: string): void;
  /** 这一条开不出来时的那一句(可观察);开着 / 在开 = null。 */
  failure?(id: string): string | null;
  retry?(id: string): void;
}

export interface WorkspaceTerminalBackend {
  /** 这台机器上的会话有没有终端格(只经云端连着的机器没有:❌ 走消息额度)。 */
  readonly available: boolean;
  /** 终端页签能不能从上次的快照复活(那条 SSH 活不过应用重启)。 */
  readonly persistent: boolean;
  terminals(ctx: SessionTabContext): WorkspaceTerminals | null;
  /** 这台机器的终端外观(本机没有)。 */
  useChrome?(ctx: SessionTabContext): WorkspaceTerminalChrome;
}
