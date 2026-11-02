import { useEffect, useState } from 'react'
import type { AccountRevisionEvent, AccountRevisionListener } from '../lib/accountRevisionCoordinator'
import { UI_EVENTS } from '../lib/uiEvents'

/** The room's existing coalesced roster refresh also refreshes this viewer's authority. */
export function useRoomAuthorityRevision({ chatId, sourceChatId, isRoom, userId, loadGroupCollab, subscribeAccountRevision }: {
  chatId: string | null
  sourceChatId: string | null
  isRoom: boolean
  userId: string | null
  loadGroupCollab: () => Promise<void>
  subscribeAccountRevision: (event: AccountRevisionEvent, listener: AccountRevisionListener) => () => void
}) {
  const [authorityRevision, setAuthorityRevision] = useState(0)
  useEffect(() => {
    if (!chatId || !isRoom || !userId) return
    const refreshTimers = new Set<number>()
    // @@@ collab-refetch-coalesce (#597) — see git history for full context.
    let pendingReload: number | null = null
    let refreshAuthority = false
    const handleCollabChange = (authorityChanged = false) => {
      refreshAuthority ||= authorityChanged
      if (pendingReload !== null) return
      pendingReload = window.setTimeout(() => {
        refreshTimers.delete(pendingReload as number)
        pendingReload = null
        if (refreshAuthority) setAuthorityRevision((n) => n + 1)
        refreshAuthority = false
        loadGroupCollab()
      }, 300)
      refreshTimers.add(pendingReload)
    }
    const handleRevision = (operations: readonly { payload: unknown }[]) => {
      const relevant = operations.filter((operation) => {
        const id = (operation.payload as { chat_id?: unknown })?.chat_id
        return id === chatId || (!!sourceChatId && id === sourceChatId)
      })
      if (relevant.length) handleCollabChange(relevant.some((operation) => (operation.payload as { user_id?: unknown })?.user_id === userId))
    }
    const unsubscribeGroup = subscribeAccountRevision('group_collab_changed', handleRevision)
    const unsubscribeMembers = subscribeAccountRevision('chat_members_changed', handleRevision)
    const handleLocalCollabChange = (event: Event) => {
      const detail = (event as CustomEvent<{ chatId?: string }>).detail
      if (detail?.chatId === chatId || (!!sourceChatId && detail?.chatId === sourceChatId)) handleCollabChange()
    }
    window.addEventListener(UI_EVENTS.groupCollabChanged, handleLocalCollabChange)
    return () => {
      refreshTimers.forEach((timer) => window.clearTimeout(timer))
      window.removeEventListener(UI_EVENTS.groupCollabChanged, handleLocalCollabChange)
      unsubscribeGroup()
      unsubscribeMembers()
    }
  }, [chatId, sourceChatId, isRoom, loadGroupCollab, subscribeAccountRevision, userId])
  return authorityRevision
}
