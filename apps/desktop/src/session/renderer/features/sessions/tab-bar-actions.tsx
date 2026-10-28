import { useCommandProvider } from '@renderer/lib/commands/use-command-provider';
import { Cable, FileText, Globe, Plus, SquareTerminal } from '@/lib/icons'
import { GitFork, GitPullRequest } from 'lucide-react'
import { observer } from 'mobx-react-lite';
import { useState } from 'react';
import { ExtensionMark } from '@renderer/features/extensions/extension-mark';
import { installedExtensionsStore } from '@renderer/features/extensions/installed-extensions-store';
import { useNavigate } from '@renderer/lib/layout/navigation-provider';
import { usePaneContext } from '@renderer/features/tabs/pane-context';
import {
  useSessionViewContext,
  useWorkspaceViewModel
} from '@renderer/features/sessions/session-view-context';
import { Button } from '@renderer/lib/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger
} from '@renderer/lib/ui/dropdown-menu';
import { BoundShortcut } from '@renderer/lib/ui/shortcut';
import {
  getSessionWorkspaceActionOrder,
  opensAgentBrowser,
  sessionWorkspaceActionBlocked,
  workspaceBlockedTitle,
  type SessionWorkspaceActionId
} from './pane-empty-state';
import { canStartSideSession, startSideSession } from './start-side-session';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { useAgents } from '@renderer/lib/stores/use-agents';
import { useTerminalEnabled } from '@renderer/features/settings/use-terminal-enabled';

/**
 * 页签条上的「+」(spec session-page「一屏几块」):紧跟最后一个页签,打开这一格要放的东西。
 */
export const TabBarAddMenu = observer(function TabBarAddMenu() {
  const { translate } = useSessionMessages();
  const sessionView = useWorkspaceViewModel();
  const { projectId, sessionId } = useSessionViewContext();
  const { pane, paneId, isFocusedPane } = usePaneContext();
  const { data: agents } = useAgents();
  const { navigate } = useNavigate();
  const canSideSession = canStartSideSession(projectId, sessionId, agents);
  const terminalEnabled = useTerminalEnabled();
  const [open, setOpen] = useState(false);
  useCommandProvider({
    scopeId: 'session-sub',
    getCommands: () => !isFocusedPane ? [] : [{ id: 'session.openAddMenu', execute: () => setOpen(true) }],
  });

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger
        render={<Button size="icon-sm" variant="ghost" aria-label={translate('task.addPanel')} />}
      >
        <Plus className="size-3.5" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-44">
        {getSessionWorkspaceActionOrder(projectId, terminalEnabled).map((actionId) =>
          renderWorkspaceActionMenuItem(actionId, translate, {
            blocked: sessionWorkspaceActionBlocked(projectId, actionId) !== null,
            blockedTitle: workspaceBlockedTitle(sessionWorkspaceActionBlocked(projectId, actionId), translate, projectId),
            openBrowser: () =>
              opensAgentBrowser(projectId)
                ? sessionView.paneLayout.open('cloud-browser', {}, { preview: false, target: { paneId } })
                : pane.open('browser', { preview: false }),
            openFiles: () => pane.open('file-browser', {}, { preview: false }),
            openReview: () => sessionView.paneLayout.open('review', {}),
            openTerminal: () => void sessionView.openTerminalAsTab(),
            openPorts: () => sessionView.paneLayout.open('remote-ports', {}, { preview: false }),
            startSideSession: () => startSideSession(projectId, sessionId),
            canStartSideSession: canSideSession
          })
        )}
        {/* Installed Apps extend the menu without joining the built-in union: their kinds exist only at runtime, and
            widening that union would cost the exhaustiveness the built-ins get from it. Refs #2374.
            behavior tab-extensions「+」菜单分两段:上面那几项是给这条会话加的;这一段列已装的 App,点一个 = 把它放到
            这一格(它原来在哪就从哪拿走,一个 App 只有一份,#7052)。只列启用的:停用的不出现(owner 10-20「灰掉也占位置」),
            启用在「App」页 —— 最后一行就去那里。
            标题与它下面的项必须在同一个 DropdownMenuGroup 里:DropdownMenuLabel 是 Base UI 的 Menu.GroupLabel,
            没有 Menu.Group 在上面就抛错,整页会被错误边界拿下(装着一个 App 时打开这个菜单就是这样)。 */}
        <DropdownMenuGroup>
          {/* 一次性 11px → 收进闭合字阶(design.md:type roles are a closed set —— 2026-09-22)。 */}
          <DropdownMenuLabel className="text-foreground-passive text-xs font-normal">
            {translate('extensions.appsSection')}
          </DropdownMenuLabel>
          {installedExtensionsStore.enabledTabContributions.map((contribution) => (
            <DropdownMenuItem
              key={contribution.kind}
              onClick={() => sessionView.paneLayout.open(contribution.kind, {}, { preview: false, target: { paneId } })}
            >
              <ExtensionMark iconDataUrl={contribution.iconDataUrl} /> {contribution.title}
            </DropdownMenuItem>
          ))}
          <DropdownMenuItem onClick={() => navigate('apps')}>
            <Plus className="size-3.5" /> {translate('extensions.addAction')}…
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
});

function renderWorkspaceActionMenuItem(
  actionId: SessionWorkspaceActionId,
  translate: ReturnType<typeof useSessionMessages>['translate'],
  actions: {
    /** 这台机器上没有这一格:灰着、悬停说原因(完整能力披露,❌ 从菜单里删)。 */
    blocked: boolean;
    /** 悬停说的那句(远程 SSH 才有 / 云电脑只有通用)。 */
    blockedTitle?: string;
    openBrowser: () => void;
    openFiles: () => void;
    openReview: () => void;
    openTerminal: () => void;
    openPorts: () => void;
    startSideSession: () => void;
    canStartSideSession: boolean;
  }
) {
  switch (actionId) {
    case 'side-session':
      // spec session-resume 临时会话视图:分一支临时的去试,关 tab 即消失。分不出来时
      // 这一项 disabled 并说明原因 —— ❌ 不做成点了没反应的假按钮。
      return (
        <DropdownMenuItem
          key={actionId}
          disabled={!actions.canStartSideSession}
          title={actions.canStartSideSession ? undefined : translate('workspace.sideTaskUnavailable')}
          onClick={actions.startSideSession}
        >
          <GitFork className="size-3.5" /> {translate('workspace.sideTask')}
          <span className="ml-auto">
            <BoundShortcut commandId="session.sideSession" variant="keycaps" />
          </span>
        </DropdownMenuItem>
      );
    case 'review':
      return (
        <DropdownMenuItem key={actionId} onClick={actions.openReview}>
          <GitPullRequest className="size-3.5" /> {translate('workspace.review')}
        </DropdownMenuItem>
      );
    case 'terminal':
      return (
        <DropdownMenuItem
          key={actionId}
          disabled={actions.blocked}
          title={actions.blocked ? actions.blockedTitle : undefined}
          onClick={actions.openTerminal}
        >
          <SquareTerminal className="size-3.5" /> {translate('workspace.terminal')}
        </DropdownMenuItem>
      );
    case 'browser':
      return (
        <DropdownMenuItem
          key={actionId}
          disabled={actions.blocked}
          title={actions.blocked ? actions.blockedTitle : undefined}
          onClick={actions.openBrowser}
        >
          <Globe className="size-3.5" /> {translate('workspace.browser')}
        </DropdownMenuItem>
      );
    case 'ports':
      return (
        <DropdownMenuItem
          key={actionId}
          disabled={actions.blocked}
          title={actions.blocked ? actions.blockedTitle : undefined}
          onClick={actions.openPorts}
        >
          <Cable className="size-3.5" /> {translate('remotePorts.tool')}
        </DropdownMenuItem>
      );
    case 'files':
      return (
        <DropdownMenuItem key={actionId} onClick={actions.openFiles}>
          <FileText className="size-3.5" /> {translate('workspace.files')}
          <span className="ml-auto">
          </span>
        </DropdownMenuItem>
      );
  }
}

/**
 * ⌘\ = 分屏开关(spec session-page「并排」「常用键照浏览器」):没并排 = 此刻这页和上一枚看过的并排;并排着 = 拆开。
 * 分屏 ❌ 另设按钮(owner 2026-10-09「能拖拽的话是不是就不需要了」):靠拖到内容区边上、页签右键「向右分 / 向下分」或这个键;
 * 拆开另有两枚页签中间那颗钮。只有聚焦着的那一块接键。
 */
export const SplitPaneHotkey = observer(function SplitPaneHotkey() {
  const { pane, isFocusedPane } = usePaneContext();
  useCommandProvider({
    scopeId: 'session-sub',
    getCommands: () => !isFocusedPane || !pane.inSplitLayout ? [] : [{ id: 'session.splitPane', execute: () => pane.toggleSplit() }],
  });
  return null;
});
