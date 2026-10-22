// gugu-dev#181 会话页侧栏里的「对话」:列表本身由壳画进 `chat-list` 那一格(components/ChatListSlotHost.tsx),
// 这里是两棵树之间剩下的两样东西,各一个 window 对象 + 一个 window 事件(谁先起来都接得上,形制同 chatActivityBridge):
//   · 壳 → 会话页:未读数。「对话」页签挂对话那边的未读总数,项目行与「项目」页签挂项目群的未读(含它的话题)。
//     只读未读数,❌ 在这里清:数只在真读了才减,切页签不算读。
//   · 会话页 → 壳:侧栏此刻在看什么 —— 搜索框里的字(一个框搜两边)、正看着的那块对话(那一行高亮)。
// 两边都只 import 这一个文件,❌ 各写一份键名。
import { useSyncExternalStore } from 'react'

/** 会话页侧栏「对话」那一格在 lib/shellSlots 里的键:会话页登记,壳的 components/ChatListSlotHost.tsx 往里画。 */
export const CHAT_LIST_SLOT_KEY = 'chat-list'

export type SidebarChatSignals = {
  /** 「对话」那边(人、用户群和它们的话题)的未读总数,免打扰的不算。 */
  readonly chatsUnread: number
  /** 每个项目群的未读(含从它开出来的话题),免打扰的不算;没有未读的群不在里面。 */
  readonly groupUnread: ReadonlyMap<string, number>
}

export type SidebarChatView = {
  readonly query: string
  readonly focusedChatId: string | null
}

const SIGNALS_KEY = '__GUGU_SIDEBAR_CHAT_SIGNALS__'
const SIGNALS_EVENT = 'gugu:sidebar-chat-signals'
const VIEW_KEY = '__GUGU_SIDEBAR_CHAT_VIEW__'
const VIEW_EVENT = 'gugu:sidebar-chat-view'

const NO_VIEW: SidebarChatView = { query: '', focusedChatId: null }

function read<T>(key: string): T | null {
  return ((window as unknown as Record<string, unknown>)[key] as T | undefined) ?? null
}

function write(key: string, event: string, value: unknown): void {
  ;(window as unknown as Record<string, unknown>)[key] = value
  window.dispatchEvent(new Event(event))
}

const subscribeTo = (event: string) => (listener: () => void) => {
  window.addEventListener(event, listener)
  return () => window.removeEventListener(event, listener)
}
const subscribeSignals = subscribeTo(SIGNALS_EVENT)
const subscribeView = subscribeTo(VIEW_EVENT)

/** 壳:整份替换;没变不通知。 */
export function publishSidebarChatSignals(next: SidebarChatSignals): void {
  const current = read<SidebarChatSignals>(SIGNALS_KEY)
  if (
    current &&
    current.chatsUnread === next.chatsUnread &&
    current.groupUnread.size === next.groupUnread.size &&
    [...next.groupUnread].every(([chatId, count]) => current.groupUnread.get(chatId) === count)
  ) return
  write(SIGNALS_KEY, SIGNALS_EVENT, next)
}

/** 会话页:壳还没告诉过 = null(还不知道,页签上先不挂数)。 */
export function useSidebarChatSignals(): SidebarChatSignals | null {
  return useSyncExternalStore(subscribeSignals, () => read<SidebarChatSignals>(SIGNALS_KEY), () => null)
}

/** 会话页:侧栏在看什么;没变不通知。 */
export function publishSidebarChatView(next: SidebarChatView): void {
  const current = read<SidebarChatView>(VIEW_KEY)
  if (current && current.query === next.query && current.focusedChatId === next.focusedChatId) return
  write(VIEW_KEY, VIEW_EVENT, next)
}

/** 壳:会话页还没说过 = 没在搜、没看着哪条对话。 */
export function useSidebarChatView(): SidebarChatView {
  return useSyncExternalStore(subscribeView, () => read<SidebarChatView>(VIEW_KEY) ?? NO_VIEW, () => NO_VIEW)
}
