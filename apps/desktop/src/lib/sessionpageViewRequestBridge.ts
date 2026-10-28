// gugu-dev#181 — 壳要打开一条对话(对话是会话页这屏的一块)。读端适配边界。
// (#7167 曾经还经它请会话页换「编程 / 通用」展示;那个手动切换已删。)
//
// 写端在任务 renderer(apps/desktop/src/session/renderer/features/sessions/stores/session-view-requests.ts)。
// 形状沿用 #4602 那座桥:一个 window 全局对象,类型与键**只从写端 type-import**;❌ 不新建 IPC 桥
// (两棵树同一文档,主进程在这件事里没有要判断的东西)。
import type {
  SESSION_VIEW_REQUEST_BRIDGE_KEY,
  SessionViewRequestBridge,
} from '@/session/renderer/features/sessions/stores/session-view-requests'

export type SessionpageViewRequestBridge = SessionViewRequestBridge

export const SESSIONPAGE_VIEW_REQUEST_BRIDGE_KEY =
  '__GUGU_SESSIONPAGE_VIEW_REQUESTS__' satisfies typeof SESSION_VIEW_REQUEST_BRIDGE_KEY

/** 桥不在 = 任务 bundle 还没跑到入口接线(或不是 Electron)。桥在但形状不对 = 两边构建漂开了,照旧 throw。 */
export function readSessionpageViewRequestBridge(
  target: Window | undefined = typeof window === 'undefined' ? undefined : window,
): SessionpageViewRequestBridge | undefined {
  if (!target) return undefined
  const candidate = (target as unknown as Record<string, unknown>)[SESSIONPAGE_VIEW_REQUEST_BRIDGE_KEY]
  if (!candidate || typeof candidate !== 'object') return undefined
  const shape = candidate as Partial<SessionpageViewRequestBridge>
  if (typeof shape.openChat !== 'function') {
    throw new Error('sessionpage view request bridge is present but malformed')
  }
  return candidate as SessionpageViewRequestBridge
}
