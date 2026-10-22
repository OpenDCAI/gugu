/**
 * 桌面此刻在屏上的会话(渲染层报来的,定义在 renderer/app/sessions-on-screen.ts):主窗那页、会话页上每一块、
 * 单独的窗、开在窗里的页签所属的会话。主进程看不见界面,只能由渲染层报;闲置回收据此不停人正看着的会话。
 */
let onScreen: ReadonlySet<string> = new Set();

export function setSessionsOnScreen(sessionIds: readonly string[]): void {
  onScreen = new Set(sessionIds);
}

export function sessionOnScreen(sessionId: string): boolean {
  return onScreen.has(sessionId);
}
