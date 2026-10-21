/**
 * 只有桌面版才有的主进程通道(例如「设置 → 设备」里经本机 ssh 做的那些事:列出用 SSH 装上的机器、卸载咕咕 server)。
 * 网页与手机没有这条路,返回 null —— 调用方据此不显示这些入口,❌ 假装能做。
 *
 * 产品代码经这里拿,❌ 直接摸 window.electronAPI(im-architecture 闸门的 product-direct-electron-api 一项)。
 */
export type DesktopIpc = {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>
  eventOn: (channel: string, callback: (data: unknown) => void) => () => void
}

export function desktopIpc(): DesktopIpc | null {
  if (typeof window === 'undefined') return null
  const api = window.electronAPI
  if (!api || typeof api.invoke !== 'function' || typeof api.eventOn !== 'function') return null
  return { invoke: (channel, ...args) => api.invoke(channel, ...args), eventOn: (channel, callback) => api.eventOn(channel, callback) }
}
