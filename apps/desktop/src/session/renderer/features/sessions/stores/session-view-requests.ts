import { observable, runInAction } from 'mobx';
import type { SessionView } from '@shared/core/sessions/sessions';

/**
 * 聊天页那颗模式按钮选了「编程 / 通用」(#7167):聊天页先照旧打开这条任务(主进程 focus-session),
 * 再经这座桥请会话页换成那种展示。**能不能换、换之前要不要问,都由会话页判断、会话页说** ——
 * 聊天页不知道这一家给不给那种展示、这台机器是不是用 SSH 添加的(谁拒绝谁说话)。
 *
 * 两棵 React 树在同一文档里、各有一份 module graph,出口沿用既有做法:一个 window 全局对象
 * (同 session-startup-failures)。读端在 apps/desktop/src/lib/sessionpageViewRequestBridge.ts,
 * 类型只从这里 type-import。
 *
 * 一条请求只认领一次:页面上有这条会话的那一份 SessionActionsProvider 拿走它(`take`)。会话还没加载出来时
 * 请求就先挂着,加载出来那一刻 reaction 再认领 —— ❌ 定时重试。
 * 挂太久的作废(`REQUEST_TTL_MS`):请求是「刚点完、页面正在打开」那一下的事,隔了很久才被认领(名单一直没到、
 * 页面后来才开)就不该突然弹出一个确认框 —— 那时人早就不在等它了。
 */
export const REQUEST_TTL_MS = 15_000;
export const SESSION_VIEW_REQUEST_BRIDGE_KEY = '__GUGU_SESSIONPAGE_VIEW_REQUESTS__';

export interface SessionViewRequestBridge {
  request(sessionId: string, view: SessionView): void;
}

const pending = observable.map<string, { view: SessionView; at: number }>();

export const sessionViewRequests = {
  request(sessionId: string, view: SessionView): void {
    runInAction(() => pending.set(sessionId, { view, at: Date.now() }));
  },
  /** 挂着等认领的会话 id(observable:reaction 读它)。 */
  pendingIds(): string[] {
    return [...pending.keys()];
  },
  /** 认领一条:拿走就删,同一条请求不会被处理两次;挂过了期限的拿走也作废。 */
  take(sessionId: string): SessionView | undefined {
    const entry = pending.get(sessionId);
    if (entry === undefined) return undefined;
    runInAction(() => pending.delete(sessionId));
    return Date.now() - entry.at <= REQUEST_TTL_MS ? entry.view : undefined;
  },
};

const bridge: SessionViewRequestBridge = { request: sessionViewRequests.request };

/** 装到宿主文档的 window 上,让 gugu 那棵树读得到。幂等。 */
export function installSessionViewRequestBridge(target: Window): void {
  (target as unknown as Record<string, unknown>)[SESSION_VIEW_REQUEST_BRIDGE_KEY] = bridge;
}
