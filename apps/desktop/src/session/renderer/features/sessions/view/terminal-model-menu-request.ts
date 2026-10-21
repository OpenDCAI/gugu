import { useSyncExternalStore } from 'react';

/**
 * 终端会话没起来、原因是模型要会员时(#7092),失败页上那颗「换模型」要打开页签条右端那颗模型按钮的面板。
 * 两者不在一棵子树里(失败页在内容区、按钮在页签条),经这里按会话 id 递一个序号:每加一次 = 再开一次。
 */
const requests = new Map<string, number>();
const listeners = new Set<() => void>();

export function requestTerminalModelMenu(sessionId: string): void {
  requests.set(sessionId, (requests.get(sessionId) ?? 0) + 1);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 这条会话被要求打开模型面板的次数(只增不减;读者按自己挂上那一刻的值算增量)。 */
export function useTerminalModelMenuRequest(sessionId: string): number {
  return useSyncExternalStore(subscribe, () => requests.get(sessionId) ?? 0);
}
