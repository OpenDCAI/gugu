// @@@self-identity-bridge (#5048) — 「当前登录用户是谁」从咕咕壳送进会话页的适配边界。
//
// 会话页投递卡显示发信人时,对**自己发的**消息不信信封:信封的 `from` 是发送那一刻冻结的事实,历史转录里还有
// 没带 `from` 的旧壳(owner 2026-09-05 在会话页看到自己的消息显示成 `user:<uuid>`),而「我是谁」渲染层自己
// 知道。会话页是另一个 bundle 里的另一棵 React 树,gugu 的 AuthContext 跨不过去 ⇒ 沿用 #2549/#2525 确立的
// `window.__GUGU_*` 全局适配对象(getSnapshot + subscribe)。
//
// 只送三格:canonical user id(与信封 `from_id` 的 `user:<id>` 比对)、昵称、咕咕号。❌ 不送 token、邮箱。

export interface SelfIdentitySnapshot {
  userId: string
  displayName: string | null
  guguNumber: number | null
}

export interface SelfIdentityBridge {
  getSnapshot(): SelfIdentitySnapshot | null
  subscribe(listener: () => void): () => void
}

export const SELF_IDENTITY_BRIDGE_KEY = '__GUGU_SELF_IDENTITY__' as const

export type SelfIdentityBridgeWindow = Window & {
  [SELF_IDENTITY_BRIDGE_KEY]?: SelfIdentityBridge
}

let current: SelfIdentitySnapshot | null = null
const listeners = new Set<() => void>()
const bridge: SelfIdentityBridge = {
  getSnapshot: () => current,
  subscribe: (listener) => {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },
}

function sameSnapshot(a: SelfIdentitySnapshot | null, b: SelfIdentitySnapshot | null): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return a.userId === b.userId && a.displayName === b.displayName && a.guguNumber === b.guguNumber
}

/** gugu 侧:登录态一变就发布一次;首次调用把桥装到 window 上(幂等)。 */
export function publishSelfIdentity(snapshot: SelfIdentitySnapshot | null, w: Window = window): void {
  const target = w as SelfIdentityBridgeWindow
  if (target[SELF_IDENTITY_BRIDGE_KEY] !== bridge) target[SELF_IDENTITY_BRIDGE_KEY] = bridge
  if (sameSnapshot(current, snapshot)) return
  current = snapshot
  for (const listener of listeners) listener()
}

/** 会话页侧:懒读,桥还没装(独立打开的会话页、未登录)就是 undefined,调用方退回信封事实。 */
export function readSelfIdentityBridge(w: Window | undefined = typeof window === 'undefined' ? undefined : window): SelfIdentityBridge | undefined {
  return w ? (w as SelfIdentityBridgeWindow)[SELF_IDENTITY_BRIDGE_KEY] : undefined
}
