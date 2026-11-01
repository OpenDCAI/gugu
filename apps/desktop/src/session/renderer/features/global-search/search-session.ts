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

/** Start a fresh search with this text and scope, without opening anything (the phone's page opens itself). */
export function resetSearchSession(options: { text?: string; chips?: SearchChip[] } = {}): void {
  updateSearchSession({ ...EMPTY, text: options.text ?? '', chips: options.chips ?? [] })
}

/** Every desktop entry point: the sidebar box, Mod+Shift+F, and the quick switcher's last row. */
export function openGlobalSearch(options: { text?: string; chips?: SearchChip[] } = {}): void {
  resetSearchSession(options)
  commandRegistry.dispatch('app.globalSearch')
}
