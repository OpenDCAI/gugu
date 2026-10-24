import { Terminal } from '@/lib/icons'
import { computed, makeObservable, reaction } from 'mobx';
import { observer } from 'mobx-react-lite';
import type { ResolvedTab, TabBarItemProps, TabEntry, TabHandle, TabProvider, TabResource, TabViewContext } from '@renderer/features/tabs/core/tab-provider';
import { createTabProvider } from '@renderer/features/tabs/core/tab-provider-registry';
import { registeredTabView } from '@renderer/features/tabs/core/tab-views';
import type { SessionTabContext } from '@renderer/features/tabs/core/session-tab-context';
import { GenericTabDragPreview, GenericTabItem } from '@renderer/features/tabs/tab-bar/generic-tab-item';
import type { PtySession } from '@renderer/lib/pty/pty-session';
import { workspaceBackend } from '../workspace-backend/workspace-backend';
import type { WorkspaceTerminalRecord, WorkspaceTerminals } from '../workspace-backend/workspace-terminal-backend';
import { useSessionMessages } from '@renderer/localization/use-session-messages';

// 终端页签只有这一种:这台电脑上的是本机 pty,别的机器上的是经 SSH 在会话目录里开的 shell
// (照 VS Code 远程终端 —— 终端跑在那台机器上,视图是同一个)。按机器不同的那一半在 workspace-terminal-backend。

export interface TerminalTabState {
  terminalId: string;
  /** 那条连接活不过应用重启(别的机器上的终端):❌ 从快照里复活一格连着空气的终端。 */
  ephemeral?: true;
}

export interface TerminalTabOpenArgs {
  terminalId: string;
}

export interface TerminalTabResourceView extends TabResource {
  readonly terminalId: string;
  readonly terminal: WorkspaceTerminalRecord | undefined;
  readonly session: PtySession | null;
  /** 开不出来时的那一句(别的机器上的终端);其余 = null。 */
  readonly failure: string | null;
  retry(): void;
  /** 那头 exit 了:别的机器上的这条就此断开,页签随之关掉(本机的终端由抽屉管,这里不动)。 */
  exited(): void;
}

class TerminalTabResource implements TerminalTabResourceView {
  private readonly disposeStaleReaction: () => void;
  private isDisposed = false;

  constructor(
    readonly terminalId: string,
    private readonly terminalManager: WorkspaceTerminals,
    private readonly handle: TabHandle
  ) {
    makeObservable(this, {
      terminal: computed,
      failure: computed,
    });

    this.disposeStaleReaction = reaction(
      () => ({
        isLoaded: this.terminalManager.isLoaded,
        hasTerminal: this.terminalManager.terminals.has(this.terminalId),
      }),
      ({ isLoaded, hasTerminal }) => {
        if (isLoaded && !hasTerminal) {
          setTimeout(() => void this.handle.close({ force: true }), 0);
        }
      },
      { fireImmediately: true }
    );
  }

  get terminal(): WorkspaceTerminalRecord | undefined {
    return this.terminalManager.terminals.get(this.terminalId);
  }

  get session() {
    return this.terminalManager.sessions.get(this.terminalId) ?? null;
  }

  get failure(): string | null {
    return this.terminalManager.failure?.(this.terminalId) ?? null;
  }

  retry(): void {
    this.terminalManager.retry?.(this.terminalId);
  }

  exited(): void {
    this.terminalManager.closeTerminal?.(this.terminalId);
  }

  dispose(): void {
    if (this.isDisposed) return;
    this.isDisposed = true;
    this.disposeStaleReaction();
    this.session?.dispose();
    this.terminalManager.closeTerminal?.(this.terminalId);
  }

  onActivateIntent(): void {
    const session = this.session;
    if (session?.status === 'disconnected') void session.connect();
  }
}

class MissingTerminalTabResource implements TerminalTabResourceView {
  constructor(readonly terminalId: string) {}

  get terminal(): WorkspaceTerminalRecord | undefined {
    return undefined;
  }

  get session() {
    return null;
  }

  readonly failure = null;

  retry(): void {}

  exited(): void {}

  dispose(): void {}

  onActivateIntent(): void {}
}

function TerminalIcon() {
  return <Terminal className="size-4 shrink-0" />;
}

const TerminalTabBarItem = observer(function TerminalTabBarItem({
  tab,
  host,
  ctx,
}: TabBarItemProps<TerminalTabResourceView>) {
  const { translate } = useSessionMessages();
  const terminal = tab.resource.terminal;
  // 终端名字是用户可改的数据；只有还没命名时才落到本地化外壳。
  const label = terminal?.data.name ?? translate('workspace.terminal');

  return (
    <GenericTabItem tab={tab} host={host} ctx={ctx} label={label} preSlot={<TerminalIcon />} />
  );
});

const TerminalTabBarItemDragPreview = observer(function TerminalTabBarItemDragPreview({
  tab,
}: {
  tab: ResolvedTab<TerminalTabResourceView>;
}) {
  const { translate } = useSessionMessages();
  const label = tab.resource.terminal?.data.name ?? translate('workspace.terminal');
  return <GenericTabDragPreview preSlot={<TerminalIcon />} label={label} />;
});

export const terminalTabProvider: TabProvider<
  'terminal',
  TerminalTabState,
  TerminalTabResourceView,
  TerminalTabOpenArgs
> = createTabProvider({
  kind: 'terminal',
  mount: 'single',
  resourceKey: (state: TerminalTabState) => state.terminalId,
  isPersistent: (state: TerminalTabState) => !state.ephemeral,

  onBeforeOpen(args: TerminalTabOpenArgs, ctx: TabViewContext): TerminalTabState | null {
    const sessionCtx = ctx as SessionTabContext;
    const backend = workspaceBackend(sessionCtx.projectId).terminal;
    if (!backend.terminals(sessionCtx)) return null;
    return backend.persistent ? { terminalId: args.terminalId } : { terminalId: args.terminalId, ephemeral: true };
  },

  initialize(
    entry: TabEntry<TerminalTabState>,
    handle: TabHandle,
    ctx: TabViewContext
  ): TerminalTabResourceView {
    const sessionCtx = ctx as SessionTabContext;
    const terminalManager = workspaceBackend(sessionCtx.projectId).terminal.terminals(sessionCtx);
    if (!terminalManager) {
      setTimeout(() => void handle.close({ force: true }), 0);
      return new MissingTerminalTabResource(entry.state.terminalId);
    }
    return new TerminalTabResource(entry.state.terminalId, terminalManager, handle);
  },

  dispose(_entry: TabEntry<TerminalTabState>, resource: TerminalTabResourceView): void {
    resource.dispose();
  },

  TabBarItem: TerminalTabBarItem,
  TabBarItemDragPreview: TerminalTabBarItemDragPreview,
  TabContent: registeredTabView('terminal'),
});
