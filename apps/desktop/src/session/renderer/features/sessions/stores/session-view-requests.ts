/**
 * 壳请会话页做事的那座桥(gugu-dev#181):壳要打开一条对话,对话是会话页这屏的一块,摆不摆、摆在哪由这一页定。
 * (#7167 曾经还经它请会话页换「编程 / 通用」展示;那个手动切换已删,展示跟设置 → 通用的「终端」开关走。)
 *
 * 两棵 React 树在同一文档里、各有一份 module graph,出口沿用既有做法:一个 window 全局对象
 * (同 session-startup-failures)。读端在 apps/desktop/src/lib/sessionpageViewRequestBridge.ts,
 * 类型只从这里 type-import。
 */
export const SESSION_VIEW_REQUEST_BRIDGE_KEY = '__GUGU_SESSIONPAGE_VIEW_REQUESTS__';

export interface SessionViewRequestBridge {
  /**
   * gugu-dev#181 壳要打开一条对话(侧栏「对话」里点一行、通知、链接……):对话是会话页这屏的一块,
   * 摆不摆、摆在哪由这一页定。`beside` = ⌘ 点,并排放在正看着那块右边。
   */
  openChat(chatId: string, beside: boolean): void;
  /** Desktop group-name entry: preserve the group and let the session page own the single auxiliary pane. */
  openGroupChat?(sourceChatId: string, chatId: string): void;
  prepareGroupSession?(sourceChatId: string, target: { projectId: string; sessionId: string }): () => void;
}

/** 装到宿主文档的 window 上,让 gugu 那棵树读得到。幂等。打开对话那一下由入口接到这屏上(这里不认这屏)。 */
export function installSessionViewRequestBridge(target: Window, open: SessionViewRequestBridge): void {
  const bridge: SessionViewRequestBridge = { ...open };
  (target as unknown as Record<string, unknown>)[SESSION_VIEW_REQUEST_BRIDGE_KEY] = bridge;
}
