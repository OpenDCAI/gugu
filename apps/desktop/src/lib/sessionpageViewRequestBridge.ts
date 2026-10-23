// #7167 — 聊天页那颗模式按钮选了「编程 / 通用」:打开任务之后,请会话页换成那种展示;gugu-dev#181 打开一条对话
// (对话是会话页这屏的一块)。读端适配边界。
//
// 写端在任务 renderer(apps/desktop/src/session/renderer/features/sessions/stores/session-view-requests.ts):
// 会话页上有那条会话的那一份 SessionActionsProvider 认领请求,能不能换、换前问不问由它判断、由它说 ——
// 聊天页这边不知道这一家给不给那种展示、机器是不是用 SSH 添加的(谁拒绝谁说话)。
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
  if (typeof shape.request !== 'function' || typeof shape.openChat !== 'function' || typeof shape.openSession !== 'function') {
    throw new Error('sessionpage view request bridge is present but malformed')
  }
  return candidate as SessionpageViewRequestBridge
}
