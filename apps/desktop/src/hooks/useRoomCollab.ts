import { useEffect, useRef, useState } from 'react'
import type { GroupCollabSnapshot } from '@gugu/core/shared/types/chat'
import { useAuth } from '../store/auth'
import { useChatStore } from '../store/chatContext'
import { EMPTY_GROUP_COLLAB, useGroupCollabLoader } from './useGroupCollabLoader'
import { useRoomAuthorityRevision } from './useRoomAuthorityRevision'

/** Topic drawers use the conversation's existing roster loader and source-group authority refresh. */
export function useRoomCollab(chatId: string | null, chatKind: 'group' | 'topic', sourceChatId: string | null = null) {
  const { user } = useAuth()
  const { getImRepository, subscribeAccountRevision } = useChatStore('getImRepository', 'subscribeAccountRevision')
  const [snapshot, setSnapshot] = useState(EMPTY_GROUP_COLLAB)
  const memory = useRef(new Map<string, GroupCollabSnapshot>())
  const { loadGroupCollab, resetGroupCollabForChat, error } = useGroupCollabLoader({
    activeChatId: chatId, isRoomChat: !!chatId, chatKind, cachedFirstFrame: chatKind !== 'topic', userId: user?.id, getImRepository,
    setGroupCollabSnapshot: setSnapshot, groupRosterMemoryCacheRef: memory,
  })
  useEffect(() => { resetGroupCollabForChat(); void loadGroupCollab() }, [loadGroupCollab, resetGroupCollabForChat])
  const authorityRevision = useRoomAuthorityRevision({ chatId, sourceChatId, isRoom: !!chatId, userId: user?.id ?? null, loadGroupCollab, subscribeAccountRevision })
  return { snapshot: error !== 'not-participant' && snapshot.scheduler.chat_id === chatId ? snapshot : null, reload: loadGroupCollab, error, authorityRevision }
}
