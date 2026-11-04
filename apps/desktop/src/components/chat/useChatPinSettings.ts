import { useEffect } from 'react'
import { skipToken, useMutation, useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { readChatPinSettings, setChatPinPreference, watchChatPinSettings, type ChatPinSettings } from '@/lib/chatPinSettings'
import { rendererLogger } from '@/lib/log'
import { messageForUser } from '@/lib/userFacingError'
import { queryClient } from '@/session/renderer/lib/query-client'
import { useAuth } from '@/store/auth'
import { useToast } from '../toastContext'

const empty: ChatPinSettings = { topicIds: [] }
const keyOf = (userId: string | undefined, chatId: string | null) => ['chat-pins', userId, chatId] as const
// Subscription ownership only; preference values live exclusively in QueryClient.
const watches = new Map<string, { users: number; stop: () => void }>()

function watch(userId: string, chatId: string) {
  const id = JSON.stringify([userId, chatId])
  let entry = watches.get(id)
  if (!entry) {
    const queryKey = keyOf(userId, chatId)
    const stop = watchChatPinSettings(userId, chatId, () => {
      void queryClient.cancelQueries({ queryKey }).then(() => queryClient.invalidateQueries({ queryKey }))
    })
    entry = { users: 0, stop }
    watches.set(id, entry)
  }
  const active = entry
  active.users++
  return () => {
    if (--active.users === 0) { active.stop(); watches.delete(id) }
  }
}

export function useChatPinSettings(chatId: string | null, enabled = true) {
  const { user } = useAuth()
  const { toast } = useToast()
  const { t } = useTranslation('messaging')
  const userId = user?.id
  const query = useQuery({
    queryKey: keyOf(userId, chatId), enabled,
    queryFn: userId && chatId ? () => readChatPinSettings(userId, chatId) : skipToken,
    retry: false, networkMode: 'always', staleTime: Infinity, refetchOnMount: false,
  }, queryClient)
  useEffect(() => {
    if (!userId || !chatId || !enabled) return
    return watch(userId, chatId)
  }, [userId, chatId, enabled])
  const mutation = useMutation({
    networkMode: 'always', scope: { id: `chat-settings:${userId}:${chatId}` },
    mutationFn: (input: { userId: string | undefined; chatId: string | null; id: string; pinned: boolean }) => {
      if (!input.userId || !input.chatId) throw new Error('A signed-in chat is required')
      return setChatPinPreference(input.userId, input.chatId, input.id, input.pinned)
    },
    onSuccess: async (pins, input) => {
      const queryKey = keyOf(input.userId, input.chatId)
      await queryClient.cancelQueries({ queryKey })
      queryClient.setQueryData(queryKey, pins)
    },
    onError: (error) => { rendererLogger('chat/pins').error({ error }, 'Saving chat pins failed'); toast(t('topic.pins.saveFailed'), 'error', messageForUser(error)) },
  }, queryClient)
  return {
    ...(query.data ?? empty), ready: query.isSuccess, error: query.isError, saving: mutation.isPending,
    retry: () => { void query.refetch() },
    set: (id: string, pinned: boolean) => mutation.mutate({ userId, chatId, id, pinned }),
  }
}
