import { isScreenView, showBesideOnScreen, showOnScreen, showSessionBeside } from '@renderer/app/screen-layout-actions';
import { openSessionInSessionWhenReady } from '@renderer/features/sessions/open-session-in-session';
import { projectGroupsStore } from '@renderer/features/projects/stores/project-groups-store';
import { appState, sidebarStore } from '@renderer/lib/stores/app-state';
import type { ScreenBlockContent } from '@renderer/app/screen-layout';

/**
 * 壳要打开一条对话(侧栏「对话」里点一行、通知、链接、「发消息」……,gugu-dev#181):对话是这屏的一块。
 * 项目群不开对话块,开它的项目块(项目就是群;几台机器上的同一个项目认侧栏那一行)—— 只在这一处判。
 * ⌘ 点只在看这屏时才拼到旁边(同会话行、项目行)。
 */
export function openChatOnScreen(chatId: string, beside: boolean): void {
  const projectId = projectGroupsStore.projectOfChat(chatId);
  const content: ScreenBlockContent = projectId
    ? { kind: 'project', projectId: sidebarStore.rowProjectIdOf(projectId) }
    : { kind: 'chat', chatId };
  (beside && isScreenView(appState.navigation.currentViewId) ? showBesideOnScreen : showOnScreen)(content);
}

/**
 * 壳的「对话」里一条没有项目的会话(它就是和 agent 私聊):和侧栏会话行点下去同一个结果 ——
 * 导航到它;⌘ 点且正看着这屏时并排放在正看着那块右边。
 */
export function openSessionOnScreen(session: { projectId: string; sessionId: string }, beside: boolean): void {
  if (beside && isScreenView(appState.navigation.currentViewId)) {
    openSessionInSessionWhenReady({ ...session, onReady: () => showSessionBeside(session) });
    return;
  }
  appState.navigation.navigate('session', session);
  openSessionInSessionWhenReady(session);
}
