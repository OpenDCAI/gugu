import { useEffect, useRef, useState } from 'react'
import type { GroupCollabSnapshot } from '@gugu/core/shared/types/chat'
import { useAuth } from '../store/auth'
import { useChatStore } from '../store/chatContext'
import { readRevisionResourceKey } from '../lib/accountRevisionCoordinator'
import { EMPTY_GROUP_COLLAB, useGroupCollabLoader } from './useGroupCollabLoader'

/** Keep a topic's existing roster loader mounted with its conversation, rather than its member drawer. */
export function useRoomCollab(chatId: string, chatKind: 'group' | 'topic') {
  const { user } = useAuth()
  const { getImRepository, subscribeAccountRevision } = useChatStore('getImRepository', 'subscribeAccountRevision')
  const [snapshot, setSnapshot] = useState(EMPTY_GROUP_COLLAB)
  const memory = useRef(new Map<string, GroupCollabSnapshot>())
  const { loadGroupCollab, resetGroupCollabForChat, error } = useGroupCollabLoader({
    activeChatId: chatId, isRoomChat: true, chatKind, userId: user?.id, getImRepository,
    setGroupCollabSnapshot: setSnapshot, groupRosterMemoryCacheRef: memory,
  })
  useEffect(() => { resetGroupCollabForChat(); void loadGroupCollab() }, [loadGroupCollab, resetGroupCollabForChat])
  useEffect(() => subscribeAccountRevision('chat_members_changed', (operations) => {
    if (operations.some((operation) => readRevisionResourceKey(operation.payload, 'chat_members_changed').chatId === chatId)) void loadGroupCollab()
  }), [chatId, loadGroupCollab, subscribeAccountRevision])
  return { snapshot: snapshot.scheduler.chat_id === chatId ? snapshot : null, reload: loadGroupCollab, error }
}
