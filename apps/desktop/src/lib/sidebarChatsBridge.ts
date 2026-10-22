// gugu-dev#181 会话页侧栏里的「对话」:列表本身由壳画进 `chat-list` 那一格(components/ChatListSlotHost.tsx),
// 这里是两棵树之间剩下的两样东西,各一个 window 对象 + 一个 window 事件(谁先起来都接得上,形制同 chatSummariesBridge):
//   · 壳 → 会话页:未读数。「对话」页签挂对话那边的未读总数,项目行与「项目」页签挂项目群的未读(含它的话题)。
//     只读未读数,❌ 在这里清:数只在真读了才减,切页签不算读。
//   · 会话页 → 壳:侧栏此刻在看什么 —— 搜索框里的字(一个框搜两边)、正看着的那块对话(那一行高亮)。
// 两边都只 import 这一个文件,❌ 各写一份键名。
import { useSyncExternalStore } from 'react'
import type { ChatItem } from '@gugu/core/shared/types/chat'

/** 会话页侧栏「对话」那一格在 lib/shellSlots 里的键:会话页登记,壳的 components/ChatListSlotHost.tsx 往里画。 */
export const CHAT_LIST_SLOT_KEY = 'chat-list'

export type SidebarChatSignals = {
  /** 「对话」那边(人、用户群和它们的话题)的未读总数,免打扰的不算。 */
  readonly chatsUnread: number
  /** 每个项目群的未读(含从它开出来的话题),免打扰的不算;没有未读的群不在里面。 */
  readonly groupUnread: ReadonlyMap<string, number>
}

/** gugu-dev#181 没有项目的会话(它就是和 agent 私聊):会话页发给壳,和对话一起排进「对话」。 */
export type SidebarSessionLine = {
  readonly projectId: string
  readonly sessionId: string
  readonly title: string
  /** 最后活动时刻(毫秒),和对话的最后一条消息时刻一起排序。 */
  readonly time: number
  /** 要你处理 / 在跑;都不是 = null(行尾不挂状态)。 */
  readonly group: 'needs-you' | 'working' | null
  /** 这个会话的 agent(行照它的私聊那样画:头像、名字);还不知道 = null。 */
  readonly agentUserId: string | null
}

export type SidebarChatView = {
  readonly focusedChatId: string | null
  /** 正看着的那条会话(没有项目的会话排在「对话」里,那一行高亮)。 */
  readonly focusedSessionId: string | null
}

const SIGNALS_KEY = '__GUGU_SIDEBAR_CHAT_SIGNALS__'
const SIGNALS_EVENT = 'gugu:sidebar-chat-signals'
const VIEW_KEY = '__GUGU_SIDEBAR_CHAT_VIEW__'
const VIEW_EVENT = 'gugu:sidebar-chat-view'
const SESSIONS_KEY = '__GUGU_SIDEBAR_SESSIONS__'
const SESSIONS_EVENT = 'gugu:sidebar-sessions'
const NO_SESSIONS: readonly SidebarSessionLine[] = []

/**
 * 壳:从聊天列表那一份算出两枚页签和项目行上的数。项目群(及从它开出来的话题)的未读记在那个群名下,其余记进「对话」;免打扰的不算(gugu-dev#181:
 * 「对话」页签挂对话那边的未读总数,项目行与「项目」页签挂项目群的未读)。只读未读数,真读了它自己会减。
 */
export function sidebarChatSignals(chats: readonly ChatItem[], projectGroupChats: ReadonlySet<string>): SidebarChatSignals {
  let chatsUnread = 0
  const groupUnread = new Map<string, number>()
  for (const chat of chats) {
    if (chat.unread_count <= 0 || chat.is_muted) continue
    const line = chat.kind === 'topic' ? (chat.source_chat_id ?? chat.id) : chat.id
    if (projectGroupChats.has(line)) groupUnread.set(line, (groupUnread.get(line) ?? 0) + chat.unread_count)
    else chatsUnread += chat.unread_count
  }
  return { chatsUnread, groupUnread }
}

const NO_VIEW: SidebarChatView = { focusedChatId: null, focusedSessionId: null }

function read<T>(key: string): T | null {
  return ((window as unknown as Record<string, unknown>)[key] as T | undefined) ?? null
}

function write(key: string, event: string, value: unknown): void {
  const target = window as unknown as Record<string, unknown>
  target[key] = value
  window.dispatchEvent(new Event(event))
}

const subscribeTo = (event: string) => (listener: () => void) => {
  window.addEventListener(event, listener)
  return () => window.removeEventListener(event, listener)
}
const subscribeSignals = subscribeTo(SIGNALS_EVENT)
const subscribeView = subscribeTo(VIEW_EVENT)
const subscribeSessions = subscribeTo(SESSIONS_EVENT)

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
  if (current && current.focusedChatId === next.focusedChatId && current.focusedSessionId === next.focusedSessionId) return
  write(VIEW_KEY, VIEW_EVENT, next)
}

/** 壳:会话页还没说过 = 没看着哪条对话。 */
export function useSidebarChatView(): SidebarChatView {
  return useSyncExternalStore(subscribeView, () => read<SidebarChatView>(VIEW_KEY) ?? NO_VIEW, () => NO_VIEW)
}

/** 会话页:没有项目的会话(整份替换;没变不通知)。 */
export function publishSidebarSessions(next: readonly SidebarSessionLine[]): void {
  const current = read<readonly SidebarSessionLine[]>(SESSIONS_KEY)
  if (current && JSON.stringify(current) === JSON.stringify(next)) return
  write(SESSIONS_KEY, SESSIONS_EVENT, next)
}

/** 壳:会话页还没发过 = 一条也没有。 */
export function useSidebarSessions(): readonly SidebarSessionLine[] {
  return useSyncExternalStore(subscribeSessions, () => read<readonly SidebarSessionLine[]>(SESSIONS_KEY) ?? NO_SESSIONS, () => NO_SESSIONS)
}

export type ShellChatAction = 'create-group' | 'add-contact'

const ACTION_KEY = '__GUGU_SIDEBAR_CHAT_ACTION__'
const ACTION_EVENT = 'gugu:sidebar-chat-action'

/**
 * 会话页:新建群聊 / 添加联系人(侧栏「对话」页那两行、⌘K 面板)。弹窗是侧栏里那份对话列表的,那份列表此刻可能还没挂上
 * (人在「项目」页):请求先存着,列表挂上或收到通知时取走 —— ❌ 发一个没人听的事件就丢了。
 */
export function requestShellChatAction(action: ShellChatAction): void {
  write(ACTION_KEY, ACTION_EVENT, action)
}

/** 壳(侧栏那份对话列表):取走一个还没办的请求;取一次就没了。 */
export function takeShellChatAction(): ShellChatAction | null {
  const action = read<ShellChatAction>(ACTION_KEY)
  ;(window as unknown as Record<string, unknown>)[ACTION_KEY] = null
  return action
}

export const subscribeShellChatActions = subscribeTo(ACTION_EVENT)
