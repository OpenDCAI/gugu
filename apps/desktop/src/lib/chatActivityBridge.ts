// 哪些对话已经有过消息(gugu-dev#181:项目群里还没有消息时,项目块正中是文件夹卡和输入框;有了才是消息流)。
//
// 壳那棵树知道每个对话的最后一条消息(聊天列表那一份),会话页不知道:壳写、会话页读,同一个 window 对象 +
// 一个 window 事件(谁先起来都接得上)。两边都只 import 这一个文件,❌ 各写一份键名。
import { useSyncExternalStore } from 'react'

const KEY = '__GUGU_CHAT_ACTIVITY__'
const EVENT = 'gugu:chat-activity'

type Activity = { readonly withMessages: ReadonlySet<string> }

/** 壳:这些对话有过消息(整份替换;没变不通知)。 */
export function publishChatsWithMessages(chatIds: Iterable<string>): void {
  const next = new Set(chatIds)
  const current = read()
  if (current && current.withMessages.size === next.size && [...next].every((id) => current.withMessages.has(id))) return
  ;(window as unknown as Record<string, unknown>)[KEY] = { withMessages: next } satisfies Activity
  window.dispatchEvent(new Event(EVENT))
}

function read(): Activity | null {
  return ((window as unknown as Record<string, unknown>)[KEY] as Activity | undefined) ?? null
}

function subscribe(listener: () => void): () => void {
  window.addEventListener(EVENT, listener)
  return () => window.removeEventListener(EVENT, listener)
}

/** 会话页:这个对话有没有过消息;壳还没告诉过 = null(还不知道,❌ 当成没有)。 */
export function useChatHasMessages(chatId: string | undefined): boolean | null {
  return useSyncExternalStore(subscribe, () => {
    const activity = read()
    return activity && chatId ? activity.withMessages.has(chatId) : null
  }, () => null)
}
