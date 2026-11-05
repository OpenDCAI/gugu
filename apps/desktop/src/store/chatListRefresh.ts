import { useCallback, type Dispatch, type SetStateAction } from 'react'
import type { ChatItem } from '@gugu/core/shared/types/chat'
import { isLifecycleCancellation } from '../lib/authBoundedFetch'
import { rendererLogger } from '../lib/log'
import type { useChatProjectionBinding } from './chatListProjection'
import type { ChatCatchupPriority } from './chatCatchupPriority'
import type { RefreshChatsOptions } from './chatContext'

export function useChatListRefresh(
  userId: string | null,
  chatProjection: ReturnType<typeof useChatProjectionBinding>,
  chatsRef: { readonly current: ChatItem[] },
  requestSeqRef: { current: number },
  setChatsLoad: Dispatch<SetStateAction<'unread' | 'idle' | 'loading' | 'failed'>>,
  priority: ChatCatchupPriority,
) {
  return useCallback(async (options: RefreshChatsOptions = {}) => {
    if (!userId) return
    const done = priority?.begin()
    const isFirstLoad = chatsRef.current.length === 0
    setChatsLoad((state) => (isFirstLoad ? 'loading' : state === 'failed' || state === 'unread' ? 'idle' : state))
    const requestSeq = ++requestSeqRef.current
    try {
      // Same projection owner for cold snapshots and revision views (I7).
      const data = await chatProjection.hydrate(userId)
      if (data.length > 0 || chatsRef.current.length === 0 || options.acceptEmpty === true || chatProjection.hasDeletedConversation(userId, chatsRef.current)) {
        await chatProjection.publish(data, chatProjection.identities(userId), {
          requestSeq, notify: !isFirstLoad, preserveMissingActive: options.preserveMissingActive,
        })
      }
    } catch (error) {
      if (!isLifecycleCancellation(error)) {
        rendererLogger('chat/list-refresh').error({ error }, 'load chats failed')
        setChatsLoad('failed')
      }
      if (options.throwOnError) throw error
    } finally {
      setChatsLoad((state) => (state === 'loading' ? 'idle' : state))
      done?.()
      priority?.initialReadCompleted()
    }
  }, [chatProjection, chatsRef, priority, requestSeqRef, setChatsLoad, userId])
}
