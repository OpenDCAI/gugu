import { useHotkey } from '@tanstack/react-hotkeys';
import { PanelRightClose, PanelRightOpen } from 'lucide-react'
import { useCallback, useEffect, useSyncExternalStore, type ReactNode } from 'react';
import { observer } from 'mobx-react-lite';
import { publishPanelToggle } from '@/lib/panelToggles';
import { hasWindowTitlebarRow, readRendererPlatform } from '@/lib/window-chrome';
import { useAppSettingsKey } from '@renderer/features/settings/use-app-settings-key';
import { getSessionPageStore } from '@renderer/features/sessions/stores/session-selectors';
import { ShellTitlebar } from '@renderer/lib/components/titlebar/shell-titlebar';
import { getEffectiveHotkey, getHotkeyRegistration } from '@renderer/lib/hooks/useKeyboardShortcuts';
import { isEmbedVisible, subscribeEmbedVisibility } from '@renderer/lib/portal-container';
import { appState } from '@renderer/lib/stores/app-state';
import { Button } from '@renderer/lib/ui/button';
import { useSessionShellContext } from './session-shell-context';
import { TitlebarActions } from './titlebar-actions';
import { useSessionMessages } from '@renderer/localization/use-session-messages';

// @@@sessionpage layout — the old task titlebar (task breadcrumb, nav arrows, git
// actions, pin, and the right-sidebar toggles incl. the Conversations flyout entry) is
// retired: tasks are invisible in the session layout and every surviving tool lives in
// the session's own tabs. The two shell-level panel toggles float over the
// content so their position stays stable without bringing the old chrome strip back.
//
// 这里只放**窗口 chrome** 级的动作(开关右边那块面板)。会话级的动作(分享、输出/来源)归那一块会话自己,
// 在它右上那条页签条的右端(session-main-column.tsx 的 SessionBlockActions)。❌ 别因为「视觉上挨着」就搬回这个固定簇。
export const SessionTitlebar = observer(function SessionTitlebar({
  leftSlot,
}: {
  /** 项目打开时挂在左上的项目菜单(项目名 / 仓库链接 / 删除项目)。
   *  ❌ 别再为它单开一条 40px 横条 —— 那正是 owner 说的「一步一景」的来源。 */
  leftSlot?: ReactNode
} = {}) {
  const { translate } = useSessionMessages();
  const { isNewSessionWorkspaceOpen, setNewSessionWorkspaceOpen } = useSessionShellContext();
  const sessionParams = appState.navigation.viewParamsStore.session as
    | { projectId?: string; sessionId?: string }
    | undefined;
  // 会话页没有面板可开关(#7052 一屏几块:对话是会话的一枚页签,工具页签与它同排)⇒ 这枚开关只在
  // 还没建任务的页面上(新建会话的草稿页、项目首页),那里仍是「输入框 + 右边一块面板」。
  const onSessionPage =
    appState.navigation.currentViewId === 'session' && sessionParams?.projectId && sessionParams.sessionId
      ? getSessionPageStore(sessionParams.projectId, sessionParams.sessionId) !== undefined
      : false;
  const isWorkspaceOpen = isNewSessionWorkspaceOpen;

  const workspacePanelLabel = isWorkspaceOpen
    ? translate('task.collapseWorkspacePanel')
    : translate('task.expandWorkspacePanel');

  const toggleWorkspace = useCallback(() => {
    setNewSessionWorkspaceOpen(!isWorkspaceOpen);
  }, [isWorkspaceOpen, setNewSessionWorkspaceOpen]);

  // #6753 Windows 标题栏行里那颗与「视图」菜单经 panelToggles 找到这里。
  useEffect(() => {
    if (onSessionPage) return;
    return publishPanelToggle('files', { open: isWorkspaceOpen, label: workspacePanelLabel, toggle: toggleWorkspace });
  }, [isWorkspaceOpen, onSessionPage, toggleWorkspace, workspacePanelLabel]);

  // Mod+.(toggleRightSidebar)只在没有任务的视图(新建会话页等)上有事可做,由这颗按钮自己接 ——
  // 按键与点按钮是同一个动作(#6754)。与其余 document 级快捷键同一道可见性闸(workspace.tsx)。
  const { value: keyboard } = useAppSettingsKey('keyboard');
  const embedVisible = useSyncExternalStore(subscribeEmbedVisibility, isEmbedVisible);
  useHotkey(getHotkeyRegistration('toggleRightSidebar', keyboard), toggleWorkspace, {
    enabled: !onSessionPage && embedVisible && getEffectiveHotkey('toggleRightSidebar', keyboard) !== null,
  });

  // 这枚开关**任何状态下都在这里**,贴窗口右缘同一个坐标 —— 面板是从它下面水平滑过去的。
  //
  // 曾经它在面板展开时搬进那条页签条的动作组(<TabBarActionRow>),收起时才回到这个固定簇,
  // 理由是「同一个容器才不会漂」。owner 2026-09-10 推翻了这个取舍:「按钮位置不变」是目的,
  // 「同屏只有一个容器」只是当时想到的手段;两者冲突时按位置不变来做。跨容器的基线一致由
  // <TabBarActionRow> 自己算高度与外边距来保证(它不继承页签的对齐),不靠这枚按钮搬家。
  // ❌ 别把它加回页签条的动作组:那会让同一个按钮同屏出现两份。

  return (
    <ShellTitlebar leftSlot={leftSlot}>
      {/* 工作级那一层:固定簇的成员只认 titlebar-actions.tsx 里的清单,少一个多一个都编译不过。
          Windows 上这颗住在标题栏行(WindowTitleBar),这里 ❌ 再画第二颗(#5454)。 */}
      {onSessionPage || hasWindowTitlebarRow(readRendererPlatform()) ? null : (
        <TitlebarActions
          actions={{
            'workspace-panel': (
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={workspacePanelLabel}
                title={workspacePanelLabel}
                onClick={toggleWorkspace}
              >
                {/* 图标随状态换形:一眼读出这一下是收起还是展开(Close/Open 是本仓库既有的面板开关词汇)。 */}
              {isWorkspaceOpen ? <PanelRightClose /> : <PanelRightOpen />}
              </Button>
            ),
          }}
        />
      )}
    </ShellTitlebar>
  );
});
