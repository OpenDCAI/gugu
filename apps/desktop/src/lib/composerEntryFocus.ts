import { useEffect, useRef, useSyncExternalStore } from 'react'

type EntryFocus = { target: string }
let pending: EntryFocus | null = null
const listeners = new Set<() => void>()
const read = () => pending
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
const emit = () => { for (const listener of listeners) listener() }

/** A user entry is an intent even when already selected; null leaves the keyboard with a resource. */
export function requestComposerEntryFocus(target: string | null): void {
  pending = target === null ? null : { target }
  emit()
}

/** The named, visible owner answers once; a later entry supersedes an unmounted owner. */
export function useComposerEntryFocus(target: string | null, ready: boolean, focus: () => void): void {
  const request = useSyncExternalStore(subscribe, read, () => null)
  const focusRef = useRef(focus)
  focusRef.current = focus
  useEffect(() => {
    if (!ready || !request || request.target !== target || pending !== request) return
    pending = null
    emit()
    focusRef.current()
  }, [request, target, ready])
}
