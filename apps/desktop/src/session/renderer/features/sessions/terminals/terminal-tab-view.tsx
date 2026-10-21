import { Terminal } from '@/lib/icons'
import { observer } from 'mobx-react-lite';
import type { ResolvedTab, TabContentProps } from '@renderer/features/tabs/core/tab-provider';
import type { SessionTabContext } from '@renderer/features/tabs/core/session-tab-context';
import { LoadingIndicator } from '@/lib/loading/LoadingIndicator';
import { EmptyState } from '@renderer/lib/ui/empty-state';
import { Button } from '@renderer/lib/ui/button';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { workspaceBackend } from '../workspace-backend/workspace-backend';
import { TerminalPtyContent } from './terminal-pty-content';
import type { TerminalTabResourceView } from './terminal-tab-provider';

export const TabContent = observer(function TerminalTabContent({ host, ctx }: TabContentProps) {
  const { translate } = useSessionMessages();
  const sessionCtx = ctx as SessionTabContext;
  const backend = workspaceBackend(sessionCtx.projectId).terminal;
  const terminalManager = backend.terminals(sessionCtx);
  const chrome = backend.useChrome?.(sessionCtx);
  const terminalTabs = host.resolvedTabs.filter(
    (tab): tab is ResolvedTab<TerminalTabResourceView> => tab.kind === 'terminal'
  );
  // 并排时屏上有两枚(spec session-page「并排」):挑自己这种里亮着的那枚。
  const activeTab = host.resolvedTabs.find((tab) => tab.isActive && tab.kind === 'terminal');
  const activeTerminal =
    activeTab?.kind === 'terminal' ? (activeTab.resource as TerminalTabResourceView) : null;
  const activeSession = activeTerminal?.session ?? null;
  const allPtySessionIds = terminalTabs
    .map((tab) => tab.resource.session?.ptySessionId)
    .filter((id): id is string => Boolean(id));
  const failure = activeTerminal?.failure ?? null;

  return (
    <TerminalPtyContent
      className="h-full"
      activeSession={activeSession}
      allPtySessionIds={allPtySessionIds}
      autoFocus={activeTerminal !== null && host.resolvedActiveTabId === activeTab?.tabId}
      remoteFiles={chrome?.remoteFiles}
      overlay={chrome?.overlay}
      onExit={activeTerminal ? () => activeTerminal.exited() : undefined}
      emptyState={
        // ⚠️ 这一格以前把**两个不同的状态**塞在同一个 EmptyState 里：还没加载完（在等）
        // 与终端已被移除（等不到了）。两者对用户的含义相反，却长着同一张脸 ——
        // 而且两段文案是硬编码英文，中文用户看到的是英文（与 @@@4891 同一类缺陷）。
        //
        // 拆开：等待期走全产品统一的加载态（❌ 不在这里另造一个 spinner / 骨架），
        // 「已移除」仍是空态 —— 它不是在加载，给它转圈是撒谎。开不出来(别的机器)= 说一句 + 再试一次。
        failure ? (
          <EmptyState
            icon={<Terminal className="text-foreground-muted h-5 w-5" />}
            label={failure}
            action={
              <Button size="xs" variant="outline" onClick={() => activeTerminal?.retry()}>
                {translate('workspace.retry')}
              </Button>
            }
          />
        ) : terminalManager?.isLoaded && !activeTerminal?.terminal ? (
          <EmptyState
            icon={<Terminal className="text-foreground-muted h-5 w-5" />}
            label={translate('workspace.terminalUnavailable')}
            description={translate('workspace.terminalRemoved')}
          />
        ) : (
          <div className="flex h-full min-h-0 flex-1 items-center justify-center">
            <LoadingIndicator
              ariaLabel={translate('workspace.terminalRestoring')}
              label={translate('workspace.terminalRestoring')}
              data-testid="terminal-drawer-loading"
            />
          </div>
        )
      }
      workspaceId={sessionCtx.workspaceId}
    />
  );
});
