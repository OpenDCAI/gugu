import { autorun } from 'mobx';
import { rpc } from '@renderer/lib/ipc';
import { appState } from '@renderer/lib/stores/app-state';
import { log } from '@renderer/utils/logger';
import { auxWindows } from './aux-windows';
import { screenLayout } from './screen-layout';

/**
 * 「这条会话在屏上」只在这里定义(spec session-page「一屏几块」)。两种问法:
 *
 *  · 它的**页**在屏上 —— 主窗正显示的那页、会话页上摆在某一块里的、整页开在单独窗里的。会话页据此判
 *    「我看得见」(workspace-view-model:页签的激活、可见)。
 *  · 它在屏上 —— 页在屏上,或它的某一枚页签开在单独的窗里(那一格自己就算看得见,见 pane-layout-store
 *    detachToWindow)。闲置回收据此判「人在看,不停」(spec idle-reclaim「不在屏上」)。
 *
 * ❌ 哪个用到「在屏上」的地方自己再拼一份:屏上能摆会话的地方会再加(块、窗、页签窗都是后来加的),拼的那份
 * 不会跟着长。回收器原来只认主窗那一页,页签开在新窗口里审阅的会话被当成没人看停掉了(2026-10-22 owner 实测)。
 */
export function sessionPageOnScreen(sessionId: string): boolean {
  const navigation = appState.navigation;
  const onSessionView = navigation.currentViewId === 'session';
  const routed = (navigation.viewParamsStore['session'] as { sessionId?: string } | undefined)?.sessionId;
  return (
    (onSessionView && routed === sessionId) ||
    (onSessionView && screenLayout.blockOfSession(sessionId) !== undefined) ||
    auxWindows.windowOfSession(sessionId) !== undefined
  );
}

/** 此刻在屏上的每一条会话。 */
export function sessionsOnScreen(): string[] {
  const navigation = appState.navigation;
  const ids = new Set<string>();
  if (navigation.currentViewId === 'session') {
    const routed = (navigation.viewParamsStore['session'] as { sessionId?: string } | undefined)?.sessionId;
    if (routed) ids.add(routed);
    for (const session of screenLayout.sessions) ids.add(session.sessionId);
  }
  for (const window of auxWindows.windows.values()) {
    if (window.content.kind === 'session' || window.content.kind === 'tab') ids.add(window.content.sessionId);
  }
  return [...ids];
}

/** 开机时装一次:屏上的会话一变就报给主进程(闲置回收读它)。主进程看不见界面,只能由这里报。 */
export function wireSessionsOnScreenReport(): () => void {
  return autorun(() => {
    const sessionIds = sessionsOnScreen();
    void rpc.sessions.reportSessionsOnScreen(sessionIds).catch((error: unknown) => {
      log.warn('Failed to report the sessions on screen:', error);
    });
  });
}
