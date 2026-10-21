/**
 * Pane selectors for the conversations domain.
 *
 * These helpers let conversation UI read conversation-tab state from a generic
 * PaneStore without the engine having to know about SessionTabResource.
 */
import type { PaneStore } from '@renderer/features/tabs/pane-store';
import type { AcpChatTabResource } from './acp/acp-chat-tab-resource';
import type { SessionTabResource } from './session-tab-resource';

export function activeSessionId(pane: PaneStore): string | undefined {
  const resource = pane.activeResourceOfKind<SessionTabResource>('session');
  return resource?.sessionId;
}

export function activeSessionResource(pane: PaneStore): SessionTabResource | undefined {
  return pane.activeResourceOfKind<SessionTabResource>('session');
}

/** @deprecated Use activeSessionResource */
export const activeSession = (pane: PaneStore, _sessions?: unknown) =>
  activeSessionResource(pane)?.store;

/**
 * 这个 pane 此刻显示的那条会话 —— 不论它是 pty 页签('conversation')还是 ACP 页签('acp-chat')。
 *
 * 「当前是哪条会话」在产品里只有一个答案,所以只写一处:侧栏行的高亮、键盘导航的光标、命令面板上
 * 「归档任务 / Mod+Shift+E」点名的对象读的都是它。❌ 各处 `?? acp-chat` 抄一遍 —— 抄第三份的那天,
 * 三个地方就开始对「用户正看着谁」给出不同答案。
 */
export function focusedSessionId(pane: PaneStore): string | undefined {
  return (
    activeSessionId(pane) ??
    pane.activeResourceOfKind<AcpChatTabResource>('acp-chat')?.store.sessionId
  );
}
