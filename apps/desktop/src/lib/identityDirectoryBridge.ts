// @@@identity-directory-bridge (#6306) — 本地身份缓存从咕咕壳送进会话页的只读窗口。
//
// 身份(名字、头像)的真值在库 identity.users;客户端只有一份缓存:IM repository(IndexedDB + 内存),
// 唯一写入口是它的 putIdentities。会话页与聊天页是同一个 document 里的两棵树 ⇒ 会话页读**同一份内存**,
// ❌ 另建缓存、❌ 经主进程转一份拷贝。形制同 selfIdentityBridge(window 全局 + getSnapshot / subscribe)。
//
// - getSnapshot():聊天页订阅到的那一份 identitiesById 本身(引用,不拷贝);没登录 / 本地库还没打开 = null。
// - ensure(ids):缓存里没有的 id 交回 IM repository 按需补取(ensureIdentities),结果照常经 putIdentities
//   写入、经订阅送达;会话页自己不查库。
//
// 桥只由咕咕壳的 bundle 装(chatMessageWindowPublication.ts 在模块加载时装上,store/chat.tsx 静态引入它),会话页 bundle 只读:两个 bundle 各有一份本模块,
// 读写都经 window 上那一个对象,❌ 在会话页侧装桥(那会装上一个永远空的副本)。
import type { DisplayIdentity } from './displayIdentity'

export type IdentityDirectorySnapshot = Readonly<Record<string, DisplayIdentity>>

export interface IdentityDirectoryBridge {
  getSnapshot(): IdentityDirectorySnapshot | null
  subscribe(listener: () => void): () => void
  ensure(ids: readonly string[]): void
}

export const IDENTITY_DIRECTORY_BRIDGE_KEY = '__GUGU_IDENTITY_DIRECTORY__' as const

type IdentityDirectoryWindow = Window & { [IDENTITY_DIRECTORY_BRIDGE_KEY]?: IdentityDirectoryBridge }

let current: IdentityDirectorySnapshot | null = null
let ensureHandler: ((ids: readonly string[]) => void) | null = null
const listeners = new Set<() => void>()
const bridge: IdentityDirectoryBridge = {
  getSnapshot: () => current,
  subscribe: (listener) => {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },
  ensure: (ids) => ensureHandler?.(ids),
}

/** 咕咕侧:装桥(幂等)。在会话页 bundle 执行之前装上,会话页首次订阅就能挂住,之后的发布都收得到。 */
export function installIdentityDirectoryBridge(w: Window = window): void {
  const target = w as IdentityDirectoryWindow
  if (target[IDENTITY_DIRECTORY_BRIDGE_KEY] !== bridge) target[IDENTITY_DIRECTORY_BRIDGE_KEY] = bridge
}

/** 咕咕侧:本地身份缓存一变就发布(subscribeIdentities);本地库关闭时发 null 并摘掉补取口(closeImRepository)。 */
export function publishIdentityDirectory(
  snapshot: IdentityDirectorySnapshot | null,
  ensure: ((ids: readonly string[]) => void) | null,
): void {
  ensureHandler = ensure
  if (sameDirectory(current, snapshot)) return
  current = snapshot
  for (const listener of listeners) listener()
}

/**
 * 本地库每一笔写(消息窗口、会话行、在线态…)都会重新算出一个新的 identitiesById 对象;只有身份行真的变了才通知会话页。
 * 没被改写的行在快照之间是同一个对象(applyOperations 只复制数组),被 put 的行是新对象 ⇒ 逐键比引用即可。
 */
function sameDirectory(a: IdentityDirectorySnapshot | null, b: IdentityDirectorySnapshot | null): boolean {
  if (a === b) return true
  if (!a || !b) return false
  const keys = Object.keys(a)
  if (keys.length !== Object.keys(b).length) return false
  return keys.every((key) => a[key] === b[key])
}

/** 会话页侧:懒读;桥缺席(独立打开的会话页)= undefined,调用方不画头像。 */
export function readIdentityDirectoryBridge(
  w: Window | undefined = typeof window === 'undefined' ? undefined : window,
): IdentityDirectoryBridge | undefined {
  return w ? (w as IdentityDirectoryWindow)[IDENTITY_DIRECTORY_BRIDGE_KEY] : undefined
}
