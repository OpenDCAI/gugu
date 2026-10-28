import { isScreenView, showBesideOnScreen, showOnScreen } from '@renderer/app/screen-layout-actions';
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
