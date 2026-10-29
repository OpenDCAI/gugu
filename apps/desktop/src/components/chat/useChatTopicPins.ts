import { useEffect } from 'react'
import { skipToken, useMutation, useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { readChatTopicPins, setChatTopicPin, watchChatTopicPins } from '@/lib/chatTopicPins'
import { rendererLogger } from '@/lib/log'
import { messageForUser } from '@/lib/userFacingError'
import { queryClient } from '@/session/renderer/lib/query-client'
import { useAuth } from '@/store/auth'
import { useChatStore } from '@/store/chatContext'
import { useToast } from '../toastContext'
import { topicPinGroups } from './topicPinsModel'

export function useChatTopicPins(chatId: string | null, enabled = true) {
  const { user } = useAuth()
  const { chats } = useChatStore('chats')
  const { toast } = useToast()
  const { t } = useTranslation('messaging')
  const userId = user?.id
  const key = ['chat-topic-pins', userId, chatId] as const
  const query = useQuery({
    queryKey: key, enabled,
    queryFn: userId && chatId ? () => readChatTopicPins(userId, chatId) : skipToken,
    retry: false, networkMode: 'always', staleTime: Infinity, refetchOnMount: 'always',
  }, queryClient)
  useEffect(() => {
    if (!userId || !chatId || !enabled) return
    const queryKey = ['chat-topic-pins', userId, chatId]
    return watchChatTopicPins(userId, chatId, () => {
      void queryClient.cancelQueries({ queryKey }).then(() => queryClient.invalidateQueries({ queryKey }))
    })
  }, [userId, chatId, enabled])
  const groups = topicPinGroups(chats, chatId, query.data ?? [])
  const mutation = useMutation({
    networkMode: 'always', scope: { id: `chat-settings:${userId}:${chatId}` },
    mutationFn: (input: { userId: string | undefined; chatId: string | null; topicId: string; pinned: boolean; availableIds: string[] }) => {
      if (!input.userId || !input.chatId) throw new Error('A signed-in chat is required')
      return setChatTopicPin(input.userId, input.chatId, input.topicId, input.pinned, input.availableIds)
    },
    onSuccess: (ids, input) => { queryClient.setQueryData(['chat-topic-pins', input.userId, input.chatId], ids) },
    onError: (error) => { rendererLogger('chat/topic-pins').error({ error }, 'Saving topic pins failed'); toast(t('topic.pins.saveFailed'), 'error', messageForUser(error)) },
  }, queryClient)
  return {
    ...groups, ready: query.isSuccess, error: query.isError, saving: mutation.isPending,
    retry: () => { void query.refetch() },
    set: (topicId: string, pinned: boolean) => mutation.mutate({ userId, chatId, topicId, pinned, availableIds: groups.topics.map((topic) => topic.id) }),
  }
}
