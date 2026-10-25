import { useTranslation } from 'react-i18next'
import { rendererLogger } from '@/lib/log';
import { messageForUser } from '@/lib/userFacingError';
import { useEffect } from 'react'
import { skipToken, useMutation, useQuery } from '@tanstack/react-query'
import { queryClient } from '../../session/renderer/lib/query-client'
import { readChatAppPins, setChatAppPin, watchChatAppPins } from '../../lib/chatAppPins'
import { useAuth } from '../../store/auth'
import { useToast } from '../toastContext'

export function useChatAppPins(chatId: string | null) {
  const { user } = useAuth()
  const { toast } = useToast()
  const { t } = useTranslation('messaging')
  const userId = user?.id
  const key = ['chat-app-pins', userId, chatId] as const
  const query = useQuery({
    queryKey: key,
    queryFn: userId && chatId ? () => readChatAppPins(userId, chatId) : skipToken,
    retry: false,
    networkMode: 'always',
    staleTime: Infinity,
    refetchOnMount: 'always',
  }, queryClient)
  useEffect(() => {
    if (!userId || !chatId) return
    const queryKey = ['chat-app-pins', userId, chatId]
    return watchChatAppPins(userId, chatId, () => {
      // A broadcast may arrive during the very first read too; discard that older answer before rereading.
      void queryClient.cancelQueries({ queryKey }).then(() => queryClient.invalidateQueries({ queryKey }))
    })
  }, [userId, chatId])
  const mutation = useMutation({
    networkMode: 'always',
    scope: { id: `chat-app-pins:${userId}:${chatId}` },
    mutationFn: ({ userId, chatId, appId, pinned }: { userId: string | undefined; chatId: string | null; appId: string; pinned: boolean }) => {
      if (!userId || !chatId) throw new Error('A signed-in chat is required')
      return setChatAppPin(userId, chatId, appId, pinned)
    },
    onSuccess: (ids, { userId, chatId }) => { queryClient.setQueryData(['chat-app-pins', userId, chatId], ids) },
    onError: (error) => { rendererLogger('actions/useChatAppPins').error({ error: error }, 'action failed'); toast(t('header.appPinsSaveFailed'), 'error', messageForUser(error)) },
  }, queryClient)
  return { ids: query.data ?? [], ready: query.isSuccess, error: query.isError, saving: mutation.isPending, retry: () => { void query.refetch() }, set: ({ appId, pinned }: { appId: string; pinned: boolean }) => mutation.mutate({ userId, chatId, appId, pinned }) }
}
