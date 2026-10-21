// @@@taskpage-session-startup-failures (#4602) — 会话页「会话启动失败账本」的读端适配边界。
//
// 写端在任务 renderer(apps/desktop/src/session/renderer/features/sessions/stores/session-startup-failures.ts):
// PTY 腿的 hydrate 以具名错误 reject 时记一条,显式重试标「重试中」,成功 / 标签页关闭时清掉。两棵 React 树在
// 同一文档里,但各有一份 module graph,所以接口沿用 #2549 / #2525 立下的形状:一个 window 全局对象。
// 类型与键**只从写端 type-import**(编译期擦除,不把任务 renderer 的 module 拉进 gugu 的 graph):两边漂开
// 就是 tsgo 红,❌ 不靠两份手抄副本在运行期碰运气。❌ 不新建 IPC 桥:主进程对 startSession 之前的 throw
// 不落任何状态,而 try 内失败落下的 durable 'error' 投影既不带 message 也不复位 —— renderer 手上那次
// hydrate 的原文与可重试性只在这份账本里。
//
// 为什么聊天面要读它:对话页「新建 Agent」时任务帧渲染的是 composer 根、切走 tab 时是 display-hidden,
// 会话页里的 toast 落在没人看的树里。用户此刻在这个 Agent 的私聊 —— 失败必须在这里显形(spec agent-reply
// 「跨面启动失败显形」)。
import type {
  SESSION_STARTUP_FAILURE_BRIDGE_KEY,
  SessionStartupFailure,
  SessionStartupFailureBridge,
} from '@/session/renderer/features/sessions/stores/session-startup-failures'

export type SessionpageSessionStartupFailure = SessionStartupFailure
export type SessionpageSessionStartupFailureBridge = SessionStartupFailureBridge

export const SESSIONPAGE_SESSION_STARTUP_FAILURE_BRIDGE_KEY =
  '__EMDASH_SESSION_STARTUP_FAILURES__' satisfies typeof SESSION_STARTUP_FAILURE_BRIDGE_KEY

/**
 * 桥不在 = 任务 bundle 还没跑到它的入口接线(或者这不是 Electron)。桥在但形状不对 = 两边构建漂开了,
 * 那是编程错误,照旧 throw(上面的 type-import 让它在 tsgo 就红,运行期几乎不可达)。
 */
export function readSessionpageSessionStartupFailureBridge(
  target: Window | undefined = typeof window === 'undefined' ? undefined : window,
): SessionpageSessionStartupFailureBridge | undefined {
  if (!target) return undefined
  const candidate = (target as unknown as Record<string, unknown>)[SESSIONPAGE_SESSION_STARTUP_FAILURE_BRIDGE_KEY]
  if (!candidate || typeof candidate !== 'object') return undefined
  const bridge = candidate as Partial<SessionpageSessionStartupFailureBridge>
  if (typeof bridge.snapshot !== 'function' || typeof bridge.subscribe !== 'function' || typeof bridge.retry !== 'function'
    || typeof bridge.describe !== 'function') {
    throw new Error('sessionpage session startup failure bridge is present but malformed')
  }
  return bridge as SessionpageSessionStartupFailureBridge
}
