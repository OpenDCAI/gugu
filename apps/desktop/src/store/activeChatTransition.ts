import { useCallback, useLayoutEffect, useRef, useState } from 'react'

export type ActiveChatWillChangeListener = (previousChatId: string, nextChatId: string | null) => void

const activeChatWillChangeListeners = new Set<ActiveChatWillChangeListener>()

export function subscribeActiveChatWillChange(listener: ActiveChatWillChangeListener): () => void {
  activeChatWillChangeListeners.add(listener)
  return () => activeChatWillChangeListeners.delete(listener)
}

export function publishActiveChatWillChange(previousChatId: string, nextChatId: string | null): void {
  activeChatWillChangeListeners.forEach((listener) => listener(previousChatId, nextChatId))
}

export function useActiveChatTransitionState(): readonly [string | null, (nextChatId: string | null) => void] {
  const [activeChatId, commitActiveChatId] = useState<string | null>(null)
  const requestedChatIdRef = useRef<string | null>(null)

  useLayoutEffect(() => {
    requestedChatIdRef.current = activeChatId
  }, [activeChatId])

  const setActiveChatId = useCallback((nextChatId: string | null) => {
    const previousChatId = requestedChatIdRef.current
    if (previousChatId !== nextChatId) {
      if (previousChatId) publishActiveChatWillChange(previousChatId, nextChatId)
      requestedChatIdRef.current = nextChatId
    }
    commitActiveChatId(nextChatId)
  }, [])

  return [activeChatId, setActiveChatId] as const
}
