import { useCallback, useSyncExternalStore } from 'react'

export type AttachmentUploadProgress = { loaded: number; total?: number; attempt: number }
const values = new Map<string, AttachmentUploadProgress>()
const listeners = new Map<string, Set<() => void>>()

/** Ephemeral transport state keyed by the same ID as its optimistic message. */
export function setAttachmentUploadProgress(messageId: string, progress?: AttachmentUploadProgress): void {
  if (progress) values.set(messageId, progress)
  else values.delete(messageId)
  for (const listener of listeners.get(messageId) ?? []) listener()
}

export function useAttachmentUploadProgress(messageId: string): AttachmentUploadProgress | undefined {
  const subscribe = useCallback((listener: () => void) => {
    const set = listeners.get(messageId) ?? new Set<() => void>()
    listeners.set(messageId, set)
    set.add(listener)
    return () => { set.delete(listener); if (!set.size) listeners.delete(messageId) }
  }, [messageId])
  const snapshot = useCallback(() => values.get(messageId), [messageId])
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}
