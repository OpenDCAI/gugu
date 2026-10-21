// #6264 装好一台机器之后「在这台机器上新建任务」:从设置里一步落到会话页的新建页,机器已经选好。
//
// 两棵 React 树(咕咕主渲染层 / 会话页)是同一文档里分别加载的两份模块,互相 import 不到对方的单例,
// 所以照既有的 window 适配对象约定(__GUGU_OPEN_SESSIONPAGE_AGENT_INSTALL__ 同款)各挂一半:
//   · 会话页挂 SESSIONPAGE_NEW_SESSION_KEY:记下「在这台机器上新开一条」的意图并切到新建页;
//   · 主渲染层挂 HOST_OPEN_NEW_SESSION_KEY:关掉设置、切到「任务」tab,再交给会话页那一半。
// 会话页还没加载完时意图先放在 PENDING_KEY,会话页挂桥时取走 —— ❌ 点了没反应。

export const SESSIONPAGE_NEW_SESSION_KEY = '__GUGU_SESSIONPAGE_NEW_SESSION_ON_DEVICE__' as const
export const SESSIONPAGE_PENDING_NEW_SESSION_KEY = '__GUGU_SESSIONPAGE_PENDING_NEW_SESSION__' as const
export const HOST_OPEN_NEW_SESSION_KEY = '__GUGU_OPEN_NEW_SESSION_ON_DEVICE__' as const

export type NewSessionBridgeWindow = {
  [SESSIONPAGE_NEW_SESSION_KEY]?: (deviceId: string) => void
  [SESSIONPAGE_PENDING_NEW_SESSION_KEY]?: string
  [HOST_OPEN_NEW_SESSION_KEY]?: (deviceId: string) => void
}

/** 会话页那一半:意图交给 `open`,并把挂桥之前就到了的那一次补上。 */
export function installSessionpageNewSessionBridge(w: NewSessionBridgeWindow, open: (deviceId: string) => void): void {
  w[SESSIONPAGE_NEW_SESSION_KEY] = open
  const pending = w[SESSIONPAGE_PENDING_NEW_SESSION_KEY]
  if (pending) {
    delete w[SESSIONPAGE_PENDING_NEW_SESSION_KEY]
    open(pending)
  }
}

/** 主渲染层那一半切好 tab 之后调:会话页在就直接交过去,不在就先存着。 */
export function handOverToSessionpage(w: NewSessionBridgeWindow, deviceId: string): void {
  const open = w[SESSIONPAGE_NEW_SESSION_KEY]
  if (open) open(deviceId)
  else w[SESSIONPAGE_PENDING_NEW_SESSION_KEY] = deviceId
}

/** 设置里的按钮调这一句;这个装配里没有会话页(网页 / 手机)时回 false,按钮就不出。 */
export function openNewSessionOnDevice(deviceId: string, w: NewSessionBridgeWindow = window as unknown as NewSessionBridgeWindow): boolean {
  const open = w[HOST_OPEN_NEW_SESSION_KEY]
  if (!open) return false
  open(deviceId)
  return true
}

export function canOpenNewSessionOnDevice(w: NewSessionBridgeWindow = window as unknown as NewSessionBridgeWindow): boolean {
  return typeof w[HOST_OPEN_NEW_SESSION_KEY] === 'function'
}

// #6264 设置 → 设备那一行的「重新连接」:会话页里这台机器的会话列表与开着的会话立刻重连,不等退避。
// 侧栏机器名从前点开有这一项,owner 嫌易误触把它改成了纯标签(「这里容易误触啊,不要让我点击有功能吧?」),
// 这一项就只剩设置里这一个入口。会话页不在这个装配里(网页 / 手机)时不出这一项。
export const SESSIONPAGE_RECONNECT_DEVICE_KEY = '__GUGU_SESSIONPAGE_RECONNECT_DEVICE__' as const

export type ReconnectBridgeWindow = {
  [SESSIONPAGE_RECONNECT_DEVICE_KEY]?: (deviceId: string) => void
}

export function installSessionpageReconnectBridge(w: ReconnectBridgeWindow, reconnect: (deviceId: string) => void): void {
  w[SESSIONPAGE_RECONNECT_DEVICE_KEY] = reconnect
}

export function canReconnectDevice(w: ReconnectBridgeWindow = window as unknown as ReconnectBridgeWindow): boolean {
  return typeof w[SESSIONPAGE_RECONNECT_DEVICE_KEY] === 'function'
}

export function reconnectDevice(deviceId: string, w: ReconnectBridgeWindow = window as unknown as ReconnectBridgeWindow): boolean {
  const reconnect = w[SESSIONPAGE_RECONNECT_DEVICE_KEY]
  if (!reconnect) return false
  reconnect(deviceId)
  return true
}
