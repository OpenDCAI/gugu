import { useSyncExternalStore } from 'react'
import { commandRegistry } from '@renderer/lib/commands/registry'

/** A scope that narrows the search: one conversation, one local task, or one sender. */
export type SearchChip =
  | { kind: 'in'; chatId: string }
  | { kind: 'in-task'; taskId: string; title: string }
  | { kind: 'from'; userId: string; name: string }

/** The filter row: everything, chat messages, task content, or files sent in chats. */
export type SearchFacet = 'all' | 'message' | 'task' | 'file'

export interface SearchSession {
  text: string
  chips: SearchChip[]
  facet: SearchFacet
  /** The highlighted result (null: the first one). */
  selectedId: string | null
}

const EMPTY: SearchSession = { text: '', chips: [], facet: 'all', selectedId: null }
let session = EMPTY
const listeners = new Set<() => void>()

export function updateSearchSession(change: Partial<SearchSession>): void {
  session = { ...session, ...change }
  for (const listener of listeners) listener()
}

export function useSearchSession(): SearchSession {
  return useSyncExternalStore((listener) => { listeners.add(listener); return () => { listeners.delete(listener) } }, () => session)
}

/** Start a fresh search with this text and scope, without opening anything. */
export function resetSearchSession(options: { text?: string; chips?: SearchChip[] } = {}): void {
  updateSearchSession({ ...EMPTY, text: options.text ?? '', chips: options.chips ?? [] })
}

/**
 * Every entry point opens this one panel: the sidebar box, Mod+Shift+F, the quick switcher's last row, and every search
 * inside a conversation (⌘F, the header's and settings' 「搜索聊天记录」, a member's 「查找 TA 的消息」), which come
 * scoped with an in: chip the user can remove. The panel's host answers app.globalSearch: the task workspace's modal,
 * or the sheet on the phone shell and wherever there is no workspace.
 */
export function openGlobalSearch(options: { text?: string; chips?: SearchChip[] } = {}): void {
  resetSearchSession(options)
  if (!commandRegistry.dispatch('app.globalSearch')) throw new Error('No global search panel is mounted')
}

/** Search one conversation (optionally one sender's messages in it): the global panel, scoped by removable chips. */
export function searchInChat(chatId: string, from?: { userId: string; name: string }): void {
  openGlobalSearch({ chips: from ? [{ kind: 'in', chatId }, { kind: 'from', ...from }] : [{ kind: 'in', chatId }] })
}
