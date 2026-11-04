import { useScreenBlock } from '@renderer/app/screen-block-context';
import { useCommandProvider } from '@renderer/lib/commands/use-command-provider';
import { Cable, Folder, Globe, Plus, SquareTerminal } from '@/lib/icons'
import { GitFork, GitPullRequest } from '@/lib/icons'
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
  sessionWorkspaceActionBlocked,
  workspaceBlockedTitle,
  type SessionWorkspaceActionId
} from './pane-empty-state';
import { canStartSideSession, startSideSession } from './start-side-session';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { useAgents } from '@renderer/lib/stores/use-agents';
import { useTerminalEnabled } from '@renderer/features/settings/use-terminal-enabled';
import { folderItem } from '@renderer/features/chats/chat-tabs/chat-panel-item';
import { openPanelItem } from '@renderer/features/chats/chat-tabs/chat-layouts';
import { useChatFolderName } from '@/components/chat/chatFolderName';
import { openApp } from '@/components/appSlot/useOpenApp';

/**
 * 页签条上的「+」(spec session-page「一屏几块」):紧跟最后一个页签,打开这一格要放的东西。一个「+」,一种样子,内容按它在哪:
 * - 任务页的一格(无 `chatId`):给这条会话加的那几项、文件夹、App;
 * - 块里一个对话的页签条(`chatId`:群、话题、人和人的私聊):这个对话的文件夹、能在这里打开的 App。
 */
export const TabBarAddMenu = observer(function TabBarAddMenu({ chatId }: { chatId?: string }) {
  const { translate } = useSessionMessages();
  const [open, setOpen] = useState(false);
  const menu = (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger
        render={
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={translate('task.addPanel')}
            data-testid={chatId ? 'block-panel-plus' : undefined}
          />
        }
      >
        <Plus className="size-3.5" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-44">
        {chatId ? <ChatAddItems chatId={chatId} /> : <TaskAddItems />}
      </DropdownMenuContent>
    </DropdownMenu>
  );
  // 对话的页签条没有这一格的留白,自己垫一点;⌘T 只属于任务页的一格(菜单内容只在打开时才挂上,键得挂在外面)。
  return chatId
    ? <span className="flex h-full shrink-0 items-center px-1">{menu}</span>
    : <>{menu}<OpenAddMenuCommand onOpen={() => setOpen(true)} /></>;
});

/** 任务页一格的那几项:给这条会话加的(侧会话、审阅、终端、浏览器、端口、文件)、文件夹,和已装的 App。 */
const TaskAddItems = observer(function TaskAddItems() {
  const { translate } = useSessionMessages();
  const sessionView = useWorkspaceViewModel();
  const { projectId, sessionId } = useSessionViewContext();
  const { pane, paneId } = usePaneContext();
  const { data: agents } = useAgents();
  const canSideSession = canStartSideSession(projectId, sessionId, agents);
  const terminalEnabled = useTerminalEnabled();
  const openTab = (kind: string) => sessionView.paneLayout.open(kind, {}, { preview: false, target: { paneId } });
  return (
    <>
      {getSessionWorkspaceActionOrder(projectId, terminalEnabled).map((actionId) =>
        renderWorkspaceActionMenuItem(actionId, translate, {
          blocked: sessionWorkspaceActionBlocked(projectId, actionId) !== null,
          blockedTitle: workspaceBlockedTitle(sessionWorkspaceActionBlocked(projectId, actionId), translate, projectId),
          openBrowser: () => pane.open('browser', { preview: false }),
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
          启用在「App」页 —— 最后一行就去那里。 */}
      <AppsSection
        apps={installedExtensionsStore.enabledTabContributions.map((contribution) => ({
          key: contribution.kind,
          title: contribution.title,
          iconDataUrl: contribution.iconDataUrl,
          open: () => openTab(contribution.kind),
        }))}
      />
    </>
  );
});

/** ⌘T:聚焦着的那一格打开它的「+」。 */
function OpenAddMenuCommand({ onOpen }: { onOpen: () => void }) {
  const { isFocusedPane } = usePaneContext();
  useCommandProvider({
    scopeId: 'session-sub',
    getCommands: () => !isFocusedPane ? [] : [{ id: 'session.openAddMenu', execute: onOpen }],
  });
  return null;
}

/** 块里一个对话的那几项(gugu-dev#181 第 ⑥ 步):这个对话的文件夹(群文件夹 / 文件夹),和能在这里打开的 App。 */
const ChatAddItems = observer(function ChatAddItems({ chatId }: { chatId: string }) {
  const folderName = useChatFolderName(chatId);
  return (
    <>
      <DropdownMenuItem onClick={() => openPanelItem(chatId, folderItem())}>
        <Folder className="size-3.5" /> {folderName}
      </DropdownMenuItem>
      <AppsSection
        apps={installedExtensionsStore.openableApps.map((app) => ({
          key: app.extensionId,
          title: app.name,
          iconDataUrl: app.iconDataUrl,
          open: () => openApp(app.extensionId, chatId),
        }))}
      />
    </>
  );
});

/**
 * 「App」那一段,两处同一份:列能在这里打开的 App,最后一行去「App」页装更多。
 * 标题与它下面的项必须在同一个 DropdownMenuGroup 里:DropdownMenuLabel 是 Base UI 的 Menu.GroupLabel,
 * 没有 Menu.Group 在上面就抛错,整页会被错误边界拿下(装着一个 App 时打开这个菜单就是这样)。
 */
function AppsSection({ apps }: { apps: { key: string; title: string; iconDataUrl: string | null; open: () => void }[] }) {
  const { translate } = useSessionMessages();
  const { navigate } = useNavigate();
  return (
    <DropdownMenuGroup>
      {/* 一次性 11px → 收进闭合字阶(design.md:type roles are a closed set —— 2026-09-22)。 */}
      <DropdownMenuLabel className="text-foreground-passive text-xs font-normal">
        {translate('extensions.appsSection')}
      </DropdownMenuLabel>
      {apps.map((app) => (
        <DropdownMenuItem key={app.key} onClick={app.open}>
          <ExtensionMark iconDataUrl={app.iconDataUrl} /> {app.title}
        </DropdownMenuItem>
      ))}
      <DropdownMenuItem onClick={() => navigate('apps')}>
        <Plus className="size-3.5" /> {translate('extensions.addAction')}…
      </DropdownMenuItem>
    </DropdownMenuGroup>
  );
}

function renderWorkspaceActionMenuItem(
  actionId: SessionWorkspaceActionId,
  translate: ReturnType<typeof useSessionMessages>['translate'],
  actions: {
    /** 这台机器上没有这一格:灰着、悬停说原因(完整能力披露,❌ 从菜单里删)。 */
    blocked: boolean;
    /** 悬停说的那句(远程 SSH 才有 / 云电脑只有通用)。 */
    blockedTitle?: string;
    openBrowser: () => void;
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
  }
}

/**
 * ⌘\ = 分屏开关(spec session-page「并排」「常用键照浏览器」):没并排 = 此刻这页和上一枚看过的并排;并排着 = 拆开。
 * 分屏 ❌ 另设按钮(owner 2026-10-09「能拖拽的话是不是就不需要了」):靠拖到内容区边上、页签右键「向右分 / 向下分」或这个键;
 * 拆开另有两枚页签中间那颗钮。只有聚焦着的那一块接键。
 */
export const SplitPaneHotkey = observer(function SplitPaneHotkey() {
  const { pane, isFocusedPane } = usePaneContext();
  const place = useScreenBlock();
  const multiBlock = place.blockId !== null && place.multi;
  useCommandProvider({
    scopeId: 'session-sub',
    getCommands: () => {
      if (!isFocusedPane) return [];
      // 页签全屏(tab-fullscreen.ts)和拆开是两件事:这个键只盖住 / 放开工作区,❌ 动布局。
      const fullscreen = { id: 'session.fullscreenTab' as const, execute: () => {
        const tabId = pane.resolvedActiveTabId;
        if (tabId) pane.tabFill(tabId, multiBlock)?.toggle();
      } };
      return pane.inSplitLayout ? [{ id: 'session.splitPane' as const, execute: () => pane.toggleSplit() }, fullscreen] : [fullscreen];
    },
  });
  return null;
});
