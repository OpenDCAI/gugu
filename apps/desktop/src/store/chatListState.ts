import { useState, useSyncExternalStore, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import type { ChatItem } from '@gugu/core/shared/types/chat'

/** One list owner for projection, functional patches, rollback and deletion.
 * React subscribes to this value; there is no layout-effect mirror to reconcile.
 */
export function createChatListState(initial: ChatItem[] = []) {
  let rows = initial
  const listeners = new Set<() => void>()
  const set: Dispatch<SetStateAction<ChatItem[]>> = update => {
    const next = typeof update === 'function' ? update(rows) : update
    if (Object.is(rows, next)) return
    rows = next
    for (const listener of listeners) listener()
  }
  return {
    get current() { return rows },
    set current(next: ChatItem[]) { set(next) },
    set,
    getSnapshot: () => rows,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}

export function useChatListState(initial: ChatItem[] = []): readonly [ChatItem[], Dispatch<SetStateAction<ChatItem[]>>, MutableRefObject<ChatItem[]>] {
  const [state] = useState(() => createChatListState(initial))
  const rows = useSyncExternalStore(state.subscribe, state.getSnapshot, state.getSnapshot)
  return [rows, state.set, state]
}
