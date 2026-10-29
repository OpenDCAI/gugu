import { useSyncExternalStore } from 'react'

export type NativeConversationVisibility = { sessionId: string; visible: readonly string[]; aliases: ReadonlyMap<string, readonly string[]> }
type State = { entries: ReadonlyMap<string, NativeConversationVisibility>; listeners: Set<() => void> }
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
