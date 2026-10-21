// @@@task-fusion (#2802) / @@@task-web-host — 会话页取宿主桥的唯一入口。
//
// 桥有两个来源,按优先级:
//   1. window.__GUGU_TASK_HOST_BRIDGE__ —— 网页版:咕咕壳在加载会话页 bundle 前装上的 WebSocket 桥
//      (src/lib/session-host-ws-client.ts)。❌ 不装到 window.electronAPI:壳里多处拿它的真值判「是不是
//      Electron」,装了会把网页版误判成桌面版。
//   2. window.electronAPI —— 桌面版:preload 注入。
// 两个都没有 = 宿主没接线,**响亮失败**,不静默降级成「功能默默不工作」。
export type SessionHostBridge = Pick<
  NonNullable<Window['electronAPI']>,
  'invoke' | 'eventSend' | 'eventOn' | 'getPathForFile' | 'requestWirePort'
>

export const SESSION_HOST_BRIDGE_KEY = '__GUGU_TASK_HOST_BRIDGE__'

export function findSessionHostBridge(): SessionHostBridge | null {
  if (typeof window === 'undefined') return null
  const injected = (window as unknown as Record<string, unknown>)[SESSION_HOST_BRIDGE_KEY]
  if (injected && typeof (injected as SessionHostBridge).invoke === 'function') {
    return injected as SessionHostBridge
  }
  return window.electronAPI ?? null
}

export function electronApi(): SessionHostBridge {
  const api = findSessionHostBridge()
  if (!api) {
    throw new Error('[session] 宿主桥不可用:桌面版缺 preload 注入,网页版缺任务页宿主连接')
  }
  return api
}
