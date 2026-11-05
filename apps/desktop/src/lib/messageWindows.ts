import type { MessageItem } from '@gugu/core/shared/types/chat'
import type { ImMessageWrite } from '../session/shared/core/im-messages'
import { MAX_WINDOW } from '../store/chatMessageWindow'

type Window = { chatId: string; root: string | null; rows: MessageItem[] }
const accounts = new Map<string, Map<string, Window>>()
const key = (chatId: string, root: string | null) => JSON.stringify([chatId, root])
/** One viewport cache per account; a rebind replaces the previous one. null rows = the conversation left. */
const publishers = new Map<string, (chatId: string, rows: MessageItem[] | null) => void>()

export function publishMessageWindows(accountId: string, publish: (chatId: string, rows: MessageItem[] | null) => void): void {
  publishers.set(accountId, publish)
}

export function initializeMessageWindows(accountId: string): void {
  if (!accounts.has(accountId)) accounts.set(accountId, new Map())
}

export function setMessageWindow(accountId: string, chatId: string, root: string | null, rows: readonly MessageItem[]): void {
  const windows = accounts.get(accountId)
  if (!windows) return
  if (root) for (const [id, window] of windows) if (window.chatId === chatId && window.root && window.root !== root) windows.delete(id)
  const sorted = [...rows].sort((a, b) => a.seq - b.seq || a.id.localeCompare(b.id)).slice(-MAX_WINDOW)
  windows.set(key(chatId, root), { chatId, root, rows: sorted })
  if (!root) publishers.get(accountId)?.(chatId, sorted)
}

/** Null means this account uses the unchanged phone cache. An empty desktop window is still authoritative. */
export function messageWindow(accountId: string, chatId: string, root: string | null = null): MessageItem[] | null {
  return accounts.has(accountId) ? accounts.get(accountId)!.get(key(chatId, root))?.rows ?? [] : null
}

/** Return streams needing a query: deletions can expose older rows outside the bounded map. */
export function acceptMessageWrites(accountId: string, writes: readonly ImMessageWrite[]): { chatId: string; root: string | null }[] {
  const windows = accounts.get(accountId)
  if (!windows) return []
  const reads = new Map<string, { chatId: string; root: string | null }>()
  for (const write of writes) {
    if (write.type === 'deleteChat') {
      for (const [id, window] of windows) if (window.chatId === write.chatId) windows.delete(id)
      publishers.get(accountId)?.(write.chatId, null)
    } else if (write.type === 'put') {
      const row = write.message, root = row.thread_root_id ?? null, id = key(row.chat_id, root)
      if (!root || windows.has(id)) {
        reads.set(id, { chatId: row.chat_id, root })
        setMessageWindow(accountId, row.chat_id, root, [...windows.get(id)?.rows.filter(value => value.id !== row.id) ?? [], row])
      }
      for (const [threadId, window] of windows) if (window.chatId === row.chat_id && window.root === row.id) {
        reads.set(threadId, { chatId: row.chat_id, root: window.root })
      }
    } else if (write.type === 'delete') {
      for (const [id, window] of windows) if (window.chatId === write.chatId) {
        window.rows = window.rows.filter(row => row.id !== write.id)
        reads.set(id, { chatId: window.chatId, root: window.root })
      }
    }
  }
  return [...reads.values()]
}

export function clearMessageWindows(accountId: string): void { accounts.delete(accountId) }
