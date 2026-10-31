import { useSyncExternalStore } from 'react'

export type NativeConversationVisibility = { sessionId: string; visible: readonly string[]; aliases: ReadonlyMap<string, readonly string[]> }
type ReadState = { chatId: string; firstUnreadId: string | null; confirmedSeq: number; loaded: readonly string[]; visible: readonly string[]; pendingSeqs: readonly number[] }
type State = { entries: ReadonlyMap<string, NativeConversationVisibility>; listeners: Set<() => void>; readers?: Map<string, ReadState> }
const KEY = '__GUGU_NATIVE_CONVERSATION_VISIBILITY__'
const empty: State = { entries: new Map(), listeners: new Set() }
function state(): State {
  if (typeof window === 'undefined') return empty
  const host = window as unknown as Record<string, State>
  return host[KEY] ??= { entries: new Map(), listeners: new Set() }
}
export function publishNativeConversationVisibility(key: string, value: NativeConversationVisibility | null): void {
  const own = state()
  const entries = new Map(own.entries)
  if (value) entries.set(key, value); else entries.delete(key)
  own.entries = entries
  for (const listener of own.listeners) listener()
}
export function useNativeConversationVisibility(): State['entries'] {
  return useSyncExternalStore(listener => { state().listeners.add(listener); return () => { state().listeners.delete(listener) } }, () => state().entries)
}
/** ID-only diagnostics share the viewport's lifetime and never carry message text or account credentials. */
export function publishNativeConversationReadState(key: string, value: ReadState | null): void {
  const readers = state().readers ??= new Map()
  if (value) readers.set(key, value); else readers.delete(key)
}
